#!/usr/bin/env node
// Run only against an isolated engine; no worker/model/forge operations.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NucleusEventStore} from '@neutron-build/workflow';
import {NucleusPgwire} from '../dist/nucleus-pgwire.js';
import {NucleusLaunchJournal,launchRequestHash} from '../dist/launch-journal.js';
if(process.env.SHIP_ISOLATED_CHECK!=='1'||!process.env.NUCLEUS_URL)throw new Error('An explicit isolated Nucleus URL is required');
const db=new NucleusPgwire(process.env.NUCLEUS_URL,'launch-recovery-proof');
const store=new NucleusEventStore(db.streams,{prefix:'ship-launch-proof'});
const journal=new NucleusLaunchJournal(db,store);
const prefix=`launch-proof-${randomUUID()}`;
const ids=[];
const blobs=new Set();
function make(suffix){
 const runId=`${prefix}-${suffix}`;ids.push(runId);
 const now=new Date().toISOString();
 const task='Independent launch recovery proof '+ 'bounded context '.repeat(2000);
 return {runId,requestHash:launchRequestHash({task}),started:{v:1,seq:0,type:'run-started',at:now,data:{workflow:'coding-agent',input:{task}}},meta:{runId,task,model:'test',status:'queued',createdAt:now,updatedAt:now}};
}
const transaction=db.transaction.bind(db);
try {
 const raced=make('race');
 const accepted=await Promise.all(Array.from({length:10},()=>journal.prepare(raced)));
 assert.ok(accepted.every(a=>a.runId===raced.runId));
 const publications=await Promise.allSettled(accepted.map(a=>journal.publish(a)));
 for(const result of publications)if(result.status==='rejected')throw result.reason;
 assert.equal((await db.document.find('ship_meta',{runId:raced.runId})).length,1);
 assert.equal((await db.document.find('ship_runs',{runId:raced.runId})).length,1);
 assert.equal((await store.load(raced.runId)).length,1);
 await db.document.update('ship_meta',{runId:raced.runId},{status:'completed'});
 await db.document.update('ship_runs',{runId:raced.runId},{status:'completed'});
 await journal.publish(await journal.prepare(raced));
 assert.equal((await db.document.find('ship_runs',{runId:raced.runId}))[0].status,'completed');
 await assert.rejects(journal.prepare({...raced,requestHash:launchRequestHash('different')}),/different launch/);
 const interrupted=await journal.prepare(make('rollback'));
 db.transaction=fn=>transaction(tx=>fn({...tx,query:tx.query.bind(tx),exec:async(sql,params)=>{
   if(sql.startsWith('UPDATE ship_launches'))throw new Error('injected before commit');
   return tx.exec(sql,params);
 },document:tx.document}));
 await assert.rejects(journal.publish(interrupted),/injected before commit/);
 assert.equal((await store.load(interrupted.runId)).length,1,'start event survives outside SQL transaction');
 assert.equal((await db.document.find('ship_meta',{runId:interrupted.runId})).length,0,'metadata rolled back');
 assert.equal((await db.document.find('ship_runs',{runId:interrupted.runId})).length,0,'scheduler row rolled back');
 assert.equal((await db.query('SELECT run_id FROM ship_launch_commits WHERE run_id = $1',[interrupted.runId])).length,0,'receipt rolled back');
 db.transaction=transaction;
 const restarted=new NucleusLaunchJournal(db,store);
 await restarted.publish(await restarted.get(interrupted.runId));
 assert.equal((await db.document.find('ship_runs',{runId:interrupted.runId}))[0].status,'wake');
 const unknown=await journal.prepare(make('unknown-commit'));
 db.transaction=async fn=>{await transaction(fn);throw new Error('injected lost commit response');};
 await assert.rejects(journal.publish(unknown),/lost commit response/);
 db.transaction=transaction;
 await journal.publish(unknown);
 assert.equal((await db.document.find('ship_runs',{runId:unknown.runId})).length,1);
 const corrupt=await journal.prepare(make('corrupt'));
 const [manifest]=await db.query('SELECT * FROM ship_launches WHERE run_id = $1',[corrupt.runId]);
 await db.query('UPDATE ship_launch_chunks SET value = $1 WHERE chunk_id = $2',['invalid',`${manifest.blob_id}:0`]);
 await assert.rejects(journal.get(corrupt.runId),/integrity check failed/);
 assert.equal((await db.document.find('ship_runs',{runId:corrupt.runId})).length,0);
 const pending=await journal.pending(prefix);
 assert.ok(pending.includes(corrupt.runId));
 console.log('Passed: real Nucleus concurrent acceptance/publication, large intent chunks, rollback, reconstruction, lost commit response, corruption refusal and completed-run preservation.');
} finally {
 db.transaction=transaction;
 for(const id of ids){
  const [row]=await db.query('SELECT blob_id FROM ship_launches WHERE run_id = $1',[id]);
  if(row)blobs.add(row.blob_id);
  await db.query('DELETE FROM ship_docs WHERE run_id = $1',[id]);
  await db.query('DELETE FROM ship_launch_commits WHERE run_id = $1',[id]);
  await db.query('DELETE FROM ship_launches WHERE run_id = $1',[id]);
 }
 for(const blob of blobs)for(const row of await db.query('SELECT chunk_id FROM ship_launch_chunks')){
  if(String(row.chunk_id).startsWith(`${blob}:`))await db.query('DELETE FROM ship_launch_chunks WHERE chunk_id = $1',[row.chunk_id]);
 }
 await db.close();
 // Event streams use the unique ship-launch-proof prefix and are retained on
 // this disposable engine; no user event stream or unknown cleanup API is used.
}
