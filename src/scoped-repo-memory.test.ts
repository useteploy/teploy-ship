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
