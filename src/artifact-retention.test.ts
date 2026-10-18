import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifacts, RECORDING_DATA_CLASS, SCREENSHOT_RETENTION_MS } from './artifacts.js';

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

test('Q3a binding: a bound artifact carries its run and revision under its own identity; unbound ones are unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(),'artifact-binding-'));
  try {
    const store = new FileArtifacts(dir);
    const png = Buffer.from([137,80,78,71,13,10,26,10,4,5,6]);
    const rev = 'c'.repeat(40);
    const unbound = await store.put('a.png',png);
    const a = await store.put('a.png',png,undefined,{runId:'run-a',revision:rev});
    const b = await store.put('a.png',png,undefined,{runId:'run-b'});
    assert.equal(new Set([unbound,a,b]).size,3,'identical pixels from two runs never share a record');
    assert.equal((await store.get(a))?.runId,'run-a');
    assert.equal((await store.get(a))?.revision,rev);
    assert.equal((await store.get(b))?.runId,'run-b');
    assert.equal((await store.get(b))?.revision,undefined);
    const plain = await store.get(unbound);
    assert.equal(plain?.runId,undefined);
    assert.equal('runId' in (plain ?? {}),false,'an unbound record gains no field');
    const rec = await store.putTemporary('w.webm',Buffer.from([26,69,223,163,1]),RECORDING_DATA_CLASS,{runId:'run-a',revision:rev});
    assert.equal((await store.get(rec))?.dataClass,RECORDING_DATA_CLASS);
    await assert.rejects(()=>store.put('a.png',png,undefined,{runId:'run-a',revision:'abc'}),/full commit revision/);
    await assert.rejects(()=>store.put('a.png',png,undefined,{runId:'../x y'}),/valid run id/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
