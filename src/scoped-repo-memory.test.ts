import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileEventStore} from './run-store.js';
import {FileRepoMemory} from './repo-memory.js';
import {ScopedRepoMemory} from './scoped-repo-memory.js';
import {repoKeyOf} from './repository-scope.js';

test('new repository scopes separate transport and full local paths; old inputs retain their scope',()=>{
  const https='https://forge.example/team/app',http='http://forge.example/team/app';
  assert.equal(repoKeyOf(https),repoKeyOf(http));
  assert.notEqual(repoKeyOf(https,2),repoKeyOf(http,2));
  assert.notEqual(repoKeyOf('file:///first/team/app',2),repoKeyOf('file:///second/team/app',2));
  assert.equal(repoKeyOf(https),'forge.example/team/app');
  assert.throws(()=>repoKeyOf('https://secret@forge.example/team/app',2),/credential-free/);
});

test('new memory context uses only historical notes whose recorded input proves the origin',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ship-scoped-memory-'));
  try {
    const events=new FileEventStore(join(dir,'runs')),raw=new FileRepoMemory(join(dir,'memory'));
    const urls=['https://forge.example/team/app','http://forge.example/team/app'];
    for(let i=0;i<2;i++){
      await events.append(`run-${i}`,{v:1,seq:0,type:'run-started',at:'t',data:{input:{repo:urls[i]}}});
      await raw.record({repo:repoKeyOf(urls[i]!),runId:`run-${i}`,note:`legacy-${i}`});
    }
    await raw.record({repo:repoKeyOf(urls[0]!),note:'manual-unattributed'});
    await raw.record({repo:repoKeyOf(urls[0]!),runId:'missing',note:'missing-history'});
    await raw.record({repo:urls[0]!,note:'new-qualified'});
    const memory=new ScopedRepoMemory(raw,events);
    assert.deepEqual(new Set((await memory.recent(urls[0]!,10)).map(n=>n.note)),new Set(['legacy-0','new-qualified']));
    assert.deepEqual((await memory.recent(urls[1]!,10)).map(n=>n.note),['legacy-1']);
    assert.equal((await memory.recent(repoKeyOf(urls[0]!),10)).length,4,'old parked inputs retain the old context');
    assert.equal((await memory.repos()).reduce((n,r)=>n+r.count,0),5,'all notes remain accessible');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('S01-3: case twins of one forge repository share memory; records land canonical; nothing is rewritten',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ship-scoped-memory-'));
  try {
    const events=new FileEventStore(join(dir,'runs')),raw=new FileRepoMemory(join(dir,'memory'));
    const upper='https://forge.example/Team/App',lower='https://forge.example/team/app';
    // v1 kept the owner's case: two runs spelling one repository differently
    // filed their notes under two keys.
    await events.append('run-up',{v:1,seq:0,type:'run-started',at:'t',data:{input:{repo:upper}}});
    await events.append('run-low',{v:1,seq:0,type:'run-started',at:'t',data:{input:{repo:lower}}});
    await events.append('run-other',{v:1,seq:0,type:'run-started',at:'t',data:{input:{repo:'https://forge.example/team/other'}}});
    await raw.record({repo:repoKeyOf(upper),runId:'run-up',note:'legacy-upper'});
    await raw.record({repo:repoKeyOf(lower),runId:'run-low',note:'legacy-lower'});
    // A v1 twin key whose run proves a DIFFERENT repository stays out.
    await raw.record({repo:repoKeyOf(upper),runId:'run-other',note:'foreign'});
    // A note written raw under a mixed-case URL before record() canonicalized.
    await raw.record({repo:upper,note:'raw-upper-url'});
    const memory=new ScopedRepoMemory(raw,events);
    const recorded=await memory.record({repo:'https://FORGE.example/Team/App.git',note:'new'});
    assert.equal(recorded.repo,lower,'a clone URL is recorded under its canonical key');
    for(const spelling of [upper,lower,'https://forge.example/TEAM/APP.git']){
      assert.deepEqual(new Set((await memory.recent(spelling,10)).map(n=>n.note)),new Set(['legacy-upper','legacy-lower','raw-upper-url','new']),spelling);
    }
    assert.ok((await memory.recent(lower,10)).every(n=>n.repo===lower),'twins surface under the one identity');
    assert.equal((await memory.recent('http://forge.example/team/app',10)).length,0,'the scheme is still never folded');
    assert.deepEqual((await memory.recent('file:///srv/Team/App',10)).map(n=>n.note),[],'file paths never fold');
    const stored=new Set((await memory.repos()).map(r=>r.repo));
    assert.ok(stored.has(repoKeyOf(upper))&&stored.has(repoKeyOf(lower))&&stored.has(upper),'stored twin keys are left exactly as written');
  } finally {await rm(dir,{recursive:true,force:true});}
});
