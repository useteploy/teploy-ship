import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_GROUNDING_CAVEAT, planGroundingView } from "./plan-grounding-view.js";

const step = (result: unknown) => [{ type: "step-completed", name: "plan-think", data: { result } }];

const report = {
  mode: "advisory",
  revision: "abcdef1234567890",
  refs: [
    { kind: "file", name: "src/nope.ts", line: 1, creates: false, status: "ungrounded", detail: "no such path" },
    { kind: "file", name: "src/ok.ts", line: 2, creates: false, status: "grounded", detail: "present" },
    { kind: "symbol", name: "fineFn", line: 3, creates: false, status: "unchecked", detail: "not searched" },
  ],
  counts: { grounded: 1, ungrounded: 1, proposed: 0, unchecked: 1 },
  allCheckedGrounded: false,
};

test("a run recorded without grounding projects to undefined (page unchanged)", () => {
  assert.equal(planGroundingView(step({ text: "the plan", usage: {} })), undefined);
  assert.equal(planGroundingView([]), undefined);
});

test("a recorded report projects ungrounded-first with counts, revision and the caveat", () => {
  const v = planGroundingView(step({ text: "p", grounding: report }));
  assert.ok(v);
  assert.match(v.headline, /1 grounded, 1 ungrounded, 0 proposed, 1 unchecked at revision abcdef123456/);
  assert.deepEqual(v.refs.map((r) => `${r.status}:${r.name}`), [
    "ungrounded:src/nope.ts",
    "unchecked:fineFn",
    "grounded:src/ok.ts",
  ]);
  assert.equal(v.mismatch, undefined);
  assert.equal(v.caveat, PLAN_GROUNDING_CAVEAT);
  assert.match(v.caveat, /not that the plan is right/);
});

test("a revision mismatch is shown as such, never folded into the counts", () => {
  const v = planGroundingView(step({ grounding: { ...report, revisionMismatch: { expected: "deadbeef", actual: "abcdef1234567890" } } }));
  assert.ok(v);
  assert.match(v.mismatch ?? "", /deadbeef/);
  assert.match(v.mismatch ?? "", /no reference was checked/);
});

test("malformed grounding is ignored rather than thrown on, and the listing is bounded", () => {
  assert.equal(planGroundingView(step({ grounding: "nope" })), undefined);
  assert.equal(planGroundingView(step({ grounding: { refs: [] } })), undefined);
  assert.equal(planGroundingView(step({ grounding: { revision: "", refs: [] } })), undefined);
  const many = { ...report, refs: Array.from({ length: 500 }, (_, i) => ({ kind: "file", name: `f${i}.ts`, status: "grounded", detail: "d" })) };
  const v = planGroundingView(step({ grounding: many }));
  assert.ok(v);
  assert.equal(v.refs.length, 60);
  assert.equal(v.omitted, 440);
  const junk = planGroundingView(step({ grounding: { ...report, refs: [...report.refs, { status: "banana", name: "x" }, { status: "grounded" }] } }));
  assert.ok(junk);
  assert.equal(junk.refs.length, 3);
});
