import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileFleetStore, FilePlacementStore, NucleusFleetStore } from "./fleet.js";
import type { WorkerInfo } from "./fleet.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-"));
}

function worker(owner: string, activeRuns: number, lastSeen: string): WorkerInfo {
  return { owner, host: "h1", sandbox: "host", maxConcurrent: 5, activeRuns, startedAt: "2026-07-09T00:00:00Z", lastSeen };
}

test("heartbeat upserts by owner — a second beat updates, not duplicates", async () => {
  const s = new FileFleetStore(await tmp());
  await s.heartbeat(worker("w1", 1, "2026-07-09T00:00:00Z"));
  await s.heartbeat(worker("w1", 3, "2026-07-09T00:00:15Z"));
  await s.heartbeat(worker("w2", 0, "2026-07-09T00:00:15Z"));
  const all = await s.list();
  assert.equal(all.length, 2, "w1 updated in place, w2 added");
  const w1 = all.find((w) => w.owner === "w1");
  assert.equal(w1?.activeRuns, 3, "latest heartbeat wins");
  assert.equal(w1?.lastSeen, "2026-07-09T00:00:15Z");
});

test("list on an empty registry is [] not a throw", async () => {
  assert.deepEqual(await new FileFleetStore(await tmp()).list(), []);
});

test("placement set/get/all round-trips; set overwrites", async () => {
  const p = new FilePlacementStore(await tmp());
  assert.equal(await p.get("run-1"), null, "unknown run is null");
  await p.set("run-1", "host-a");
  await p.set("run-2", "host-b");
  await p.set("run-1", "host-c"); // overwrite
  assert.equal(await p.get("run-1"), "host-c");
  assert.deepEqual(await p.all(), { "run-1": "host-c", "run-2": "host-b" });
});

test("placement all() on an empty store is {} not a throw", async () => {
  assert.deepEqual(await new FilePlacementStore(await tmp()).all(), {});
});

/**
 * A stand-in for the pgwire adapter, deliberately modelling the ONE Nucleus
 * behaviour these stores depend on: a table's columns are fixed at CREATE and
 * cannot be ALTER-ADDed later, which is why sensed fields ride sibling tables.
 * Writing to a column the CREATE did not declare throws here, as it must.
 */
function fakeDb(fail: (sql: string) => boolean = () => false) {
  const tables = new Map<string, { cols: string[]; rows: Array<Record<string, unknown>> }>();
  const sqls: string[] = [];
  const table = (name: string) => {
    const t = tables.get(name);
    if (t === undefined) throw new Error(`relation "${name}" does not exist`);
    return t;
  };
  const query = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    sqls.push(sql);
    if (fail(sql)) throw new Error(`nucleus rejected: ${sql.slice(0, 40)}`);
    const create = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]+)\)$/.exec(sql.trim());
    if (create !== null) {
      const name = create[1]!;
      if (!tables.has(name)) {
        tables.set(name, { cols: [...create[2]!.matchAll(/(\w+)\s+TEXT/g)].map((m) => m[1]!), rows: [] });
      }
      return [];
    }
    const select = /^SELECT ([\w, ]+) FROM (\w+)(?: WHERE (\w+) (<|=) \$1)?$/.exec(sql.trim());
    if (select !== null) {
      const cols = select[1]!.split(",").map((c) => c.trim());
      const t = table(select[2]!);
      const hit = t.rows.filter((r) =>
        select[3] === undefined ? true : select[4] === "=" ? r[select[3]] === params[0] : String(r[select[3]]) < String(params[0]),
      );
      return hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    }
    const update = /^UPDATE (\w+) SET ([\s\S]+) WHERE (\w+) = \$(\d+)$/.exec(sql.trim());
    if (update !== null) {
      const t = table(update[1]!);
      const sets = [...update[2]!.matchAll(/(\w+) = \$(\d+)/g)];
      for (const [col] of sets.map((m) => [m[1]!])) {
        if (!t.cols.includes(col)) throw new Error(`column "${col}" of relation "${update[1]}" does not exist`);
      }
      for (const row of t.rows.filter((r) => r[update[3]!] === params[Number(update[4]) - 1])) {
        for (const m of sets) row[m[1]!] = params[Number(m[2]) - 1];
      }
      return [];
    }
    const insert = /^INSERT INTO (\w+) \(([\w, ]+)\) VALUES \(([$\d, ]+)\)$/.exec(sql.trim());
    if (insert !== null) {
      const t = table(insert[1]!);
      const cols = insert[2]!.split(",").map((c) => c.trim());
      for (const col of cols) {
        if (!t.cols.includes(col)) throw new Error(`column "${col}" of relation "${insert[1]}" does not exist`);
      }
      t.rows.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
      return [];
    }
    const del = /^DELETE FROM (\w+) WHERE (\w+) (<|=) \$1$/.exec(sql.trim());
    if (del !== null) {
      const t = table(del[1]!);
      t.rows = t.rows.filter((r) => (del[3] === "=" ? r[del[2]!] !== params[0] : !(String(r[del[2]!]) < String(params[0]))));
      return [];
    }
    throw new Error(`fakeDb cannot parse: ${sql}`);
  };
  const taken = new Set<string>();
  const db = { query, kv: { setNX: async (key: string) => (taken.has(key) ? false : (taken.add(key), true)) } };
  return { db: db as unknown as import("./nucleus-pgwire.js").NucleusPgwire, tables, sqls };
}

function sensed(owner: string): WorkerInfo {
  return {
    ...worker(owner, 1, "2026-08-26T00:00:00Z"),
    maxConcurrent: 1,
    freeMemMB: 2268,
    load1: 1.2,
    cpus: 4,
    held: "disk",
    totalMemMB: 3921,
    diskFreeMB: 1800,
    diskUsedPct: 97.4,
    inodeUsedPct: 41,
    capacityBinding: "disk",
  };
}

test("NucleusFleetStore: sensed capacity rides a THIRD sibling table and joins back on list", async () => {
  const { db, tables } = fakeDb();
  const store = new NucleusFleetStore(db);
  await store.heartbeat(sensed("w1"));
  assert.deepEqual(
    [...tables.keys()].sort(),
    ["ship_fleet", "ship_fleet_capacity", "ship_fleet_load"],
    "capacity did NOT try to widen ship_fleet_load, which is populated on deployed boxes",
  );
  const [w] = await store.list();
  assert.equal(w?.maxConcurrent, 1, "the derived ceiling is the one on the wire");
  assert.equal(w?.held, "disk", "the new hold variant survives the round trip");
  assert.equal(w?.capacityBinding, "disk");
  assert.equal(w?.diskFreeMB, 1800);
  assert.equal(w?.diskUsedPct, 97.4, "a fraction survives TEXT storage");
  assert.equal(w?.inodeUsedPct, 41);
  assert.equal(w?.totalMemMB, 3921);

  await store.heartbeat({ ...sensed("w1"), diskFreeMB: 40_000, capacityBinding: "cpu", maxConcurrent: 4 });
  const again = await store.list();
  assert.equal(again.length, 1, "second beat updates the sibling row, it does not duplicate it");
  assert.equal(again[0]?.diskFreeMB, 40_000);
  assert.equal(again[0]?.capacityBinding, "cpu");
});

test("NucleusFleetStore: the capacity table is additive — a failure there leaves liveness fresh", async () => {
  let broken = true;
  const { db } = fakeDb((sql) => broken && sql.includes("ship_fleet_capacity"));
  const store = new NucleusFleetStore(db);
  await assert.rejects(() => store.heartbeat(sensed("w1")), /nucleus rejected/, "the error is surfaced, not swallowed");

  const [w] = await store.list();
  assert.equal(w?.owner, "w1", "the base row was written FIRST, so the worker is still alive on the page");
  assert.equal(w?.lastSeen, "2026-08-26T00:00:00Z");
  assert.equal(w?.held, "disk", "ship_fleet_load was written too — only the third table failed");
  assert.equal(w?.capacityBinding, undefined, "the page lists the worker, just without the sensed capacity");
  assert.equal(w?.diskFreeMB, undefined);

  // The failed ensure must not be cached: the next beat after Nucleus recovers writes it.
  broken = false;
  await store.heartbeat(sensed("w1"));
  assert.equal((await store.list())[0]?.capacityBinding, "disk");
});

test("NucleusFleetStore: prune drops the base row and both sibling rows together", async () => {
  const { db, tables } = fakeDb();
  const store = new NucleusFleetStore(db);
  await store.heartbeat(sensed("old"));
  await store.heartbeat({ ...sensed("new"), lastSeen: "2026-08-26T12:00:00Z" });
  assert.equal(await store.prune(new Date("2026-08-26T06:00:00Z")), 1);
  assert.deepEqual((await store.list()).map((w) => w.owner), ["new"]);
  assert.deepEqual(tables.get("ship_fleet_capacity")!.rows.map((r) => r.owner), ["new"], "no orphaned capacity row");
  assert.deepEqual(tables.get("ship_fleet_load")!.rows.map((r) => r.owner), ["new"]);
});
