import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileEventStore} from './run-store.js';
import {FileRepoStatsStore,costPerMerge} from './repo-stats.js';
import {ScopedRepoStatsStore} from './scoped-repo-stats.js';

test('historical statistics resolve from immutable input and unknown origins stay unscoped',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ship-scoped-stats-'));
  const events=new FileEventStore(join(dir,'runs')),raw=new FileRepoStatsStore(dir);
  const urls=['https://github.com/team/app','https://forge.example/team/app'];
  for(let i=0;i<2;i++){
    await events.append(`run-${i}`,{v:1,seq:0,type:'run-started',at:'t',data:{input:{repo:urls[i]}}});
    await raw.record({runId:`run-${i}`,repo:'team/app',kind:'merged',at:'t'});
  }
  await raw.record({runId:'run-missing',repo:'team/app',kind:'merged',at:'t'});
  const scoped=new ScopedRepoStatsStore(raw,events);
  assert.deepEqual((await scoped.list(urls[0])).map(x=>x.runId),['run-0']);
  assert.deepEqual((await scoped.list(urls[1])).map(x=>x.runId),['run-1']);
  assert.equal((await scoped.list()).filter(x=>x.repo==='team/app').length,1);
  await assert.rejects(scoped.list('team/app'),/identity conflicts/);
  assert.ok((await raw.list()).every(row=>row.repo==='team/app'),'historical records are not rewritten');
});

test('cost per merge uses the exact forge and refuses ambiguous legacy totals',()=>{
  const entries=[{kind:'repo',key:'https://github.com/team/app',amountUSD:2},{kind:'repo',key:'https://forge.example/team/app',amountUSD:20}];
  const counts={sent:2,merged:2,parked:0,reverted:0};
  assert.equal(costPerMerge('https://github.com/team/app',counts,entries),1);
  assert.equal(costPerMerge('https://forge.example/team/app',counts,entries),10);
  assert.equal(costPerMerge('team/app',counts,entries),null);
  assert.equal(costPerMerge('https://github.com/team/app',counts,[...entries,{kind:'repo',key:'github.com/team/app',amountUSD:1}]),null,'legacy spend is not silently mixed into an exact-origin ratio');
});
