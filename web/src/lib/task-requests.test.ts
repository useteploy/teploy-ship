import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.SHIP_WEB_TOKEN = "request-test-token";
process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-requests-"));
const { action } = await import("../routes/index.js");
const { shipRuntime } = await import("./store.server.js");
const { signSession, SESSION_COOKIE } = await import("./session.server.js");
const runtime = await shipRuntime();
await runtime.governance.setAuthority("approve", { roles: ["admin"], users: [] });
const url = "https://git.example.com/team/site";
await runtime.projects.set({ repo: url, url, autoMerge: false, autoDeploy: false });
function request(role: "editor" | "viewer", fields: Record<string, string>) {
  return new Request("http://ship.test/", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}` }, body: new URLSearchParams(fields) });
}
test("teammate can submit a deduplicated plan request without launching; viewer cannot submit", async () => {
  const fields = { intent: "submit-request", task: "Plan simpler wording", journey: "plan", repo: url, requestId: randomUUID() };
  const [first, ...retries] = await Promise.all(Array.from({length:8}, () => action({ request: request("editor", fields) })));
  assert.equal(first.status, 302);
  assert.ok(retries.every(again => first.headers.get("location") === again.headers.get("location")));
  const changed = await action({request:request("editor",{...fields,task:"Different request with reused ID"})});
  assert.match(decodeURIComponent(changed.headers.get("location") ?? ""), /different content/);
  const tasks = await runtime.intake.list("proposed");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "request-plan");
  assert.equal(tasks[0].source, "team-request");
  assert.equal(tasks[0].requestedBy, "editor");
  assert.equal((await runtime.listMeta()).length, 0);
  const refused = await action({ request: request("editor", { ...fields, intent: "new-run" }) });
  assert.match(refused.headers.get("location") ?? "", /denied=approve/);
  assert.equal((await action({ request: request("viewer", { ...fields, requestId: randomUUID() }) })).status, 403);
});
test("unregistered project and invalid journey do not create a proposal", async () => {
  for (const overrides of [{ repo: "https://other.test/x/y" }, { journey: "deploy" }]) {
    const result = await action({ request: request("editor", { intent: "submit-request", task: "Help", journey: "change", repo: url, requestId: randomUUID(), ...overrides }) });
    assert.match(result.headers.get("location") ?? "", /error=/);
  }
  assert.equal((await runtime.intake.list()).length, 1);
});

function adminRequest(fields: Record<string,string>) {
  return new Request("http://ship.test/", {method:"POST",headers:{authorization:"Bearer request-test-token"},body:new URLSearchParams(fields)});
}
test("direct launches survive concurrent retries and reject changed intent under the same ID",async()=>{
  const fields={intent:"new-run",repo:url,journey:"change",task:"Update the label",requestId:randomUUID()};
  const responses=await Promise.all(Array.from({length:8},()=>action({request:adminRequest(fields)})));
  const location=responses[0].headers.get("location")!;
  assert.match(location,/^\/runs\/run-request-/);
  assert.ok(responses.every(r=>r.headers.get("location")===location));
  const runId=location.split("/").pop()!.split("?")[0]!;
  assert.equal((await runtime.store.load(runId)).length,1);
  const meta=(await runtime.loadMeta(runId))!;
  await runtime.saveMeta({...meta,status:"completed"});
  await action({request:adminRequest(fields)});
  assert.equal((await runtime.loadMeta(runId))?.status,"completed");
  const conflict=await action({request:adminRequest({...fields,task:"Do unrelated work"})});
  assert.match(decodeURIComponent(conflict.headers.get("location")!),/different launch/);
  const missing=await action({request:adminRequest({...fields,requestId:""})});
  assert.match(decodeURIComponent(missing.headers.get("location")!),/Refresh the page/);
});

test("interrupted intake claim remains visible and authorized retries reuse its run identity",async()=>{
  const {task}=await runtime.intake.propose({source:"team-request",kind:"request-change",repo:url,title:"Fix a typo",dedupeKey:randomUUID(),requestedBy:"editor"});
  const runId="run-interrupted-intake";
  await runtime.intake.claim(task.taskId,runId);
  const {loader}=await import("../routes/index.js");
  const page=await loader({request:adminRequest({})});
  assert.ok(page.pendingLaunches.some(t=>t.taskId===task.taskId));
  const fields={intent:"retry-task",taskId:task.taskId};
  const denied=await action({request:request("editor",fields)});
  assert.match(denied.headers.get("location")!,/denied=approve/);
  const retries=await Promise.all(Array.from({length:5},()=>action({request:adminRequest(fields)})));
  assert.ok(retries.every(r=>r.headers.get("location")===`/runs/${runId}`));
  assert.equal((await runtime.store.load(runId)).length,1);
  assert.equal((await runtime.intake.get(task.taskId))?.runId,runId);
  assert.equal((await loader({request:adminRequest({})})).pendingLaunches.some(t=>t.taskId===task.taskId),false);
});
