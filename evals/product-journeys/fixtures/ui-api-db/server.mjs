// notes-api: tiny HTTP API over SQLite (node:sqlite). No dependencies.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pendingMigrations } from './migrate.mjs';

const DEFAULT_DB_PATH = resolve('notes.sqlite');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'fixture-admin-token';

export function connect(path = process.env.NOTES_DB || DEFAULT_DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  return db;
}

export function createApp() {
  const db = connect();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, data) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      const pending = pendingMigrations(db);
      if (pending.length > 0) return json(503, { status: 'degraded', db: 'ok', migrations: 'pending', pending });
      return json(200, { status: 'ok', db: 'ok', migrations: 'current' });
    }

    if (req.method === 'GET' && url.pathname === '/api/notes') {
      return json(200, db.prepare('SELECT id, title, body, created_at FROM notes ORDER BY id').all());
    }

    if (req.method === 'POST' && url.pathname === '/api/notes') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const title = String(data.title || '').trim();
          const body = String(data.body || '').trim();
          if (!title || !body) return json(400, { error: 'title and body are required' });
          const result = db.prepare('INSERT INTO notes (title, body) VALUES (?, ?)').run(title, body);
          return json(201, { id: Number(result.lastInsertRowid), title, body });
        } catch (err) {
          // DEFECT (open): a duplicate title hits the UNIQUE constraint and
          // surfaces as an unhandled 500. The correct behavior is a 409
          // Conflict that names the duplicate. See tests/duplicate-title.test.mjs.
          return json(500, { error: 'internal error' });
        }
      });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/notes/')) {
      const id = Number(url.pathname.split('/').pop());
      // DEFECT (open): README says admin actions require the admin token, but
      // this route never checks X-Admin-Token.
      const result = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      if (result.changes === 0) return json(404, { error: 'not found' });
      return json(204, {});
    }

    return json(404, { error: 'not found' });
  });
  return { server, db };
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`listening ${app.server.address().port}`);
  });
}
