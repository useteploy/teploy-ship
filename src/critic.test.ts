import assert from "node:assert/strict";
import { test } from "node:test";

import { CRITIC_APPROVE_TOKEN, criticFeedback, isApproved } from "./critic.js";

test("isApproved accepts the exact token the critic is asked for", () => {
  assert.equal(isApproved(CRITIC_APPROVE_TOKEN), true);
  assert.equal(isApproved("  APPROVE  "), true);
  assert.equal(isApproved("APPROVE\n"), true);
});

test("isApproved tolerates case and a trailing sentence mark", () => {
  assert.equal(isApproved("Approve"), true);
  assert.equal(isApproved("APPROVE."), true);
  assert.equal(isApproved("Approve!"), true);
});

test("isApproved accepts a verdict alone on the final line", () => {
  assert.equal(isApproved("Looks correct.\nAPPROVE"), true);
  assert.equal(isApproved("Checked the diff against the task.\n\nAPPROVE"), true);
  assert.equal(isApproved("Reasoning here.\napprove."), true);
});

// The gate must fail CLOSED. A substring test (the original bug) reads every
// one of these as an approval and ships work the critic explicitly rejected.
test("isApproved rejects prose that merely contains the token", () => {
  assert.equal(isApproved("I cannot APPROVE this — the fix is wrong."), false);
  assert.equal(isApproved("I do not APPROVE."), false);
  assert.equal(isApproved("APPROVE is not warranted: the test still fails."), false);
  assert.equal(isApproved("This does not APPROVE of the change"), false);
  assert.equal(isApproved("Cannot approve — missing a null check on line 12."), false);
});

test("isApproved rejects empty and non-verdict text", () => {
  assert.equal(isApproved(""), false);
  assert.equal(isApproved("   "), false);
  assert.equal(isApproved("The diff looks fine to me."), false);
});

test("criticFeedback carries the review into an actionable nudge", () => {
  const nudge = criticFeedback("  The retry loop is unbounded.  ");
  assert.match(nudge, /The retry loop is unbounded\./);
  assert.match(nudge, /finish again/);
});
