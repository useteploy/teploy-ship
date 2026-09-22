import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

test('create then list a note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-roundtrip-'));
  process.env.NOTES_DB = join(dir, 'notes.sqlite');
  const { server, db } = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(base + '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'first note', body: 'hello' })
    });
    assert.equal(created.status, 201);
    const listed = await (await fetch(base + '/api/notes')).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'first note');
  } finally {
    server.close();
    db.close();
    delete process.env.NOTES_DB;
  }
});
