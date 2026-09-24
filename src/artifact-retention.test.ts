import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifacts, SCREENSHOT_RETENTION_MS } from './artifacts.js';

test('temporary screenshots expire independently of identical permanent or newer captures', async () => {
  const dir = await mkdtemp(join(tmpdir(),'artifact-expiry-'));
  try {
    const store = new FileArtifacts(dir);
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    const permanent = await store.put('proof.png',png);
    const old = await store.putTemporary('takeover.png',png);
    const fresh = await store.putTemporary('takeover.png',png);
    assert.equal(new Set([permanent,old,fresh]).size,3);
    const path = join(dir,old+'.json');
    const row = JSON.parse(await readFile(path,'utf8'));
    assert.ok(Date.parse(row.expiresAt) > Date.now() + SCREENSHOT_RETENTION_MS - 10000);
    assert.equal((await store.get(old))?.data,png.toString('base64'));
    row.expiresAt='2000-01-01T00:00:00.000Z';
    await writeFile(path,JSON.stringify(row));
    assert.equal(await store.get(old),null);
    await store.pruneExpired();
    assert.equal((await store.get(permanent))?.data,png.toString('base64'));
    assert.equal((await store.get(fresh))?.data,png.toString('base64'));
    assert.equal((await readdir(dir)).length,2);
    await store.pruneExpired();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
