import assert from "node:assert/strict";
import { test } from "node:test";

import { HARNESS_VERSIONS } from "./harness.js";
import { STEER_REPLY_EXTERNAL_MESSAGE, STEER_REPLY_UNSUPPORTED_MESSAGE, harnessSupports, recordedHarnessIds, steerLoopExited, steerReplyRefusal } from "./harness-capabilities.js";

test("S13/D6/D7: steering is supported by every current contract and refused for the 1-contract external logs", () => {
  // Native: always (no version to check).
  assert.equal(harnessSupports({ harness: { id: "native" } }, "steer"), true);
  assert.equal(harnessSupports({ harness: { id: "native", version: "1" } }, "steer"), true);
  // External contract 2: the session-resume contracts (D6/D7).
  assert.equal(harnessSupports({ harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } }, "steer"), true);
  assert.equal(harnessSupports({ harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } }, "steer"), true);
  // The 1-contract external adapters read nothing but their starting prompt —
  // a note accepted for one of their runs would be stored, acknowledged and
  // never read, so the gate refuses it.
  assert.equal(harnessSupports({ harness: { id: "claude-code", version: "1" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: "opencode", version: "1" } }, "steer"), false);
  // No version at all: a hand-built input or a pre-contract log — the safe
  // answer for a run whose program is unknown.
  assert.equal(harnessSupports({ harness: { id: "claude-code" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: "opencode" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: "codex" } }, "steer"), false);
});

test("S13: a run with no harness field is native, unknown harnesses and malformed refs support nothing", () => {
  assert.equal(harnessSupports({}, "steer"), true);
  assert.equal(harnessSupports(undefined, "steer"), true);
  assert.equal(harnessSupports({ harness: { id: "mystery", version: "2" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: 7 } }, "steer"), false);
  assert.equal(harnessSupports({ harness: {} }, "steer"), false);
});

test("S13: every harness in the run must support steering, single and multi-attempt", () => {
  assert.equal(harnessSupports({ harness: { id: "native" }, harnessAttempts: [{ id: "native" }, { id: "native" }] }, "steer"), true);
  // Attempts carry the same id + version refs enqueueRun materialises.
  assert.equal(
    harnessSupports(
      { harness: { id: "native", version: "1" }, harnessAttempts: [{ id: "opencode", version: "2" }, { id: "claude-code", version: "2" }] },
      "steer",
    ),
    true,
  );
  assert.equal(
    harnessSupports({ harness: { id: "native", version: "1" }, harnessAttempts: [{ id: "opencode", version: "1" }] }, "steer"),
    false,
    "one 1-contract attempt is enough to refuse: its notes would be dropped",
  );
  assert.deepEqual(recordedHarnessIds({ harness: { id: "native", version: "1" }, harnessAttempts: [{ id: "opencode", version: "2" }] }), ["native", "opencode"]);
});

test("steerLoopExited: a multi-attempt run is open until the FINAL attempt's closing step, then exited", () => {
  const cc = { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] };
  const two = { steer: true, harnessAttempts: [cc, cc] };
  const done = (name: string) => ({ type: "step-completed", name });
  assert.equal(steerLoopExited(two, []), false);
  assert.equal(steerLoopExited(two, [done("attempt-0-harness-steer-undelivered")]), false, "attempt 0 closing says nothing about attempt 1");
  assert.equal(steerLoopExited(two, [done("attempt-0-harness-steer-undelivered"), done("attempt-1-harness-steer-undelivered")]), true);
  const three = { steer: true, harnessAttempts: [cc, cc, cc] };
  assert.equal(steerLoopExited(three, [done("attempt-1-harness-steer-undelivered")]), false);
  assert.equal(steerLoopExited(three, [done("attempt-2-harness-steer-undelivered")]), true);
  assert.equal(steerLoopExited({ steer: true, harness: cc }, [done("harness-steer-undelivered")]), true, "single harness unchanged");
});

test("steerReplyRefusal: queue/interrupt need the D2 flag and an all-native run", () => {
  const cc = { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] };
  assert.equal(steerReplyRefusal({ steer: true, steerReply: true }), undefined);
  assert.equal(steerReplyRefusal({ steer: true }), STEER_REPLY_UNSUPPORTED_MESSAGE);
  assert.equal(steerReplyRefusal({ steer: true, steerReply: true, harness: cc }), STEER_REPLY_EXTERNAL_MESSAGE);
  assert.equal(steerReplyRefusal({ steer: true, steerReply: true, harnessAttempts: [{ id: "native", version: "1" }, cc] }), STEER_REPLY_EXTERNAL_MESSAGE);
});
