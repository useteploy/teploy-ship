#!/usr/bin/env node
// Real daemon/lease and editor request-path proof, in isolated file-backed
// state. Pair with the Nucleus receipt for the database carrier; no production
// run or repository is modified. Requires the worker's sandbox env.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'ship-editor-proof-'));
process.env.TEPLOY_SHIP_STATE = join(scratch, 'state');
const { sandboxProvider } = await import('../dist/durable.js');
const { fileRuntime } = await import('../dist/runtime.js');
const { PLAN_EVENT } = await import('../dist/plan.js');
const { requestWorkspace, serveWorkspaceRequests, resolveEditorReply } = await import('../dist/workspace-requests.js');
const { takeoverReplyKey } = await import('../dist/takeover.js');
const runtime = fileRuntime();
const executor = sandboxProvider({
  baseURL: process.env.SHIP_SANDBOX_URL, token: process.env.SHIP_SANDBOX_TOKEN,
  image: process.env.SHIP_SANDBOX_IMAGE ?? 'ship-sandbox-node:dev', network: 'none', ttlSec: 900,
});
const runId = 'editor-proof-' + Date.now().toString(36);
const repo = 'https://github.com/teploy/editor-live-proof';
let handle;
async function op(kind, path, extra) {
  await requestWorkspace(runtime, runId, kind, 'editor-proof', path, extra);
  await serveWorkspaceRequests(runtime, executor, { allowlist: repo });
  const raw = JSON.parse(await runtime.config.get(takeoverReplyKey(runId)));
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 14000);
  const reply = await resolveEditorReply(runtime, runId, raw);
  assert.equal(reply.error, undefined, kind + ': ' + reply.error);
  return reply;
}
try {
  ({ handle } = await executor.create({}));
  const now = new Date().toISOString();
  await runtime.store.append(runId, { v:1, seq:1, at:now, type:'run-started', data:{input:{repo,task:'editor proof',plan:true,trust:'operator'}} });
  await runtime.store.append(runId, { v:1, seq:2, at:now, type:'step-completed', name:'sandbox', data:{result:{handle}} });
  await runtime.saveMeta({runId,task:'editor proof',status:'waiting',eventName:PLAN_EVENT,model:'proof',source:'manual',createdAt:now,updatedAt:now});
  await op('takeover-acquire');
  const content = 'é"\n'.repeat(50000);
  await op('takeover-write', 'large.txt', {content});
  assert.equal((await op('takeover-read','large.txt')).output, content);
  await op('takeover-write','empty.txt',{content:''});
  assert.equal((await op('takeover-read','empty.txt')).output,'');
  await op('takeover-release',undefined,{reason:'isolated editor transport proof complete'});
  console.log(JSON.stringify({pass:true,bytes:Buffer.byteLength(content),checks:['real daemon','lease-fenced write','lease-fenced exact read','empty file','bounded config rows','handback'],scope:'isolated file-backed run; no model or production run'}));
} finally {
  if (handle) await executor.destroy?.(handle);
  await runtime.close();
  rmSync(scratch,{recursive:true,force:true});
}
