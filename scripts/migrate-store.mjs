#!/usr/bin/env node
// migrate-store.mjs — one-shot copy of teploy-ship's shared store from a
// Nucleus engine to a PostgreSQL engine. Both speak the Postgres wire
// protocol, so this is table-at-a-time SELECT -> INSERT over two clients.
//
// WHAT IT COPIES
//   - Every public base table it finds on the source, minus exclusions
//     (engine internals and the derived code-index cache), including the
//     ship_migrations ledger (duplicate ledger rows on the target are
//     harmless: the app reads it into a Set).
//   - Per-run event streams (ship:{runId}) via STREAM_XRANGE, replayed in
//     order into the SQL stream table (ship_stream) the postgres dialect
//     uses. KV locks/claims are NOT copied: every key is TTL-transient
//     (locks, done-claims, launch counters) and starts empty by design.
//
// WHAT IT SKIPS (and why)
//   - Tables starting with "_"        (engine internals, e.g. _neutron_migrations)
//   - ship_code_files/_chunks/_repos  (embedding cache; re-indexes lazily)
//
// SAFETY
//   - Target tables are created IF NOT EXISTS from the source's own column
//     metadata; PKs are carried over. Existing rows are left alone — run
//     this against an EMPTY target store (fresh accessory), not a live one.
//   - Writers must be stopped on the app during the copy (see runbook).
//   - A fresh source connection per table: the v1 RowDescription collision
//     defect tracks long-lived pools running many distinct statements, so
//     the migrator never reuses one.
//
// USAGE (from the repo root; pg is a project dependency; the target password
// rides PGPASSWORD so no credential ever appears in a URL or argv)
//   FROM_URL='postgres://nucleus@ship-nucleus:5432/nucleus?sslmode=disable' \
//   TO_URL='postgres://ship@ship-postgres:5432/ship?sslmode=disable' \
//   PGPASSWORD='<the ship user password>' \
//   node scripts/migrate-store.mjs
//
// Exit code 0 only if every table's row count matches the source.

import pg from "pg";

const FROM_URL = process.env.FROM_URL ?? "";
const TO_URL = process.env.TO_URL ?? "";
const EXCLUDED = (name) => name.startsWith("_") || name.startsWith("ship_code_");

if (FROM_URL === "" || TO_URL === "") {
  console.error("need FROM_URL (nucleus) and TO_URL (postgres)");
  process.exit(2);
}

const log = (m) => console.log(`[migrate] ${m}`);

const open = async (url) => {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
};

async function tableNames(client) {
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

async function columns(client, table) {
  const { rows } = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
  return rows;
}

async function primaryKey(client, table) {
  const { rows } = await client.query(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

// Nucleus's VECTOR type maps to pgvector's vector; everything else (TEXT,
// JSONB) carries over verbatim. (Vector columns only exist in skipped
// code-index tables, but the mapping keeps the script total.)
const mapType = (t) => (/^vector/i.test(t) ? "vector" : t);

async function count(client, table) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
  return rows[0].n;
}

async function copyTable(meta, target, table) {
  const srcCols = await columns(meta, table);
  if (srcCols.length === 0) throw new Error(`${table}: no columns on source`);
  const ddl = srcCols.map((c) => `"${c.column_name}" ${mapType(c.data_type)} NULL`).join(", ");
  const pk = await primaryKey(meta, table);
  const pkClause = pk.length > 0 ? `, PRIMARY KEY (${pk.map((c) => `"${c}"`).join(", ")})` : "";
  await target.query(`CREATE TABLE IF NOT EXISTS "${table}" (${ddl}${pkClause})`);

  const colList = srcCols.map((c) => `"${c.column_name}"`).join(", ");
  const placeholders = srcCols.map((_, i) => `$${i + 1}`).join(", ");
  const insert = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;
  const jsonbCols = new Set(srcCols.filter((c) => c.data_type === "jsonb").map((c) => c.column_name));

  // SOURCE IS AUTHORITATIVE: clear the target table first. The app's first
  // boot on an empty store seeds default rows (fleet self-measurement,
  // default policies, the migration ledger), and a re-run after a partial
  // failure must not double-copy PK'd rows either — both cases collapse to
  // "target ends up exactly equal to source", which DELETE-then-copy gives.
  await target.query(`DELETE FROM "${table}"`);

  // Fresh source connection per table (see SAFETY).
  const source = await open(FROM_URL);
  let copied = 0;
  try {
    const { rows } = await source.query(`SELECT ${colList} FROM "${table}"`);
    for (const row of rows) {
      const params = srcCols.map((c) =>
        jsonbCols.has(c.column_name) && typeof row[c.column_name] === "object" && row[c.column_name] !== null
          ? JSON.stringify(row[c.column_name])
          : row[c.column_name],
      );
      await target.query(insert, params);
      copied += 1;
    }
  } finally {
    await source.end().catch(() => undefined);
  }
  return copied;
}

async function copyStreams(target, runIds) {
  await target.query(
    `CREATE TABLE IF NOT EXISTS ship_stream (
       id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       stream TEXT NOT NULL,
       ms BIGINT NOT NULL,
       fields TEXT NOT NULL
     )`,
  );
  await target.query("CREATE INDEX IF NOT EXISTS idx_ship_stream_stream ON ship_stream (stream, id)");
  let entries = 0;
  for (const runId of runIds) {
    const stream = `ship:${runId}`;
    const source = await open(FROM_URL);
    try {
      // STREAM_XRANGE returns a scalar JSON text under the single output
      // column; the name varies by engine, so read the first column's value.
      const { rows } = await source.query("SELECT STREAM_XRANGE($1, $2, $3, $4)", [stream, 0, 9223372036854775807, 1_000_000]);
      const first = rows[0];
      const raw = first === undefined ? null : Object.values(first)[0];
      if (raw === null || raw === undefined || raw === "") continue;
      const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
      // Idempotent re-runs: clear this stream's rows before replaying them.
      await target.query("DELETE FROM ship_stream WHERE stream = $1", [stream]);
      for (const entry of parsed) {
        const fields =
          typeof entry.fields === "object" && entry.fields !== null ? entry.fields : { event: String(entry.fields ?? "") };
        const ms = Number.parseInt(String(entry.id ?? "0").split("-")[0], 10);
        await target.query("INSERT INTO ship_stream (stream, ms, fields) VALUES ($1, $2, $3)", [
          stream,
          Number.isFinite(ms) ? ms : 0,
          JSON.stringify(fields),
        ]);
        entries += 1;
      }
    } catch (error) {
      // Best effort by design: one run's history must not block the migration.
      log(`stream ${stream}: skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      await source.end().catch(() => undefined);
    }
  }
  return entries;
}

async function main() {
  const target = await open(TO_URL);
  // One metadata client for the whole run: catalog queries are few and
  // uniform — not the collision shape the per-table rule guards against.
  const meta = await open(FROM_URL);

  const names = (await tableNames(meta)).filter((n) => !EXCLUDED(n));
  log(`source tables: ${names.join(", ")}`);

  const report = [];
  for (const table of names) {
    const before = await count(meta, table);
    const copied = await copyTable(meta, target, table);
    const after = await count(target, table);
    const ok = copied === before && after >= before;
    report.push({ table, ok });
    log(`${table}: ${copied} rows copied (source ${before}, target now ${after}) ${ok ? "OK" : "MISMATCH"}`);
  }

  const { rows: runRows } = await meta.query("SELECT DISTINCT run_id FROM ship_docs WHERE run_id IS NOT NULL");
  const runIds = runRows.map((r) => String(r.run_id));
  const entries = await copyStreams(target, runIds);
  log(`event streams: ${entries} entries across ${runIds.length} runs (best effort)`);

  await meta.end().catch(() => undefined);
  await target.end().catch(() => undefined);

  const bad = report.filter((r) => !r.ok);
  if (bad.length > 0) {
    console.error(`[migrate] FAILED tables: ${bad.map((r) => r.table).join(", ")}`);
    process.exit(1);
  }
  log(`done — ${report.length} tables verified`);
}

main().catch((error) => {
  console.error(`[migrate] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
