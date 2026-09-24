import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(
  join(tmpdir(), "ship-workspace-actions-"),
);
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "workspace-tests";
const { shipRuntime } = await import("./store.server.js");
const templates = await import("../routes/workflows.js");
const setup = await import("../routes/setup.js");
const run = await import("../routes/runs/[id].js");
const { enqueueRun } = await import("./ship.server.js");
function request(path: string, fields: Record<string, string>, auth = true) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: auth ? { authorization: "Bearer workspace-tests" } : {},
    body: new URLSearchParams({...(fields.intent === "follow-up" ? {requestId:randomUUID()} : {}), ...fields}),
  });
}
test("workflows require policy authority and persist through the shared store", async () => {
  assert.equal(
    (
      await templates.action({
        request: request("/workflows", { name: "Bad" }, false),
      })
    ).status,
    403,
  );
  const res = await templates.action({
    request: request("/workflows", {
      id: "custom-test",
      name: "Our checks",
      description: "Team routine",
      task: "Run meaningful tests",
      mode: "scan",
      plan: "on",
    }),
  });
  assert.equal(res.status, 303);
  const page = await templates.loader({
    request: new Request("http://localhost/workflows?edit=custom-test"),
  });
  assert.equal(page.selected?.task, "Run meaningful tests");
  assert.equal(page.selected?.mode, "scan");
  assert.equal(
    (
      await templates.action({
        request: request("/workflows", { id: "fix", intent: "delete" }),
      })
    ).status,
    400,
  );
  await templates.action({
    request: request("/workflows", { id: "custom-test", intent: "delete" }),
  });
  assert.equal(
    (
      await templates.loader({
        request: new Request("http://localhost/workflows"),
      })
    ).templates.some((t) => t.id === "custom-test"),
    false,
  );
});
test("guided registration preserves existing project settings and rejects embedded secrets", async () => {
  assert.equal(
    (
      await setup.action({
        request: request(
          "/setup",
          { url: "https://github.com/team/repo" },
          false,
        ),
      })
    ).status,
    403,
  );
  const runtime = await shipRuntime();
  await setup.action({
    request: request("/setup", {
      url: "https://github.com/team/repo",
      tests: "pnpm test",
    }),
  });
  const p = await runtime.projects.forRepo("https://github.com/team/repo");
  assert.equal(p?.neverAuto, true);
  assert.equal(p?.autoMerge, false);
  assert.equal(p?.testCommand, "pnpm test");
  await setup.action({
    request: request("/setup", {
      url: "https://github.com/team/repo",
      tests: "overwrite",
    }),
  });
  assert.equal(
    (await runtime.projects.forRepo("https://github.com/team/repo"))
      ?.testCommand,
    "pnpm test",
  );
  const bad = await setup.action({
    request: request("/setup", {
      url: "https://token:secret@github.com/team/private",
    }),
  });
  assert.match(
    bad.headers.get("location") ?? "",
    /without\+embedded\+credentials/,
  );
});
test("follow-up requires launch authority and a terminal parent; new run records lineage and context", async () => {
  const runtime = await shipRuntime();
  await enqueueRun(runtime, {
    runId: "run-parent",
    task: "Fix the parser",
    model: "test",
    source: "manual",
    trust: "operator",
  });
  assert.match(
    (
      await run.action({
        params: { id: "run-parent" },
        request: request(
          "/runs/run-parent",
          { intent: "follow-up", message: "Add tests" },
          false,
        ),
      })
    ).headers.get("location") ?? "",
    /denied=approve/,
  );
  assert.match(
    (
      await run.action({
        params: { id: "run-parent" },
        request: request("/runs/run-parent", {
          intent: "follow-up",
          message: "Add tests",
        }),
      })
    ).headers.get("location") ?? "",
    /messageError/,
  );
  const meta = await runtime.loadMeta("run-parent");
  assert.ok(meta);
  await runtime.saveMeta({ ...meta, status: "completed" });
  const response = await run.action({
    params: { id: "run-parent" },
    request: request("/runs/run-parent", {
      intent: "follow-up",
      message: "Add tests",
      plan: "on",
      mode: "scan",
    }),
  });
  const id = response.headers.get("location")!.split("/").pop()!;
  const events = await runtime.store.load(id);
  const input = (events[0].data as any).input;
  assert.equal(input.parentRunId, "run-parent");
  assert.equal((events[0].data as any).taskRootRunId, "run-parent");
  assert.equal(input.plan, undefined, "read-only investigation does not park on a code-change plan");
  assert.equal(input.mode, "scan");
  assert.match(input.task, /Fix the parser/);
  assert.match(input.task, /Add tests/);
});

test("setup preparation persists and verification enqueues recorded checks with no publication",async()=>{
  const runtime=await shipRuntime();
  await setup.action({request:request('/setup',{intent:'environment',repo:'team/repo',prepare:'npm ci',timeout:'120',tests:'npm test'})});
  const project=await runtime.projects.forRepo('team/repo');
  assert.equal(project?.preparation?.command,'npm ci');assert.equal(project?.preparation?.timeoutMs,120000);
  const response=await setup.action({request:request('/setup',{intent:'verify',repo:'team/repo'})});
  const id=response.headers.get('location')!.split('/').pop()!.split('?')[0];
  const input=(await runtime.store.load(id))[0].data as any;
  assert.equal(input.input.environmentCheckOnly,true);assert.equal(input.input.environmentCheck,true);assert.equal(input.input.mode,'scan');assert.equal(input.input.preparation.command,'npm ci');
  assert.equal(input.input.autoMerge,undefined);
});

test("requesting changes at merge review claims the decision and keeps the PR open", async () => {
  const runtime = await shipRuntime();
  const id = 'run-review-parent';
  await enqueueRun(runtime, {runId:id,repo:'https://github.com/team/repo',task:'Fix parser',model:'test',source:'manual',trust:'operator'});
  await runtime.store.append(id, {v:1,seq:1,at:new Date().toISOString(),type:'step-completed',name:'repo-pr',data:{result:{number:1,url:'https://github.com/team/repo/pull/1'}}});
  const meta=await runtime.loadMeta(id);assert.ok(meta);await runtime.saveMeta({...meta,status:'waiting',eventName:'approve-merge'});
  const responder=setInterval(async()=>{
    const raw=await runtime.config.get('SHIP_WORKSPACE_REQUEST_'+id);if(!raw)return;
    const req=JSON.parse(raw);
    await runtime.config.set('SHIP_WORKSPACE_REPLY_'+id,JSON.stringify({id:req.id,at:new Date().toISOString(),forge:{number:1,state:'open',head:'abcdef1234',checkedAt:new Date().toISOString(),checks:[],reviews:[],warnings:[]}}));
  },20);
  try {
    const previousAttempts = process.env.SHIP_HARNESS_ATTEMPTS;
    process.env.SHIP_HARNESS_ATTEMPTS = 'native,claude-code';
    try {
      const refused = await run.action({params:{id},request:request('/runs/'+id,{intent:'follow-up',eventName:'approve-merge',message:'Review before changing',mode:'fix',plan:'on'})});
      assert.match(refused.headers.get('location')!, /messageError=/);
      assert.equal((await runtime.loadMeta(id))?.eventName, 'approve-merge', 'failed admission restores the pending decision');
      assert.equal((await runtime.loadMeta(id))?.status, 'waiting');
      assert.equal((await runtime.store.load(id)).some(e=>e.type==='run-cancelled'), false);
    } finally {
      if (previousAttempts === undefined) delete process.env.SHIP_HARNESS_ATTEMPTS;
      else process.env.SHIP_HARNESS_ATTEMPTS = previousAttempts;
    }
    const res=await run.action({params:{id},request:request('/runs/'+id,{intent:'follow-up',eventName:'approve-merge',message:'Also cover negative values',mode:'fix'})});
    const next=res.headers.get('location')!.split('/').pop()!;assert.match(next,/^run-/);
    const input=(await runtime.store.load(next))[0].data as any;
    assert.equal(input.input.pr,1);assert.equal(input.input.requireOpenPr,true);assert.equal(input.input.parentRunId,id);
    assert.equal((await runtime.loadMeta(id))?.status,'cancelling');
    assert.equal((await runtime.store.load(id)).some(e=>e.name==='merge-decision'),false,'no deny/close operation is sent');
  } finally {clearInterval(responder)}
});


test("workspace JSON uses the active server Response constructor", async () => {
  const resource = await import("../routes/api/runs/[id]/workspace.js");
  const NativeResponse = globalThis.Response;
  // Reproduce Hono's Response subclass: inherited static json() returns a
  // native response that fails instanceof checks against the replacement.
  class ServerResponse extends NativeResponse {}
  globalThis.Response = ServerResponse;
  try {
    assert.equal(Response.json({}) instanceof Response, false);
    await assert.rejects(
      resource.loader({params:{id:"run-parent"},request:request("/api/runs/run-parent/workspace",{})}),
      (response: unknown) => response instanceof ServerResponse && response.status === 200 && response.headers.get("content-type") === "application/json",
    );
  } finally { globalThis.Response = NativeResponse; }
});


test("an external harness cannot silently bypass requested plan approval", async () => {
  const runtime = await shipRuntime();
  await assert.rejects(enqueueRun(runtime, {runId:"run-external-plan",repo:"https://github.com/team/repo",task:"Fix it",model:"test",source:"manual",trust:"operator",harness:"claude-code",plan:true}), /Plan review requires the native harness/);
  assert.equal((await runtime.store.load("run-external-plan")).length, 0);
});


test("retrying a failed PR revision retains its original PR before publication", async () => {
  const runtime = await shipRuntime();
  const id = "run-failed-pr";
  await enqueueRun(runtime, {runId:id,repo:"https://github.com/team/repo",pr:7,task:"Revise it",model:"test",source:"manual",trust:"operator"});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:"failed"});
  const responder=setInterval(async()=>{
    const raw=await runtime.config.get("SHIP_WORKSPACE_REQUEST_"+id);if(!raw)return;
    const req=JSON.parse(raw);
    await runtime.config.set("SHIP_WORKSPACE_REPLY_"+id,JSON.stringify({id:req.id,at:new Date().toISOString(),forge:{number:7,state:"open",head:"abcdef1234",checkedAt:new Date().toISOString(),checks:[],reviews:[],warnings:[]}}));
  },20);
  try {
    const data=await run.loader({params:{id},request:request("/runs/"+id,{})});
    assert.equal(data.hasPr,true);
    const res=await run.action({params:{id},request:request("/runs/"+id,{intent:"follow-up",message:"Retry the requested revision",mode:"fix"})});
    const next=res.headers.get("location")!.split("/").pop()!;
    const input=(await runtime.store.load(next))[0].data as any;
    assert.equal(input.input.pr,7);
    assert.equal(input.input.requireOpenPr,true);
  } finally {clearInterval(responder)}
});

test("legacy project identity conflicts preserve run history but prevent new work", async () => {
  const runtime = await shipRuntime();
  const repo = "https://github.com/legacy/history";
  const id = "run-legacy-identity";
  await enqueueRun(runtime, {runId:id,repo,task:"Original request",model:"test",source:"manual",trust:"operator"});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:"completed"});
  await runtime.projects.set({repo:"legacy/history",autoMerge:false,autoDeploy:false});
  const data = await run.loader({params:{id},request:request("/runs/"+id,{})});
  assert.equal(data.meta?.runId,id);
  assert.match(data.messageError ?? "", /identity conflicts/);
  assert.equal(data.planSupported,false);
  const res = await run.action({params:{id},request:request("/runs/"+id,{intent:"follow-up",message:"Try again",journey:"change"})});
  assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /identity conflicts/);
  assert.equal((await runtime.listMeta({limit:100})).filter(m => m.task === "Try again").length,0);
});

test("project plan requirement is saved through UI and enforced on unchecked launches", async () => {
  const projectsRoute = await import("../routes/projects.js");
  const inbox = await import("../routes/index.js");
  const runtime = await shipRuntime();
  const url = "https://github.com/team/plan-policy";
  await runtime.projects.set({ repo: url, url, harness: "native", autoMerge: false, autoDeploy: false });
  const saved = await projectsRoute.action({ request: request("/projects", { repo: url, url, harness: "native", planReviewPresent: "1", requirePlanReview: "on" }) });
  assert.equal(saved.status, 302);
  assert.equal((await runtime.projects.forRepo(url))?.requirePlanReview, true);
  const page = await inbox.loader({ request: request("/", {}) });
  assert.equal(page.projects.find(p => p.url === url)?.requirePlanReview, true);
  const launched = await inbox.action({ request: request("/", { intent: "new-run", repo: url, journey: "change", task: "Change one button label", requestId: "ac33a1df-7d2b-4ae0-a71b-ac9ed66fa23e" }) });
  const location = launched.headers.get("location")!;
  assert.match(location, /^\/runs\//);
  const id = location.split("/").pop()!.split("?")[0]!;
  assert.equal(((await runtime.store.load(id))[0]?.data as any).input.plan, true);
  // An old settings form omitting the new control must not remove the floor.
  await projectsRoute.action({ request: request("/projects", { repo: url, url, harness: "native" }) });
  assert.equal((await runtime.projects.forRepo(url))?.requirePlanReview, true);
  await projectsRoute.action({ request: request("/projects", { repo: url, url, harness: "native", planReviewPresent: "1" }) });
  assert.notEqual((await runtime.projects.forRepo(url))?.requirePlanReview, true);
});

test("follow-up retries share one child and refuse changed content under the same key",async()=>{
  const runtime=await shipRuntime();
  const id='run-followup-idempotence';
  await enqueueRun(runtime,{runId:id,task:'Original',model:'test',source:'manual',trust:'operator'});
  const meta=await runtime.loadMeta(id);assert.ok(meta);await runtime.saveMeta({...meta,status:'completed'});
  const fields={intent:'follow-up',message:'Explain the result',journey:'investigate',requestId:randomUUID()};
  const results=await Promise.all(Array.from({length:8},()=>run.action({params:{id},request:request('/runs/'+id,fields)})));
  const locations=results.map(r=>r.headers.get('location'));
  assert.equal(new Set(locations).size,1);
  assert.match(locations[0]!,/^\/runs\/run-request-/);
  const child=locations[0]!.split('/').pop()!;
  assert.equal((await runtime.store.load(child)).length,1);
  const current=await runtime.loadMeta(child);assert.ok(current);await runtime.saveMeta({...current,status:'completed'});
  const retry=await run.action({params:{id},request:request('/runs/'+id,fields)});
  assert.equal(retry.headers.get('location'),locations[0]);
  assert.equal((await runtime.loadMeta(child))?.status,'completed');
  const changed=await run.action({params:{id},request:request('/runs/'+id,{...fields,message:'Do something else'})});
  assert.match(decodeURIComponent(changed.headers.get('location')!),/different follow-up/);
  const missing=await run.action({params:{id},request:request('/runs/'+id,{...fields,requestId:''})});
  assert.match(decodeURIComponent(missing.headers.get('location')!),/Refresh the page/);
});

test("project settings refuse a mismatched clone URL without storing ineffective policy",async()=>{
  const projects=await import('../routes/projects.js');
  const runtime=await shipRuntime();
  const response=await projects.action({request:request('/projects',{repo:'binding/expected',url:'https://forge.example/binding/different',planReviewPresent:'1',requirePlanReview:'on'})});
  assert.match(decodeURIComponent(response.headers.get('location')!),/must match its clone URL/);
  assert.equal(await runtime.projects.forRepo('binding/expected'),null);
  assert.equal(await runtime.projects.forRepo('https://forge.example/binding/different'),null);
});


test("project settings cannot persist or echo a credential-bearing clone URL",async()=>{
  const projects=await import('../routes/projects.js');
  const runtime=await shipRuntime();
  const response=await projects.action({request:request('/projects',{repo:'binding/credentials',url:'https://synthetic:DO_NOT_ECHO@forge.example/binding/credentials'})});
  const location=decodeURIComponent(response.headers.get('location')!);
  assert.match(location,/without embedded credentials/);
  assert.equal(location.includes('DO_NOT_ECHO'),false);
  assert.equal(await runtime.projects.forRepo('binding/credentials'),null);
});


test('guided connection binds an unbound project without resetting policies and same-named forges stay separate',async()=>{
  const runtime = await shipRuntime();
  await runtime.projects.set({repo:'identity-setup/app',autoMerge:false,autoDeploy:false,requirePlanReview:true,neverAuto:true,testCommand:'make check'});
  const first='https://first.setup.invalid/identity-setup/app',second='https://second.setup.invalid/identity-setup/app';
  const connected=await setup.action({request:request('/setup',{url:first,tests:'ignored'})});
  assert.equal(connected.headers.get('location'),`/setup?repo=${encodeURIComponent(first)}`);
  assert.equal((await runtime.projects.forRepo(first))?.requirePlanReview,true);
  assert.equal((await runtime.projects.forRepo(first))?.testCommand,'make check');
  await setup.action({request:request('/setup',{url:second,tests:'pnpm test'})});
  const page=await setup.loader({request:new Request(`http://localhost/setup?repo=${encodeURIComponent(second)}`)});
  assert.equal(page.selected?.url,second);
  assert.equal(page.selected?.testCommand,'pnpm test');
  assert.equal((await runtime.projects.forRepo(first))?.testCommand,'make check');
  await assert.rejects(runtime.projects.forRepo('identity-setup/app'),/identity conflicts/);
});

test("takeover panel ops require steer authority per request and carry the operator's name", async () => {
  const runtime = await shipRuntime();
  const id = "run-panel-auth";
  await enqueueRun(runtime, {runId:id,repo:'https://github.com/team/repo',task:'Panel',model:'test',source:'manual',trust:'operator'});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:'waiting',eventName:'ship-ask-1'});
  // no credential: the steer grant is re-checked on every POST, never cached in the page
  for (const intent of ["takeover-console", "takeover-read", "takeover-write"]) {
    const denied = await run.action({params:{id},request:new Request("http://localhost/runs/"+id,{method:"POST",body:new URLSearchParams({intent, path:"src/a.ts", command:"echo hi", content:"x"})})});
    assert.match(denied.headers.get("location") ?? "", /denied=steer/, intent);
  }
  const res = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-console",command:"echo hi",tab:"console"})});
  assert.match(res.headers.get("location") ?? "", /takeover=pending&tab=console/);
  const recorded = JSON.parse((await runtime.config.get("SHIP_WORKSPACE_REQUEST_"+id))!);
  assert.equal(recorded.kind, "takeover-console");
  assert.equal(recorded.command, "echo hi");
  assert.equal(typeof recorded.by, "string");
});

test("takeover panel bounds: command cap and read path are refused at request time", async () => {
  const runtime = await shipRuntime();
  const id = "run-panel-bounds";
  await enqueueRun(runtime, {runId:id,repo:'https://github.com/team/repo',task:'Bounds',model:'test',source:'manual',trust:'operator'});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:'waiting',eventName:'ship-ask-1'});
  const long = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-console",command:"x".repeat(2001)})});
  assert.match(decodeURIComponent(long.headers.get("location") ?? ""), /limited to 2000 characters/);
  const read = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-read",path:"src/a.ts",tab:"editor"})});
  assert.match(read.headers.get("location") ?? "", /takeover=pending&tab=editor/);
  const recorded = JSON.parse((await runtime.config.get("SHIP_WORKSPACE_REQUEST_"+id))!);
  assert.equal(recorded.kind, "takeover-read");
  assert.equal(recorded.path, "src/a.ts");
  // an unknown tab never rides the redirect back into the URL
  const weird = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-changes",tab:"attacks"})});
  assert.equal((weird.headers.get("location") ?? "").includes("tab="), false);
});

test("the run page surfaces the panel reply state the worker wrote", async () => {
  const runtime = await shipRuntime();
  const id = "run-panel-surface";
  await enqueueRun(runtime, {runId:id,repo:'https://github.com/team/repo',task:'Surface',model:'test',source:'manual',trust:'operator'});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:'waiting',eventName:'ship-ask-1'});
  await runtime.config.set("SHIP_TAKEOVER_REPLY_"+id, JSON.stringify({
    id: "r-1", at: new Date().toISOString(), kind: "takeover-console", running: true, output: "$ echo hi\n…",
  }));
  const data = await run.loader({params:{id},request:request("/runs/"+id,{})});
  assert.equal(data.takeover.reply?.running, true);
  assert.equal(data.takeover.reply?.id, "r-1");
  assert.equal(data.takeoverTab, "console");
});

test("the browser tab: steer authority per POST, action shape recorded, file:// refused, reply surfaced", async () => {
  const runtime = await shipRuntime();
  const id = "run-browser-tab";
  await enqueueRun(runtime, {runId:id,repo:'https://github.com/team/repo',task:'Browser',model:'test',source:'manual',trust:'operator'});
  const meta = await runtime.loadMeta(id); assert.ok(meta);
  await runtime.saveMeta({...meta,status:'waiting',eventName:'ship-ask-1'});
  // no credential: the steer grant is re-checked on every POST
  const denied = await run.action({params:{id},request:new Request("http://localhost/runs/"+id,{method:"POST",body:new URLSearchParams({intent:"takeover-browser",tab:"browser",browser:JSON.stringify({action:"navigate",url:"http://localhost:8000/"})})})});
  assert.match(denied.headers.get("location") ?? "", /denied=steer/);
  // an authorized POST rides the redirect back to the browser tab
  const res = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-browser",tab:"browser",browser:JSON.stringify({action:"navigate",url:"http://localhost:8000/"})})});
  assert.match(res.headers.get("location") ?? "", /takeover=pending&tab=browser/);
  const recorded = JSON.parse((await runtime.config.get("SHIP_WORKSPACE_REQUEST_"+id))!);
  assert.equal(recorded.kind, "takeover-browser");
  assert.deepEqual(recorded.browser, { action: "navigate", url: "http://localhost:8000/" });
  assert.equal(typeof recorded.by, "string");
  // file:// is refused at request time, with the reason on the redirect
  const refused = await run.action({params:{id},request:request("/runs/"+id,{intent:"takeover-browser",tab:"browser",browser:JSON.stringify({action:"navigate",url:"file:///etc/passwd"})})});
  assert.match(decodeURIComponent(refused.headers.get("location") ?? ""), /http and https only/);
  // the worker's browser reply (screenshot + page state) surfaces through the loader
  await runtime.config.set("SHIP_TAKEOVER_REPLY_"+id, JSON.stringify({
    id: "r-b1", at: new Date().toISOString(), kind: "takeover-browser",
    output: "Browser navigate http://localhost:8000/ — http://localhost:8000/ (1280x800, png, 1.2 KB).",
    browser: { artifact: "a".repeat(64), url: "http://localhost:8000/", width: 1280, height: 800, format: "png" },
  }));
  const data = await run.loader({params:{id},request:new Request("http://localhost/runs/"+id+"?tab=browser",{})});
  assert.equal(data.takeoverTab, "browser");
  // only a well-formed artifact reference survives the loader; the screenshot itself never rides the reply
  assert.equal(data.takeover.reply?.browser?.artifact, "a".repeat(64));
  assert.equal((data.takeover.reply?.browser as Record<string, unknown> | undefined)?.image, undefined);
  await runtime.config.set("SHIP_TAKEOVER_REPLY_"+id, JSON.stringify({
    id: "r-b2", at: new Date().toISOString(), kind: "takeover-browser", output: "x",
    browser: { artifact: "../../etc/passwd", image: "aGVsbG8=" },
  }));
  const hostile = await run.loader({params:{id},request:new Request("http://localhost/runs/"+id+"?tab=browser",{})});
  assert.equal(hostile.takeover.reply?.browser?.artifact, undefined, "a malformed reference is dropped, not rendered into a URL");
  assert.equal(data.takeover.reply?.browser?.url, "http://localhost:8000/");
});
