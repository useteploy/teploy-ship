import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowEvent } from "@neutron-build/workflow";

process.env.SHIP_WEB_TOKEN = "fork-test-token";
process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-fork-web-"));
process.env.SHIP_FORK = "on";

const { action } = await import("../routes/runs/[id].js");
const { shipRuntime } = await import("./store.server.js");
const { signSession, SESSION_COOKIE } = await import("./session.server.js");

/**
 * DF1 (SHIP_FORK): the run page's fork action, through the real route handler
 * and the file runtime — the same shape launch-recovery.test.ts uses for the
 * recovery route. Everything the negative controls need is observable in the
 * redirect and the stores: a refused fork must leave nothing behind.
 */
const runtime = await shipRuntime();
await runtime.governance.setAuthority("approve", { roles: ["admin", "editor"], users: [] });

const AT = "2026-10-17T09:00:00.000Z";
const SHA = "fedcba0987654321fedcba0987654321fedcba09";

function ev(seq: number, type: WorkflowEvent["type"], name: string | undefined, data: unknown): WorkflowEvent {
  return { v: 1, seq, type, at: AT, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/** A settled source run that pushed one commit, as the store holds it. */
async function seedSource(runId: string, status: string): Promise<void> {
  await runtime.store.append(runId, ev(0, "run-started", undefined, {
    workflow: "coding-agent",
    taskRootRunId: runId,
    input: { task: `Task of ${runId}`, repo: "https://git.example.com/a/b", trust: "operator" },
  }));
  await runtime.store.append(runId, ev(1, "step-completed", "repo-setup", { result: { branch: `ship/${runId}`, base: "main" } }));
  await runtime.store.append(runId, ev(2, "step-completed", "repo-push", { result: { kind: "pushed", sha: SHA } }));
  await runtime.saveMeta({ runId, task: `Task of ${runId}`, model: "test-model", status, createdAt: AT, updatedAt: AT });
}

function post(runId: string, fields: Record<string, string>, role: "admin" | "viewer" = "admin"): Request {
  return new Request(`http://ship.test/runs/${runId}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}` },
    body: new URLSearchParams(fields),
  });
}

const forkForm = (): Record<string, string> => ({ intent: "fork", message: "Take this work further, differently", journey: "change", requestId: randomUUID() });
const locationOf = async (response: Promise<Response>): Promise<string> => (await response).headers.get("location") ?? "";
/** How many fork runs exist — a refused fork must never add one. */
const forkRunCount = async (): Promise<number> => (await runtime.listMeta({ limit: 100 })).filter((m) => m.runId.startsWith("run-request-")).length;

test("the fork action enqueues a new task root from the recorded push and touches nothing of the source", async () => {
  await seedSource("run-fsrc1", "completed");
  const before = (await runtime.store.load("run-fsrc1")).length;
  const form = forkForm();
  const location = await locationOf(action({ request: post("run-fsrc1", form), params: { id: "run-fsrc1" } }));
  const forkRunId = location.replace(/^\/runs\//, "").split("?")[0]!;
  assert.match(forkRunId, /^run-request-[a-f0-9]{32,}$/);

  const started = (await runtime.store.load(forkRunId)).find((e) => e.type === "run-started");
  const data = started?.data as { taskRootRunId?: string; input?: { forkOf?: { runId: string; sha?: string; branch?: string }; task?: string; parentRunId?: string; pr?: number } };
  assert.deepEqual(data.input!.forkOf, { runId: "run-fsrc1", sha: SHA, branch: "ship/run-fsrc1" });
  assert.equal(data.taskRootRunId, forkRunId, "the fork anchors itself, not the source's thread");
  assert.equal(data.input!.parentRunId, undefined);
  assert.equal(data.input!.pr, undefined, "no PR: the fork opens its own");
  assert.match(data.input!.task ?? "", /Recorded: this run forks run-fsrc1/);
  assert.match(data.input!.task ?? "", new RegExp(SHA));

  // The source is untouched: same events, still settled, no new runs beyond the fork.
  assert.equal((await runtime.store.load("run-fsrc1")).length, before, "not one event appended to the source");
  assert.equal((await runtime.loadMeta("run-fsrc1"))!.status, "completed");
  const ids = (await runtime.listMeta({ limit: 100 })).map((m) => m.runId);
  assert.deepEqual(ids.filter((id) => id.startsWith("run-request-")), [forkRunId]);

  // A retry with the same requestId and fields republishes the same fork.
  const retry = await locationOf(action({ request: post("run-fsrc1", form), params: { id: "run-fsrc1" } }));
  assert.equal(retry.replace(/^\/runs\//, "").split("?")[0], forkRunId);
  assert.equal(await forkRunCount(), 1);
});

test("the fork action refuses an in-flight source by name and enqueues nothing", async () => {
  await seedSource("run-fsrc2", "running");
  const location = await locationOf(action({ request: post("run-fsrc2", forkForm()), params: { id: "run-fsrc2" } }));
  assert.match(decodeURIComponent(location), /messageError=[^]*FORK_SOURCE_NOT_SETTLED/);
  assert.match(decodeURIComponent(location), /run-fsrc2/);
  assert.equal(await forkRunCount(), 1, "no ghost fork run");
});

test("flag off: the route itself refuses, whatever the page would have offered", async () => {
  await seedSource("run-fsrc3", "completed");
  const saved = process.env.SHIP_FORK;
  process.env.SHIP_FORK = "off";
  try {
    const location = await locationOf(action({ request: post("run-fsrc3", forkForm()), params: { id: "run-fsrc3" } }));
    assert.match(decodeURIComponent(location), /messageError=[^]*SHIP_FORK/);
    assert.equal(await forkRunCount(), 1, "nothing enqueued");
  } finally {
    if (saved !== undefined) process.env.SHIP_FORK = saved;
  }
});

test("the fork takes follow-up authority: a viewer is denied by name", async () => {
  await seedSource("run-fsrc4", "completed");
  const location = await locationOf(action({ request: post("run-fsrc4", forkForm(), "viewer"), params: { id: "run-fsrc4" } }));
  assert.match(location, /denied=approve/);
  assert.equal(await forkRunCount(), 1, "nothing enqueued");
});
