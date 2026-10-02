import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { runTiming } from "./run-timing.js";

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
