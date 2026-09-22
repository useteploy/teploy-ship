// Scenario pj-b-db-migration: pinned flag via forward-only migration.
// Builds a real v1 database with data, runs the worked tree's migrate.mjs,
// and checks preservation + idempotence + API exposure.
import * as lib from './lib.mjs';
import { join } from 'node:path';

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];

  const dir = lib.mktmp('pj-b-migration-');
  const dbPath = join(dir, 'notes.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.prepare("INSERT INTO notes (title, body) VALUES ('keep me', 'v1 data')").run();
  db.close();

  const first = await lib.run('node', ['migrate.mjs'], { cwd: workDir, env: { NOTES_DB: dbPath }, timeoutMs: 60000 });
  evidence.push({ kind: 'run', check: 'migrate on existing v1 database', value: { code: first.code, out: first.stdout.trim() } });
  if (first.code !== 0) reasons.push(`migrate.mjs failed on an existing v1 database:\n${first.stderr.slice(-1500)}`);

  if (first.code === 0) {
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('SELECT title, body FROM notes').all();
    evidence.push({ kind: 'probe', check: 'v1 rows survive the migration', value: rows });
    if (!rows.some(r => r.title === 'keep me')) reasons.push('existing rows were lost by the migration — data loss on upgrade');

    let pinned = false;
    try {
      pinned = check.prepare('SELECT pinned FROM notes').all().every(r => r.pinned === 0);
    } catch { pinned = false; }
    evidence.push({ kind: 'probe', check: 'pinned column exists, defaults false', value: pinned });
    if (!pinned) reasons.push('notes.pinned column missing or not defaulting to false after migration');

    const second = await lib.run('node', ['migrate.mjs'], { cwd: workDir, env: { NOTES_DB: dbPath }, timeoutMs: 60000 });
    let appliedTwice = [];
    try {
      appliedTwice = check.prepare('SELECT name, COUNT(*) AS n FROM schema_migrations GROUP BY name HAVING n > 1').all();
    } catch { /* table missing entirely — caught above */ }
    evidence.push({ kind: 'run', check: 'second migrate run is a no-op', value: { code: second.code, doubleApplied: appliedTwice } });
    if (second.code !== 0 || appliedTwice.length > 0) reasons.push('migration is not idempotent (second run errored or double-applied)');
    check.close();
  }

  const server = await lib.bootServer('node', ['server.mjs'], {
    cwd: workDir,
    env: { NOTES_DB: dbPath, PORT: '0' }
  });
  try {
    const listed = await lib.request('GET', `http://127.0.0.1:${server.port}/api/notes`);
    const exposes = listed.status === 200 && listed.body?.some(r => 'pinned' in r);
    evidence.push({ kind: 'probe', check: 'API rows include pinned', value: exposes });
    if (!exposes) reasons.push(`GET /api/notes does not expose pinned on migrated data (status ${listed.status})`);
  } finally {
    await server.stop();
  }

  return lib.result(reasons.length === 0, reasons, evidence);
}
