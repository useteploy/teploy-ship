import assert from "node:assert/strict";
import { test } from "node:test";

import { runWebhookPayload } from "./notify.js";
import type { RunNotification } from "./notify.js";
import { pushDiffFromEvents, surfacedTestIntegrity, testIntegrityRecord, testIntegritySection, testIntegritySurfacingMode } from "./test-integrity-surface.js";
import type { IntegrityLogEvent } from "./test-integrity-surface.js";
import { spliceVerification, verificationSection } from "./verification.js";
import type { Evidence } from "./verification.js";

// S08 surfacing (programme wave 5): the detector's findings on the pull
// request body and the run webhook, behind SHIP_TEST_INTEGRITY_SURFACING.
// The repo's wiring discipline applies to every test below: default-off
// byte-equivalence, a real-path test with the flag on through the actual
// composition code, and a negative control per rule.

// Diff builder, same convention as test-integrity.test.ts: lines carry their
// own +/-/space prefix and the hunk counts are computed.
function edit(path: string, body: string[]): string {
  const o = body.filter((l) => l[0] === "-" || l[0] === " ").length;
  const n = body.filter((l) => l[0] === "+" || l[0] === " ").length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -10,${o} +10,${n} @@`, ...body, ""].join("\n");
}

const SKIP_DIFF = edit("src/billing.test.ts", [" ctx", '+it.skip("bills correctly", () => {', "+  expect(bill(2)).toBe(4);", "+});"]);
const CLEAN_DIFF = edit("src/billing.ts", [" x", "-return 2 * n;", "+return n + n;"]);

const ev = (type: string, data?: unknown, name?: string): IntegrityLogEvent => ({ type, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) });
const pushStep = (result: unknown): IntegrityLogEvent[] => [ev("step-completed", { result }, "repo-push")];

// ---------------------------------------------------------------------------
// mode parsing

test("the flag is off unless explicitly shadow or on; junk is off and logged", () => {
  assert.equal(testIntegritySurfacingMode({}).mode, "off");
  assert.equal(testIntegritySurfacingMode({ SHIP_TEST_INTEGRITY_SURFACING: "" }).mode, "off");
  assert.equal(testIntegritySurfacingMode({ SHIP_TEST_INTEGRITY_SURFACING: "off" }).mode, "off");
  assert.equal(testIntegritySurfacingMode({ SHIP_TEST_INTEGRITY_SURFACING: "shadow" }).mode, "shadow");
  assert.equal(testIntegritySurfacingMode({ SHIP_TEST_INTEGRITY_SURFACING: "on" }).mode, "on");
  assert.deepEqual(testIntegritySurfacingMode({ SHIP_TEST_INTEGRITY_SURFACING: "yes" }), { mode: "off", invalid: "yes" });
});

// ---------------------------------------------------------------------------
// (a) default-off byte-equivalence — PR body and webhook payload

test("flag unset: the PR body's Verification section is byte-identical, no Test integrity part", () => {
  const evidence: Evidence = { tests: { kind: "passed", command: "pytest", durationMs: 10 } };
  const withFindingsAvailable = verificationSection({ ...evidence }, "run-1");
  assert.ok(withFindingsAvailable !== null);
  // The pre-change build had no testIntegrity field at all; the same input
  // must render to the same bytes.
  assert.equal(verificationSection({ ...evidence, testIntegrity: undefined }, "run-1"), withFindingsAvailable);
  assert.doesNotMatch(withFindingsAvailable, /Test integrity/);
  // And the wiring hands the worker nothing to spread in.
  for (const env of [{}, { SHIP_TEST_INTEGRITY_SURFACING: "" }, { SHIP_TEST_INTEGRITY_SURFACING: "off" }]) {
    assert.equal(surfacedTestIntegrity({ diff: SKIP_DIFF, env, where: "test", log: () => {} }), undefined, JSON.stringify(env));
  }
});

test("flag unset: the webhook payload is byte-identical to the pre-change shape", () => {
  // Pinned literal: this is exactly what a worker on the default flag sends.
  const notification: RunNotification = { runId: "run-9", status: "completed", pr: "http://f/o/r/pulls/9", repo: "o/r", task: "t", outcome: "finished" };
  assert.equal(
    JSON.stringify(runWebhookPayload(notification)),
    '{"run_id":"run-9","status":"completed","pr":"http://f/o/r/pulls/9","repo":"o/r","task":"t","outcome":"finished"}',
  );
  // Through the worker's own composition spread, with findings available:
  const integrity = surfacedTestIntegrity({ diff: SKIP_DIFF, env: {}, where: "test", log: () => {} });
  assert.equal(integrity, undefined);
  const owed = { ...notification, ...(integrity !== undefined ? { testIntegrity: integrity } : {}) };
  assert.equal(JSON.stringify(runWebhookPayload(owed)), JSON.stringify(runWebhookPayload(notification)));
});

// ---------------------------------------------------------------------------
// (b) real path with the flag on — through verificationSection and runWebhookPayload

test("flag on: findings land in the PR body's Verification section, between the markers", () => {
  const integrity = surfacedTestIntegrity({ diff: SKIP_DIFF, env: { SHIP_TEST_INTEGRITY_SURFACING: "on" }, where: "test", log: () => {} });
  assert.ok(integrity !== undefined);
  const section = verificationSection({ testIntegrity: integrity }, "run-1");
  assert.ok(section !== null);
  assert.match(section, /<!-- teploy-ship:verification -->/);
  assert.match(section, /\*\*Test integrity\*\* — tampered \(1 finding\)/);
  assert.match(section, /`src\/billing\.test\.ts:11` skipped-test \[high\/high\]/);
  assert.match(section, /it\.skip\("bills correctly"/);
  assert.match(section, /flags patterns, it does not prove intent/);
  // The section splices into a body the way every other part does, and a
  // second run replaces its span rather than stacking a second copy.
  const first = spliceVerification("The agent's summary.", section!);
  assert.ok(first.includes("The agent's summary."));
  assert.equal(spliceVerification(first, section!).indexOf("Test integrity"), first.indexOf("Test integrity"));
});

test("flag on: the webhook payload gains the additive test_integrity field, snake_case on the wire", () => {
  const integrity = surfacedTestIntegrity({
    diff: SKIP_DIFF,
    env: { SHIP_TEST_INTEGRITY_SURFACING: "on", SHIP_ORACLE_PATHS: "acceptance/**" },
    where: "test",
    log: () => {},
  });
  assert.ok(integrity !== undefined);
  assert.equal(integrity.oracleConfigured, true);
  const payload = runWebhookPayload({ runId: "run-9", status: "completed", testIntegrity: integrity });
  assert.equal(payload.test_integrity?.verdict, "tampered");
  assert.equal(payload.test_integrity?.total, 1);
  assert.equal(payload.test_integrity?.diff_complete, true);
  assert.equal(payload.test_integrity?.oracle_configured, true);
  assert.deepEqual(
    Object.keys(payload.test_integrity!.findings[0]!),
    ["kind", "file", "line", "severity", "confidence", "evidence"],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 64 * 1024);
});

test("flag on: the worker's own composition carries the field off the recorded repo-push diff", () => {
  const events = [
    ...pushStep({ kind: "pushed", sha: "feed0000", diff: SKIP_DIFF }),
    ev("run-completed", { output: { status: "finished", pr: "http://f/o/r/pulls/9" } }),
  ];
  // Exactly the call the terminal branch makes, then exactly its spread.
  const integrity = surfacedTestIntegrity({
    diff: pushDiffFromEvents(events),
    env: { SHIP_TEST_INTEGRITY_SURFACING: "on" },
    where: "the run webhook payload",
    runId: "run-9",
    log: () => {},
  });
  const owed: RunNotification = { runId: "run-9", status: "completed", ...(integrity !== undefined ? { testIntegrity: integrity } : {}) };
  const payload = runWebhookPayload(owed);
  assert.equal(payload.test_integrity?.findings[0]?.kind, "skipped-test");
  assert.equal(payload.test_integrity?.findings[0]?.file, "src/billing.test.ts");
});

test("an oracle edit surfaces as tampered, not suspicious", () => {
  const oracleEdit = edit("acceptance/oracle.test.ts", [" ctx", "+// touched", "+x = 2;"]);
  const integrity = surfacedTestIntegrity({
    diff: oracleEdit,
    env: { SHIP_TEST_INTEGRITY_SURFACING: "on", SHIP_ORACLE_PATHS: "acceptance/**" },
    where: "test",
    log: () => {},
  });
  assert.ok(integrity !== undefined);
  assert.equal(integrity.verdict, "tampered");
  assert.ok(integrity.findings.some((f) => f.kind === "oracle-edit"));
});

// ---------------------------------------------------------------------------
// (c) negative controls

test("flag on but no findings: no section, no field — clean is silence, not a clean bill", () => {
  const integrity = surfacedTestIntegrity({ diff: CLEAN_DIFF, env: { SHIP_TEST_INTEGRITY_SURFACING: "on" }, where: "test", log: () => {} });
  assert.equal(integrity, undefined, "a clean diff surfaces nothing");
  assert.equal(verificationSection({ testIntegrity: undefined }, "run-1"), null, "no other evidence and no findings means no section at all");
  const payload = runWebhookPayload({ runId: "r", status: "completed" });
  assert.ok(!("test_integrity" in payload));
});

test("no usable diff never crashes and never surfaces", () => {
  const on = { SHIP_TEST_INTEGRITY_SURFACING: "on" } as NodeJS.ProcessEnv;
  // No repo-push step, an unpushed result, a missing or non-string diff.
  assert.equal(surfacedTestIntegrity({ diff: pushDiffFromEvents([]), env: on, where: "test", log: () => {} }), undefined);
  assert.equal(surfacedTestIntegrity({ diff: pushDiffFromEvents(pushStep({ kind: "empty" })), env: on, where: "test", log: () => {} }), undefined);
  assert.equal(surfacedTestIntegrity({ diff: pushDiffFromEvents(pushStep({ kind: "pushed", sha: "x" })), env: on, where: "test", log: () => {} }), undefined);
  assert.equal(surfacedTestIntegrity({ diff: pushDiffFromEvents(pushStep({ kind: "pushed", diff: 42 })), env: on, where: "test", log: () => {} }), undefined);
  // Garbage text is not a diff: the parser yields nothing, verdict clean.
  assert.equal(testIntegrityRecord("not a diff at all", []), undefined);
  assert.equal(surfacedTestIntegrity({ diff: "not a diff at all", env: on, where: "test", log: () => {} }), undefined);
});

test("shadow computes and logs what on would surface, and writes nothing", () => {
  const lines: string[] = [];
  const integrity = surfacedTestIntegrity({
    diff: SKIP_DIFF,
    env: { SHIP_TEST_INTEGRITY_SURFACING: "shadow" },
    where: "the pull request body",
    runId: "run-4",
    log: (l) => lines.push(l),
  });
  assert.equal(integrity, undefined, "shadow never hands back a record");
  assert.deepEqual(lines, ["[test-integrity] shadow: run run-4: would surface tampered (1 finding) on the pull request body; nothing was written"]);
  // A clean diff in shadow is silence: there is nothing that on would add.
  const quiet: string[] = [];
  surfacedTestIntegrity({ diff: CLEAN_DIFF, env: { SHIP_TEST_INTEGRITY_SURFACING: "shadow" }, where: "test", log: (l) => quiet.push(l) });
  assert.deepEqual(quiet, []);
});

test("an unreadable flag value is treated as off, with one log line", () => {
  const lines: string[] = [];
  const integrity = surfacedTestIntegrity({
    diff: SKIP_DIFF,
    env: { SHIP_TEST_INTEGRITY_SURFACING: "yes" },
    where: "test",
    log: (l) => lines.push(l),
  });
  assert.equal(integrity, undefined);
  assert.deepEqual(lines, ['[test-integrity] SHIP_TEST_INTEGRITY_SURFACING="yes" is not off|shadow|on; treated as off']);
});

// ---------------------------------------------------------------------------
// bounds honesty

test("many findings are capped and the remainder is counted, never silently dropped", () => {
  const many = Array.from({ length: 25 }, (_, i) => edit(`src/t${i}.test.ts`, [" ctx", `+it.skip("s${i}", () => {});`])).join("");
  const integrity = testIntegrityRecord(many, []);
  assert.ok(integrity !== undefined);
  assert.equal(integrity.total, 25);
  assert.equal(integrity.findings.length, 20);
  assert.equal(integrity.omitted, 5);
  assert.match(testIntegritySection(integrity), /- … and 5 more\./);
});

test("a middle-cut diff says the read is incomplete, in the section and on the wire", () => {
  const cut = `... [1234 chars omitted from the middle of this diff] ...\n${SKIP_DIFF}`;
  const integrity = testIntegrityRecord(cut, []);
  assert.ok(integrity !== undefined);
  assert.equal(integrity.diffComplete, false);
  assert.match(testIntegritySection(integrity), /Part of the published diff was omitted, so this read is incomplete\./);
  assert.equal(runWebhookPayload({ runId: "r", status: "completed", testIntegrity: integrity }).test_integrity?.diff_complete, false);
});
