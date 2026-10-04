import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, pendingMigrations } from '../migrate.mjs';
import { createApp } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function withMigratedServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'notes-health-'));
  process.env.NOTES_DB = join(dir, 'notes.sqlite');
  const { server, db } = createApp();
  applyMigrations(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    db.close();
    delete process.env.NOTES_DB;
  }
}

test('health reports ok once migrations are current', async () => {
  await withMigratedServer(async base => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.migrations, 'current');
    assert.equal(body.db, 'ok');
  });
});

