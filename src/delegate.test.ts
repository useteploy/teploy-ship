import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, completeSleep, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { DELEGATE_HELP, DELEGATE_TASK_MAX, parseAction, transcriptTurn } from "./actions.js";
import type { ActionDialect } from "./actions.js";
import { systemPrompt } from "./prompt.js";
import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import {
  DELEGATE_CHILD_REFUSED,
  DELEGATE_MAX_CEILING,
  DELEGATE_MAX_DEFAULT,
  DELEGATE_UNAVAILABLE,
  childTaskPrompt,
  delegateCapMessage,
  delegateMaxChildren,
  delegatedChildRunId,
  delegationKey,
  parseDelegationRecord,
  registerDelegateControl,
  transferFromEvents,
  transferObservation,
} from "./delegate.js";
import type { DelegateControl, DelegateTransfer } from "./delegate.js";
import { delegateControlFromRuntime, enqueueRun, fileRuntime } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

const ON: ActionDialect = { delegate: true };

// A model that reacts to the last observation, counting its calls so tests
// can prove replay never re-invoked it (durable.test.ts's reactiveModel).
function reactiveModel(turns: Array<string | ((obs: string) => string)>): { model: ModelAdapter; callCount: () => number } {
  let index = 0;
  let calls = 0;
  return {
    callCount: () => calls,
    model: {
      provider: "scripted",
      modelId: "s1",
      async doGenerate(options): Promise<AdapterGenerateResult> {
        calls++;
        const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
        const obs = typeof lastUser?.content === "string" ? lastUser.content : "";
        const turn = turns[index++] ?? "```finish\nout of script\n```";
        const text = typeof turn === "function" ? turn(obs) : turn;
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

// The executor shape durable.test.ts's localProvider builds: one real
// LocalExecutor attached to every handle, so parks restore into it fine.
async function localProvider(snapshot = false): Promise<ExecutorProvider> {
  const root = await mkdtemp(join(tmpdir(), "delegate-"));
  const executor: AgentExecutor = new LocalExecutor({ root });
  let restores = 0;
  return {
    async create() {
      return { handle: `local:${root}` };
    },
    attach() {
      return executor;
    },
    ...(snapshot
      ? {
          snapshot: async () => "image-0",
          createFrom: async () => ({ handle: `local-restored-${++restores}` }),
        }
      : {}),
  };
}

/** A control whose child materialises only when the test says so. */
function fakeControl(): {
  control: DelegateControl;
  spawnCount: () => number;
  finish: (transfer: DelegateTransfer) => void;
  spawned: () => string[];
} {
  let ready: DelegateTransfer | null = null;
  const spawned: string[] = [];
  const control: DelegateControl = {
    async spawn(request) {
      spawned.push(request.task);
      return { ok: true, childRunId: `run-del-fake-${spawned.length}` };
    },
    async outcome() {
      return ready;
    },
  };
  return { control, spawnCount: () => spawned.length, finish: (t) => (ready = t), spawned: () => spawned };
}

// ---------------------------------------------------------------- flag-off equivalence

test("a ```delegate block parses as `none` unless the dialect admits it — flag-off is pre-feature bytes", () => {
  const text = "Splitting this off.\n```delegate path=src/foo\nDo the foo work.\n```";
  assert.deepEqual(parseAction(text), { kind: "none" });
  // The transcript keeps the whole turn — nothing was cut at an action fence.
  assert.equal(transcriptTurn(text), text);
  // The prompt does not mention the action either.
  const off = systemPrompt({ workdir: "/work", task: "t" });
  assert.ok(!off.includes("# Delegating work"));
  assert.ok(!off.includes("```delegate"));
});

test("the dialect parses ```delegate with task and scope hints", () => {
  assert.deepEqual(parseAction("```delegate\nDo the work.\n```", ON), { kind: "delegate", task: "Do the work." });
  assert.deepEqual(parseAction("```delegate path=src/foo\nDo the work.\n```", ON), {
    kind: "delegate",
    task: "Do the work.",
    path: "src/foo",
  });
  assert.deepEqual(parseAction("```delegate repo=https://forge.example/team/repo.git path=src/foo\nDo the work.\n```", ON), {
    kind: "delegate",
    task: "Do the work.",
    repo: "https://forge.example/team/repo.git",
    path: "src/foo",
  });
});

test("```delegate validation refuses what the loop could not honour", () => {
  assert.deepEqual(parseAction("```delegate\n```", ON), { kind: "invalid", message: "```delegate block needs the child's task in its body, e.g.\n```delegate path=src/foo\nMake the foo parser accept RFC 3339 durations. Add tests.\n```" });
  const badRepo = parseAction("```delegate repo=not-a-url\nx\n```", ON);
  assert.ok(badRepo.kind === "invalid" && badRepo.message.includes("full clone URL"));
  const badPath = parseAction("```delegate path=../etc\nx\n```", ON);
  assert.ok(badPath.kind === "invalid" && badPath.message.includes("'..' is not allowed"));
  const long = parseAction(`\`\`\`delegate\n${"x".repeat(DELEGATE_TASK_MAX + 10)}\n\`\`\``, ON);
  assert.ok(long.kind === "delegate" && long.task.length <= DELEGATE_TASK_MAX + 100 && long.task.includes("task clamped"));
  assert.ok(DELEGATE_HELP.includes("```delegate"));
});

test("the prompt offers delegation only when the run input admits it", () => {
  const on = systemPrompt({ workdir: "/work", task: "t", delegate: true });
  assert.ok(on.includes("# Delegating work"));
  assert.ok(on.includes("hard-capped"));
});

// ---------------------------------------------------------------- pure helpers

test("delegateMaxChildren defaults narrow and clamps wide", () => {
  assert.equal(delegateMaxChildren({}), DELEGATE_MAX_DEFAULT);
  assert.equal(delegateMaxChildren({ SHIP_DELEGATE_MAX: "garbage" }), DELEGATE_MAX_DEFAULT);
  assert.equal(delegateMaxChildren({ SHIP_DELEGATE_MAX: "0" }), DELEGATE_MAX_DEFAULT);
  assert.equal(delegateMaxChildren({ SHIP_DELEGATE_MAX: "5" }), 5);
  assert.equal(delegateMaxChildren({ SHIP_DELEGATE_MAX: "500" }), DELEGATE_MAX_CEILING);
});

test("child run ids are deterministic per (task root, index) and records parse or refuse", () => {
  assert.equal(delegatedChildRunId("run-root", 1), delegatedChildRunId("run-root", 1));
  assert.notEqual(delegatedChildRunId("run-root", 1), delegatedChildRunId("run-root", 2));
  const record = { taskRootRunId: "run-root", entries: [{ index: 1, parentRunId: "run-a", turn: 0, childRunId: "run-del-x", task: "t", at: "now" }] };
  assert.deepEqual(parseDelegationRecord(JSON.stringify(record), "run-root"), record);
  assert.equal(parseDelegationRecord(JSON.stringify(record), "run-other"), null);
  assert.equal(parseDelegationRecord("not json", "run-root"), null);
  assert.equal(parseDelegationRecord(undefined, "run-root"), null);
});

test("transferFromEvents projects a child's terminal log, and null before it", () => {
  const id = "run-child";
  assert.equal(transferFromEvents(id, [{ type: "step-completed", name: "sandbox", data: { result: "h" } }]), null);
  assert.equal(transferFromEvents(id, []), null);
  const completed: WorkflowEvent[] = [
    { v: 1, seq: 1, type: "run-completed", at: "now", data: { output: { summary: "Fixed the parser; tests pass.", pr: "https://forge/x/pull/1" } } },
  ];
  assert.deepEqual(transferFromEvents(id, completed), { childRunId: id, status: "completed", summary: "Fixed the parser; tests pass.", pr: "https://forge/x/pull/1" });
  const failed: WorkflowEvent[] = [{ v: 1, seq: 1, type: "run-failed", at: "now", data: { error: { message: "Model call failed: 500" } } }];
  assert.deepEqual(transferFromEvents(id, failed), { childRunId: id, status: "failed", summary: "Model call failed: 500" });
  const cancelled: WorkflowEvent[] = [{ v: 1, seq: 1, type: "run-cancelled", at: "now", data: { reason: "operator" } }];
  assert.deepEqual(transferFromEvents(id, cancelled), { childRunId: id, status: "cancelled", summary: "operator" });
});

test("the transfer observation names the child, its status, and what to do about a failure", () => {
  const ok = transferObservation({ childRunId: "run-del-1", status: "completed", summary: "All tests pass." });
  assert.ok(ok.startsWith("Delegated run run-del-1 completed:"));
  assert.ok(ok.includes("All tests pass."));
  assert.ok(!ok.includes("FAILED"));
  const failed = transferObservation({ childRunId: "run-del-1", status: "failed", summary: "boom" });
  assert.ok(failed.includes("The child FAILED"));
  const cancelled = transferObservation({ childRunId: "run-del-1", status: "cancelled", summary: "stopped" });
  assert.ok(cancelled.includes("CANCELLED"));
  assert.ok(transferObservation({ childRunId: "r", status: "completed", summary: "s", pr: "https://x/1" }).includes("Pull request: https://x/1"));
});

test("the child task prompt states lineage and the standalone-brief rule", () => {
  const task = childTaskPrompt({ parentRunId: "run-parent", turn: 3, task: "Do the work.", repo: "https://forge.example/team/repo.git", path: "src/foo" });
  assert.ok(task.includes("[Delegated task, claimed by run run-parent at its turn 3]"));
  assert.ok(task.includes("https://forge.example/team/repo.git"));
  assert.ok(task.includes("scoped to src/foo/"));
  assert.ok(task.endsWith("Do the work."));
});

// ---------------------------------------------------------------- the runtime control

/** A file runtime in a throwaway state dir, with the env the test wants. */
async function fileRuntimeIn(env: Record<string, string>): Promise<{ runtime: ShipRuntime; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "ship-delegate-"));
  const saved = { ...process.env } as Record<string, string | undefined>;
  process.env.TEPLOY_SHIP_STATE = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const k of Object.keys(env)) if (!(k in saved)) delete (saved as Record<string, string>)[k];
  return {
    runtime: fileRuntime(),
    restore: () => {
      for (const key of Object.keys({ ...env, TEPLOY_SHIP_STATE: "" })) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}

/** Enqueue a parent by hand so the test controls its recorded gates and meta. */
async function enqueueParent(
  runtime: ShipRuntime,
  runId: string,
  input: Record<string, unknown>,
  meta: { source?: string; model?: string },
): Promise<void> {
  const started: WorkflowEvent = {
    v: 1,
    seq: 0,
    type: "run-started",
    at: new Date().toISOString(),
    data: { workflow: "coding-agent", taskRootRunId: runId, input },
  };
  await runtime.store.append(runId, started);
  await runtime.saveMeta({
    runId,
    task: "parent task",
    model: meta.model ?? "test-model",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(meta.source !== undefined ? { source: meta.source } : {}),
  });
}

const childInputOf = async (runtime: ShipRuntime, runId: string): Promise<Record<string, unknown>> => {
  const started = (await runtime.store.load(runId)).find((e) => e.type === "run-started");
  return ((started?.data as { input?: Record<string, unknown> })?.input ?? {}) as Record<string, unknown>;
};

test("spawn records lineage, inherits gates and source, and never admits delegation on the child", async () => {
  const { runtime, restore } = await fileRuntimeIn({ SHIP_DELEGATE: "on" });
  try {
    await enqueueParent(
      runtime,
      "run-parent",
      { task: "parent task", repo: "https://forge.example/team/repo.git", trust: "external", plan: true, sandboxNetwork: "allowlist" },
      { source: "github", model: "glm-5.3" },
    );
    const control = delegateControlFromRuntime(runtime);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 2, task: "Child task." });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.reason);
    const childId = (spawned as { childRunId: string }).childRunId;
    assert.equal(childId, delegatedChildRunId("run-parent", 1));

    // Lineage: parentRunId threads the child under the parent (and the task
    // root follows it in enqueueRun), and the child is marked a delegateChild.
    const input = await childInputOf(runtime, childId);
    assert.equal(input.parentRunId, "run-parent");
    assert.equal(input.delegateChild, true);
    // The one-level rule at enqueue: SHIP_DELEGATE=on does NOT reach the child.
    assert.equal(input.delegate, undefined);
    // Gates: trust, plan and the declared network tier are copied, never widened.
    assert.equal(input.trust, "external");
    assert.equal(input.plan, true);
    assert.equal(input.sandboxNetwork, "allowlist");
    assert.equal(input.repo, "https://forge.example/team/repo.git");
    // Spend: the child carries the parent's source, so its settle lands in
    // the same (source, day) bucket the daily cap reads.
    const meta = await runtime.loadMeta(childId);
    assert.equal(meta?.source, "github");
    assert.equal(meta?.model, "glm-5.3");
    // The task is the framed child prompt, not the bare fence body.
    const task = typeof input.task === "string" ? input.task : "";
    assert.ok(task.includes("[Delegated task, claimed by run run-parent at its turn 2]"));
    assert.ok(task.endsWith("Child task."));
    // The ledger holds the claim, keyed by the task root.
    const record = parseDelegationRecord(await runtime.config.get(delegationKey("run-parent")), "run-parent");
    assert.equal(record?.entries.length, 1);
    assert.equal(record?.entries[0]?.childRunId, childId);
  } finally {
    restore();
  }
});

test("spawn is idempotent per (parent, turn) and the cap is hard per task root", async () => {
  const { runtime, restore } = await fileRuntimeIn({ SHIP_DELEGATE_MAX: "2" });
  try {
    await enqueueParent(runtime, "run-parent", { task: "t" }, { source: "cli" });
    const control = delegateControlFromRuntime(runtime);
    const first = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "one" });
    assert.ok(first.ok);
    // The SAME (parent, turn) republishes its own child rather than claiming another slot.
    const again = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "one" });
    assert.ok(again.ok && again.childRunId === (first as { childRunId: string }).childRunId);
    const second = await control.spawn({ parentRunId: "run-parent", turn: 3, task: "two" });
    assert.ok(second.ok);
    const third = await control.spawn({ parentRunId: "run-parent", turn: 5, task: "three" });
    assert.ok(!third.ok);
    assert.equal((third as { reason: string }).reason, delegateCapMessage(2));
    const record = parseDelegationRecord(await runtime.config.get(delegationKey("run-parent")), "run-parent");
    assert.equal(record?.entries.length, 2);
  } finally {
    restore();
  }
});

test("a repo hint that names anything but the parent's own repository is refused", async () => {
  const { runtime, restore } = await fileRuntimeIn({});
  try {
    await enqueueParent(runtime, "run-parent", { task: "t", repo: "https://forge.example/team/repo.git" }, { source: "cli" });
    const control = delegateControlFromRuntime(runtime);
    const other = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", repoHint: "https://forge.example/team/other.git" });
    assert.ok(!other.ok && (other as { reason: string }).reason.includes("own repository"));
    // The same repo in a different spelling is the same repository.
    const same = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", repoHint: "https://forge.example/team/repo.git" });
    assert.ok(same.ok);
    // A workspace run (no repo) cannot grant one at all.
    await enqueueParent(runtime, "run-ws", { task: "t" }, { source: "cli" });
    const refused = await control.spawn({ parentRunId: "run-ws", turn: 0, task: "t", repoHint: "https://forge.example/team/repo.git" });
    assert.ok(!refused.ok);
  } finally {
    restore();
  }
});

test("outcome answers null until the child's log is terminal, then the same transfer forever", async () => {
  const { runtime, restore } = await fileRuntimeIn({});
  try {
    await enqueueParent(runtime, "run-parent", { task: "t" }, { source: "cli" });
    const control = delegateControlFromRuntime(runtime);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t" });
    assert.ok(spawned.ok);
    const childId = (spawned as { childRunId: string }).childRunId;
    assert.equal(await control.outcome(childId), null);
    const done: WorkflowEvent = {
      v: 1,
      seq: 5,
      type: "run-completed",
      at: new Date().toISOString(),
      data: { output: { summary: "Child finished the work." } },
    };
    await runtime.store.append(childId, done);
    assert.deepEqual(await control.outcome(childId), { childRunId: childId, status: "completed", summary: "Child finished the work." });
  } finally {
    restore();
  }
});

test("enqueue materialises SHIP_DELEGATE and suppresses it for scans and children", async () => {
  const { runtime, restore } = await fileRuntimeIn({ SHIP_DELEGATE: "1" });
  try {
    await enqueueRun(runtime, { runId: "run-plain", task: "t", model: "m" });
    assert.equal((await childInputOf(runtime, "run-plain")).delegate, true);
    await enqueueRun(runtime, { runId: "run-scan", task: "t", model: "m", mode: "scan" });
    assert.equal((await childInputOf(runtime, "run-scan")).delegate, undefined);
    await enqueueRun(runtime, { runId: "run-kid", task: "t", model: "m", delegateChild: true });
    const kid = await childInputOf(runtime, "run-kid");
    assert.equal(kid.delegateChild, true);
    assert.equal(kid.delegate, undefined);
  } finally {
    restore();
  }
  // Flag OFF: no input field at all — the equivalence the upgrade fence reads.
  const { runtime: off, restore: restoreOff } = await fileRuntimeIn({});
  try {
    await enqueueRun(off, { runId: "run-off", task: "t", model: "m" });
    const started = (await off.store.load("run-off")).find((e) => e.type === "run-started");
    const raw = JSON.stringify((started?.data as { input?: unknown })?.input);
    assert.ok(!raw.includes("delegate"));
  } finally {
    restoreOff();
  }
});

// ---------------------------------------------------------------- the loop

test("a delegate action parks on the child and merges its transfer back as the observation", async () => {
  const { model, callCount } = reactiveModel([
    "```delegate path=src/foo\nMake the foo parser accept durations.\n```",
    (obs) => (obs.includes("Delegated run") && obs.includes("completed:") ? "```bash\necho child-result-received\n```" : "```bash\necho no-transfer\n```"),
    (obs) => (obs.includes("child-result-received") ? "```finish\nDone with the child's result in hand.\n```" : "```bash\necho wrong\n```"),
    // The finish gate holds once for proof; a command and a second finish
    // satisfy it (the same shape durable.test.ts's first test pins).
    (obs) => (obs.includes("Before finishing") ? "```bash\necho proof-of-work\n```" : "```bash\necho unexpected\n```"),
    "```finish\nDone and proven.\n```",
  ]);
  const provider = await localProvider();
  const fake = fakeControl();
  const wf = durableAgent({ model, executor: provider, delegate: fake.control });
  const store = new MemoryEventStore();

  // Pass 1: the delegate turn spawns and parks (sleeping) — no snapshot steps
  // because this provider cannot snapshot, the ask park's own rule.
  const parked = await executeRun({ workflow: wf, runId: "run-parent", store, input: { task: "split the work", delegate: true } });
  assert.equal(parked.status, "sleeping");
  assert.equal(fake.spawnCount(), 1);
  assert.equal(callCount(), 1, "only the delegate turn thought before the park");
  const events = await store.load("run-parent");
  const names = events.filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(names.includes("turn-0-delegate-spawn"));
  assert.ok(names.includes("turn-0-delegate-wait"));
  assert.ok(!names.some((n) => n?.includes("delegate-snapshot")));

  // The child finishes between passes; the worker's wake is completeSleep.
  fake.finish({ childRunId: "run-del-fake-1", status: "completed", summary: "The parser now accepts durations; tests added." });
  await completeSleep(store, "run-parent");

  const done = await executeRun({ workflow: wf, runId: "run-parent", store });
  assert.equal(done.status, "completed");
  // Replay never re-spawned and never re-called the model for the parked turn.
  assert.equal(fake.spawnCount(), 1);
  assert.equal(callCount(), 5);
  const final = (await store.load("run-parent")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(final.includes("turn-1-think"));
  // The wait step recorded exactly two iterations (one poll, one transfer).
  assert.equal(final.filter((n) => n === "turn-0-delegate-wait").length, 2);
  // The transfer is the recorded result the next turn consumed.
  const waits = (await store.load("run-parent")).filter((e) => e.type === "step-completed" && e.name === "turn-0-delegate-wait");
  assert.deepEqual((waits.at(-1)?.data as { result?: unknown }).result, {
    childRunId: "run-del-fake-1",
    status: "completed",
    summary: "The parser now accepts durations; tests added.",
  });
});

test("a snapshot-capable provider parks and restores around the wait", async () => {
  const { model } = reactiveModel([
    "```delegate\nChild task.\n```",
    (obs) => (obs.includes("Delegated run") ? "```bash\necho proof\n```" : "```bash\necho no\n```"),
    "```finish\nDone.\n```",
  ]);
  const provider = await localProvider(true);
  const fake = fakeControl();
  const wf = durableAgent({ model, executor: provider, delegate: fake.control });
  const store = new MemoryEventStore();
  const parked = await executeRun({ workflow: wf, runId: "run-parent", store, input: { task: "t", delegate: true } });
  assert.equal(parked.status, "sleeping");
  fake.finish({ childRunId: "run-del-fake-1", status: "completed", summary: "done" });
  await completeSleep(store, "run-parent");
  const done = await executeRun({ workflow: wf, runId: "run-parent", store });
  assert.equal(done.status, "completed");
  const names = (await store.load("run-parent")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(names.includes("turn-0-delegate-snapshot"));
  assert.ok(names.includes("turn-0-delegate-restore"));
});

test("a delegation child is refused BY NAME, without recording a delegate step", async () => {
  const { model } = reactiveModel([
    "```delegate\nGrandchild task.\n```",
    (obs) => (obs.includes(DELEGATE_CHILD_REFUSED.slice(0, "Delegation refused".length)) ? "```bash\necho doing it myself\n```" : "```bash\necho no-refusal\n```"),
    "```finish\nDone myself.\n```",
  ]);
  const provider = await localProvider();
  const fake = fakeControl();
  const wf = durableAgent({ model, executor: provider, delegate: fake.control });
  const store = new MemoryEventStore();
  const done = await executeRun({ workflow: wf, runId: "run-child", store, input: { task: "t", delegateChild: true } });
  assert.equal(done.status, "completed");
  assert.equal(fake.spawnCount(), 0);
  const names = (await store.load("run-child")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(!names.some((n) => n?.includes("delegate")), "a refused delegation records no delegate step");
});

test("without a control the action degrades to a refusal, never a failed run", async () => {
  // Hermetic: earlier tests in this file registered a runtime control, and
  // this one must prove the NO-control degradation, not accidentally exercise
  // a stale registration pointing at another store.
  registerDelegateControl(undefined);
  try {
    const { model } = reactiveModel([
      "```delegate\nAnything.\n```",
      (obs) => (obs === DELEGATE_UNAVAILABLE ? "```bash\necho fallback\n```" : "```bash\necho wrong\n```"),
      "```finish\nDone without delegating.\n```",
    ]);
    const provider = await localProvider();
    const wf = durableAgent({ model, executor: provider }); // no delegate anywhere
    const store = new MemoryEventStore();
    const done = await executeRun({ workflow: wf, runId: "run-x", store, input: { task: "t", delegate: true } });
    assert.equal(done.status, "completed");
  } finally {
    registerDelegateControl(undefined);
  }
});

test("a refused spawn (the cap) reaches the model as an observation and the run continues", async () => {
  const { model } = reactiveModel([
    "```delegate\nOver the cap.\n```",
    (obs) => (obs.includes("Delegation refused") ? "```bash\necho doing it myself\n```" : "```bash\necho wrong\n```"),
    "```finish\nDone myself.\n```",
  ]);
  const provider = await localProvider();
  const refusing: DelegateControl = {
    async spawn() {
      return { ok: false, reason: delegateCapMessage(2) };
    },
    async outcome() {
      return null;
    },
  };
  const wf = durableAgent({ model, executor: provider, delegate: refusing });
  const store = new MemoryEventStore();
  const done = await executeRun({ workflow: wf, runId: "run-x", store, input: { task: "t", delegate: true } });
  assert.equal(done.status, "completed");
  const names = (await store.load("run-x")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(names.includes("turn-0-delegate-spawn"));
  assert.ok(!names.some((n) => n === "turn-0-delegate-wait"), "a refused spawn never waits");
});

test("the scan belt refuses delegation even on a hand-crafted scan input", async () => {
  const { model } = reactiveModel([
    "```delegate\nShould not happen.\n```",
    (obs) => (obs === DELEGATE_UNAVAILABLE ? `Scanned nothing.\n\nFINDINGS_JSON\n[]` : `Wrong.\n\nFINDINGS_JSON\n[]`),
  ]);
  const provider = await localProvider();
  const fake = fakeControl();
  const wf = durableAgent({ model, executor: provider, delegate: fake.control });
  const store = new MemoryEventStore();
  const done = await executeRun({ workflow: wf, runId: "run-scan", store, input: { task: "t", delegate: true, mode: "scan" } });
  assert.equal(done.status, "completed");
  assert.equal(fake.spawnCount(), 0);
  const names = (await store.load("run-scan")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.ok(!names.some((n) => n?.includes("delegate")), "a scan delegates nothing");
});
