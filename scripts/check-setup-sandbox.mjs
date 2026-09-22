// Isolated event store + real sandbox. Requires explicit fixture and credentials;
// never starts a worker, calls a model, pushes commits or opens a pull request.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MemoryEventStore,executeRun} from '@neutron-build/workflow';
import {durableAgent,sandboxProvider} from '../dist/durable.js';
import {policyFromEnv} from '../dist/repo-policy.js';
import {safeForDisplay} from '../dist/redact.js';
if(process.env.SHIP_ISOLATED_CHECK!=='1'||!process.env.SHIP_CHECK_REPO||!process.env.SHIP_CHECK_COMMAND)throw new Error('Explicit isolated fixture required');
const repo=process.env.SHIP_CHECK_REPO;
let modelCalls=0,destroyed=0;
const handles=[];
const model={provider:'disabled',modelId:'no-model',async doGenerate(){modelCalls++;throw new Error('Model must not be called')},async *doStream(){modelCalls++;throw new Error('Model must not be called')}};
const provider=sandboxProvider({baseURL:process.env.SHIP_SANDBOX_URL,token:process.env.SHIP_SANDBOX_TOKEN,image:process.env.SHIP_SANDBOX_IMAGE,network:'allowlist',ttlSec:600});
const create=provider.create.bind(provider),destroy=provider.destroy.bind(provider);
provider.create=async o=>{const r=await create(o);handles.push(r.handle);return r};
provider.destroy=async h=>{await destroy(h);destroyed++};
const store=new MemoryEventStore(),runId=`setup-proof-${randomUUID()}`;
try{
 const result=await executeRun({runId,store,workflow:durableAgent({model,executor:provider,workdir:'/work',repoPolicy:policyFromEnv({...process.env,SHIP_REPO_ALLOWLIST:repo})}),input:{
  task:'Isolated deterministic setup proof',repo,trust:'operator',mode:'scan',environmentCheck:true,environmentCheckOnly:true,
  preparation:{command:'python3 --version',timeoutMs:30000},testCommand:process.env.SHIP_CHECK_COMMAND,testTimeoutMs:120000,
  sandboxEgressAllow:[new URL(repo).host],
 }});
 const events=await store.load(runId),steps=events.filter(e=>e.type==='step-completed').map(e=>e.name);
 const check=events.find(e=>e.type==='step-completed'&&e.name==='environment-check');
 assert.equal(modelCalls,0);
 assert.equal(destroyed,handles.length,'sandbox release completed');
 assert.ok(steps.every(s=>['sandbox','repo-setup','environment-prepare','environment-check'].includes(s)));
 console.log(JSON.stringify({status:result.status,modelCalls,sandboxes:handles.length,destroyed,steps,check:check?.data}));
 assert.equal(result.status,process.env.SHIP_CHECK_EXPECTED||'completed');
}catch(error){console.error(safeForDisplay(error instanceof Error?error.message:String(error)));process.exitCode=1}
finally{for(const h of handles)await destroy(h).catch(()=>{})}
