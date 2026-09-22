#!/usr/bin/env node
// Run seed, restart the isolated engine, then run verify with the printed ID.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NucleusEventStore } from '@neutron-build/workflow';
import { NucleusPgwire } from '../dist/nucleus-pgwire.js';
import { NucleusLaunchJournal, launchRequestHash } from '../dist/launch-journal.js';
if(process.env.SHIP_ISOLATED_CHECK!=='1'||!process.env.NUCLEUS_URL)throw new Error('Isolated engine required');
const [phase,id]=process.argv.slice(2);
if(!['seed','verify'].includes(phase))throw new Error('Use seed or verify RUN_ID');
if(phase==='verify'&&!/^launch-restart-[a-f0-9-]+$/.test(id??''))throw new Error('Use the exact proof ID printed by seed');
const db=new NucleusPgwire(process.env.NUCLEUS_URL,'launch-restart-proof');
const store=new NucleusEventStore(db.streams,{prefix:'ship-launch-proof'});
const journal=new NucleusLaunchJournal(db,store);
try {
 if(phase==='seed'){
  const runId=`launch-restart-${randomUUID()}`,now=new Date().toISOString();
  await journal.prepare({runId,requestHash:launchRequestHash('restart proof'),started:{v:1,seq:0,type:'run-started',at:now,data:{workflow:'coding-agent',input:{task:'Restart proof'}}},meta:{runId,task:'Restart proof',model:'test',status:'queued',createdAt:now,updatedAt:now}});
  assert.equal((await store.load(runId)).length,0);
  console.log(runId);
 } else {
  const accepted=await journal.get(id);assert.ok(accepted);
  await journal.publish(accepted);
  assert.equal((await db.document.find('ship_runs',{runId:id}))[0].status,'wake');
  assert.equal((await store.load(id)).length,1);
  const [manifest]=await db.query('SELECT * FROM ship_launches WHERE run_id = $1',[id]);
  for(let i=0;i<Number(manifest.parts);i++)await db.query('DELETE FROM ship_launch_chunks WHERE chunk_id = $1',[`${manifest.blob_id}:${i}`]);
  await db.query('DELETE FROM ship_docs WHERE run_id = $1',[id]);
  await db.query('DELETE FROM ship_launch_commits WHERE run_id = $1',[id]);
  await db.query('DELETE FROM ship_launches WHERE run_id = $1',[id]);
  console.log('Passed: accepted intent survives engine restart and publishes one schedulable run.');
 }
} finally {await db.close();}
