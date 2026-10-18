import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { runTiming } from "./run-timing.js";
import type { PhaseTiming } from "./run-timing.js";

const T0 = Date.parse("2026-10-02T10:00:00.000Z");
let seq = 0;
function ev(type: WorkflowEvent["type"], offsetS: number | null, name?: string): WorkflowEvent {
  return {
    v: 1,
    seq: ++seq,
    type,
    at: offsetS === null ? "not-a-date" : new Date(T0 + offsetS * 1000).toISOString(),
    ...(name !== undefined ? { name } : {}),
  };
}
/** Same as `ev`, carrying step data (a fingerprint records `{result: {hash, dirty}}`). */
function evd(type: WorkflowEvent["type"], offsetS: number, name: string, data: unknown): WorkflowEvent {
  return { ...ev(type, offsetS, name), data };
}
const at = (offsetS: number): string => new Date(T0 + offsetS * 1000).toISOString();

test("S28: splits a completed run into first-step, human wait and active time", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 30, "scan"),
    ev("event-waiting", 40, "plan-approval"),
    ev("event-received", 340, "plan-approval"),
    ev("step-completed", 400, "turn-0-exec"),
    ev("run-completed", 460),
  ]);
  assert.equal(t.telemetry, "complete");
  assert.equal(t.terminal, "completed");
  assert.equal(t.toFirstStepMs, 30_000);
  assert.equal(t.elapsedMs, 460_000);
  assert.equal(t.waitingOnPeopleMs, 300_000);
  assert.equal(t.waitingOnTimersMs, 0);
  assert.equal(t.activeMs, 160_000);
  assert.deepEqual(t.unknown, []);
});

test("S28: an open wait is open, not measured against the wall clock, and blocks active time", () => {
  seq = 0;
  const t = runTiming([ev("run-started", 0), ev("step-completed", 10), ev("event-waiting", 20, "merge")]);
  assert.equal(t.terminal, "open");
  assert.equal(t.elapsedMs, null);
  assert.equal(t.waitingOnPeopleMs, 0, "no RESOLVED waits; the open one is not counted");
  assert.deepEqual(t.waits, [{ kind: "event", name: "merge", waitedMs: null, resolved: false }]);
  assert.equal(t.activeMs, null);
  assert.ok(t.unknown.some(u => u.includes("still open")));
});

test("S28: no usable timestamps is missing telemetry, never a fast run", () => {
  seq = 0;
  const t = runTiming([ev("run-started", null), ev("run-completed", null)]);
  assert.equal(t.telemetry, "missing");
  assert.equal(t.elapsedMs, null);
  assert.equal(t.activeMs, null);
  assert.equal(runTiming([]).telemetry, "missing");
});

test("S28: a decision delivered before the run reached its wait costs no wait", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("event-received", 5, "merge"),
    ev("step-completed", 8),
    ev("event-waiting", 10, "merge"),
    ev("run-completed", 20),
  ]);
  assert.equal(t.waits[0]!.waitedMs, 0);
  assert.equal(t.waits[0]!.resolved, true);
  assert.equal(t.waitingOnPeopleMs, 0);
  assert.equal(t.activeMs, 20_000);
});

test("S28: timers are accounted separately, and failed runs keep their terminal state", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 1),
    ev("sleep-started", 2, "poll"),
    ev("sleep-completed", 62, "poll"),
    ev("run-failed", 70),
  ]);
  assert.equal(t.terminal, "failed");
  assert.equal(t.waitingOnTimersMs, 60_000);
  assert.equal(t.waitingOnPeopleMs, 0);
  assert.equal(t.activeMs, 10_000);
});

test("S28: a resolved wait with unusable timestamps makes the totals unknown, not zero", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 1),
    ev("event-waiting", null, "plan-approval"),
    ev("event-received", 100, "plan-approval"),
    ev("run-completed", 200),
  ]);
  assert.equal(t.waitingOnPeopleMs, null);
  assert.equal(t.activeMs, null);
  assert.equal(t.telemetry, "partial");
});

test("S28: events are ordered by seq, not by array position", () => {
  seq = 0;
  const events = [ev("run-started", 0), ev("step-completed", 5), ev("run-completed", 9)];
  assert.deepEqual(runTiming([...events].reverse()), runTiming(events));
});

// ------------------------------------------------------------- phases (D4-a)

/** Look one phase up by key; the test names the phase it expects to find. */
function phaseOf(t: ReturnType<typeof runTiming>, key: PhaseTiming["phase"]): PhaseTiming {
  const found = t.phases.find((p) => p.phase === key);
  assert.ok(found !== undefined, `phase "${key}" should be derived`);
  return found;
}

test("D4-a: a pinned fixture log derives exact phase gaps, TTFT and TTFE", () => {
  seq = 0;
  const events = [
    ev("run-started", 0),
    ev("step-completed", 30, "sandbox"),
    ev("step-completed", 100, "repo-setup"),
    ev("step-completed", 130, "environment-prepare"),
    ev("step-completed", 190, "environment-check"),
    ev("step-completed", 200, "repo-context"),
    ev("step-completed", 320, "repo-index"),
    ev("step-completed", 900, "baseline-tests"),
    ev("step-completed", 940, "warm-cache"),
    ev("step-completed", 1000, "plan-think"),
    ev("step-completed", 1010, "plan-snapshot"),
    ev("event-waiting", 1015, "plan-approval"),
    ev("event-received", 5015, "plan-approval"),
    ev("step-completed", 5030, "plan-restore"),
    ev("step-completed", 5100, "turn-0-think"),
    ev("step-completed", 5200, "turn-0-exec"),
    evd("step-completed", 5210, "turn-0-fingerprint", { result: { hash: "aaaa", dirty: true } }),
    ev("step-completed", 5300, "turn-1-think"),
    ev("step-completed", 5400, "turn-1-exec"),
    evd("step-completed", 5410, "turn-1-fingerprint", { result: { hash: "bbbb", dirty: false } }),
    ev("step-completed", 5420, "change-class"), // deliberately in no family
    ev("step-completed", 5500, "repo-push"),
    ev("step-completed", 5600, "repo-pr"),
    ev("run-completed", 5610),
  ];
  const t = runTiming(events, { claimedAt: at(5) });
  assert.equal(phaseOf(t, "admission").durationMs, 5_000, "enqueue -> worker claim");
  assert.equal(phaseOf(t, "sandbox-create").durationMs, 25_000, "the first phase starts at the claim");
  assert.equal(phaseOf(t, "clone").durationMs, 70_000);
  assert.equal(phaseOf(t, "environment").durationMs, 90_000, "prepare and check fold into one phase");
  assert.equal(phaseOf(t, "context").durationMs, 10_000);
  assert.equal(phaseOf(t, "index").durationMs, 120_000);
  assert.equal(phaseOf(t, "baseline").durationMs, 580_000);
  assert.equal(phaseOf(t, "warm-cache").durationMs, 40_000);
  // The park is the human wait plus the snapshot/restore only a park records.
  assert.equal(phaseOf(t, "plan-park").durationMs, 4_025_000);
  assert.deepEqual(phaseOf(t, "plan-park").steps, ["plan-snapshot", "plan-approval", "plan-restore"]);
  assert.equal(phaseOf(t, "model-think").durationMs, 220_000, "plan-think (from warm-cache) + both turn thinks (from plan-restore and the prior fingerprint)");
  assert.deepEqual(phaseOf(t, "model-think").steps, ["plan-think", "turn-0-think", "turn-1-think"]);
  assert.equal(phaseOf(t, "model-exec").durationMs, 200_000);
  assert.equal(phaseOf(t, "publish").durationMs, 180_000, "push (from change-class, the event before it) + PR");
  assert.equal(t.ttftMs, 1_000_000, "run-started -> plan-think");
  assert.equal(t.ttftWhy, null);
  assert.equal(t.ttfeMs, 5_210_000, "run-started -> first dirty fingerprint");
  assert.equal(t.ttfeWhy, null);
  assert.equal(t.phases[0]!.phase, "admission", "admission always leads");
  assert.equal(t.telemetry, "complete");
  assert.deepEqual(t.unknown, []);
});

test("D4-a: without a claim, admission is the stated upper bound and overlaps the first phase", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 30, "sandbox"),
    ev("step-completed", 90, "repo-setup"),
    ev("run-completed", 95),
  ]);
  assert.equal(phaseOf(t, "admission").durationMs, 30_000);
  assert.equal(t.toFirstStepMs, 30_000, "same figure, same bound, one channel each");
  assert.equal(phaseOf(t, "sandbox-create").durationMs, 30_000, "the documented overlap: queue + first step");
  assert.equal(phaseOf(t, "clone").durationMs, 60_000);
  assert.deepEqual(t.unknown, [], "an absent claim is the norm for old runs, not a fault");
});

test("D4-a: a claim outside the run's window is refused with a reason, never a split gap", () => {
  seq = 0;
  const events = [ev("run-started", 0), ev("step-completed", 30, "sandbox"), ev("run-completed", 40)];
  const late = runTiming(events, { claimedAt: at(60) });
  assert.equal(phaseOf(late, "admission").durationMs, 30_000, "falls back to the upper bound");
  assert.ok(late.unknown.some((u) => u.includes("outside the run's window")));
  assert.equal(late.telemetry, "partial");
  const early = runTiming(events, { claimedAt: at(-60) });
  assert.equal(phaseOf(early, "admission").durationMs, 30_000);
  assert.ok(early.unknown.some((u) => u.includes("outside the run's window")));
});

test("D4-a: an unstamped step yields a null phase with a reason, never 0", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 30, "sandbox"),
    ev("step-completed", null, "repo-setup"),
    ev("step-completed", 200, "repo-index"),
    ev("run-completed", 260),
  ]);
  const clone = phaseOf(t, "clone");
  assert.equal(clone.durationMs, null);
  assert.deepEqual(clone.steps, ["repo-setup"]);
  const index = phaseOf(t, "index");
  assert.equal(index.durationMs, null, "the unstamped boundary poisons the next gap too");
  assert.ok(t.unknown.some((u) => u.includes('phase "clone"')));
  assert.ok(t.unknown.some((u) => u.includes('phase "index"')));
});

test("D4-a: a run with no edit has a null TTFE with a reason, and so does one with no fingerprints", () => {
  seq = 0;
  const scanned = runTiming([
    ev("run-started", 0),
    ev("step-completed", 10, "sandbox"),
    ev("step-completed", 50, "turn-0-think"),
    ev("step-completed", 60, "turn-0-exec"),
    evd("step-completed", 61, "turn-0-fingerprint", { result: { hash: "h", dirty: false } }),
    ev("run-completed", 70),
  ]);
  assert.equal(scanned.ttfeMs, null, "no edit happened");
  assert.match(scanned.ttfeWhy!, /no edit/);
  assert.equal(scanned.ttftMs, 50_000);

  seq = 0;
  const bare = runTiming([ev("run-started", 0), ev("step-completed", 10, "sandbox"), ev("run-completed", 20)]);
  assert.equal(bare.ttfeMs, null);
  assert.match(bare.ttfeWhy!, /no turn fingerprint/);
  assert.deepEqual(bare.unknown, [], "a structural absence is not missing telemetry");
});

test("D4-a: TTFT is null with a reason when the log holds no think step", () => {
  seq = 0;
  const t = runTiming([ev("run-started", 0), ev("step-completed", 5, "sandbox"), ev("run-completed", 9)]);
  assert.equal(t.ttftMs, null);
  assert.match(t.ttftWhy!, /no think step/);
  assert.deepEqual(t.unknown, []);
});

test("D4-a: attempt-prefixed steps fold into their phase families", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 10, "sandbox"),
    ev("step-completed", 20, "attempt-1-sandbox"),
    ev("step-completed", 30, "attempt-1-turn-0-think"),
    ev("run-completed", 40),
  ]);
  assert.equal(phaseOf(t, "sandbox-create").durationMs, 20_000, "both executions charge the same phase");
  assert.deepEqual(phaseOf(t, "sandbox-create").steps, ["sandbox", "attempt-1-sandbox"]);
  assert.equal(phaseOf(t, "model-think").durationMs, 10_000);
  assert.equal(t.ttftMs, 30_000, "the first think step wins, whichever attempt wrote it");
});

test("D4-a: an open plan park leaves the phase null rather than measuring against the clock", () => {
  seq = 0;
  const t = runTiming([
    ev("run-started", 0),
    ev("step-completed", 10, "sandbox"),
    ev("step-completed", 20, "plan-think"),
    ev("step-completed", 22, "plan-snapshot"),
    ev("event-waiting", 24, "plan-approval"),
  ]);
  const park = phaseOf(t, "plan-park");
  assert.equal(park.durationMs, null);
  assert.deepEqual(park.steps, ["plan-snapshot", "plan-approval"]);
});
