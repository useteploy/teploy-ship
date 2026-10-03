import assert from "node:assert/strict";
import test from "node:test";
import { integrationStatus } from "./integration-evidence.js";
import type { IntegrationEvidence } from "./integration-evidence.js";

const sha = (c: string) => c.repeat(40);
const API = "https://forge.example/o/api";
const CLIENT = "https://forge.example/o/client";
const current = { producer: { repo: API, sha: sha("a") }, consumer: { repo: CLIENT, sha: sha("b") } };

function ev(over: Partial<IntegrationEvidence> = {}): IntegrationEvidence {
  return {
    class: "executed-pair",
    producer: { repo: API, sha: sha("a") },
    consumer: { repo: CLIENT, sha: sha("b") },
    command: "node verify-pair.mjs api client /sum",
    result: "passed",
    at: "2026-10-03T10:00:00Z",
    ...over,
  };
}

test("S18: an unrequired integration test never blocks, whatever evidence exists", () => {
  const s = integrationStatus(false, [ev({ result: "failed" })], current);
  assert.equal(s.state, "not-required");
  assert.equal(s.blocking, false);
});

test("S18: a passing executed test on the exact revisions satisfies", () => {
  const s = integrationStatus(true, [ev()], current);
  assert.equal(s.state, "satisfied");
  assert.equal(s.blocking, false);
  assert.equal(s.basis?.result, "passed");
});

test("S18: static compatibility never satisfies an executed requirement", () => {
  const s = integrationStatus(true, [ev({ class: "static", command: undefined })], current);
  assert.equal(s.state, "missing");
  assert.equal(s.blocking, true);
  assert.match(s.ignored[0]!.why, /different evidence class/);
});

test("S18: a racing upstream change makes the evidence stale, naming which side moved", () => {
  const producerMoved = integrationStatus(true, [ev()], { ...current, producer: { repo: API, sha: sha("c") } });
  assert.equal(producerMoved.state, "stale");
  assert.equal(producerMoved.blocking, true);
  assert.match(producerMoved.reason, /earlier producer revision/);

  const bothMoved = integrationStatus(true, [ev()], { producer: { repo: API, sha: sha("c") }, consumer: { repo: CLIENT, sha: sha("d") } });
  assert.match(bothMoved.reason, /producer and consumer/);
});

test("S18: a failure on the current revisions is not outvoted by an older pass, and newest decides", () => {
  const failedLater = integrationStatus(true, [ev({ at: "2026-10-03T09:00:00Z" }), ev({ result: "failed", at: "2026-10-03T11:00:00Z" })], current);
  assert.equal(failedLater.state, "failed");
  const passedLater = integrationStatus(true, [ev({ result: "failed", at: "2026-10-03T09:00:00Z" }), ev({ at: "2026-10-03T11:00:00Z" })], current);
  assert.equal(passedLater.state, "satisfied", "a genuine re-run that passes supersedes the earlier failure");
  const tie = integrationStatus(true, [ev(), ev({ result: "failed" })], current);
  assert.equal(tie.state, "failed", "at the same instant a failure wins");
});

test("S18: not-run and unknown are unresolved, never a pass and never a failure", () => {
  for (const result of ["not-run", "unknown"] as const) {
    const s = integrationStatus(true, [ev({ result })], current);
    assert.equal(s.state, "unresolved", result);
    assert.equal(s.blocking, true, result);
  }
});

test("S18: executed evidence without a command, abbreviated revisions and other pairs are set aside with reasons", () => {
  const s = integrationStatus(
    true,
    [
      ev({ command: "  " }),
      ev({ producer: { repo: API, sha: "abc1234" } }),
      ev({ consumer: { repo: "https://forge.example/o/other", sha: sha("b") } }),
      ev({ at: "garbage" }),
    ],
    current,
  );
  assert.equal(s.state, "missing");
  assert.equal(s.ignored.length, 4);
  assert.deepEqual(s.ignored.map((i) => i.why.split(" ")[0]).sort(), ["evidence", "evidence", "executed", "revision"]);
});

test("S18: a current revision that is not a full commit id cannot be matched to anything", () => {
  const s = integrationStatus(true, [ev()], { ...current, producer: { repo: API, sha: "main" } });
  assert.equal(s.state, "unresolved");
  assert.equal(s.blocking, true);
});
