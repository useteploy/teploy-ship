import assert from "node:assert/strict";
import test from "node:test";

import { DOC_FIELDS } from "./nucleus-pgwire.js";
import { MIGRATIONS, migrate } from "./migrations.js";
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

/** A NucleusPgwire stand-in that records SQL and fakes the KV lock. */
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
      // A probe: succeed only when the table exists and has the columns asked for.
      if (table !== undefined && !tables.has(table)) throw new Error(`relation "${table}" does not exist`);
      const asked = /^SELECT (.+?) FROM/i.exec(text)?.[1] ?? "";
      if (asked !== "1" && table !== undefined) {
        const have = columns[table] ?? [];
        for (const c of asked.split(",").map((s) => s.trim())) {
          if (c !== "*" && !have.includes(c)) throw new Error(`column "${c}" does not exist`);
        }
      }
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

test("001 rebuilds ship_docs aside when the source column is missing", async () => {
  const db = fakeDb({
    existingTables: new Set(["ship_docs"]),
    columns: { ship_docs: ["collection", "run_id", "workflow", "status", "wake_at", "event_name", "task", "model", "workspace", "created_at", "updated_at"] },
  });
  const applied = await migrate(db);
  assert.deepEqual(applied, ["001-ship-docs-source-ranon"]);
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
    columns: { ship_docs: ["source", "ran_on"] },
  });
  assert.deepEqual(await migrate(current), []);
  assert.doesNotMatch(current.sql.join("\n"), /RENAME TO/);
});

test("migrate runs each migration at most once", async () => {
  const db = fakeDb({
    existingTables: new Set(["ship_docs"]),
    columns: { ship_docs: ["collection"] },
  });
  assert.deepEqual(await migrate(db), ["001-ship-docs-source-ranon"]);
  assert.deepEqual(await migrate(db), [], "second call must be a no-op");
});

test("a process that loses the migration lock proceeds instead of racing", async () => {
  const db = fakeDb({ existingTables: new Set(["ship_docs"]), columns: { ship_docs: ["collection"] } });
  // Hold the lock, so the migrate() call below is the loser.
  await db.kv.setNX("ship:migrate", "someone-else");
  assert.deepEqual(await migrate(db), []);
  assert.doesNotMatch(db.sql.join("\n"), /RENAME TO/);
});
