// Isolated engine only. No workers, forge writes or model calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nucleusRuntime,enqueueRun} from '../dist/runtime.js';
import {MERGE_EVENT} from '../dist/plan.js';
if(process.env.SHIP_ISOLATED_CHECK!=='1'||!process.env.NUCLEUS_URL)throw new Error('Explicit isolated engine required');
const runtime=await nucleusRuntime(process.env.NUCLEUS_URL,'revision-recovery-proof');
const mode=process.argv[2]??'seed';
const prefix=process.argv[3]??`revision-proof-${randomUUID()}`;
assert.match(prefix,/^revision-proof-[a-f0-9-]+$/);
const parent=prefix+'-parent',child=prefix+'-child',other=prefix+'-other';
try {
 if(mode==='seed'){
  await enqueueRun(runtime,{runId:parent,task:'Synthetic revision parent',model:'test',source:'manual',trust:'operator'});
  await runtime.db.document.update('ship_meta',{runId:parent},{status:'waiting',eventName:MERGE_EVENT});
  await runtime.db.document.update('ship_runs',{runId:parent},{status:'waiting',eventName:MERGE_EVENT});
  assert.equal(await runtime.claimDecision(parent,MERGE_EVENT),true);
  await runtime.releaseDecision(parent,MERGE_EVENT);
  assert.equal((await runtime.db.document.find('ship_meta',{runId:parent}))[0].eventName,MERGE_EVENT,'failed generic delivery restores its own held decision');
  const append=runtime.store.append.bind(runtime.store);
  runtime.store.append=async(id,event)=>{if(id===parent&&event.type==='run-cancelled')throw new Error('interrupted before cancel');return append(id,event)};
  await assert.rejects(enqueueRun(runtime,{runId:child,parentRunId:parent,reviewParent:parent,task:'Synthetic revision',model:'test',source:'manual',trust:'operator'}),/interrupted before cancel/);
  runtime.store.append=append;
  assert.equal(await runtime.loadMeta(child),null);
  assert.equal(await runtime.claimDecision(parent,MERGE_EVENT),false,'merge cannot claim held review');
  assert.equal(await runtime.claimDecision(parent,MERGE_EVENT,other),false,'another revision cannot steal the hold');
  await runtime.releaseDecision(parent,MERGE_EVENT);
  assert.equal(await runtime.claimDecision(parent,MERGE_EVENT),false,'generic release cannot reopen a revision-owned decision');
  console.log(prefix);
 } else if(mode==='verify'){
  const intent=await runtime.launches.get(child);assert.ok(intent);
  await Promise.all(Array.from({length:6},()=>runtime.launches.publish(intent)));
  assert.equal((await runtime.store.load(parent)).filter(e=>e.type==='run-cancelled').length,1);
  assert.equal((await runtime.store.load(child)).length,1);
  assert.equal((await runtime.db.document.find('ship_runs',{runId:child})).length,1);
  await runtime.db.document.update('ship_runs',{runId:child},{status:'completed'});
  await runtime.launches.publish(intent);
  assert.equal((await runtime.loadMeta(child)).status,'completed');
  console.log('Passed: actual engine restart recovers held revision, concurrent retries publish one child, generic release cannot reopen the hold, completed child stays completed.');
  for(const id of [parent,child]){
   const [row]=await runtime.db.query('SELECT * FROM ship_launches WHERE run_id = $1',[id]);
   await runtime.db.query('DELETE FROM ship_docs WHERE run_id = $1',[id]);
   await runtime.db.query('DELETE FROM ship_launch_commits WHERE run_id = $1',[id]);
   await runtime.db.query('DELETE FROM ship_launches WHERE run_id = $1',[id]);
   if(row)for(let i=0;i<Number(row.parts);i++)await runtime.db.query('DELETE FROM ship_launch_chunks WHERE chunk_id = $1',[`${row.blob_id}:${i}`]);
  }
  // Own unique event streams remain in this disposable restore. No user data removed.
 } else throw new Error('Expected seed or verify');
} finally {await runtime.close()}
