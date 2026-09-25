#!/usr/bin/env node
// Deterministic workflow recovery against real daemon snapshots. Scripted
// model, isolated disk-backed event store; no production runs or forge writes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun, deliverEvent } from '@neutron-build/workflow';
import { durableAgent, sandboxProvider, PLAN_EVENT, approvalEvent } from '../dist/durable.js';
import { defaultApprovalPolicy } from '../dist/approval.js';
import { fileRuntime } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'ship-two-park-'));
process.env.TEPLOY_SHIP_STATE = root;
const real = sandboxProvider({ baseURL: process.env.SHIP_SANDBOX_URL,
  token: process.env.SHIP_SANDBOX_TOKEN, image: process.env.SHIP_SANDBOX_IMAGE,
  network: 'none', ttlSec: 900 });
const handles = new Set();
const snapshots = [];
const destroyed = [];
const executor = { ...real,
  async create(...args) { const r = await real.create(...args); handles.add(r.handle); return r; },
  async createFrom(...args) { const r = await real.createFrom(...args); handles.add(r.handle); return r; },
  async snapshot(handle) { const image = await real.snapshot(handle); snapshots.push({handle, image}); return image; },
  async destroy(handle) { await real.destroy(handle); handles.delete(handle); destroyed.push(handle); },
};
const turns = [
  '1. Clean the build\n2. Finish',
  '```bash\nrm -rf build/\n```',
  '```bash\nprintf recovered > recovery-proof.txt\ncat recovery-proof.txt\n```',
  '```finish\nCleaned after two parks.\n```',
  '```bash\ncat recovery-proof.txt\n```',
  '```finish\nCleaned after two parks.\n```',
];
let calls = 0;
const model = { provider: 'scripted', modelId: 'two-park-proof',
  async doGenerate() {
    assert.ok(calls < turns.length, 'unexpected extra model call');
    return {content:[{type:'text', text:turns[calls++]}], finishReason:'stop',
      usage:{inputTokens:1,outputTokens:1,totalTokens:2},raw:null};
  }, async *doStream() { throw new Error('unused'); },
};
const runId = 'two-park-proof-' + Date.now().toString(36);
let runtime;
async function open() {
  await runtime?.close();
  runtime = fileRuntime();
  return durableAgent({model, executor, approveAction:defaultApprovalPolicy,
    loadEvents: id => runtime.store.load(id)});
}
try {
  let workflow = await open();
  let result = await executeRun({workflow,runId,store:runtime.store,input:{task:'clean',plan:true}});
  assert.equal(result.status,'waiting');
  assert.equal(result.eventName,PLAN_EVENT);
  workflow = await open();
  await deliverEvent(runtime.store,runId,PLAN_EVENT,{approved:true});
  result = await executeRun({workflow,runId,store:runtime.store});
  assert.equal(result.status,'waiting');
  assert.equal(result.eventName,approvalEvent(0));
  assert.ok(destroyed.includes(snapshots[0].handle),'first workspace really disposed');
  workflow = await open();
  await deliverEvent(runtime.store,runId,approvalEvent(0),{approved:true});
  result = await executeRun({workflow,runId,store:runtime.store});
  assert.equal(result.status,'completed',JSON.stringify(result.error));
  assert.equal(result.output.agentSummary,'Cleaned after two parks.');
  assert.equal(snapshots.length,2);
  assert.notEqual(snapshots[0].handle,snapshots[1].handle);
  console.log(JSON.stringify({pass:true,runId,calls,snapshots,destroyed,
    scope:'real sandbox snapshots; disk store reopened at each park; scripted model; no production run',
    events:(await runtime.store.load(runId)).map(e=>({type:e.type,name:e.name}))},null,2));
} finally {
  for (const handle of handles) await real.destroy(handle).catch(error=>console.error('cleanup:',error.message));
  await runtime?.close();
  rmSync(root,{recursive:true,force:true});
}
