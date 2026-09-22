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

test('pending migrations degrade health to 503', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-pending-'));
  process.env.NOTES_DB = join(dir, 'notes.sqlite');
  const { server, db } = createApp();
  assert.ok(pendingMigrations(db).length >= 1, 'fixture ships at least one unapplied migration');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.migrations, 'pending');
    assert.ok(Array.isArray(body.pending) && body.pending.length >= 1);
  } finally {
    server.close();
    db.close();
    delete process.env.NOTES_DB;
  }
});
