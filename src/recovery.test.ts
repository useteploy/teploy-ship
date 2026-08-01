import assert from "node:assert/strict";
import { test } from "node:test";

import type { Action } from "./actions.js";
import { RecoveryTracker } from "./recovery.js";

const bash = (code: string): Action => ({ kind: "bash", code });

test("repeating the same action fires a loop nudge at the threshold", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 3, failureThreshold: 99, maxNudges: 3, noProgressThreshold: 99 });
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  const third = tracker.observe(bash("ls"), 0);
  assert.equal(third.kind, "nudge");
  assert.match((third as { message: string }).message, /repeated the same action/);
});

test("distinct actions do not trip the loop detector", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 3, failureThreshold: 99, maxNudges: 3, noProgressThreshold: 99 });
  assert.equal(tracker.observe(bash("ls"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("pwd"), 0).kind, "ok");
  assert.equal(tracker.observe(bash("cat x"), 0).kind, "ok");
});

test("consecutive failures fire a thrashing nudge; a success resets the count", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 99, failureThreshold: 3, maxNudges: 3, noProgressThreshold: 99 });
  assert.equal(tracker.observe(bash("a"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("b"), 0).kind, "ok"); // success resets
  assert.equal(tracker.observe(bash("c"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("d"), 1).kind, "ok");
  const signal = tracker.observe(bash("e"), 1);
  assert.equal(signal.kind, "nudge");
  assert.match((signal as { message: string }).message, /failed/);
});

test("persistent looping past maxNudges escalates to abort", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 2, failureThreshold: 99, maxNudges: 2, noProgressThreshold: 99 });
  // each pair of identical actions = one nudge (windows clear after firing)
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "nudge"); // nudge 1
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "nudge"); // nudge 2
  assert.equal(tracker.observe(bash("x"), 1).kind, "ok");
  assert.equal(tracker.observe(bash("x"), 1).kind, "abort"); // nudge 3 > maxNudges
});

test("TS-056: succeeding without changing anything is detected as spinning", () => {
  const tracker = new RecoveryTracker({
    loopThreshold: 99,
    failureThreshold: 99,
    maxNudges: 3,
    noProgressThreshold: 3,
  });
  // Every command exits 0 and every command is different, so neither the loop
  // detector nor the failure detector fires. The work never moves.
  const look = (n: number): Action => ({ kind: "bash", code: `cat file-${n}.txt` });
  assert.equal(tracker.observe(look(1), 0, "same-diff").kind, "ok");
  assert.equal(tracker.observe(look(2), 0, "same-diff").kind, "ok");
  assert.equal(tracker.observe(look(3), 0, "same-diff").kind, "ok");
  const signal = tracker.observe(look(4), 0, "same-diff");
  assert.equal(signal.kind, "nudge");
  assert.match(signal.kind === "nudge" ? signal.message : "", /succeeded but changed nothing/);
});

test("real progress resets the spinning counter", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 99, failureThreshold: 99, maxNudges: 3, noProgressThreshold: 2 });
  assert.equal(tracker.observe({ kind: "bash", code: "a" }, 0, "diff-1").kind, "ok");
  assert.equal(tracker.observe({ kind: "bash", code: "b" }, 0, "diff-1").kind, "ok");
  // The work changed — the agent is building, not spinning.
  assert.equal(tracker.observe({ kind: "bash", code: "c" }, 0, "diff-2").kind, "ok");
  assert.equal(tracker.observe({ kind: "bash", code: "d" }, 0, "diff-2").kind, "ok");
});

test("TS-056: loop detection covers edits and ignores cosmetic whitespace", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 2, failureThreshold: 99, maxNudges: 3, noProgressThreshold: 99 });
  const edit: Action = { kind: "edit", file: "a.ts", search: "const x = 1;", replace: "const x = 2;" };
  assert.equal(tracker.observe(edit, 0).kind, "ok");
  // The same edit again — previously invisible to the tracker entirely.
  assert.equal(tracker.observe({ ...edit }, 0).kind, "nudge");

  const spaced = new RecoveryTracker({ loopThreshold: 2, failureThreshold: 99, maxNudges: 3, noProgressThreshold: 99 });
  assert.equal(spaced.observe({ kind: "bash", code: "npm  test" }, 1).kind, "ok");
  assert.equal(spaced.observe({ kind: "bash", code: "npm test" }, 1).kind, "nudge", "whitespace is not a new idea");
});
