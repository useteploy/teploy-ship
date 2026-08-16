import assert from "node:assert/strict";
import { test } from "node:test";

import type { Action } from "./actions.js";
import { RecoveryTracker, SETTLE_NUDGE, SETTLE_STOP } from "./recovery.js";
import type { RecoverySignal } from "./recovery.js";

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

// --- settle: spinning over an already-edited tree is a finish, not a failure ---

/** A distinct read-only command each turn — evades the loop detector. */
let inspection = 0;
const look = (): Action => ({ kind: "bash", code: `cat file-${inspection++}.txt` });

/** Run zero-progress turns until a rut fires; bounded so a bug cannot hang. */
function spinToRut(tracker: RecoveryTracker, options: { dirty: boolean; fingerprint?: string }): RecoverySignal {
  for (let i = 0; i < 12; i++) {
    const signal = tracker.observe(look(), 0, options.fingerprint ?? "diff-1", options.dirty);
    if (signal.kind !== "ok") return signal;
  }
  throw new Error("no rut fired within 12 zero-progress turns");
}

test("settle is off by default: a dirty tree spinning past maxNudges still aborts", () => {
  const tracker = new RecoveryTracker({ loopThreshold: 99, failureThreshold: 99, maxNudges: 1, noProgressThreshold: 2 });
  const first = spinToRut(tracker, { dirty: true });
  assert.equal(first.kind, "nudge");
  assert.match(first.kind === "nudge" ? first.message : "", /succeeded but changed nothing/);
  const last = spinToRut(tracker, { dirty: true });
  assert.equal(last.kind, "abort", "without settle, a dirty tree changes nothing about the outcome");
  assert.match(last.kind === "abort" ? last.message : "", /without changing anything/);
});

test("settle on + dirty tree: one finish-now nudge, then a deliberate stop instead of an abort", () => {
  const tracker = new RecoveryTracker({
    loopThreshold: 99,
    failureThreshold: 99,
    maxNudges: 3,
    noProgressThreshold: 2,
    settle: true,
  });
  // First rut: the agent is told it may already be done.
  const rut1 = spinToRut(tracker, { dirty: true });
  assert.equal(rut1.kind, "nudge");
  assert.equal(rut1.kind === "nudge" ? rut1.message : "", SETTLE_NUDGE);
  // It kept going anyway: the ordinary spinning nudges resume, unchanged.
  for (const _ of [2, 3]) {
    const rut = spinToRut(tracker, { dirty: true });
    assert.equal(rut.kind, "nudge");
    assert.match(rut.kind === "nudge" ? rut.message : "", /succeeded but changed nothing/);
  }
  // Past maxNudges the run ends — as a stop, at the exact turn it would
  // otherwise have aborted.
  const final = spinToRut(tracker, { dirty: true });
  assert.equal(final.kind, "stop");
  assert.equal(final.kind === "stop" ? final.message : "", SETTLE_STOP);
});

test("settle on + CLEAN tree: nothing changes — nothing was built, so it is still an abort", () => {
  const tracker = new RecoveryTracker({
    loopThreshold: 99,
    failureThreshold: 99,
    maxNudges: 1,
    noProgressThreshold: 2,
    settle: true,
  });
  const first = spinToRut(tracker, { dirty: false, fingerprint: "empty" });
  assert.equal(first.kind, "nudge");
  assert.match(first.kind === "nudge" ? first.message : "", /succeeded but changed nothing/, "not the settle nudge");
  assert.equal(spinToRut(tracker, { dirty: false, fingerprint: "empty" }).kind, "abort");
});

test("settle never blesses a stuck agent: looping and thrashing still abort over a dirty tree", () => {
  const looping = new RecoveryTracker({
    loopThreshold: 2,
    failureThreshold: 99,
    maxNudges: 1,
    noProgressThreshold: 99,
    settle: true,
  });
  const same: Action = { kind: "bash", code: "python -m pytest" };
  assert.equal(looping.observe(same, 0, "diff-1", true).kind, "ok");
  assert.equal(looping.observe(same, 0, "diff-1", true).kind, "nudge");
  assert.equal(looping.observe(same, 0, "diff-1", true).kind, "ok");
  const loopEnd = looping.observe(same, 0, "diff-1", true);
  assert.equal(loopEnd.kind, "abort");
  assert.match(loopEnd.kind === "abort" ? loopEnd.message : "", /repeating the same action/);

  const thrashing = new RecoveryTracker({
    loopThreshold: 99,
    failureThreshold: 2,
    maxNudges: 1,
    noProgressThreshold: 99,
    settle: true,
  });
  assert.equal(thrashing.observe(look(), 1, "diff-1", true).kind, "ok");
  assert.equal(thrashing.observe(look(), 1, "diff-1", true).kind, "nudge");
  assert.equal(thrashing.observe(look(), 1, "diff-1", true).kind, "ok");
  const failEnd = thrashing.observe(look(), 1, "diff-1", true);
  assert.equal(failEnd.kind, "abort");
  assert.match(failEnd.kind === "abort" ? failEnd.message : "", /kept failing/);
});

test("the settle nudge fires at most once per run, even after real progress in between", () => {
  const tracker = new RecoveryTracker({
    loopThreshold: 99,
    failureThreshold: 99,
    maxNudges: 9,
    noProgressThreshold: 2,
    settle: true,
  });
  const rut1 = spinToRut(tracker, { dirty: true });
  assert.equal(rut1.kind === "nudge" ? rut1.message : "", SETTLE_NUDGE);
  // The agent takes the hint the other way and edits again — then settles again.
  assert.equal(tracker.observe({ kind: "bash", code: "sed -i s/a/b/ x.py" }, 0, "diff-2", true).kind, "ok");
  const rut2 = spinToRut(tracker, { dirty: true, fingerprint: "diff-2" });
  assert.equal(rut2.kind, "nudge");
  assert.match(rut2.kind === "nudge" ? rut2.message : "", /succeeded but changed nothing/, "offered once, not every rut");
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
