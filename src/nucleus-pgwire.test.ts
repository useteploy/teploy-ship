import assert from "node:assert/strict";
import { test } from "node:test";

import { NucleusPgwire, isTransientPoolFailure, type PoolLike, type SoloClientLike } from "./nucleus-pgwire.js";
import { MIGRATIONS } from "./migrations.js";
import { nucleusRuntime } from "./runtime.js";

const MASKED = new TypeError("Cannot read properties of undefined (reading 'name')");

/**
 * A pool that can be told to reject, plus the solo connection the retry path
 * opens. The distinction is the whole point of the fixture: `pool.connect()`
 * hands back a POOLED client — very often the one that just failed — which is
 * why the retry has to go somewhere else entirely.
 */
function fakePool(plan: { poolRejections: unknown[]; soloFails?: boolean; clientFails?: boolean }) {
  const log: string[] = [];
  let released: boolean | undefined;
  let soloEnded = 0;
  const pool: PoolLike = {
    async query(sql) {
      log.push(`pool:${sql}`);
      if (plan.poolRejections.length > 0) throw plan.poolRejections.shift();
      return { rows: [{ v: "pooled" }], rowCount: 1 };
    },
    async connect() {
      log.push("pool-connect");
      return {
        async query(sql) {
          log.push(`pool-client:${sql}`);
          if (plan.clientFails) throw MASKED;
          return { rows: [{ v: "checked-out" }], rowCount: 1 };
        },
        release(destroy?: boolean) {
          released = destroy === true;
        },
      };
    },
    on() {
      return undefined;
    },
    async end() {},
  };
  const solo = (): SoloClientLike => ({
    async connect() {
      log.push("solo-connect");
      return undefined;
    },
    async query(sql) {
      log.push(`solo:${sql}`);
      if (plan.soloFails) throw MASKED;
      return { rows: [{ v: "solo" }], rowCount: 1 };
    },
    async end() {
      soloEnded += 1;
      log.push("solo-end");
    },
  });
  return { pool, solo, log, destroyed: () => released, soloEnded: () => soloEnded };
}

test("a masked pool rejection is retried on a connection of its own, never back into the pool", async () => {
  const { pool, solo, log } = fakePool({ poolRejections: [MASKED] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  assert.deepEqual(await db.query("SELECT 1"), [{ v: "solo" }]);
  // No `pool-connect`: the measured failure survives a checkout from the same
  // pool, so retrying there is retrying the thing that failed.
  assert.deepEqual(log, ["pool:SELECT 1", "solo-connect", "solo:SELECT 1", "solo-end"]);
});

test("the throwaway connection is closed whether the retry succeeds or fails", async () => {
  const ok = fakePool({ poolRejections: [MASKED] });
  await new NucleusPgwire("postgres://x", "test", { pool: ok.pool, solo: ok.solo }).query("SELECT 1");
  assert.equal(ok.soloEnded(), 1);

  const bad = fakePool({ poolRejections: [MASKED], soloFails: true });
  await assert.rejects(new NucleusPgwire("postgres://x", "test", { pool: bad.pool, solo: bad.solo }).query("SELECT 1"), /reading 'name'/);
  assert.equal(bad.soloEnded(), 1, "a leaked connection per failure would be worse than the failure");
});

test("a rejection with no error object at all is also retried", async () => {
  const { pool, solo } = fakePool({ poolRejections: [undefined] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  assert.equal(await db.exec("UPDATE t SET c = c WHERE 1=0"), 1);
});

test("with no way to open a connection of its own, the retry still falls back to a checkout", async () => {
  const { pool, log, destroyed } = fakePool({ poolRejections: [undefined], clientFails: true });
  // An injected pool with no solo seam — the shape a test or an embedder uses.
  const db = new NucleusPgwire("", "test", { pool });
  await assert.rejects(db.query("SELECT 1"), /reading 'name'/);
  assert.deepEqual(log, ["pool:SELECT 1", "pool-connect", "pool-client:SELECT 1"]);
  assert.equal(destroyed(), true, "release(true) so the poisoned connection is not handed back out");
});

test("a genuine database error is not retried", async () => {
  const dbError = Object.assign(new Error("syntax error at or near \"SELEC\""), { code: "42601" });
  const { pool, solo, log } = fakePool({ poolRejections: [dbError] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  await assert.rejects(db.query("SELEC 1"), /syntax error/);
  assert.deepEqual(log, ["pool:SELEC 1"], "no second attempt of any kind");
});

test("isTransientPoolFailure: the shapes seen live are transient; SQLSTATE errors are not", () => {
  assert.equal(isTransientPoolFailure(MASKED), true);
  assert.equal(isTransientPoolFailure(undefined), true);
  assert.equal(isTransientPoolFailure(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isTransientPoolFailure(new Error("Connection terminated unexpectedly")), true);
  assert.equal(isTransientPoolFailure(Object.assign(new Error("dup"), { code: "23505" })), false);
  assert.equal(isTransientPoolFailure(new Error("some application error")), false);
});

/**
 * A pool that only records the statements it is asked to run and hands back a
 * caller-supplied answer. Everything below is about the SQL that leaves this
 * process — the rows are incidental.
 */
function recordingPool(answer: (sql: string, params: unknown[]) => unknown[] = () => []) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool: PoolLike = {
    async query(sql, params = []) {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      const rows = answer(sql, params);
      return { rows, rowCount: rows.length };
    },
    async connect() {
      throw new Error("the recording pool never fails, so nothing should check out a client");
    },
    on() {
      return undefined;
    },
    async end() {},
  };
  // The DDL from #ensureDocs is noise in every assertion below.
  const statements = (): string[] => seen.filter((s) => !/^CREATE TABLE/i.test(s.sql)).map((s) => s.sql);
  const calls = (): Array<{ sql: string; params: unknown[] }> =>
    seen.filter((s) => !/^CREATE TABLE/i.test(s.sql));
  return { pool, statements, calls };
}

/**
 * The guarantee `RunIndex.due` depends on. The scheduler asks this primitive
 * for every sleeping, retrying and woken run three times a tick, and acts only
 * on what comes back — so a row this drops is a run that never launches. A
 * default limit here would have cost exactly the fifteen stranded minutes the
 * bounded-read work was prompted by.
 */
test("find without options emits the statement it always did — no ORDER BY, no LIMIT", async () => {
  const { pool, calls } = recordingPool();
  const db = new NucleusPgwire("", "due", { pool });
  await db.document.find("ship_runs", { status: "sleeping" });
  assert.deepEqual(calls(), [
    { sql: "SELECT * FROM ship_docs WHERE collection = $1 AND status = $2", params: ["ship_runs", "sleeping"] },
  ]);
});

test("find ranks on the joined stamp when asked to, not on the collection's own", async () => {
  const { pool, calls } = recordingPool();
  const db = new NucleusPgwire("", "list", { pool });
  await db.document.find("ship_meta", {}, { newest: { limit: 200, freshenedBy: "ship_runs" } });
  const [only] = calls();
  // Ranking on ship_docs.updated_at alone is a different question with a
  // different answer: measured against a live Nucleus v0.1.8, over 400 metas
  // whose run records carried independent stamps, the naive rank got 45 of 50
  // rows wrong. The subselect is what makes the cut safe.
  assert.match(only!.sql, /ORDER BY GREATEST\(ship_docs\.updated_at, COALESCE\(\(SELECT MAX\(r\.updated_at\)/);
  assert.match(only!.sql, /r\.collection = \$2 AND r\.run_id = ship_docs\.run_id\), ship_docs\.updated_at\)\) DESC LIMIT 200$/);
  assert.deepEqual(only!.params, ["ship_meta", "ship_runs"], "the joined collection travels as a parameter");
});

test("find without freshenedBy ranks on the collection's own stamp", async () => {
  const { pool, calls } = recordingPool();
  const db = new NucleusPgwire("", "list", { pool });
  await db.document.find("ship_meta", {}, { newest: { limit: 5 } });
  assert.deepEqual(calls(), [
    { sql: "SELECT * FROM ship_docs WHERE collection = $1 ORDER BY ship_docs.updated_at DESC LIMIT 5", params: ["ship_meta"] },
  ]);
});

test("runIds becomes an IN list numbered after the filter's own parameters", async () => {
  const { pool, calls } = recordingPool();
  const db = new NucleusPgwire("", "list", { pool });
  await db.document.find("ship_runs", { workflow: "durable" }, { runIds: ["r1", "r2", "r3"] });
  assert.deepEqual(calls(), [
    {
      sql: "SELECT * FROM ship_docs WHERE collection = $1 AND workflow = $2 AND run_id IN ($3, $4, $5)",
      params: ["ship_runs", "durable", "r1", "r2", "r3"],
    },
  ]);
});

test("an empty runIds list answers without a round trip", async () => {
  const { pool, calls } = recordingPool();
  const db = new NucleusPgwire("", "list", { pool });
  // `IN ()` is not SQL, and "one of nothing" needs no engine to answer.
  assert.deepEqual(await db.document.find("ship_runs", {}, { runIds: [] }), []);
  assert.deepEqual(calls(), []);
});

test("a bounded find still maps rows through the column map", async () => {
  const { pool } = recordingPool(() => [
    { collection: "ship_meta", run_id: "r1", updated_at: "2026-08-30T00:00:00.000Z", workflow: "durable", status: null },
  ]);
  const db = new NucleusPgwire("", "list", { pool });
  assert.deepEqual(await db.document.find("ship_meta", {}, { newest: { limit: 1, freshenedBy: "ship_runs" } }), [
    { runId: "r1", workflow: "durable", updatedAt: "2026-08-30T00:00:00.000Z" },
  ]);
});

/**
 * listMeta, through the real runtime, against a pool that models the parts of
 * Nucleus the bounded reads rely on.
 *
 * The modelling is deliberate and, per this repo's own rule about fakes, it is
 * a CLAIM that was checked rather than an assumption: the ranking below —
 * `GREATEST(meta stamp, MAX(run stamp for the same runId))`, cut by LIMIT —
 * was run against a live Nucleus v0.1.8 on 2026-08-30 over six trials at
 * 500–1500 documents (a third of them with no run record at all, plus orphan
 * run records with no meta doc) and returned the exact set the JavaScript
 * implementation computes, every time. The naive alternative — ranking on the
 * meta stamp alone — got 45 of 50 rows wrong on the same data, which is the
 * whole reason the subselect is there.
 */
function shipDocsPool(rows: { metas: Record<string, unknown>[]; runs: Record<string, unknown>[] }) {
  const seen: string[] = [];
  const effective = (meta: Record<string, unknown>): string => {
    const own = String(meta.updated_at ?? "");
    const stamps = rows.runs.filter((r) => r.run_id === meta.run_id).map((r) => String(r.updated_at ?? ""));
    const newest = stamps.length === 0 ? own : stamps.reduce((a, b) => (a > b ? a : b));
    return newest > own ? newest : own;
  };
  const pool: PoolLike = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      seen.push(text);
      if (/^CREATE TABLE/i.test(text)) return { rows: [], rowCount: 0 };
      // Nothing pending, so migrate() is a no-op and never touches the table.
      if (/^SELECT id FROM ship_migrations/i.test(text)) {
        return { rows: MIGRATIONS.map((m) => ({ id: m.id })), rowCount: MIGRATIONS.length };
      }
      const collection = params[0];
      if (collection === "ship_meta") {
        const limit = Number(/LIMIT (\d+)$/.exec(text)?.[1] ?? Number.MAX_SAFE_INTEGER);
        const ranked = [...rows.metas].sort((a, b) => (effective(a) < effective(b) ? 1 : -1)).slice(0, limit);
        return { rows: ranked, rowCount: ranked.length };
      }
      const wanted = new Set(params.slice(1).map(String));
      const matched = /IN \(/.test(text)
        ? rows.runs.filter((r) => wanted.has(String(r.run_id)))
        : rows.runs;
      return { rows: matched, rowCount: matched.length };
    },
    async connect() {
      throw new Error("unreachable: the modelled pool never rejects");
    },
    on() {
      return undefined;
    },
    async end() {},
  };
  return { pool, seen };
}

const AT = (hhmm: string): string => `2026-08-30T${hhmm}:00.000Z`;

/** Six runs whose meta stamps and index stamps disagree, on purpose. */
const LIST_META_ROWS = {
  metas: [1, 2, 3, 4, 5, 6].map((n) => ({
    collection: "ship_meta",
    run_id: `m${n}`,
    task: `task ${n}`,
    status: "completed",
    model: "glm-5.3",
    created_at: AT(`00:0${n}`),
    updated_at: AT(`00:0${n}`),
  })),
  runs: [
    // m1 and m2 were last touched by the WORKER, hours after their meta rows
    // were last written. Their index stamps are the ones that matter.
    { collection: "ship_runs", run_id: "m1", status: "waiting", event_name: "approval", updated_at: AT("09:00") },
    { collection: "ship_runs", run_id: "m2", status: "sleeping", updated_at: AT("08:00") },
    // m4's index row is OLDER than its meta row: it overlays status, not order.
    { collection: "ship_runs", run_id: "m4", status: "failed", updated_at: AT("00:00") },
  ],
};

test("listMeta bounds both reads without changing the page it returns", async () => {
  const { pool, seen } = shipDocsPool(LIST_META_ROWS);
  const runtime = await nucleusRuntime("", "test", { db: new NucleusPgwire("", "test", { pool }), log: () => {} });

  // Effective recency is m1 (09:00), m2 (08:00), then m6/m5/m4/m3 by their own
  // stamps. A limit of three must therefore land on m1, m2, m6 — and NOT on
  // m6/m5/m4, which is what ordering the meta collection by its own column
  // would have produced.
  const page = await runtime.listMeta({ limit: 3 });
  assert.deepEqual(page.map((m) => m.runId), ["m1", "m2", "m6"]);
  assert.equal(page[0]!.status, "waiting", "the index is status-authoritative");
  assert.equal(page[0]!.eventName, "approval");
  assert.equal(page[0]!.updatedAt, AT("09:00"), "and it carries the newer stamp forward");
  assert.equal(page[1]!.status, "sleeping");
  assert.equal(page[2]!.status, "completed", "m6 has no index row, so its own meta stands");

  const reads = seen.filter((s) => /FROM ship_docs/.test(s));
  assert.equal(reads.length, 2, "one read per collection, as before");
  assert.match(reads[0]!, /ORDER BY GREATEST\(ship_docs\.updated_at, COALESCE\(\(SELECT MAX\(r\.updated_at\)/);
  assert.match(reads[0]!, /LIMIT 3$/);
  // The second read is the one that used to drag every run record Ship had ever
  // written back across the wire so that three of them could be looked up.
  assert.match(reads[1]!, /run_id IN \(\$2, \$3, \$4\)$/);
});

test("listMeta overlays exactly what the unbounded implementation overlaid", async () => {
  const { pool } = shipDocsPool(LIST_META_ROWS);
  const runtime = await nucleusRuntime("", "test", { db: new NucleusPgwire("", "test", { pool }), log: () => {} });

  // An independent oracle: the pre-bound algorithm, spelled out over the FULL
  // row set with no limit anywhere — read every meta, read every run record,
  // join in memory, overlay, sort, slice.
  const byRun = new Map(LIST_META_ROWS.runs.map((r) => [String(r.run_id), r]));
  const oracle = LIST_META_ROWS.metas
    .map((doc) => {
      const rec = byRun.get(String(doc.run_id));
      const meta: Record<string, unknown> = {
        runId: doc.run_id, task: doc.task, status: doc.status, model: doc.model,
        createdAt: doc.created_at, updatedAt: doc.updated_at,
      };
      if (rec === undefined) return meta;
      meta.status = rec.status;
      if (rec.status === "waiting" && typeof rec.event_name === "string") meta.eventName = rec.event_name;
      if (String(rec.updated_at) > String(doc.updated_at)) meta.updatedAt = rec.updated_at;
      return meta;
    })
    .sort((a, b) => ((a.updatedAt as string) < (b.updatedAt as string) ? 1 : -1));

  for (const limit of [1, 2, 3, 6, 200]) {
    assert.deepEqual(
      await runtime.listMeta({ limit }),
      oracle.slice(0, limit),
      `bounded and unbounded disagree at limit ${limit}`,
    );
  }
});
