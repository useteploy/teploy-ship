import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { resolveStackBase, stackNote, stackedPrsEnabled, type StackBaseDeps } from "./stacked-pr.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { fingerprintOf, stepFingerprint, WORKFLOW_STEPS } from "./step-fingerprint.js";
import type { RecordedInput } from "./step-fingerprint.js";

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-17T09:00:00Z") + minute * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/** Run SHIP_STACKED_PRS set to `value` (undefined = unset) around one async body. */
async function withStackEnv<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env.SHIP_STACKED_PRS;
  if (value === undefined) delete process.env.SHIP_STACKED_PRS;
  else process.env.SHIP_STACKED_PRS = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SHIP_STACKED_PRS;
    else process.env.SHIP_STACKED_PRS = saved;
  }
}

const REPO = "https://git.example.com/a/b";
const BASE_SHA = "1234567890123456789012345678901234567890";
const STACK: { runId: string; pr: number; branch: string; sha: string } = { runId: "run-base", pr: 3, branch: "ship/run-base", sha: BASE_SHA };

/** A base run's log: opened PR #3 from ship/run-base, pushed BASE_SHA. */
function baseLog(overrides: { input?: Record<string, unknown>; withoutPr?: boolean; withoutPush?: boolean } = {}): WorkflowEvent[] {
  const events: WorkflowEvent[] = [
    ev("run-started", 0, undefined, { workflow: "coding-agent", input: { repo: REPO, ...(overrides.input ?? {}) } }),
    ev("step-completed", 1, "repo-setup", { result: { branch: "ship/run-base", base: "main" } }),
  ];
  if (!overrides.withoutPr) events.push(ev("step-completed", 5, "repo-pr", { result: { number: 3, url: `${REPO}/pulls/3` } }));
  if (!overrides.withoutPush) events.push(ev("step-completed", 6, "repo-push", { result: { kind: "pushed", sha: BASE_SHA } }));
  events.push(ev("run-completed", 8, undefined, { output: { status: "finished" } }));
  return events;
}

test("the flag is on for SHIP_STACKED_PRS=on (and the truthy spellings), off otherwise", () => {
  for (const on of ["on", "ON", " on ", "1", "true", "yes"]) assert.equal(stackedPrsEnabled({ SHIP_STACKED_PRS: on }), true, on);
  for (const off of ["off", "", "0", "nope", undefined]) assert.equal(stackedPrsEnabled({ ...(off !== undefined ? { SHIP_STACKED_PRS: off } : {}) }), false, String(off));
});

test("resolveStackBase reads the base PR, branch and pushed sha off the base run's log", async () => {
  const deps: StackBaseDeps = { loadMeta: async () => ({ status: "completed" }), store: { load: async () => baseLog() } };
  assert.deepEqual(await resolveStackBase(deps, "run-base", REPO), { ok: true, record: STACK });
  // No repo match requirement beyond equality; the stacked run's own repo is
  // optional in the deps contract but the mismatch below must refuse.
});

test("resolveStackBase refusals: missing run, wrong repo, chained stack, no PR, no push", async () => {
  const reason = async (deps: StackBaseDeps, repo: string | undefined = REPO): Promise<string> => {
    const r = await resolveStackBase(deps, "run-base", repo);
    return r.ok ? "" : r.reason;
  };
  assert.match(await reason({ loadMeta: async () => null, store: { load: async () => [] } }), /does not exist/);
  assert.match(
    await reason({ loadMeta: async () => ({}), store: { load: async () => baseLog({ input: { repo: "https://git.example.com/x/y" } }) } }),
    /different repository/,
  );
  assert.match(await reason({ loadMeta: async () => ({}), store: { load: async () => baseLog({ input: { stack: STACK } }) } }), /itself stacked; stacking is one level deep/);
  assert.match(await reason({ loadMeta: async () => ({}), store: { load: async () => baseLog({ withoutPr: true }) } }), /no open pull request of its own/);
  assert.match(await reason({ loadMeta: async () => ({}), store: { load: async () => baseLog({ withoutPush: true }) } }), /pushed nothing/);
});

test("stackNote names the base run, its PR and the recorded head", () => {
  const note = stackNote(STACK);
  assert.match(note, /Recorded: this run stacks on run-base/);
  assert.match(note, /pull request #3/);
  assert.match(note, new RegExp(BASE_SHA));
  assert.match(note, /not the default branch/);
});

// --------------------------------------------------------------- enqueue ----

/**
 * Capture-only runtime shaped like fork.test.ts's captureForkEnqueue, plus the
 * one read the stack resolution makes: the BASE run's meta and log.
 */
function captureStackEnqueue(events: WorkflowEvent[]): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>>; started: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const started: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { forRepo: async () => null, list: async () => [] },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    loadMeta: async (runId: string) => (runId === "run-base" ? { runId, status: "completed" } : null),
    store: {
      load: async (runId: string) => (runId === "run-base" ? events : []),
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") {
          inputs.push(event.data!.input!);
          started.push(event.data!);
        }
      },
    },
    saveMeta: async () => {},
    launches: undefined,
  } as unknown as ShipRuntime;
  return { runtime, inputs, started };
}

test("enqueueRun materialises stack and the Recorded line; the run opens on the base's branch", async () => {
  await withStackEnv("on", async () => {
    const { runtime, inputs } = captureStackEnqueue(baseLog());
    await enqueueRun(runtime, {
      runId: "run-stack1",
      stackOn: "run-base",
      task: "Second slice of work",
      userMessage: "Second slice of work",
      model: "m",
      repo: REPO,
      source: "manual",
    });
    assert.deepEqual(inputs[0]!.stack, STACK, "the resolved base facts, verbatim");
    assert.match(String(inputs[0]!.task), /Recorded: this run stacks on run-base/);
    assert.match(String(inputs[0]!.task), /Second slice of work/);
    assert.ok(!("pr" in inputs[0]!), "a stacked run opens its own PR");
  });
});

test("flag off: the enqueue itself refuses a stack and leaves nothing behind", async () => {
  await withStackEnv(undefined, async () => {
    const { runtime, inputs } = captureStackEnqueue(baseLog());
    await assert.rejects(
      enqueueRun(runtime, { runId: "run-stack2", stackOn: "run-base", task: "t", model: "m", repo: REPO }),
      /stack refused \(SHIP_STACKED_PRS off\)/,
    );
    assert.equal(inputs.length, 0, "a refused stack enqueues nothing");
  });
});

test("structural refusals: a pr, a fork, a scan or a missing repo cannot stack", async () => {
  await withStackEnv("on", async () => {
    const cases: Array<Record<string, unknown>> = [
      { pr: 9 },
      { forkOf: "run-base" },
      { mode: "scan" },
    ];
    for (const extra of cases) {
      const { runtime, inputs } = captureStackEnqueue(baseLog());
      await assert.rejects(
        enqueueRun(runtime, { runId: "run-stack3", stackOn: "run-base", task: "t", model: "m", repo: REPO, ...extra } as Parameters<typeof enqueueRun>[1]),
        // The fork+stack case trips the fork rule first (its flag is off
        // here); every case refuses before any run exists.
        /refused/,
      );
      assert.equal(inputs.length, 0);
    }
    const noRepo = captureStackEnqueue(baseLog());
    await assert.rejects(
      enqueueRun(noRepo.runtime, { runId: "run-stack5", stackOn: "run-base", task: "t", model: "m" }),
      /stack refused: a stacked run needs a repository/,
    );
    assert.equal(noRepo.inputs.length, 0);
    const unresolvable = captureStackEnqueue(baseLog({ withoutPr: true }));
    await assert.rejects(
      enqueueRun(unresolvable.runtime, { runId: "run-stack4", stackOn: "run-base", task: "t", model: "m", repo: REPO }),
      /no open pull request of its own/,
    );
  });
});

test("the woken revision's stackRebase rides the input verbatim, and a malformed one is refused at enqueue", async () => {
  await withStackEnv("on", async () => {
    const { runtime, inputs } = captureStackEnqueue(baseLog());
    const stackRebase = { oldBaseHeadSha: BASE_SHA, defaultBranch: "main" };
    await enqueueRun(runtime, { runId: "run-rev9", task: "rebase the stack", model: "m", repo: REPO, pr: 3, source: "pr-watch", stackRebase });
    assert.deepEqual(inputs[0]!.stackRebase, stackRebase);

    for (const bad of [{ oldBaseHeadSha: "short", defaultBranch: "main" }, { oldBaseHeadSha: BASE_SHA, defaultBranch: " main " }]) {
      const refused = captureStackEnqueue(baseLog());
      await assert.rejects(
        enqueueRun(refused.runtime, { runId: "run-rev10", task: "t", model: "m", repo: REPO, pr: 3, stackRebase: bad }),
        /stackRebase\./,
      );
      assert.equal(refused.inputs.length, 0);
    }
  });
});

test("runs without stackOn enqueue byte-identically: no key, no note, and the field admits no step", async () => {
  const { runtime, inputs } = captureStackEnqueue(baseLog());
  await enqueueRun(runtime, { runId: "run-plain", task: "Just a task", model: "m", repo: REPO });
  assert.ok(!("stack" in inputs[0]!), "the key is absent, not merely undefined");
  assert.equal(inputs[0]!.task, "Just a task", "no note appended");
  // The fingerprint half of the same invariant over input shapes a stack could
  // take: `stack` gates no step, so it cannot move the upgrade fence.
  for (const base of [{ task: "t" }, { task: "t", repo: "r", tests: true }, { task: "t", repo: "r", pr: 7 }] as RecordedInput[]) {
    assert.equal(
      stepFingerprint({ ...base, stack: STACK } as RecordedInput),
      stepFingerprint(base),
      `stack admits no step for ${JSON.stringify(base)}`,
    );
  }
  // And the woken revision's field admits exactly one step, only on a PR run:
  // an ordinary PR run keeps the exact pre-feature fingerprint (the D4-c
  // pattern), while the revision's moves by that one step and nothing else.
  const revision = { task: "t", repo: "r", pr: 5, stackRebase: { oldBaseHeadSha: BASE_SHA, defaultBranch: "main" } } as unknown as RecordedInput;
  assert.notEqual(
    stepFingerprint(revision),
    stepFingerprint({ task: "t", repo: "r", pr: 5 } as RecordedInput),
    "the woken revision admits the stack-rebase step; an ordinary PR run does not",
  );
  assert.equal(
    stepFingerprint({ task: "t", repo: "r", pr: 5 } as RecordedInput),
    fingerprintOf(WORKFLOW_STEPS.filter((s) => s.key !== "step:stack-rebase"), { task: "t", repo: "r", pr: 5 } as RecordedInput),
    "an ordinary PR run's fingerprint is exactly the pre-feature fingerprint",
  );
});
