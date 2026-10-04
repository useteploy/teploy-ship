import assert from "node:assert/strict";
import { test } from "node:test";
import { findingContinuityLines } from "./finding-continuity-view.js";

const step = (result: unknown) => [{ type: "step-completed", name: "scan-findings", data: { result } }];

test("a run recorded without continuity projects to undefined (page unchanged)", () => {
  assert.equal(findingContinuityLines(step({ found: true, findings: [], errors: [] })), undefined);
  assert.equal(findingContinuityLines([]), undefined);
});

test("recorded advisory lines are projected and bounded", () => {
  const lines = findingContinuityLines(step({ continuity: { advisory: ["a", "b", 3, "", "x".repeat(900)] } }));
  assert.deepEqual(lines?.slice(0, 2), ["a", "b"]);
  assert.equal(lines?.length, 3);
  assert.equal(lines?.[2]?.length, 500);
});

test("malformed continuity is ignored rather than thrown on", () => {
  assert.equal(findingContinuityLines(step({ continuity: { advisory: "nope" } })), undefined);
  assert.equal(findingContinuityLines(step({ continuity: null })), undefined);
});
