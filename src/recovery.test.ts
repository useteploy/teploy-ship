import assert from "node:assert/strict";
import { test } from "node:test";

import type { Action } from "./actions.js";
import { RecoveryTracker } from "./recovery.js";

const bash = (code: string): Action => ({ kind: "bash", code });

test("repeating the same action fires a loop nudge at the threshold", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 3, failureThreshold: 99, maxNudges: 3 });
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  const third = tracker.observe(bash("ls"), 0);
  assert.equal(third.kind, "nudge");
  assert.match((third as { message: string }).message, /repeated the same action/);
});

test("distinct actions do not trip the loop detector", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 3, failureThreshold: 99, maxNudges: 3 });
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("pwd"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("cat x"), 0).kind, "ok");
});

test("consecutive failures fire a thrashing nudge; a success resets the count", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 99, failureThreshold: 3, maxNudges: 3 });
  assert.equal(tracker.observe(bash("a"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("b"), 0).kind, "ok"); // success resets
  assert.equal(tracker.observe(bash("c"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("d"), 1).kind, "ok");
  const signal = tracker.observe(bash("e"), 1);
  assert.equal(signal.kind, "nudge");
  assert.match((signal as { message: string }).message, /failed/);
});

test("persistent looping past maxNudges escalates to abort", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 2, failureThreshold: 99, maxNudges: 2 });
  // each pair of identical actions = one nudge (windows clear after firing)
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "nudge"); // nudge 1
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "nudge"); // nudge 2
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "abort"); // nudge 3 > maxNudges
});
