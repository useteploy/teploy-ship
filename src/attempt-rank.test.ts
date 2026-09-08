import assert from "node:assert/strict";
import { test } from "node:test";

import { attemptOutcomeLine, rankAttempts } from "./attempt-rank.js";
import type { AttemptOutcome } from "./attempt-rank.js";

function attempt(n: number, over: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return { attempt: n, harness: `h${n}`, changedFiles: 1, ...over };
}

const passed = { kind: "passed" as const, command: "pnpm test", durationMs: 1000 };
const failed = { kind: "failed" as const, command: "pnpm test", durationMs: 1000, exitCode: 1, output: "boom" };

test("a failing suite is never selected over a passing one, whatever the critic says", () => {
  const attempts = [attempt(1, { tests: failed, changedFiles: 2 }), attempt(2, { tests: passed, changedFiles: 9 })];
  // The critic prefers the failing attempt 1, loudly.
  const ranked = rankAttempts(attempts, 1);
  assert.equal(ranked.winner?.attempt, 2);
  assert.match(ranked.reason, /selected attempt 2 of 2: suite passed/);
  assert.match(ranked.reason, /attempt 1 suite failed \(exit 1\)/);
  // And the order puts every passing attempt above every failing one.
  assert.deepEqual(ranked.order.map((a) => a.attempt), [2, 1]);
});

test("no suite outcome sorts below a passing one, and an absent suite is not a pass", () => {
  const attempts = [attempt(1, {}), attempt(2, { tests: passed })];
  assert.equal(rankAttempts(attempts, 1).winner?.attempt, 2);
  // Both without a suite: launch order holds (the critic breaks the tie).
  assert.deepEqual(rankAttempts([attempt(1, {}), attempt(2, {})], 2).order.map((a) => a.attempt), [2, 1]);
  assert.deepEqual(rankAttempts([attempt(1, {}), attempt(2, {})], null).order.map((a) => a.attempt), [1, 2]);
});

test("the build separates attempts the suite could not", () => {
  const buildOk = { kind: "passed" as const, command: "pnpm build", durationMs: 500 };
  const buildBad = { kind: "failed" as const, command: "pnpm build", durationMs: 500, exitCode: 2, output: "tsc" };
  const attempts = [attempt(1, { tests: passed, build: buildBad }), attempt(2, { tests: passed, build: buildOk })];
  assert.equal(rankAttempts(attempts, 1).winner?.attempt, 2);
  // A failed build never beats a passed one, but it does beat a failed SUITE.
  assert.equal(rankAttempts([attempt(1, { tests: failed, build: buildOk }), attempt(2, { tests: passed })], 1).winner?.attempt, 2);
});

test("fewest changed files among the attempts that passed both", () => {
  const attempts = [attempt(1, { tests: passed, changedFiles: 4 }), attempt(2, { tests: passed, changedFiles: 2 })];
  assert.equal(rankAttempts(attempts, 1).winner?.attempt, 2);
  // A tie on files falls to the critic's pick.
  assert.equal(rankAttempts([attempt(1, { tests: passed, changedFiles: 2 }), attempt(2, { tests: passed, changedFiles: 2 })], 2).winner?.attempt, 2);
  assert.equal(rankAttempts([attempt(1, { tests: passed, changedFiles: 2 }), attempt(2, { tests: passed, changedFiles: 2 })], null).winner?.attempt, 1);
});

test("an empty diff is the caller's to exclude, not the ranking's to hide", () => {
  // Zero changed files still counts at rung 3: the ranking is honest about the
  // outcomes it was handed, and the caller (durable.ts) drops the no-diff
  // attempts before ranking, exactly as P5-4 already did.
  const attempts = [attempt(1, { changedFiles: 0 }), attempt(2, { changedFiles: 3 })];
  assert.equal(rankAttempts(attempts, null).winner?.attempt, 1);
});

test("the reason line renders one line per attempt, winner first", () => {
  const attempts = [
    attempt(1, { tests: failed, changedFiles: 1 }),
    attempt(2, { tests: passed, changedFiles: 2 }),
    attempt(3, { tests: failed, changedFiles: 5 }),
  ];
  const { reason } = rankAttempts(attempts, null);
  assert.equal(
    reason,
    "selected attempt 2 of 3: suite passed, 2 files changed; " +
      "attempt 1 suite failed (exit 1), 1 file changed; " +
      "attempt 3 suite failed (exit 1), 5 files changed",
  );
  assert.equal(
    attemptOutcomeLine(attempts[1]!),
    "suite passed, 2 files changed",
  );
  assert.equal(attemptOutcomeLine(attempt(9, { tests: undefined })), "suite not run, 1 file changed");
});

test("an errored suite is not a pass, and a disabled suite is rendered honestly", () => {
  const errored = { kind: "errored" as const, command: "pnpm test", reason: "no runner" };
  const disabled = { kind: "disabled" as const, reason: "no test command configured" };
  assert.equal(rankAttempts([attempt(1, { tests: errored }), attempt(2, { tests: passed })], 1).winner?.attempt, 2);
  assert.equal(rankAttempts([attempt(1, { tests: disabled }), attempt(2, { tests: passed })], 1).winner?.attempt, 2);
  assert.match(attemptOutcomeLine(attempt(1, { tests: errored })), /suite could not run/);
  assert.match(attemptOutcomeLine(attempt(1, { tests: disabled })), /suite not configured/);
});

test("the winner is first in the order, and the order covers every attempt", () => {
  const attempts = [attempt(1), attempt(2), attempt(3), attempt(4), attempt(5)];
  const ranked = rankAttempts(attempts, null);
  assert.equal(ranked.order.length, 5);
  assert.equal(ranked.winner, ranked.order[0]);
});

test("tied names exactly the attempts the critic may be asked about", () => {
  const attempts = [
    attempt(1, { tests: failed, changedFiles: 2 }),
    attempt(2, { tests: passed, changedFiles: 2 }),
    attempt(3, { tests: passed, changedFiles: 2 }),
    attempt(4, { tests: passed, changedFiles: 7 }),
  ];
  const { tied, winner } = rankAttempts(attempts, null);
  // 2 and 3 are level on suite, build and file count; 1 failed the suite and
  // 4 changed more files, so neither belongs in the set the critic may decide.
  assert.deepEqual(tied, [2, 3]);
  assert.equal(winner?.attempt, 2);
  // A clean win by the suite leaves the critic nothing to decide.
  assert.deepEqual(rankAttempts([attempt(1, { tests: failed }), attempt(2, { tests: passed })], null).tied, [2]);
});

test("no attempts at all is an answer, not a crash", () => {
  assert.deepEqual(rankAttempts([], null), { order: [], winner: undefined, tied: [], reason: "no attempt finished" });
});
