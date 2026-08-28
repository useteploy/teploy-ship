import assert from "node:assert/strict";
import test from "node:test";

import { DOC_FIELDS } from "./nucleus-pgwire.js";
import { MIGRATIONS, hasColumns, migrate } from "./migrations.js";
import { RUN_META_FIELDS } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * The regression that motivated migration 001: RunMeta grew `source`, the
 * Nucleus column map did not, and column() throws on an unmapped key — so every
 * run launched from the dashboard or the intake sweep died on saveMeta.
 */
test("every RunMeta field is persistable by the Nucleus document store", () => {
  const missing = RUN_META_FIELDS.filter((f) => !DOC_FIELDS.includes(f));
  assert.deepEqual(
    missing,
    [],
    `RunMeta fields with no ship_docs column: ${missing.join(", ")} — add them to COLUMNS, the DDL, and a migration`,
  );
});

test("migration ids are unique and stably ordered", () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepEqual([...new Set(ids)], ids, "duplicate migration id");
  assert.deepEqual([...ids].sort(), ids, "migrations must be listed in id order");
});

/**
 * A NucleusPgwire stand-in that records SQL and fakes the KV lock.
 *
 * It deliberately reproduces Nucleus's REAL column semantics, which differ from
 * Postgres's and from what an earlier version of this fake asserted:
 *
 *   - an unknown TABLE raises in either shape;
 *   - an unknown COLUMN in a SELECT projection resolves to NULL, no error;
 *   - an unknown COLUMN in an UPDATE assignment DOES raise.
 *
 * The lenient-SELECT rule is the whole point. A fake that threw on a SELECT of a
 * missing column (as this one used to) makes a SELECT-based `hasColumns` look
 * correct, which is how three migrations that silently never ran shipped with a
 * green suite. Verified against a live Nucleus 2026-08-04.
 */
function fakeDb(options: { existingTables?: Set<string>; columns?: Record<string, string[]> } = {}) {
  const tables = options.existingTables ?? new Set<string>();
  const columns = options.columns ?? {};
  const sql: string[] = [];
  const ledger: string[] = [];
  let lock: string | null = null;
  const db = {
    sql,
    async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      sql.push(text.replace(/\s+/g, " ").trim());
      const table = /FROM\s+(\w+)/i.exec(text)?.[1] ?? /TABLE(?: IF NOT EXISTS)?\s+(\w+)/i.exec(text)?.[1];
      if (/^CREATE TABLE/i.test(text) && table !== undefined) {
        tables.add(table);
        return [];
      }
      if (/^ALTER TABLE (\w+) RENAME TO (\w+)/i.test(text)) {
        const [, from, to] = /^ALTER TABLE (\w+) RENAME TO (\w+)/i.exec(text)!;
        tables.delete(from!);
        tables.add(to!);
        columns[to!] = columns[from!] ?? [];
        return [];
      }
      if (/^INSERT INTO ship_migrations/i.test(text)) {
        ledger.push(String(params[0]));
        return [];
      }
      if (/^SELECT id FROM ship_migrations/i.test(text)) {
        return ledger.map((id) => ({ id }));
      }
      if (/^INSERT/i.test(text)) return [];

      // The write-shaped column probe: `UPDATE t SET c = c, d = d WHERE 1 = 0`.
      // Strict on column names — this is what makes hasColumns work.
      const update = /^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE/is.exec(text);
      if (update !== null) {
        const [, target, assignments] = update;
        if (!tables.has(target!)) throw new Error(`relation "${target}" does not exist`);
        const have = columns[target!] ?? [];
        for (const pair of assignments!.split(",")) {
          const name = pair.split("=")[0]!.trim();
          if (!have.includes(name)) throw new Error(`column "${name}" does not exist`);
        }
        return [];
      }

      // Reads: unknown TABLE raises, unknown COLUMN does not (Nucleus resolves
      // it to NULL). Deliberately lenient — see the note on fakeDb.
      if (table !== undefined && !tables.has(table)) throw new Error(`relation "${table}" does not exist`);
      return [];
    },
    kv: {
      setNX: async (key: string, value: string): Promise<boolean> => {
        if (lock !== null) return false;
        lock = value;
        void key;
        return true;
      },
      cdel: async (): Promise<boolean> => {
        lock = null;
        return true;
      },
    },
  };
  return db as unknown as NucleusPgwire & { sql: string[] };
}

/**
 * The bug that made migrations 001-003 no-op on the only deployment that needed
 * them: `hasColumns` probed with `SELECT <cols> FROM t LIMIT 1`, and Nucleus
 * answers a SELECT of a missing column with NULL instead of an error. Every
 * `needed()` returned false, migrate() wrote all three to the ledger, and the
 * schema stayed wrong — with a log line saying the migrations were applied.
 * Found by probing the live smoke instance, not by this suite.
 */
test("hasColumns probes with a write, because Nucleus reads unknown columns as NULL", async () => {
  const db = fakeDb({ existingTables: new Set(["t"]), columns: { t: ["a", "b"] } });

  assert.equal(await hasColumns(db, "t", ["a", "b"]), true, "present columns must report present");
  assert.equal(await hasColumns(db, "t", ["a", "gone"]), false, "a missing column must report absent");

  const joined = db.sql.join("\n");
  assert.match(joined, /UPDATE t SET a = a, gone = gone WHERE 1 = 0/, "probe must be write-shaped");
  assert.doesNotMatch(
    joined,
    /SELECT[^\n]*\bgone\b/,
    "a SELECT probe cannot detect a missing column on Nucleus — that is the bug",
  );
});

test("a missing column is still detected when SELECT is lenient end-to-end", async () => {
  // Exactly the smoke box's state on 2026-08-04: the table exists, the column
  // does not, and a SELECT of it would have succeeded.
  const db = fakeDb({ existingTables: new Set(["ship_memory"]), columns: { ship_memory: ["repo", "note", "run_id", "created_at"] } });
  assert.deepEqual(await migrate(db), ["003-ship-memory-note-id"]);
});

test("001 rebuilds ship_docs aside when the source column is missing", async () => {
  const db = fakeDb({
    existingTables: new Set(["ship_docs"]),
    columns: { ship_docs: ["collection", "run_id", "workflow", "status", "wake_at", "event_name", "task", "model", "workspace", "created_at", "updated_at"] },
  });
  const applied = await migrate(db);
  assert.deepEqual(applied, ["001-ship-docs-source-ranon", "004-ship-docs-actor"]);
  const joined = db.sql.join("\n");
  assert.match(joined, /ALTER TABLE ship_docs RENAME TO ship_docs_001/);
  assert.match(joined, /CREATE TABLE ship_docs \(.*source TEXT.*ran_on TEXT/s);
  assert.match(joined, /INSERT INTO ship_docs \(.*\) SELECT .* FROM ship_docs_001/);
  // Non-destructive: the old rows are renamed aside, never dropped or truncated.
  assert.doesNotMatch(joined, /DROP TABLE|TRUNCATE/i);
});

test("001 is a no-op on a fresh install and on an already-migrated store", async () => {
  const fresh = fakeDb(); // no ship_docs yet — the store DDL already has the columns
  assert.deepEqual(await migrate(fresh), []);
  assert.doesNotMatch(fresh.sql.join("\n"), /RENAME TO/);

  const current = fakeDb({
    existingTables: new Set(["ship_docs"]),
    // "Already migrated" means through the LATEST migration touching this
    // table, not through 001 — a store carrying source/ran_on but not
    // actor/actor_kind is mid-chain and 004 is correctly still pending.
    columns: { ship_docs: ["source", "ran_on", "actor", "actor_kind"] },
  });
  assert.deepEqual(await migrate(current), []);
  assert.doesNotMatch(current.sql.join("\n"), /RENAME TO/);
});

test("migrate runs each migration at most once", async () => {
  const db = fakeDb({
    existingTables: new Set(["ship_docs"]),
    columns: { ship_docs: ["collection"] },
  });
  assert.deepEqual(await migrate(db), ["001-ship-docs-source-ranon", "004-ship-docs-actor"]);
  assert.deepEqual(await migrate(db), [], "second call must be a no-op");
});

test("a process that loses the migration lock proceeds instead of racing", async () => {
  const db = fakeDb({ existingTables: new Set(["ship_docs"]), columns: { ship_docs: ["collection"] } });
  // Hold the lock, so the migrate() call below is the loser.
  await db.kv.setNX("ship:migrate", "someone-else");
  assert.deepEqual(await migrate(db), []);
  assert.doesNotMatch(db.sql.join("\n"), /RENAME TO/);
});

/**
 * Columns of the LAST `CREATE TABLE <table>` in a source file.
 *
 * Last, not first, and that distinction is the whole point once a table has
 * more than one migration. Migration 001 creates ship_docs in its 2026-era
 * shape and 004 rebuilds it with `actor`; only 004's shape may be compared to
 * today's DDL. An earlier migration is a historical snapshot — editing it to
 * match the current DDL would make the chain skip columns for a deployment
 * sitting between the two, which is the failure this whole test exists to stop.
 */
function columnsOf(source: string, table: string): string[] | null {
  const re = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([^)]*)\\)`, "gs");
  const bodies = [...source.matchAll(re)].map((m) => m[1]);
  const body = bodies.at(-1);
  if (body === undefined) return null;
  return body
    .split(",")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name !== "")
    .sort();
}

/**
 * The guard for the mistake that produced migrations 002 and 003: a column was
 * added to a store's CREATE TABLE and nowhere else. A FRESH install picks it up
 * (the DDL has it) and an EXISTING one does not, because CREATE TABLE IF NOT
 * EXISTS is a no-op on a table that is already there — so the change works
 * perfectly in development and breaks on every real deployment.
 *
 * A migration's new-table shape must therefore match the store's DDL exactly.
 * Add a column to one and this fails until you add it to the other.
 */
test("each migrated table's shape matches the store DDL that creates it fresh", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = async (relative: string): Promise<string> =>
    readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");
  const migrationSource = await read("migrations.ts");

  const owners: Array<{ table: string; file: string }> = [
    { table: "ship_docs", file: "nucleus-pgwire.ts" },
    { table: "ship_steer", file: "steer.ts" },
    { table: "ship_memory", file: "repo-memory.ts" },
    { table: "ship_runtime_config", file: "runtime-config.ts" },
    { table: "ship_connect_requests", file: "connect-requests.ts" },
  ];

  for (const { table, file } of owners) {
    const fromStore = columnsOf(await read(file), table);
    const fromMigration = columnsOf(migrationSource, table);
    assert.notEqual(fromStore, null, `${file} should create ${table}`);
    assert.notEqual(fromMigration, null, `${table} should have a migration rebuilding it`);
    assert.deepEqual(
      fromMigration,
      fromStore,
      `${table}: the migration and the store DDL disagree. A column added to one and not the other ` +
        `works on a fresh install and breaks every existing deployment.`,
    );
  }
});

test("migrations 002 and 003 rebuild aside and copy, never dropping data", async () => {
  const db = fakeDb({
    existingTables: new Set(["ship_steer", "ship_memory"]),
    columns: {
      ship_steer: ["note_id", "run_id", "text", "created_at", "consumed"],
      ship_memory: ["repo", "note", "run_id", "created_at"],
    },
  });
  const applied = await migrate(db);
  assert.deepEqual(applied, ["002-ship-steer-consumed-turn", "003-ship-memory-note-id"]);

  const joined = db.sql.join("\n");
  assert.match(joined, /ALTER TABLE ship_steer RENAME TO ship_steer_002/);
  assert.match(joined, /ALTER TABLE ship_memory RENAME TO ship_memory_003/);
  assert.match(joined, /INSERT INTO ship_steer \(.*\) SELECT .* FROM ship_steer_002/);
  assert.match(joined, /INSERT INTO ship_memory \(.*\) SELECT .* FROM ship_memory_003/);
  assert.doesNotMatch(joined, /DROP TABLE|TRUNCATE/i);
});

/**
 * 006's probe, specifically. The generic hasColumns test above proves the probe
 * shape; this proves that ship_runtime_config actually goes through it, because
 * the failure mode is silent: a SELECT-shaped probe on this table would report
 * every column present forever, migrate() would record 006 as applied, and a
 * later column would be read back as NULL — which for AKIROO_PULL_TOKEN reads
 * as "the connector is not configured" rather than as a schema fault.
 */
test("006 probes ship_runtime_config write-shaped, and is a no-op on a fresh install", async () => {
  const fresh = fakeDb();
  assert.deepEqual(await migrate(fresh), [], "the store DDL creates the table; there is nothing to migrate");

  const stale = fakeDb({
    existingTables: new Set(["ship_runtime_config"]),
    columns: { ship_runtime_config: ["config_key", "config_value"] },
  });
  assert.deepEqual(await migrate(stale), ["006-ship-runtime-config"]);

  const joined = stale.sql.join("\n");
  assert.match(
    joined,
    /UPDATE ship_runtime_config SET config_key = config_key, config_value = config_value, updated_at = updated_at, updated_by = updated_by WHERE 1 = 0/,
    "the shape probe must be an UPDATE",
  );
  assert.doesNotMatch(
    joined,
    /SELECT[^\n]*\bupdated_by\b/,
    "a SELECT probe cannot see a missing column on Nucleus — that is the bug this rule exists for",
  );
  assert.match(joined, /ALTER TABLE ship_runtime_config RENAME TO ship_runtime_config_006/);
  assert.doesNotMatch(joined, /DROP TABLE|TRUNCATE/i);
});

/**
 * 007's probe, the same way and for a sharper reason. ship_connect_requests
 * holds the local record that makes "this Ship started that connect" a
 * checkable fact, so a column silently missing from it is not a display fault:
 * `verifier` read back as NULL is a connect that posts an empty secret and
 * reports Akiroo's refusal as the operator's mistake, and `used_at` read back
 * as NULL is a handshake with no single-use left in it.
 *
 * A SELECT-shaped probe here would report every column present forever, record
 * 007 as applied, and leave exactly that.
 */
test("007 probes ship_connect_requests write-shaped, and is a no-op on a fresh install", async () => {
  const fresh = fakeDb();
  assert.deepEqual(await migrate(fresh), [], "the store DDL creates the table; there is nothing to migrate");

  const stale = fakeDb({
    existingTables: new Set(["ship_connect_requests"]),
    // A table from before the verifier was stored — the shape that makes the
    // lenient read dangerous rather than merely wrong.
    columns: { ship_connect_requests: ["request_id", "akiroo_url", "expires_at", "used_at"] },
  });
  assert.deepEqual(await migrate(stale), ["007-ship-connect-requests"]);

  const joined = stale.sql.join("\n");
  assert.match(
    joined,
    /UPDATE ship_connect_requests SET request_id = request_id, verifier = verifier, akiroo_url = akiroo_url, expires_at = expires_at, used_at = used_at WHERE 1 = 0/,
    "the shape probe must be an UPDATE",
  );
  assert.doesNotMatch(
    joined,
    /SELECT[^\n]*\bverifier\b/,
    "a SELECT probe cannot see a missing column on Nucleus — that is the bug this rule exists for",
  );
  assert.match(joined, /ALTER TABLE ship_connect_requests RENAME TO ship_connect_requests_007/);
  // Nothing is copied across, and nothing is destroyed either: a row here is a
  // handshake in flight for at most ten minutes, and the recovery for losing
  // one is to start the connect again.
  assert.doesNotMatch(joined, /DROP TABLE|TRUNCATE/i);
  assert.doesNotMatch(joined, /INSERT INTO ship_connect_requests/);
});
