import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileTaskRequirements,
  MemoryTaskRequirements,
  NucleusTaskRequirements,
  RequirementConflictError,
  TASK_REQUIREMENT_COLUMNS,
  TASK_REQUIREMENT_STATEMENT_LIMIT,
} from "./task-requirements.js";
import type { TaskRequirementStore } from "./task-requirements.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/** A just-enough Nucleus: primary key enforcement, SELECT by key / by task, conditional UPDATE with a row count. */
function fakeDb(opts: { racingInsert?: () => void } = {}): NucleusPgwire & { sql: string[]; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const sql: string[] = [];
  let raced = false;
  const db = {
    sql,
    rows,
    async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (/^CREATE TABLE/i.test(text)) return [];
      if (/^INSERT INTO ship_task_requirements/i.test(text)) {
        // Simulate another writer landing between our read and our insert.
        if (opts.racingInsert !== undefined && !raced) {
          raced = true;
          opts.racingInsert();
        }
        const key = String(params[0]);
        if (rows.has(key)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
        const names = ["req_key", "task_root_run_id", "requirement_id", "statement", "source", "source_run_id", "state", "created_at", "created_by", "waived_at", "waived_by", "waived_reason"];
        rows.set(key, Object.fromEntries(names.map((n, i) => [n, params[i]])));
        return [];
      }
      if (/WHERE req_key = \$1/i.test(text)) {
        const row = rows.get(String(params[0]));
        return row === undefined ? [] : [row];
      }
      if (/WHERE task_root_run_id = \$1/i.test(text)) {
        return [...rows.values()].filter((r) => r.task_root_run_id === params[0]);
      }
      return [];
    },
    async exec(text: string, params: unknown[] = []): Promise<number> {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (/^UPDATE ship_task_requirements/i.test(text)) {
        const row = rows.get(String(params[4]));
        if (row === undefined || row.state !== params[5]) return 0;
        Object.assign(row, { state: params[0], waived_at: params[1], waived_by: params[2], waived_reason: params[3] });
        return 1;
      }
      return 0;
    },
  };
  return db as unknown as NucleusPgwire & { sql: string[]; rows: Map<string, Record<string, unknown>> };
}

async function stores(): Promise<Array<{ name: string; store: TaskRequirementStore }>> {
  const dir = await mkdtemp(join(tmpdir(), "ship-task-req-"));
  return [
    { name: "memory", store: new MemoryTaskRequirements() },
    { name: "file", store: new FileTaskRequirements(dir) },
    { name: "nucleus", store: new NucleusTaskRequirements(fakeDb()) },
  ];
}

const base = { taskRootRunId: "run-1", requirementId: "r1", statement: "Search matches name and email", source: "request" as const, sourceRunId: "run-1", createdBy: "user-1" };

test("S03: adding is idempotent for identical content, so a retried add does not duplicate", async () => {
  for (const { name, store } of await stores()) {
    const first = await store.add(base);
    const again = await store.add(base);
    assert.equal(first.created, true, name);
    assert.equal(again.created, false, name);
    assert.equal((await store.list("run-1")).length, 1, name);
  }
});

test("S03: a different statement under an existing id is refused, never silently replaced", async () => {
  for (const { name, store } of await stores()) {
    await store.add(base);
    await assert.rejects(() => store.add({ ...base, statement: "Something else entirely" }), RequirementConflictError, name);
    assert.equal((await store.list("run-1"))[0]!.statement, "Search matches name and email", name);
  }
});

test("S03: a concurrent writer that wins the key is judged by what it wrote", async () => {
  const db = fakeDb({
    racingInsert: () => {
      db.rows.set("run-1/r1", {
        req_key: "run-1/r1", task_root_run_id: "run-1", requirement_id: "r1", statement: "A rival statement", source: "request",
        source_run_id: "run-1", state: "active", created_at: "2026-10-03T00:00:00.000Z", created_by: "x", waived_at: "", waived_by: "", waived_reason: "",
      });
    },
  });
  const store = new NucleusTaskRequirements(db);
  await assert.rejects(() => store.add(base), RequirementConflictError, "the rival's different content is a conflict");

  const same = fakeDb({
    racingInsert: () => {
      same.rows.set("run-1/r1", {
        req_key: "run-1/r1", task_root_run_id: "run-1", requirement_id: "r1", statement: base.statement, source: "request",
        source_run_id: "run-1", state: "active", created_at: "2026-10-03T00:00:00.000Z", created_by: "x", waived_at: "", waived_by: "", waived_reason: "",
      });
    },
  });
  const outcome = await new NucleusTaskRequirements(same).add(base);
  assert.equal(outcome.created, false, "identical content from the rival is the same requirement");
});

test("S03: a waiver needs an actor and a reason, and is recorded exactly once", async () => {
  for (const { name, store } of await stores()) {
    await store.add(base);
    await assert.rejects(() => store.waive("run-1", "r1", "", "because"), /actor/, name);
    await assert.rejects(() => store.waive("run-1", "r1", "user-2", "  "), /reason/, name);
    assert.equal((await store.list("run-1"))[0]!.state, "active", `${name}: a refused waiver changes nothing`);

    const first = await store.waive("run-1", "r1", "user-2", "out of scope for this release", new Date("2026-10-03T12:00:00Z"));
    assert.ok(first.ok, name);
    const second = await store.waive("run-1", "r1", "user-3", "again");
    assert.deepEqual(second, { ok: false, failure: "already-waived" }, name);

    const [row] = await store.list("run-1");
    assert.equal(row!.state, "waived", name);
    assert.equal(row!.waivedBy, "user-2", `${name}: the first waiver stands`);
    assert.equal(row!.waivedReason, "out of scope for this release", name);
    assert.equal(row!.statement, base.statement, `${name}: a waived requirement is kept, not deleted`);
    assert.deepEqual(await store.waive("run-1", "nope", "u", "r"), { ok: false, failure: "unknown" }, name);
  }
});

test("S03: requirements are per task and listed oldest first", async () => {
  for (const { name, store } of await stores()) {
    await store.add({ ...base, requirementId: "b", now: new Date("2026-10-03T10:00:00Z") });
    await store.add({ ...base, requirementId: "a", now: new Date("2026-10-03T09:00:00Z") });
    await store.add({ ...base, taskRootRunId: "run-2", requirementId: "z" });
    assert.deepEqual((await store.list("run-1")).map((r) => r.requirementId), ["a", "b"], name);
    assert.deepEqual((await store.list("run-2")).map((r) => r.requirementId), ["z"], name);
    assert.deepEqual(await store.list("run-3"), [], name);
  }
});

test("S03: empty, oversized and unaddressed requirements are refused", async () => {
  const store = new MemoryTaskRequirements();
  await assert.rejects(() => store.add({ ...base, statement: "   " }), /statement/);
  await assert.rejects(() => store.add({ ...base, statement: "x".repeat(TASK_REQUIREMENT_STATEMENT_LIMIT + 1) }), /at most/);
  await assert.rejects(() => store.add({ ...base, requirementId: " " }), /task and an id/);
});

test("S03: the Nucleus store creates its own new table and never alters an existing one", async () => {
  const db = fakeDb();
  const store = new NucleusTaskRequirements(db);
  await store.add(base);
  assert.ok(db.sql.some((s) => /^CREATE TABLE IF NOT EXISTS ship_task_requirements/.test(s)));
  assert.ok(!db.sql.some((s) => /ALTER TABLE|DROP TABLE/i.test(s)), "additive only");
  const ddl = db.sql.find((s) => s.startsWith("CREATE TABLE"))!;
  for (const column of TASK_REQUIREMENT_COLUMNS) assert.ok(ddl.includes(column), `DDL lacks ${column}`);
});
