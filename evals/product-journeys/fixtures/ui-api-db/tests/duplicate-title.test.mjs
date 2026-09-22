// KNOWN FAILING test tracking the open duplicate-title defect: POSTing a
// duplicate title currently returns 500. The acceptable outcomes are 409
// (conflict) or 400 (bad request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

test('duplicate title is rejected, not a 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-dup-'));
  process.env.NOTES_DB = join(dir, 'notes.sqlite');
  const { server, db } = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(base + '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'same title', body: 'one' })
    });
    assert.equal(first.status, 201);
    const second = await fetch(base + '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'same title', body: 'two' })
    });
    assert.ok(second.status === 409 || second.status === 400, `expected 409 or 400, got ${second.status}`);
  } finally {
    server.close();
    db.close();
    delete process.env.NOTES_DB;
  }
});
