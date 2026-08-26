/**
 * The smoke run's done-check, made permanent.
 *
 * The plan's acceptance criterion for the end-to-end smoke was: "deliberately
 * reintroduce each of the four L0 bugs one at a time and confirm the smoke run
 * catches each." Doing that by hand against a live deployment proves it once,
 * on one afternoon, and never again — and an assertion nobody has watched fail
 * is a comment, not a check.
 *
 * So each bug is replayed here as the event log it would have produced, and
 * the smoke's own verdict function has to go red on it. If someone later
 * loosens an assertion to make a flaky smoke green, this fails.
 *
 * The four, with the commits that fixed them:
 *   1. `SHIP_MODEL` ignored — the run used a model nobody asked for. (d88f43a)
 *   2. A prefixed `SHIP_MODEL_PRICING` override silently dropped, so the run's
 *      cost never reached a ledger.                                 (1538d45)
 *   3. Findings written to a path the executor refuses, git excludes and the
 *      publisher never reads: the step "ran" and produced nothing.
 *   4. The strict approval policy applied inside a sandbox, so an unattended
 *      run parked forever.                              (d3b7029, 67315d1)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateSmoke } from "./smoke-e2e.mjs";

const ASKED_MODEL = "zai/glm-5.3";
const TEST_COMMAND = "sh test.sh";

/** The log a healthy run leaves behind. Every case below is this, minus one thing. */
function healthy(overrides = {}) {
  const {
    prStep = { type: "step-completed", name: "repo-pr", data: { result: { url: "http://forge/tyler/ship-smoke/pulls/1", number: 1 } } },
    testsStep = { type: "step-completed", name: "tests", data: { result: { kind: "passed", command: TEST_COMMAND, durationMs: 120 } } },
    extra = [],
    completed = {
      type: "run-completed",
      data: { output: { status: "finished", usage: { inputTokens: 2998, outputTokens: 822, totalTokens: 8940 } } },
    },
  } = overrides;
  return {
    meta: { runId: "run-1", status: "completed", model: ASKED_MODEL, ...(overrides.meta ?? {}) },
    events: [
      { type: "run-started", data: { input: { task: "t" } } },
      { type: "step-completed", name: "repo-setup", data: { result: { branch: "ship/x", base: "main" } } },
      { type: "step-completed", name: "turn-0-exec", data: { result: { exitCode: 0 } } },
      ...(testsStep === null ? [] : [testsStep]),
      { type: "step-completed", name: "repo-push", data: { result: { kind: "pushed", sha: "abc" } } },
      ...(prStep === null ? [] : [prStep]),
      ...extra,
      ...(completed === null ? [] : [completed]),
    ],
    ledger: overrides.ledger ?? { priced: 1.23, unpriced: 0 },
    askedModel: ASKED_MODEL,
    testCommand: TEST_COMMAND,
  };
}

const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.label);

test("a healthy run passes every assertion — otherwise the cases below prove nothing", () => {
  const checks = evaluateSmoke(healthy());
  assert.deepEqual(failed(checks), [], JSON.stringify(checks, null, 2));
  assert.ok(checks.length >= 6, "the verdict must actually be asserting things");
});

test("bug 1: the run used a model nobody asked for", () => {
  const checks = evaluateSmoke(healthy({ meta: { model: "anthropic/claude-sonnet-5" } }));
  assert.deepEqual(failed(checks), ["the model used is the model asked for"]);
  const detail = checks.find((c) => !c.ok).detail;
  assert.match(detail, /asked "zai\/glm-5\.3", ran "anthropic\/claude-sonnet-5"/, "the failure has to name both");
});

test("bug 2: the run's cost never reached a ledger", () => {
  const checks = evaluateSmoke(healthy({ ledger: { priced: 0, unpriced: 0 } }));
  assert.deepEqual(failed(checks), ["that usage reached a spend ledger"]);
});

test("bug 2, the other half: an unpriced model is COUNTED, not treated as a miss", () => {
  // P5-3: a free or unrecognised model is never reported as $0 — it lands in
  // the unpriced-run ledger. The smoke must pass on either kind of model
  // without being told which it has, or it will be quietly disabled the first
  // time someone points it at a coding-plan model.
  const checks = evaluateSmoke(healthy({ ledger: { priced: 0, unpriced: 1 } }));
  assert.deepEqual(failed(checks), []);
});

test("bug 3: the step ran and produced nothing — a command ran, the suite did not", () => {
  // The scan-findings shape: something executed, the run finished, and the
  // artifact that was the entire point never existed. `disabled` is exactly
  // what a suite configured at a path nothing honours reports.
  const disabled = evaluateSmoke(
    healthy({ testsStep: { type: "step-completed", name: "tests", data: { result: { kind: "disabled", reason: "no test command configured for this repo or worker" } } } }),
  );
  assert.deepEqual(failed(disabled), ["the suite ran and passed", "it was the configured command, not something else"]);

  const absent = evaluateSmoke(healthy({ testsStep: null }));
  assert.ok(failed(absent).includes("the suite ran and passed"));
  assert.match(absent.find((c) => c.label === "the suite ran and passed").detail, /no `tests` step in the log at all/);
});

test("bug 3, sharper: a DIFFERENT command ran, and the smoke says so", () => {
  // `FINISH_NUDGE_NO_EVIDENCE` asks whether a command RAN, not whether the
  // suite passed (tests.ts:11) — `ls` satisfies it. A smoke that only checked
  // "something executed" would be green here, which is the whole trap.
  const checks = evaluateSmoke(
    healthy({ testsStep: { type: "step-completed", name: "tests", data: { result: { kind: "passed", command: "ls", durationMs: 3 } } } }),
  );
  assert.deepEqual(failed(checks), ["it was the configured command, not something else"]);
});

test("bug 4: an unattended run parked on an approval nobody is coming to answer", () => {
  const checks = evaluateSmoke(
    healthy({
      meta: { status: "waiting" },
      prStep: null,
      completed: null,
      extra: [{ type: "event-waiting", name: "approval:rm -rf /work/x" }],
    }),
  );
  assert.ok(failed(checks).includes("no approval park"));
  assert.match(checks.find((c) => c.label === "no approval park").detail, /parked on: approval:rm/);
  assert.ok(failed(checks).includes("a pull request was opened"), "a parked run also produced no PR");
});

test("a red suite fails the smoke even though the PR opened", () => {
  // Ship publishes a failing suite's PR on purpose (tests.ts's docstring), so
  // "a PR exists" is not evidence the change works. The smoke must not inherit
  // that leniency: its fixture task is one line and its suite is deterministic.
  const checks = evaluateSmoke(
    healthy({
      testsStep: {
        type: "step-completed",
        name: "tests",
        data: { result: { kind: "failed", command: TEST_COMMAND, durationMs: 90, exitCode: 1, output: "answer.txt is '41', expected 42" } },
      },
    }),
  );
  assert.deepEqual(failed(checks), ["the suite ran and passed"]);
});

test("a run that opened no pull request fails, whatever else went right", () => {
  const checks = evaluateSmoke(healthy({ prStep: null, meta: { status: "failed" } }));
  assert.deepEqual(failed(checks), ["a pull request was opened"]);
});

test("a run that burned no tokens fails — the model was never actually called", () => {
  const checks = evaluateSmoke(
    healthy({ completed: { type: "run-completed", data: { output: { status: "finished", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } } } }),
  );
  assert.deepEqual(failed(checks), ["the run recorded model usage"]);
});

test("the critic's own suite step counts as the suite — it is the same command over the same tree", () => {
  // A3 moved the suite in front of the critic and lets the publish gate reuse
  // its outcome, so on a critic run the recorded step is turn-scoped and there
  // is no bare `tests` step. The smoke must not read that as "no suite ran".
  const checks = evaluateSmoke(
    healthy({
      testsStep: {
        type: "step-completed",
        name: "turn-4-critic-tests",
        data: { result: { kind: "passed", command: TEST_COMMAND, durationMs: 120 } },
      },
    }),
  );
  assert.deepEqual(failed(checks), []);
});
