#!/usr/bin/env node
// Run only against an isolated restore, with no workers connected.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NucleusPgwire} from '../dist/nucleus-pgwire.js';
import {NucleusProjectStore,projectReference} from '../dist/projects.js';
if(process.env.SHIP_ISOLATED_CHECK!=='1'||!process.env.NUCLEUS_URL)throw new Error('Explicit isolated engine required');
const db=new NucleusPgwire(process.env.NUCLEUS_URL,'project-identity-proof');
const repo=`identity-proof/${randomUUID()}`;
const urls=[`https://first.identity-proof.invalid/${repo}`,`https://second.identity-proof.invalid/${repo}`];
try {
  const before=await db.query('SELECT repo, doc FROM ship_projects');
  await db.query('CREATE TABLE IF NOT EXISTS ship_projects_v2 (repo TEXT PRIMARY KEY, doc TEXT)');
  const marker=await db.query('SELECT repo FROM ship_projects_v2 WHERE repo = $1',['@migration']);
  if(!marker.length){
    const transaction=db.transaction.bind(db);
    db.transaction=fn=>transaction(tx=>fn({...tx,query:async(sql,params)=>{
      if(sql==='SELECT repo, doc FROM ship_projects')throw new Error('injected import interruption');
      return tx.query(sql,params);
    }}));
    await assert.rejects(new NucleusProjectStore(db).list(),/injected import interruption/);
    db.transaction=transaction;
    assert.equal((await db.query('SELECT repo FROM ship_projects_v2')).length,0,'failed import rolls back marker and rows');
  }
  const stores=Array.from({length:4},()=>new NucleusProjectStore(db));
  const imported=await Promise.all(stores.map(s=>s.list()));
  assert.ok(imported.every(rows=>rows.length===before.length),'one complete import visible to concurrent readers');
  assert.deepEqual(await db.query('SELECT repo, doc FROM ship_projects'),before,'legacy source unchanged');
  for(const p of imported[0])assert.equal(projectReference(await stores[0].forRepo(projectReference(p))),projectReference(p));
  const projects=urls.map((url,i)=>({repo:url,url,autoMerge:false,autoDeploy:false,testCommand:`echo forge-${i}`,neverAuto:true}));
  await Promise.all(projects.map((p,i)=>stores[i].set(p)));
  await Promise.all(stores.map(s=>s.set(projects[0])));
  assert.equal((await stores[0].forRepo(urls[0])).testCommand,'echo forge-0');
  assert.equal((await stores[1].forRepo(urls[1])).testCommand,'echo forge-1');
  await assert.rejects(stores[0].forRepo(repo),/identity conflicts/);
  await assert.rejects(stores[0].remove(repo),/identity conflicts/);
  await stores[0].set({...projects[0],testCommand:'echo changed'});
  assert.equal((await stores[1].forRepo(urls[1])).testCommand,'echo forge-1');
  // A concurrent writer between read and conditional write must not be lost.
  const transact=db.transaction.bind(db);
  let inject=true;
  db.transaction=fn=>transact(tx=>fn({
    query:tx.query.bind(tx),document:tx.document,
    exec:async(sql,params)=>{
      if(inject&&sql.startsWith('UPDATE ship_projects_v2 SET doc')){
        inject=false;
        const {repo:_repo,...doc}={...projects[0],label:'concurrent'};
        await db.query('UPDATE ship_projects_v2 SET doc = $1 WHERE repo = $2',[JSON.stringify(doc),urls[0]]);
      }
      return tx.exec(sql,params);
    },
  }));
  await assert.rejects(stores[0].set({...projects[0],label:'stale'}));
  db.transaction=transact;
  assert.equal((await stores[0].forRepo(urls[0])).label,'concurrent');
  await stores[0].remove(urls[0]);
  assert.equal(await new NucleusProjectStore(db).forRepo(urls[0]),null);
  const unbound={repo:`${repo}-unbound`,autoMerge:false,autoDeploy:false,neverAuto:true,testCommand:'echo retained'};
  await stores[0].set(unbound);
  const bound=`https://first.identity-proof.invalid/${repo}-unbound`;
  await assert.rejects(stores[0].forRepo(bound),/identity conflicts/);
  await stores[0].set({...unbound,url:bound});
  assert.equal((await stores[0].forRepo(bound)).testCommand,'echo retained');
  assert.equal((await stores[0].list()).filter(p=>p.repo===unbound.repo).length,1);
  await stores[0].remove(bound);
  await stores[0].remove(urls[1]);
  assert.deepEqual(await db.query('SELECT repo, doc FROM ship_projects'),before);
  assert.equal((await new NucleusProjectStore(db).list()).length,before.length);
  console.log(`Passed: ${before.length} legacy projects retained; rollback, concurrent import/registration, forge isolation, explicit binding and removal verified.`);
}finally{await db.close()}
