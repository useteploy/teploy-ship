import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePreparation, prepareEnvironment } from "./environment.js";
import { FileArtifacts } from "./artifacts.js";
import { readForgeState } from "./forge-state.js";
import { fileCommand } from "./workspace-requests.js";
import { parseRepoUrl } from "./git.js";

test("preparation bounds, redaction and failures are explicit", async () => {
  assert.throws(() =>
    normalizePreparation({ command: "true", timeoutMs: 900001 }),
  );
  assert.equal(normalizePreparation({ command: "  " }), undefined);
  const outcome = await prepareEnvironment(
    {
      exec: async () => ({
        stdout: "API_KEY=abcdefghi",
        stderr: "install failed",
        exitCode: 1,
      }),
    } as any,
    { command: "npm ci", timeoutMs: 1000 },
  );
  assert.equal(outcome.kind, "failed");
  assert.doesNotMatch(outcome.output, /abcdefghi/);
  assert.match(outcome.output, /install failed/);
});
test("artifacts persist with content identities and reject executable media", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-artifact-test-"));
  const store = new FileArtifacts(dir),
    png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const id = await store.put("test.png", png);
  assert.equal(
    (await new FileArtifacts(dir).get(id))?.data,
    png.toString("base64"),
  );
  assert.equal(await store.get("../../secrets"), null);
  await assert.rejects(
    store.put("x.svg", Buffer.from("<svg onload=alert(1)>")),
  );
  await assert.rejects(
    store.put("large.png", Buffer.alloc(4 * 1024 * 1024 + 1)),
  );
});
test("forge status binds CI to current head and distinguishes missing checks", async () => {
  const calls: string[] = [];
  const fake = async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/pulls/3"))
      return Response.json({
        state: "closed",
        merged: true,
        head: { sha: "abc1234567" },
        base: { ref: "main" },
        title: "Fix",
      });
    if (String(url).includes("/reviews"))
      return Response.json([
        { user: { login: "reviewer" }, state: "APPROVED", body: "Looks good" },
      ]);
    return new Response("unavailable", { status: 403 });
  };
  const result = await readForgeState(
    parseRepoUrl("https://github.com/team/repo"),
    "test-token",
    3,
    fake as any,
  );
  assert.equal(result.state, "merged");
  assert.equal(result.reviews[0]?.author, "reviewer");
  assert.equal(result.checks.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.ok(calls.some((c) => c.includes("/commits/abc1234567/status")));
});
test("repository inspection cannot read arbitrary filesystem paths or execute a filename", () => {
  for (const path of [
    "../secret",
    "/etc/passwd",
    "a/../../secret",
    ".git/config",
    "file\nname",
  ])
    assert.throws(() => fileCommand(path));
  const command = fileCommand("a'$(touch owned).ts");
  assert.match(command, /git --no-pager show/);
  assert.match(command, /'\\''/);
});

test("scheduled work is deduplicated and preserves read-only intent", async () => {
  const { FileRuntimeConfig } = await import("./runtime-config.js");
  const { FileIntakeStore } = await import("./intake.js");
  const { sweepWorkflowSchedules, scheduleKey } = await import(
    "./workflow-schedules.js"
  );
  const dir = await mkdtemp(join(tmpdir(), "ship-schedule-test-"));
  const config = new FileRuntimeConfig(dir),
    intake = new FileIntakeStore(join(dir, "tasks"));
  const now = Date.now(),
    schedule = {
      id: "test",
      name: "Review",
      repo: "team/repo",
      task: "Inspect only",
      mode: "scan",
      plan: false,
      everyMinutes: 60,
      enabled: true,
      createdAt: new Date(now - 7200000).toISOString(),
      by: "tester",
    };
  await config.set(scheduleKey("test"), JSON.stringify(schedule));
  const runtime = {
    config,
    intake,
    projects: {
      forRepo: async () => ({ url: "https://github.com/team/repo" }),
    },
  } as any;
  await sweepWorkflowSchedules(runtime, now);
  await sweepWorkflowSchedules(runtime, now);
  assert.equal((await intake.list()).length, 1);
  assert.equal((await intake.list())[0]?.kind, "workflow-scan");
  await config.set(
    scheduleKey("test"),
    JSON.stringify({ ...schedule, enabled: false }),
  );
  await sweepWorkflowSchedules(runtime, now + 3600000);
  assert.equal((await intake.list()).length, 1);
});

test("worker replies are request-bound and never contact an unapproved forge", async () => {
  const { serveWorkspaceRequests, requestKey, replyKey } = await import(
    "./workspace-requests.js"
  );
  const values = new Map<string, string>();
  values.set(
    requestKey("run-test"),
    JSON.stringify({
      id: "request-1",
      runId: "run-test",
      kind: "forge",
      at: new Date().toISOString(),
      by: "tester",
    }),
  );
  const runtime = {
    config: {
      list: async () => [...values.keys()].map((key) => ({ key })),
      get: async (k: string) => values.get(k),
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
    },
    projects: { list: async () => [] },
    store: {
      load: async () => [
        {
          type: "run-started",
          data: { input: { repo: "https://unapproved.invalid/team/repo" } },
        },
      ],
    },
  } as any;
  await serveWorkspaceRequests(
    runtime,
    {
      attach: () => {
        throw new Error("must not execute");
      },
    } as any,
    { allowlist: "https://github.com/allowed", gitToken: "do-not-send" },
  );
  const reply = JSON.parse(values.get(replyKey("run-test"))!);
  assert.equal(reply.id, "request-1");
  assert.match(reply.error, /refusing repository/);
  assert.doesNotMatch(JSON.stringify(reply), /do-not-send/);
});

test("follow-up checkout refuses a PR closed after its UI check", async () => {
  const {resolvePr}=await import('./git.js');
  const ref=parseRepoUrl('https://github.com/team/repo');
  await assert.rejects(resolvePr(ref,'token',1,(async()=>Response.json({state:'closed',merged:true,head:{ref:'feature'},base:{ref:'main'}})) as any,true),/no longer open/);
});

test("live workspace inspection shows tracked edits without invoking repository diff helpers", async () => {
  const {hostRunner}=await import("./deploy.js");
  const {writeFile,rm}=await import("node:fs/promises");
  const {changesCommand}=await import("./workspace-requests.js");
  const dir=await mkdtemp(join(tmpdir(),"ship-live-diff-"));
  const run=hostRunner();
  const exec=async(argv:string[])=>{const r=await run(argv,{cwd:dir,timeoutMs:10000});assert.equal(r.code,0,r.stderr);return r.stdout;};
  try {
    await exec(["git","init"]);await exec(["git","config","user.name","Test"]);await exec(["git","config","user.email","test@example.invalid"]);
    await writeFile(join(dir,"file.txt"),"original\n");await exec(["git","add","file.txt"]);await exec(["git","commit","-m","Initial"]);
    await exec(["git","config","diff.external","must-not-run"]);
    await exec(["git","config","core.fsmonitor","must-not-run"]);
    await writeFile(join(dir,"file.txt"),"edited\n");await writeFile(join(dir,"untracked.txt"),"never-read-this-content");
    const output=await exec(["sh","-c",changesCommand()]);
    assert.match(output,/file.txt/);assert.match(output,/\+edited/);assert.match(output,/untracked.txt/);
    assert.doesNotMatch(output,/never-read-this-content/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("background forge refresh cannot replace the last workspace inspection",async()=>{
  const {workspaceInspection,replyKey}=await import("./workspace-requests.js");
  const rows=new Map<string,string>([[replyKey("run-test"),JSON.stringify({id:"forge",at:"now",forge:{}})],["SHIP_WORKSPACE_INSPECTION_run-test",JSON.stringify({id:"files",kind:"changes",at:"then",output:"local edits"})]]);
  const result=await workspaceInspection({config:{get:async(k:string)=>rows.get(k)} as any},"run-test");
  assert.equal(result?.id,"files");assert.equal(result?.output,"local edits");
});

test("inspection attaches to the latest restored workspace handle",async()=>{
  const {serveWorkspaceRequests,requestKey}=await import("./workspace-requests.js");
  const rows=new Map<string,string>([[requestKey("run-restored"),JSON.stringify({id:"inspect",runId:"run-restored",kind:"changes",at:new Date().toISOString(),by:"test"})]]);
  const runtime={config:{list:async()=>[...rows.keys()].map(key=>({key})),get:async(key:string)=>rows.get(key),set:async(key:string,value:string)=>{rows.set(key,value);}},projects:{list:async()=>[]},store:{load:async()=>[{type:"run-started",data:{input:{repo:"https://github.com/team/repo"}}},{type:"step-completed",name:"sandbox",data:{result:"expired"}},{type:"step-completed",name:"merge-restore",data:{result:{handle:"restored"}}}]}} as any;
  let attached="";
  await serveWorkspaceRequests(runtime,{attach:(handle:string)=>{attached=handle;return {exec:async()=>({exitCode:0,stdout:" M file.txt",stderr:""})};}} as any,{allowlist:"https://github.com/team"});
  assert.equal(attached,"restored");
  assert.equal(JSON.parse(rows.get("SHIP_WORKSPACE_INSPECTION_run-restored")!).kind,"changes");
});
