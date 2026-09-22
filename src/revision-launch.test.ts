import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventStore, RunMetaStore } from './run-store.js';
import { FileLaunchJournal, recoverLaunches, type LaunchIntent } from './launch-journal.js';
import { finishReviewReplacement } from './revision-launch.js';
import { MERGE_EVENT } from './plan.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'ship-revision-'));
  const store = new FileEventStore(join(dir,'runs'));
  const meta = new RunMetaStore(join(dir,'runs'));
  const now = new Date().toISOString();
  await store.append('parent',{v:1,seq:0,type:'run-started',at:now,data:{}});
  await meta.save({runId:'parent',task:'Original',model:'test',status:'waiting',eventName:MERGE_EVENT,createdAt:now,updatedAt:now});
  const runtime = {store,loadMeta:(id:string)=>meta.load(id),saveMeta:meta.save.bind(meta),claimDecision:meta.claimDecision.bind(meta)};
  const journal = () => new FileLaunchJournal(store,meta,join(dir,'launches'),intent=>finishReviewReplacement(runtime,intent));
  const intent:LaunchIntent = {runId:'child',reviewParent:'parent',requestHash:'a'.repeat(64),started:{v:1,seq:0,type:'run-started',at:now,data:{input:{parentRunId:'parent'}}},meta:{runId:'child',task:'Revise',model:'test',status:'queued',createdAt:now,updatedAt:now}};
  return {store,meta,runtime,journal,intent};
}

test('accepted revision recovers a crash after holding merge review before cancellation',async()=>{
  const f=await fixture();
  await f.journal().prepare(f.intent);
  const original=f.store.append.bind(f.store);
  f.store.append=async(id,event)=>{if(event.type==='run-cancelled')throw new Error('interrupted');await original(id,event)};
  await assert.rejects(f.journal().publish(f.intent),/interrupted/);
  assert.equal(await f.meta.claimDecision('parent',MERGE_EVENT),false);
  assert.equal(await f.meta.claimDecision('parent',MERGE_EVENT,'other-child'),false);
  assert.equal(await f.meta.load('child'),null);
  f.store.append=original;
  assert.deepEqual((await recoverLaunches(f.journal())).recovered,['child']);
  assert.equal((await f.store.load('parent')).filter(e=>e.type==='run-cancelled').length,1);
  assert.equal((await f.meta.load('child'))?.status,'queued');
  const child=await f.meta.load('child');assert.ok(child);await f.meta.save({...child,status:'completed'});
  await f.journal().publish(f.intent);
  assert.equal((await f.meta.load('child'))?.status,'completed');
});

test('an already claimed merge cannot be replaced or schedule a revision',async()=>{
  const f=await fixture();
  assert.equal(await f.meta.claimDecision('parent',MERGE_EVENT),true);
  await f.journal().prepare(f.intent);
  await assert.rejects(f.journal().publish(f.intent),/already taken/);
  assert.equal(await f.meta.load('child'),null);
  assert.equal((await f.store.load('child')).length,0);
  assert.equal((await f.store.load('parent')).some(e=>e.type==='run-cancelled'),false);
});

test('two accepted revisions compete for one parent decision; only the winner runs',async()=>{
  const f=await fixture();
  const other={...f.intent,runId:'other-child',requestHash:'b'.repeat(64),meta:{...f.intent.meta,runId:'other-child'}};
  await Promise.all([f.journal().prepare(f.intent),f.journal().prepare(other)]);
  const results=await Promise.allSettled([f.journal().publish(f.intent),f.journal().publish(other)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal([await f.meta.load('child'),await f.meta.load('other-child')].filter(Boolean).length,1);
});

test('failure after parent cancellation recovers without reopening review or duplicating the child',async()=>{
  const f=await fixture();
  await f.journal().prepare(f.intent);
  const append=f.store.append.bind(f.store);
  f.store.append=async(id,event)=>{if(id==='child')throw new Error('interrupted child publication');await append(id,event)};
  await assert.rejects(f.journal().publish(f.intent),/interrupted child publication/);
  assert.equal((await f.store.load('parent')).filter(e=>e.type==='run-cancelled').length,1);
  await f.meta.releaseDecision('parent',MERGE_EVENT);
  assert.equal(await f.meta.claimDecision('parent',MERGE_EVENT),false);
  assert.equal(await f.meta.load('child'),null);
  f.store.append=append;
  assert.deepEqual((await recoverLaunches(f.journal())).recovered,['child']);
  assert.equal((await f.store.load('parent')).filter(e=>e.type==='run-cancelled').length,1);
  assert.equal((await f.store.load('child')).length,1);
});
