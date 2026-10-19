import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";

import {
  FORK_SOURCE_NOT_SETTLED,
  forkEnabled,
  forkNote,
  forkSourceNotSettled,
  isForkableSourceStatus,
  resolveForkSource,
  type ForkSourceDeps,
} from "./fork.js";
import { MERGE_EVENT, PLAN_EVENT } from "./plan.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { stepFingerprint } from "./step-fingerprint.js";
import type { RecordedInput } from "./step-fingerprint.js";

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-17T09:00:00Z") + minute * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/** Run SHIP_FORK set to `value` (undefined = unset) around one async body. */
async function withForkEnv<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env.SHIP_FORK;
  if (value === undefined) delete process.env.SHIP_FORK;
  else process.env.SHIP_FORK = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SHIP_FORK;
    else process.env.SHIP_FORK = saved;
  }
}

test("the flag is on unless explicitly off (unset means on)", () => {
  for (const on of ["on", "ON", " on ", "1", "true", "yes", "", "nope", undefined]) assert.equal(forkEnabled({ ...(on !== undefined ? { SHIP_FORK: on } : {}) }), true, String(on));
  for (const off of ["off", "OFF", " 0 ", "0", "false", "no"]) assert.equal(forkEnabled({ SHIP_FORK: off }), false, off);
});

test("the forkable set: settled runs and the merge park, nothing in flight", () => {
  // T3's isForkableSourceRunStatus admits settled + waiting; Ship's waiting is
  // several parks, so only the merge review (published work, one decision
  // outstanding) joins the settled set. Everything else refuses below.
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(isForkableSourceStatus(status), true, status);
  assert.equal(isForkableSourceStatus("waiting", MERGE_EVENT), true, "parked at merge review");
  for (const refused of ["queued", "running", "cancelling", "waiting"]) assert.equal(isForkableSourceStatus(refused), false, refused);
  assert.equal(isForkableSourceStatus("waiting", PLAN_EVENT), false, "a plan park is not finished work");
  assert.equal(isForkableSourceStatus("waiting", "turn-3-ask"), false, "an ask park is not finished work");
});

test("an unforkable source is refused by name, with its state", () => {
  const reason = forkSourceNotSettled("run-src1", "running");
  assert.ok(reason.includes(FORK_SOURCE_NOT_SETTLED), "the refusal carries its code");
  assert.ok(reason.includes("run-src1"), "names the run");
  assert.ok(reason.includes("is running"), "names the state");
  const parked = forkSourceNotSettled("run-src1", "waiting", PLAN_EVENT);
  assert.ok(parked.includes(`waiting on ${PLAN_EVENT}`), "a park names what it waits on");
});

/** The store fake resolveForkSource reads: one source run's meta and log. */
function sourceDeps(status: string, events: WorkflowEvent[], eventName?: string): ForkSourceDeps {
  return {
    loadMeta: async () => ({ status, ...(eventName !== undefined ? { eventName } : {}) }),
    store: { load: async () => events },
  };
}

test("resolveForkSource reads the pushed sha and the recorded branch off a settled run", async () => {
  const sha = "1234567890123456789012345678901234567890";
  const events = [
    ev("run-started", 0, undefined, { workflow: "coding-agent", input: { repo: "https://git.example.com/a/b" } }),
    ev("step-completed", 1, "repo-setup", { result: { branch: "ship/run-src1", base: "main" } }),
    ev("step-completed", 5, "repo-push", { result: { kind: "pushed", sha } }),
  ];
  const resolved = await resolveForkSource(sourceDeps("completed", events), "run-src1");
  assert.deepEqual(resolved, { ok: true, record: { runId: "run-src1", sha, branch: "ship/run-src1" } });
});

test("resolveForkSource: a run that pushed nothing carries no sha — the default-branch fork", async () => {
  const events = [
    ev("run-started", 0, undefined, { workflow: "coding-agent", input: { repo: "https://git.example.com/a/b" } }),
    ev("step-completed", 1, "repo-setup", { result: { branch: "ship/run-src1", base: "main" } }),
    ev("step-completed", 5, "repo-push", { result: { kind: "empty" } }),
  ];
  const resolved = await resolveForkSource(sourceDeps("failed", events), "run-src1");
  assert.deepEqual(resolved, { ok: true, record: { runId: "run-src1", branch: "ship/run-src1" } }, "no sha key at all");
});

test("resolveForkSource refuses an in-flight source by name and a missing one honestly", async () => {
  const inFlight = await resolveForkSource(sourceDeps("running", []), "run-src9");
  assert.equal(inFlight.ok, false);
  assert.ok((inFlight as { reason: string }).reason.includes(FORK_SOURCE_NOT_SETTLED));
  const parked = await resolveForkSource(sourceDeps("waiting", [], "turn-2-ask"), "run-src9");
  assert.equal(parked.ok, false, "an ask park is not forkable");
  const mergeParked = await resolveForkSource(sourceDeps("waiting", [ev("run-started", 0)], MERGE_EVENT), "run-src8");
  assert.equal(mergeParked.ok, true, "a merge review is");
  const missing = await resolveForkSource({ loadMeta: async () => null, store: { load: async () => [] } }, "run-none");
  assert.deepEqual(missing, { ok: false, reason: "fork refused: run run-none does not exist" });
});

test("forkNote says where the fork starts, including the no-push case", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  assert.match(forkNote({ runId: "run-src1", sha }), new RegExp(`Recorded: this run forks run-src1.*${sha}`));
  assert.match(forkNote({ runId: "run-src1", sha }), /own pull request; the forked run's pull request and branch are not touched/);
  const noPush = forkNote({ runId: "run-src2" });
  assert.match(noPush, /Recorded: this run forks run-src2, which recorded no pushed commit/);
  assert.match(noPush, /starts from the repository's default branch/);
});

// --------------------------------------------------------------- enqueue ----

/**
 * Capture-only runtime shaped like projects.test.ts's captureEnqueue, plus the
 * two reads the fork resolution makes: the SOURCE run's meta and log.
 */
function captureForkEnqueue(fix: {
  status: string;
  eventName?: string;
  events: WorkflowEvent[];
}): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>>; started: Array<Record<string, unknown>>; metas: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const started: Array<Record<string, unknown>> = [];
  const metas: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { forRepo: async () => null, list: async () => [] },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    loadMeta: async (runId: string) => (runId === "run-src1" ? { runId, status: fix.status, ...(fix.eventName !== undefined ? { eventName: fix.eventName } : {}) } : null),
    store: {
      load: async (runId: string) => (runId === "run-src1" ? fix.events : []),
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown>; taskRootRunId?: string } }) => {
        if (event.type === "run-started") {
          inputs.push(event.data!.input!);
          started.push(event.data!);
        }
      },
    },
    saveMeta: async (meta: Record<string, unknown>) => {
      metas.push(meta);
    },
  } as unknown as ShipRuntime;
  return { runtime, inputs, started, metas };
}

const PUSHED_SHA = "fedcba0987654321fedcba0987654321fedcba09";
const SOURCE_LOG: WorkflowEvent[] = [
  ev("run-started", 0, undefined, { workflow: "coding-agent", input: { repo: "https://git.example.com/a/b", trust: "operator" } }),
  ev("step-completed", 1, "repo-setup", { result: { branch: "ship/run-src1", base: "main" } }),
  ev("step-completed", 5, "repo-push", { result: { kind: "pushed", sha: PUSHED_SHA } }),
  ev("run-completed", 8, undefined, { output: { status: "finished" } }),
];
const NO_PUSH_LOG: WorkflowEvent[] = [
  ev("run-started", 0, undefined, { workflow: "coding-agent", input: { repo: "https://git.example.com/a/b" } }),
  ev("step-completed", 1, "repo-setup", { result: { branch: "ship/run-src1", base: "main" } }),
  ev("run-completed", 8, undefined, { output: { status: "finished" } }),
];

test("enqueueRun materialises forkOf and the Recorded line, as a new task root", async () => {
  await withForkEnv("on", async () => {
    const { runtime, inputs, started, metas } = captureForkEnqueue({ status: "completed", events: SOURCE_LOG });
    await enqueueRun(runtime, {
      runId: "run-fork1",
      forkOf: "run-src1",
      task: "Take this further",
      userMessage: "Take this further",
      model: "m",
      repo: "https://git.example.com/a/b",
      source: "manual",
    });
    const input = inputs[0]!;
    assert.deepEqual(input.forkOf, { runId: "run-src1", sha: PUSHED_SHA, branch: "ship/run-src1" }, "the resolved source facts, verbatim");
    assert.match(String(input.task), /Recorded: this run forks run-src1/);
    assert.match(String(input.task), new RegExp(PUSHED_SHA));
    assert.equal(String(input.task).startsWith("Take this further\n\nRecorded:"), true, "the note rides the task after the message");
    assert.ok(!("parentRunId" in input), "a fork is a new task root, not a follow-up");
    assert.equal(input.pr, undefined, "no PR: the fork opens its own");
    assert.equal((started[0]! as { taskRootRunId?: string }).taskRootRunId, "run-fork1", "the fork anchors itself");
    assert.equal(metas[0]!.task, "Take this further", "the note does not pollute the run's title");
  });
});

test("a fork of a run that pushed nothing records no sha and says it starts from the default branch", async () => {
  await withForkEnv("on", async () => {
    const { runtime, inputs } = captureForkEnqueue({ status: "completed", events: NO_PUSH_LOG });
    await enqueueRun(runtime, { runId: "run-fork2", forkOf: "run-src1", task: "Try another angle", model: "m", repo: "https://git.example.com/a/b" });
    assert.deepEqual(inputs[0]!.forkOf, { runId: "run-src1", branch: "ship/run-src1" });
    assert.match(String(inputs[0]!.task), /which recorded no pushed commit/);
    assert.match(String(inputs[0]!.task), /repository's default branch/);
  });
});

test("forking an in-flight run is refused by name and enqueues nothing", async () => {
  await withForkEnv("on", async () => {
    for (const status of ["queued", "running", "cancelling"]) {
      const { runtime, inputs } = captureForkEnqueue({ status, events: SOURCE_LOG });
      await assert.rejects(
        enqueueRun(runtime, { runId: "run-fork3", forkOf: "run-src1", task: "t", model: "m" }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.includes(FORK_SOURCE_NOT_SETTLED) && message.includes(status);
        },
        `${status} must refuse naming its state`,
      );
      assert.equal(inputs.length, 0, "a refused fork leaves no run-started behind");
    }
    const askPark = captureForkEnqueue({ status: "waiting", eventName: "turn-4-ask", events: SOURCE_LOG });
    await assert.rejects(
      enqueueRun(askPark.runtime, { runId: "run-fork4", forkOf: "run-src1", task: "t", model: "m" }),
      /FORK_SOURCE_NOT_SETTLED/,
      "an ask park is in flight for this purpose",
    );
    assert.equal(askPark.inputs.length, 0);
  });
});

test("flag off: the enqueue itself refuses a fork", async () => {
  await withForkEnv("off", async () => {
    const { runtime, inputs } = captureForkEnqueue({ status: "completed", events: SOURCE_LOG });
    await assert.rejects(
      enqueueRun(runtime, { runId: "run-fork5", forkOf: "run-src1", task: "t", model: "m" }),
      /fork refused \(SHIP_FORK off\)/,
    );
    assert.equal(inputs.length, 0);
  });
});

test("a fork that also claims a parent is refused: lineage is forkOf, not parentRunId", async () => {
  await withForkEnv("on", async () => {
    const { runtime } = captureForkEnqueue({ status: "completed", events: SOURCE_LOG });
    await assert.rejects(
      enqueueRun(runtime, { runId: "run-fork6", forkOf: "run-src1", parentRunId: "run-src1", task: "t", model: "m" }),
      /new task root/,
    );
  });
});

test("runs without forkOf enqueue byte-identically: no key, no note, same fingerprint", async () => {
  const { runtime, inputs } = captureForkEnqueue({ status: "completed", events: SOURCE_LOG });
  await enqueueRun(runtime, { runId: "run-plain", task: "Just a task", model: "m", repo: "https://git.example.com/a/b" });
  assert.ok(!("forkOf" in inputs[0]!), "the key is absent, not merely undefined");
  assert.equal(inputs[0]!.task, "Just a task", "no note appended");
  // The fingerprint half of the same invariant, over input shapes a fork could
  // take: the field admits no step, so it cannot move the upgrade fence.
  for (const base of [{ task: "t" }, { task: "t", repo: "r", tests: true }, { task: "t", repo: "r", pr: 7 }, { task: "t", repo: "r", mode: "scan" }] as RecordedInput[]) {
    assert.equal(
      stepFingerprint({ ...base, forkOf: { runId: "run-src1", sha: PUSHED_SHA } } as RecordedInput),
      stepFingerprint(base),
      `forkOf admits no step for ${JSON.stringify(base)}`,
    );
  }
});
