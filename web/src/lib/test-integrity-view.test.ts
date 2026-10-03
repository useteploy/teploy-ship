import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEAN_TEXT, parseOraclePaths, testIntegrityPanel, type IntegrityLogEvent } from "./test-integrity-view.js";

const push = (diff: unknown, kind = "pushed"): IntegrityLogEvent[] => [{ type: "step-completed", name: "repo-push", data: { result: { kind, sha: "abc1234", diff } } }];
const CLEAN = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n";
const SKIP = "diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,3 +1,3 @@\n import { it } from 'node:test';\n-it('works', () => {});\n+it.skip('works', () => {});\n";

test("clean diff projects as analysed/clean with no findings", () => {
  const p = testIntegrityPanel(push(CLEAN));
  assert.equal(p.state, "analysed");
  if (p.state !== "analysed") return;
  assert.equal(p.verdict, "clean");
  assert.equal(p.total, 0);
  assert.equal(p.complete, true);
  assert.match(p.headline, /no test-tampering patterns found \(heuristic; not proof the tests are sound\)/);
  assert.doesNotMatch(p.headline, /verified/i);
});

test("an added skip marker is tampered and carries file, line and evidence", () => {
  const p = testIntegrityPanel(push(SKIP));
  assert.equal(p.state, "analysed");
  if (p.state !== "analysed") return;
  assert.equal(p.verdict, "tampered");
  assert.equal(p.top[0]!.file, "src/a.test.ts");
  assert.ok(p.top[0]!.line > 0);
  assert.match(p.top[0]!.evidence, /skip/);
  assert.ok((p.byKind["skipped-test"] ?? 0) >= 1);
});

test("a lower-confidence pattern is suspicious, not tampered", () => {
  const d =
    "diff --git a/src/price.ts b/src/price.ts\n--- a/src/price.ts\n+++ b/src/price.ts\n@@ -1,1 +1,1 @@\n-  return qty * 10;\n+  return qty * 12;\n" +
    "diff --git a/src/price.test.ts b/src/price.test.ts\n--- a/src/price.test.ts\n+++ b/src/price.test.ts\n@@ -1,3 +1,3 @@\n run();\n-  assert.equal(total(2), 20);\n+  assert.equal(total(2), 24);\n done();\n";
  const p = testIntegrityPanel(push(d));
  assert.equal(p.state, "analysed");
  if (p.state !== "analysed") return;
  assert.equal(p.verdict, "suspicious");
});

test("oracle paths pass through: touching one is tampered", () => {
  const p = testIntegrityPanel(push(CLEAN), ["src/**"]);
  assert.equal(p.state === "analysed" && p.verdict, "tampered");
  assert.equal(p.state === "analysed" && p.oracleConfigured, true);
});

test("NEGATIVE CONTROL: a missing diff is never clean", () => {
  const cases: IntegrityLogEvent[][] = [
    [],
    push(undefined),
    push(""),
    push("not a diff"),
    push(CLEAN, "empty"),
    push(CLEAN, "refused"),
    [{ type: "step-completed", name: "repo-push", data: { result: "garbage" } }],
  ];
  for (const events of cases) {
    const p = testIntegrityPanel(events);
    assert.equal(p.state, "not-analysed", JSON.stringify(events));
    assert.equal((p as { verdict?: string }).verdict, undefined);
  }
});

test("a diff with a middle section cut out is marked incomplete", () => {
  const cut = `${CLEAN}\n\n... [4000 chars omitted from the middle of this diff] ...\n\n${CLEAN}`;
  const p = testIntegrityPanel(push(cut));
  assert.equal(p.state === "analysed" && p.complete, false);
});

test("only the published push diff is read, and the last push wins", () => {
  const events: IntegrityLogEvent[] = [
    { type: "step-completed", name: "critic-diff", data: { result: { diff: SKIP } } },
    ...push(CLEAN),
  ];
  const p = testIntegrityPanel(events);
  assert.equal(p.state === "analysed" && p.verdict, "clean");
});

test("clean wording never claims the tests are verified", () => {
  assert.match(CLEAN_TEXT, /heuristic; not proof/);
  assert.doesNotMatch(CLEAN_TEXT, /verified|passed/i);
});

test("SHIP_ORACLE_PATHS parsing: blanks dropped, unset is empty", () => {
  assert.deepEqual(parseOraclePaths(undefined), []);
  assert.deepEqual(parseOraclePaths(""), []);
  assert.deepEqual(parseOraclePaths(" tests/**, ,acceptance/ "), ["tests/**", "acceptance/"]);
});
