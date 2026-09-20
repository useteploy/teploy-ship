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
    body: new URLSearchParams(fields),
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
  assert.equal(input.input.environmentCheck,true);assert.equal(input.input.mode,'scan');assert.equal(input.input.preparation.command,'npm ci');
  assert.equal(input.input.autoMerge,undefined);
});
