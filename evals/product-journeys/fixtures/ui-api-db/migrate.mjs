// Forward-only SQL migrations. Each file in migrations/ applies once, in
// lexical order, recorded in schema_migrations. Idempotent by construction:
// re-running applies nothing.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, 'migrations');

export function availableMigrations() {
  return readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
}

export function pendingMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(row => row.name));
  return availableMigrations().filter(name => !applied.has(name));
}

export function applyMigrations(db) {
  const appliedNow = [];
  for (const name of pendingMigrations(db)) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
      appliedNow.push(name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return appliedNow;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const db = new DatabaseSync(process.env.NOTES_DB || resolve(here, 'notes.sqlite'));
  const appliedNow = applyMigrations(db);
  const pending = pendingMigrations(db);
  console.log(JSON.stringify({ applied: appliedNow, pending }));
  process.exit(pending.length > 0 ? 1 : 0);
}
