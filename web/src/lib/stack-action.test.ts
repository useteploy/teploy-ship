import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowEvent } from "@neutron-build/workflow";

process.env.SHIP_WEB_TOKEN = "stack-test-token";
process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-stack-web-"));
process.env.SHIP_STACKED_PRS = "on";

const { action, loader } = await import("../routes/runs/[id].js");
const { shipRuntime } = await import("./store.server.js");
const { signSession, SESSION_COOKIE } = await import("./session.server.js");

/**
 * DS1 (SHIP_STACKED_PRS): the run page's stack action, through the real route
 * handler and the file runtime — the same shape fork-action.test.ts uses for
 * the fork. Everything the negative controls need is observable in the
 * redirect and the stores: a refused stack must leave nothing behind.
 */
const runtime = await shipRuntime();
await runtime.governance.setAuthority("approve", { roles: ["admin", "editor"], users: [] });

const AT = "2026-10-17T09:00:00.000Z";
const SHA = "fedcba0987654321fedcba0987654321fedcba09";

function ev(seq: number, type: WorkflowEvent["type"], name: string | undefined, data: unknown): WorkflowEvent {
  return { v: 1, seq, type, at: AT, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/**
 * A base run's log as the store holds it: opened PR #3 from its own work
 * branch and pushed one commit — the two recorded facts a stack stands on.
 * `withoutPr` drops the `repo-pr` step for the no-open-PR control.
 */
async function seedBase(runId: string, status: string, withoutPr = false): Promise<void> {
  await runtime.store.append(runId, ev(0, "run-started", undefined, {
    workflow: "coding-agent",
    taskRootRunId: runId,
    input: { task: `Task of ${runId}`, repo: "https://git.example.com/a/b", trust: "operator" },
  }));
  await runtime.store.append(runId, ev(1, "step-completed", "repo-setup", { result: { branch: `ship/${runId}`, base: "main" } }));
  if (!withoutPr) {
    await runtime.store.append(runId, ev(2, "step-completed", "repo-pr", { result: { number: 3, url: "https://git.example.com/a/b/pulls/3" } }));
  }
  await runtime.store.append(runId, ev(3, "step-completed", "repo-push", { result: { kind: "pushed", sha: SHA } }));
  await runtime.saveMeta({ runId, task: `Task of ${runId}`, model: "test-model", status, createdAt: AT, updatedAt: AT });
}

function post(runId: string, fields: Record<string, string>, role: "admin" | "viewer" = "admin"): Request {
  return new Request(`http://ship.test/runs/${runId}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}` },
    body: new URLSearchParams(fields),
  });
}

const stackForm = (): Record<string, string> => ({ intent: "stack", message: "Add the migration on top", journey: "change", requestId: randomUUID() });
const locationOf = async (response: Promise<Response>): Promise<string> => (await response).headers.get("location") ?? "";
/** How many stacked runs exist — a refused stack must never add one. */
const stackRunCount = async (): Promise<number> => (await runtime.listMeta({ limit: 100 })).filter((m) => m.runId.startsWith("run-request-")).length;

test("the stack action enqueues a change on the base's recorded head and touches nothing of the base", async () => {
  await seedBase("run-sbase1", "completed");
  const before = (await runtime.store.load("run-sbase1")).length;
  const form = stackForm();
  const location = await locationOf(action({ request: post("run-sbase1", form), params: { id: "run-sbase1" } }));
  const stackRunId = location.replace(/^\/runs\//, "").split("?")[0]!;
  assert.match(stackRunId, /^run-request-[a-f0-9]{32,}$/);

  const started = (await runtime.store.load(stackRunId)).find((e) => e.type === "run-started");
  const data = started?.data as { taskRootRunId?: string; input?: { stack?: { runId: string; pr: number; branch: string; sha: string }; task?: string; parentRunId?: string; pr?: number } };
  assert.deepEqual(data.input!.stack, { runId: "run-sbase1", pr: 3, branch: "ship/run-sbase1", sha: SHA });
  assert.equal(data.taskRootRunId, stackRunId, "the stack stands alone as a task, like a fork");
  assert.equal(data.input!.parentRunId, undefined);
  assert.equal(data.input!.pr, undefined, "no pr: the stacked run opens its own, against the base's branch");
  assert.match(data.input!.task ?? "", /Recorded: this run stacks on run-sbase1/);
  assert.match(data.input!.task ?? "", /pull request #3/);
  assert.match(data.input!.task ?? "", new RegExp(SHA));

  // The base is untouched: same events, still settled, no new runs beyond the stack.
  assert.equal((await runtime.store.load("run-sbase1")).length, before, "not one event appended to the base");
  assert.equal((await runtime.loadMeta("run-sbase1"))!.status, "completed");
  const ids = (await runtime.listMeta({ limit: 100 })).map((m) => m.runId);
  assert.deepEqual(ids.filter((id) => id.startsWith("run-request-")), [stackRunId]);

  // A retry with the same requestId and fields republishes the same stack.
  const retry = await locationOf(action({ request: post("run-sbase1", form), params: { id: "run-sbase1" } }));
  assert.equal(retry.replace(/^\/runs\//, "").split("?")[0], stackRunId);
  assert.equal(await stackRunCount(), 1);

  // The lineage line's payload (#132): the stacked run's page reads its base
  // off the recorded input — runId, pr, branch and the head it was cut at —
  // exactly the way the fork page reads forkedFrom. The base's own page
  // carries no such key.
  const page = await loader({ params: { id: stackRunId }, request: new Request(`http://ship.test/runs/${stackRunId}`) });
  assert.deepEqual(page.stackedOn, { runId: "run-sbase1", pr: 3, branch: "ship/run-sbase1", sha: SHA });
  const basePage = await loader({ params: { id: "run-sbase1" }, request: new Request("http://ship.test/runs/run-sbase1") });
  assert.equal(basePage.stackedOn, undefined, "a non-stacked run renders no lineage: the key sits undefined exactly like forkedFrom");
});

test("the stack action refuses a base without an open pull request of its own and enqueues nothing", async () => {
  await seedBase("run-sbase2", "completed", true);
  const location = await locationOf(action({ request: post("run-sbase2", stackForm()), params: { id: "run-sbase2" } }));
  assert.match(decodeURIComponent(location), /messageError=[^]*no open pull request of its own/);
  assert.match(decodeURIComponent(location), /run-sbase2/);
  assert.equal(await stackRunCount(), 1, "no ghost stack run");
});

test("flag off: the route itself refuses, whatever the page would have offered", async () => {
  await seedBase("run-sbase3", "completed");
  const saved = process.env.SHIP_STACKED_PRS;
  delete process.env.SHIP_STACKED_PRS;
  try {
    const location = await locationOf(action({ request: post("run-sbase3", stackForm()), params: { id: "run-sbase3" } }));
    assert.match(decodeURIComponent(location), /messageError=[^]*SHIP_STACKED_PRS/);
    assert.equal(await stackRunCount(), 1, "nothing enqueued");
  } finally {
    if (saved !== undefined) process.env.SHIP_STACKED_PRS = saved;
  }
});

test("the stack takes follow-up authority: a viewer is denied by name", async () => {
  await seedBase("run-sbase4", "completed");
  const location = await locationOf(action({ request: post("run-sbase4", stackForm(), "viewer"), params: { id: "run-sbase4" } }));
  assert.match(location, /denied=approve/);
  assert.equal(await stackRunCount(), 1, "nothing enqueued");
});

test("a manually launched stack-rebase intake task carries its stack facts like the worker's auto-launch (live 2026-10-18)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../routes/index.tsx", import.meta.url), "utf8");
  const launch = src.slice(src.indexOf('intent === "launch-task" || intent === "retry-task" || intent === "dismiss-task") {'));
  assert.match(launch.slice(0, launch.indexOf("} catch (error)")), /task\.stack !== undefined \? \{ stackRebase: task\.stack \}/);
});
