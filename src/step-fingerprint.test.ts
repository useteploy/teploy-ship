import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WIRE_FORMAT_VERSION } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import {
  FINGERPRINT_SCHEME,
  UPGRADE_HOLD_EVENT,
  WORKFLOW_STEPS,
  admittedSteps,
  buildFingerprint,
  buildStepSequence,
  extractStepSequence,
  fingerprintOf,
  preflightReport,
  recordedFingerprint,
  replayDrift,
  stepFingerprint,
  tableDrift,
  upgradeHoldRefusal,
} from "./step-fingerprint.js";
import type { RecordedInput, WorkflowStep } from "./step-fingerprint.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { toItem } from "./inbox.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fixtures");

function startedEvent(input: unknown, fingerprint?: string): WorkflowEvent {
  return {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: "2026-08-27T00:00:00.000Z",
    data: { workflow: "coding-agent", input, ...(fingerprint !== undefined ? { stepFingerprint: fingerprint } : {}) },
  };
}

function terminal(type: "run-completed" | "run-failed" | "run-cancelled"): WorkflowEvent {
  return { v: WIRE_FORMAT_VERSION, seq: 9, type, at: "2026-08-27T00:00:01.000Z", data: { output: null } };
}

/**
 * One cursor event — the smallest log that has recorded something replayable.
 * A run that has executed at all has at least one; a run whose log is only
 * `run-started` has executed nothing, and replay of it is a fresh start.
 */
function cursorEvent(): WorkflowEvent {
  return { v: WIRE_FORMAT_VERSION, seq: 1, type: "step-completed", name: "sandbox", at: "2026-08-27T00:00:00.500Z", data: { result: null } };
}

// ---------------------------------------------------------------------------
// The enforcement: the declared table must equal what the code actually does
// ---------------------------------------------------------------------------

test("the declared step table is exactly the sequence the compiled workflow records", async () => {
  const extracted = await buildStepSequence();
  assert.deepEqual(
    WORKFLOW_STEPS.map((s) => s.key),
    extracted,
    "WORKFLOW_STEPS has fallen behind durable.ts / harness-external.js — add, rename or reorder the entry to match, " +
      "and give a new step the input gate that admits it (see the header of step-fingerprint.ts)",
  );
});

test("tableDrift: an agreeing extraction is not drift", async () => {
  assert.equal(tableDrift(await buildStepSequence()), null);
});

test("tableDrift: a stale table is named, in every shape it can be stale in", () => {
  const table = WORKFLOW_STEPS.map((s) => s.key);
  const reordered = [...table];
  const swap = reordered[1]!;
  reordered[1] = reordered[2]!;
  reordered[2] = swap;
  const renamed = table.map((k, i) => (i === 0 ? "step:renamed" : k));
  const withExtra = ["step:extra", ...table];
  const withMissing = table.slice(1);
  for (const [label, extracted] of [
    ["reordered", reordered],
    ["renamed", renamed],
    ["table has an extra entry", withExtra],
    ["table is missing an entry", withMissing],
  ] as const) {
    const drift = tableDrift(extracted);
    assert.notEqual(drift, null, `${label} must be drift`);
    assert.match(drift!, /position \d+|has an entry/, `${label} names where it diverges`);
  }
});

test("every module that records a step is listed in WORKFLOW_STEP_MODULES", async () => {
  // The list is the fingerprint's coverage; a module that records steps and is
  // not in it is invisible to the fence, which would report a build as
  // unchanged while its step sequence had moved.
  const dist = dirname(fileURLToPath(import.meta.url));
  const { readdir } = await import("node:fs/promises");
  const { WORKFLOW_STEP_MODULES } = await import("./step-fingerprint.js");
  const listed = new Set<string>(WORKFLOW_STEP_MODULES);
  const missing: string[] = [];
  for (const entry of await readdir(dist)) {
    if (!entry.endsWith(".js") || entry.endsWith(".test.js") || listed.has(entry)) continue;
    const source = await readFile(join(dist, entry), "utf8");
    if (extractStepSequence(source).length > 0) missing.push(entry);
  }
  assert.deepEqual(missing, [], "these modules record workflow steps but are not covered by the fingerprint");
});

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

test("extractStepSequence reads step calls in order and normalises interpolations", () => {
  const source = [
    'const a = await ctx.step("first", () => 1);',
    "const b = await ws.ctx.step(`${p}turn-${turn}-think`, () => 2);",
    "const c = await ctx.waitForEvent(PLAN_EVENT);",
    "const d = await ctx.waitForEvent(approvalEvent(turn));",
  ].join("\n");
  assert.deepEqual(extractStepSequence(source), [
    "step:first",
    "step:*turn-*-think",
    "wait:PLAN_EVENT",
    "wait:approvalEvent(turn)",
  ]);
});

test("extractStepSequence ignores prose that mentions a step, in both comment shapes", () => {
  // durable.ts really does discuss `ctx.step(` in its header. A regex scan over
  // the raw text counted those and produced a sequence the code never records.
  const source = [
    '// there were 33 ctx.step("ghost") calls and none had a retry',
    "/**",
    ' * See ctx.step("phantom") above.',
    " */",
    'const a = await ctx.step("real", () => 1);',
    'const s = "ctx.step(\\"in-a-string\\")";',
  ].join("\n");
  assert.deepEqual(extractStepSequence(source), ["step:real"]);
});

test("extractStepSequence stays in sync through a template holding a regex holding a nested template", () => {
  // harness-external.ts's shq(): `'${value.replace(/'/g, `'\\''`)}'`. A naive
  // quote tracker desynchronises here and then reads the rest of the file with
  // strings and code swapped — silently, which is the dangerous part.
  const source = [
    "export function shq(value) { return `'${value.replace(/'/g, `'\\\\''`)}'`; }",
    "const ratio = total / count / 2;",
    'const a = await ctx.step("after-the-mess", () => 1);',
  ].join("\n");
  assert.deepEqual(extractStepSequence(source), ["step:after-the-mess"]);
});

test("extractStepSequence records a computed step name rather than dropping it", () => {
  const source = 'const a = await ctx.step(nameFor(turn), () => 1);';
  assert.deepEqual(extractStepSequence(source), ["step:<computed>"]);
});

// ---------------------------------------------------------------------------
// The gates, checked against real recorded logs
// ---------------------------------------------------------------------------

/** A recorded step name matches a declared key, `*` standing for any run of characters. */
function keyMatches(key: string, recorded: string): boolean {
  const pattern = key
    .replace(/^step:/, "")
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${pattern}$`).test(recorded);
}

for (const name of ["fx-workspace", "fx-repo"]) {
  test(`gates: every step ${name} actually recorded is admitted by its own input`, async () => {
    const fixture = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as {
      events: WorkflowEvent[];
    };
    const input = (fixture.events.find((e) => e.type === "run-started")!.data as { input: RecordedInput }).input;
    const admitted = admittedSteps(input);
    const recorded = fixture.events.filter((e) => e.type === "step-completed").map((e) => e.name!);
    assert.ok(recorded.length > 10, "fixture carries a real step sequence");
    for (const step of recorded) {
      assert.ok(
        admitted.some((key) => keyMatches(key, step)),
        `${name} recorded "${step}" but no admitted gate covers it — the gate for that step is too narrow, ` +
          `which means a real replay break would slip past the fence`,
      );
    }
  });
}

/**
 * The gates, stated a second time and independently of the table.
 *
 * The fixture check above cannot separate `step:tests` from `step:*tests` — the
 * `*` stands for an empty prefix, so the wildcard key legitimately matches the
 * bare name and covers for it. This says which keys each shape of run admits
 * outright, so a gate annotated against the wrong input field fails here even
 * when another key happens to cover the same recorded name.
 */
const GATE_CASES: Array<{ what: string; input: RecordedInput; admits: string[]; denies: string[] }> = [
  {
    what: "a bare workspace run",
    input: { task: "t" },
    admits: ["step:sandbox", "step:*turn-*-think", "step:*turn-*-exec", "wait:approvalEvent(turn)"],
    denies: [
      "step:repo-setup",
      "step:repo-context",
      "step:repo-push",
      "step:repo-pr",
      "step:verification",
      "step:tests",
      "step:*tests",
      "step:scan-findings",
      "step:*plan-think",
      "step:*turn-*-steer",
      "step:*turn-*-critic",
      "step:*harness-run",
    ],
  },
  {
    what: "a repo run with the suite on",
    input: { task: "t", repo: "r", tests: true },
    admits: ["step:repo-setup", "step:repo-context", "step:repo-push", "step:repo-pr", "step:verification", "step:tests", "step:*tests"],
    denies: ["step:repo-comment", "step:change-class", "step:auto-merge", "step:preview-deploy", "step:telemetry-check", "step:rollback"],
  },
  {
    what: "a review follow-up on an existing pull request",
    input: { task: "t", repo: "r", pr: 7 },
    admits: ["step:pr-review-comments", "step:repo-comment"],
    denies: ["step:tests"],
  },
  {
    what: "a scan",
    input: { task: "t", repo: "r", mode: "scan" },
    admits: ["step:scan-findings"],
    denies: ["step:tests", "step:change-class", "step:preview-deploy"],
  },
  {
    what: "a run that opted into every publish-side gate",
    input: {
      task: "t",
      repo: "r",
      changeClass: true,
      autoMerge: true,
      rollback: true,
      preview: true,
      telemetry: true,
      reviewers: { users: ["a"], teams: [] },
    },
    admits: [
      "step:change-class",
      "wait:CHANGE_EVENT",
      "step:change-rejected",
      "step:auto-merge",
      "step:rollback",
      "step:preview-deploy",
      "step:telemetry-check",
      "step:repo-reviewers",
    ],
    denies: ["step:tests"],
  },
  {
    what: "a plan-preview run with steering, the critic and the edit hold",
    input: { task: "t", plan: true, steer: true, critic: true, requireEdit: true },
    admits: [
      "step:*plan-think",
      "step:*plan-snapshot",
      "wait:PLAN_EVENT",
      "step:*plan-restore",
      "step:*turn-*-steer",
      "step:*turn-*-critic-diff",
      "step:*turn-*-critic",
      "step:*turn-*-finish-tree",
      "step:*turn-*-hold-recheck",
    ],
    denies: ["step:*turn-*-fingerprint"],
  },
  {
    what: "settle alone, which turns the recovery tracker on (durable.ts recoveryOn)",
    input: { task: "t", settle: true },
    admits: ["step:*turn-*-fingerprint"],
    denies: [],
  },
  {
    what: "recovery explicitly OFF, which the tracker must honour",
    input: { task: "t", settle: true, recovery: false },
    admits: [],
    denies: ["step:*turn-*-fingerprint"],
  },
  {
    what: "an external harness",
    input: { task: "t", harness: { id: "claude-code", version: "1" } },
    admits: ["step:*harness-preflight", "step:*harness-run"],
    denies: ["step:harness-pick"],
  },
  {
    what: "a native run, which records no harness steps",
    input: { task: "t", harness: { id: "native", version: "1" } },
    admits: [],
    denies: ["step:*harness-preflight", "step:*harness-run", "step:harness-pick"],
  },
  {
    what: "a multi-harness attempt run",
    input: {
      task: "t",
      repo: "r",
      harnessAttempts: [
        { id: "native", version: "1" },
        { id: "claude-code", version: "1" },
      ],
    },
    admits: ["step:*sandbox", "step:*repo-setup", "step:*diff", "step:harness-pick", "step:*harness-run"],
    denies: [],
  },
];

for (const gate of GATE_CASES) {
  test(`gates: ${gate.what}`, () => {
    const admitted = new Set(admittedSteps(gate.input));
    for (const key of gate.admits) {
      assert.ok(admitted.has(key), `${gate.what} must admit ${key}`);
    }
    for (const key of gate.denies) {
      assert.equal(admitted.has(key), false, `${gate.what} must NOT admit ${key}`);
    }
  });
}

// ---------------------------------------------------------------------------
// What the fingerprint is and is not sensitive to
// ---------------------------------------------------------------------------

const base: readonly WorkflowStep[] = [
  { key: "step:one", admits: () => true },
  { key: "step:two", admits: () => true },
];
const OLD: RecordedInput = { task: "t" };
const NEW: RecordedInput = { task: "t", rollback: true };

test("a step added UNCONDITIONALLY moves the fingerprint of every input", () => {
  const after: WorkflowStep[] = [...base, { key: "step:three", admits: () => true }];
  assert.notEqual(fingerprintOf(after, OLD), fingerprintOf(base, OLD));
  assert.notEqual(fingerprintOf(after, NEW), fingerprintOf(base, NEW));
});

test("a step added GATED on a run-input flag moves only the runs that carry the flag", () => {
  // This is the UPGRADING table's first row, and the reason the gates exist at
  // all: without them every optional feature this codebase adds would park
  // every run in flight, and an operator would learn to ignore the fence.
  const after: WorkflowStep[] = [...base, { key: "step:three", admits: (i) => i.rollback === true }];
  assert.equal(fingerprintOf(after, OLD), fingerprintOf(base, OLD), "a run without the flag is untouched");
  assert.notEqual(fingerprintOf(after, NEW), fingerprintOf(base, NEW), "a run with the flag sees the new step");
});

test("renaming a step moves the fingerprint", () => {
  const after: WorkflowStep[] = [{ key: "step:one", admits: () => true }, { key: "step:deux", admits: () => true }];
  assert.notEqual(fingerprintOf(after, OLD), fingerprintOf(base, OLD));
});

test("reordering two steps moves the fingerprint", () => {
  const after: WorkflowStep[] = [base[1]!, base[0]!];
  assert.notEqual(fingerprintOf(after, OLD), fingerprintOf(base, OLD));
});

test("the fingerprint is stable across runs and carries its scheme", () => {
  assert.equal(stepFingerprint(OLD), stepFingerprint({ task: "t" }));
  assert.ok(stepFingerprint(OLD).startsWith(`${FINGERPRINT_SCHEME}:`));
  assert.ok(buildFingerprint().startsWith(`${FINGERPRINT_SCHEME}:`));
  assert.notEqual(stepFingerprint(OLD), stepFingerprint({ task: "t", repo: "r" }), "a repo run has a different shape");
});

// ---------------------------------------------------------------------------
// replayDrift
// ---------------------------------------------------------------------------

test("replayDrift: a run recorded by this build replays", () => {
  const input: RecordedInput = { task: "t", repo: "r", tests: true };
  assert.equal(replayDrift([startedEvent(input, stepFingerprint(input))]), null);
  assert.equal(replayDrift([startedEvent(input, stepFingerprint(input)), cursorEvent()]), null);
});

test("replayDrift: a run recorded by a different build is drift, and names both prints", () => {
  const input: RecordedInput = { task: "t", repo: "r" };
  const drift = replayDrift([startedEvent(input, `${FINGERPRINT_SCHEME}:0000000000000000`), cursorEvent()]);
  assert.notEqual(drift, null);
  assert.equal(drift!.recorded, `${FINGERPRINT_SCHEME}:0000000000000000`);
  assert.equal(drift!.current, stepFingerprint(input));
});

test("replayDrift: a run that has recorded nothing replayable is not held, whatever its fingerprint says", () => {
  // A log of run-started alone has ZERO cursor events: replay walks cursor
  // events one-by-one, so there is nothing to walk — executing this run under
  // a disagreeing build is a fresh start, not a replay, and no divergence is
  // possible. Holding it parks a run no deploy can hurt, with a reason that
  // is untrue for it. The recorded print stays stale in the log; if a later
  // deploy disagrees with the ORIGINAL build after this one has run, that
  // later fence read is a false park — the fence's documented conservative
  // trade, one rollback-or-resume, not a broken run.
  const input: RecordedInput = { task: "t", repo: "r" };
  assert.equal(
    replayDrift([startedEvent(input, `${FINGERPRINT_SCHEME}:0000000000000000`)]),
    null,
    "no cursor events means no replay obligation",
  );
});

test("replayDrift: a run with no recorded fingerprint is let through, not held", () => {
  // Every run in flight on the deploy that introduces the fence is in this
  // state. Holding them would make the fence's own arrival the outage.
  assert.equal(recordedFingerprint([startedEvent({ task: "t" })]), undefined);
  assert.equal(replayDrift([startedEvent({ task: "t" })]), null);
});

test("replayDrift: a fingerprint from another SCHEME is uncomparable, not drift", () => {
  assert.equal(replayDrift([startedEvent({ task: "t" }, "s0:deadbeefdeadbeef")]), null);
});

// ---------------------------------------------------------------------------
// enqueue records it, in the one place that cannot break replay
// ---------------------------------------------------------------------------

function captureRuntime(): { runtime: ShipRuntime; events: WorkflowEvent[] } {
  const events: WorkflowEvent[] = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: { append: async (_runId: string, event: WorkflowEvent) => void events.push(event) },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  return { runtime, events };
}

test("enqueueRun records the fingerprint on run-started, beside the input and never inside it", async () => {
  const { runtime, events } = captureRuntime();
  await enqueueRun(runtime, { runId: "run-fp", task: "do it", model: "m", repo: "https://git.example.com/o/r" });

  const started = events.find((e) => e.type === "run-started")!;
  const data = started.data as { input: Record<string, unknown>; stepFingerprint?: string };
  assert.equal(typeof data.stepFingerprint, "string");
  assert.equal(
    "stepFingerprint" in data.input,
    false,
    "the fingerprint must not live in the run INPUT — the input is what gates step presence, so a field there " +
      "changes how in-flight runs replay and would cause the failure the fence exists to prevent",
  );
  assert.equal(
    data.stepFingerprint,
    stepFingerprint(data.input as RecordedInput),
    "the recorded print must be the print of the recorded input, or a replay compares two different things",
  );
  assert.equal(replayDrift(events), null, "the build that enqueued a run can replay it");
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function row(runId: string, events: WorkflowEvent[]) {
  return { runId, status: "queued", task: "t", events };
}

test("preflight: an in-flight run this build cannot replay makes the deploy unsafe", () => {
  const input: RecordedInput = { task: "t" };
  const report = preflightReport([
    row("run-ok", [startedEvent(input, stepFingerprint(input)), cursorEvent()]),
    row("run-bad", [startedEvent(input, `${FINGERPRINT_SCHEME}:1111111111111111`), cursorEvent()]),
  ]);
  assert.equal(report.wouldBreak, 1);
  assert.equal(report.safe, false);
  assert.deepEqual(
    report.runs.map((r) => [r.runId, r.verdict]),
    [
      ["run-ok", "ok"],
      ["run-bad", "would-break"],
    ],
  );
});

test("preflight: a finished run cannot be hurt by a deploy and is not counted", () => {
  const input: RecordedInput = { task: "t" };
  for (const type of ["run-completed", "run-failed", "run-cancelled"] as const) {
    const report = preflightReport([
      row("run-done", [startedEvent(input, `${FINGERPRINT_SCHEME}:2222222222222222`), terminal(type)]),
    ]);
    assert.deepEqual(report.runs, [], `${type} is terminal — its log will never be replayed again`);
    assert.equal(report.safe, true);
  }
});

test("preflight: a run it cannot compare is unsafe until someone says otherwise", () => {
  const rows = [row("run-old", [startedEvent({ task: "t" })])];
  assert.equal(preflightReport(rows).safe, false, "'we cannot tell' must not read as 'fine'");
  assert.equal(preflightReport(rows).unrecorded, 1);
  assert.equal(preflightReport(rows, { allowUnrecorded: true }).safe, true);
});

test("preflight: nothing in flight is safe", () => {
  assert.equal(preflightReport([]).safe, true);
  assert.equal(preflightReport([]).build, buildFingerprint());
});

test("preflight: a queued run that has recorded nothing cannot be hurt by a deploy", () => {
  const input: RecordedInput = { task: "t" };
  const report = preflightReport([row("run-fresh", [startedEvent(input, `${FINGERPRINT_SCHEME}:3333333333333333`)])]);
  assert.deepEqual(
    report.runs.map((r) => [r.runId, r.verdict]),
    [["run-fresh", "ok"]],
    "a log with no cursor events is a fresh start under any build, not a replay",
  );
  assert.equal(report.safe, true);
});

// ---------------------------------------------------------------------------
// what an operator is shown
// ---------------------------------------------------------------------------

test("a held run asks to be rolled back or cancelled, never approved", () => {
  const item = toItem({
    runId: "run-held",
    task: "t",
    status: "waiting",
    eventName: UPGRADE_HOLD_EVENT,
    model: "m",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(item.state, "blocked");
  assert.deepEqual(
    item.needs!.actions.map((a) => a.label),
    ["resume", "cancel"],
    "approving an upgrade hold would answer a question nobody asked",
  );
  assert.match(item.needs!.prompt, /step sequence differs/);
});

test("the refusal a decision surface gets names the two honest actions and the danger", () => {
  const refusal = upgradeHoldRefusal("run-held");
  assert.match(refusal, /run-held/);
  assert.match(refusal, /resume run-held/, "the rollback path is the way out");
  assert.match(refusal, /cancel run-held/, "giving the run up is the alternative");
  assert.match(refusal, /log the hold protects/, "the operator must be told WHY approving is refused, not just that it is");
  assert.doesNotMatch(refusal, /approve/i);
});
