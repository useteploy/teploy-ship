import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { explainRun, formatExplanation } from "./explain.js";

// A failed run used to leave a status and several hundred events. "max-steps"
// is a category, not an explanation, and most of what makes software feel
// maintained rather than prototyped is what happens when things go wrong.
//
// Every case below asserts the same two things: that the headline names what
// actually happened, and that `nextStep` tells a person to do something
// specific. "Check the logs" is the failure mode this module exists to avoid,
// so a test at the end refuses it across every branch.

let seq = 0;
function ev(type: string, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: seq++, type, at: "2026-08-22T00:00:00Z", ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) } as WorkflowEvent;
}
const started = (task = "fix the off-by-one") => ev("run-started", undefined, { input: { task } });
const completed = (output: Record<string, unknown>) => ev("run-completed", undefined, { output });

test("a finished run with a pull request points at the review, not at the logs", () => {
  const e = explainRun([started(), ev("step-completed", "turn-0-exec"), completed({ status: "finished", summary: "Fixed it.", pr: "https://git/pr/1", turns: 3 })]);
  assert.match(e.headline, /Finished/);
  assert.match(e.nextStep, /Review the pull request/);
  assert.equal(e.needsAttention, false);
  assert.ok(e.evidence.some((x) => x.includes("https://git/pr/1")));
});

test("a finished run that published nothing is flagged, because nobody will look at it otherwise", () => {
  const e = explainRun([started(), completed({ status: "finished", summary: "No change needed." })]);
  assert.match(e.headline, /published nothing/);
  assert.equal(e.needsAttention, true, "a silent no-op is the easiest failure to miss");
});

test("max-steps distinguishes work that was published from work that was lost", () => {
  const withPr = explainRun([started(), completed({ status: "max-steps", turns: 40, pr: "https://git/pr/2" })]);
  assert.match(withPr.nextStep, /draft pull request/);

  const without = explainRun([started(), completed({ status: "max-steps", turns: 40 })]);
  assert.match(without.nextStep, /SHIP_MAX_STEPS|split it/);
  assert.doesNotMatch(without.nextStep, /draft pull request/, "there was no PR — do not send someone looking for one");
});

test("a nondeterminism failure says the run is unrecoverable instead of suggesting a resume", () => {
  // The specific shape an upgrade-during-flight produces. Telling someone to
  // resume this is worse than useless: it cannot succeed, and the honest
  // answer is to cancel and re-enqueue.
  const e = explainRun([started(), ev("run-failed", undefined, { error: "NondeterminismError: leftover cursor event turn-4-exec" })]);
  assert.match(e.headline, /no longer be replayed/);
  assert.match(e.nextStep, /Cancel it and enqueue the task again/);
  assert.match(e.nextStep, /UPGRADING/, "point at the document that prevents a repeat");
  assert.doesNotMatch(e.nextStep, /resume the run/i);
});

test("an ordinary throw is separated from the agent's own work", () => {
  const e = explainRun([started(), ev("run-failed", undefined, { error: "connect ECONNREFUSED 172.18.0.2:5432" })]);
  assert.match(e.stoppedAt, /ECONNREFUSED/);
  assert.match(e.nextStep, /fault in Ship or its store, not in the agent/i);
});

test("a parked run says it is waiting for a person and that nothing is burning", () => {
  const e = explainRun([started(), ev("step-completed", "turn-2-exec"), ev("event-waiting", "turn-2-approval")]);
  assert.match(e.headline, /waiting for you/);
  assert.match(e.nextStep, /Approve or deny/);
  assert.equal(e.needsAttention, true);
});

test("a run that threw while parked is a crash, not a pending approval", () => {
  // Ordering is the whole point: a run can be several things at once and only
  // the innermost one is actionable.
  const e = explainRun([started(), ev("event-waiting", "turn-2-approval"), ev("run-failed", undefined, { error: "boom" })]);
  assert.doesNotMatch(e.headline, /waiting/i);
  assert.match(e.stoppedAt, /boom/);
});

test("budget exhaustion names the cap rather than blaming the work", () => {
  const e = explainRun([started(), completed({ status: "budget-exhausted", turns: 12 })]);
  assert.match(e.headline, /spend cap/);
  assert.match(e.nextStep, /budget|daily window/i);
  assert.match(e.stoppedAt, /not because the work was done/);
});

test("stuck points at the environment, which is where the cause almost always is", () => {
  const e = explainRun([started(), completed({ status: "stuck", turns: 9 })]);
  assert.match(e.nextStep, /missing dependency|wrong path|test the agent cannot run/);
  assert.match(e.nextStep, /rarely the model/);
});

test("deliberate stops and rejected plans are not reported as failures", () => {
  for (const status of ["settled", "plan-rejected"]) {
    const e = explainRun([started(), completed({ status })]);
    assert.equal(e.needsAttention, false, `${status} should not demand attention`);
  }
  assert.equal(explainRun([started(), ev("run-cancelled")]).needsAttention, false);
});

test("an empty log blames the wiring, which is the only thing it can be", () => {
  const e = explainRun([]);
  assert.match(e.nextStep, /NUCLEUS_URL|same store/i);
  assert.equal(e.needsAttention, true);
});

test("turns are counted from executing turns, not from every step", () => {
  // A nudged turn thinks twice. Counting think steps would report a run as
  // longer than it was, and turn counts are what an operator uses to decide
  // whether a ceiling needs raising.
  const e = explainRun([
    started(),
    ev("step-completed", "turn-0-think"),
    ev("step-completed", "turn-0-exec"),
    ev("step-completed", "turn-1-think"),
    ev("step-completed", "turn-1-think"),
    ev("step-completed", "turn-1-exec"),
  ]);
  assert.ok(e.evidence.includes("2 turns"), `expected 2 turns, got ${JSON.stringify(e.evidence)}`);
});

test("no explanation ever tells a person to go and read the logs", () => {
  // The bar this module exists to clear. A run detail page already shows the
  // log; if the explanation's advice is "look at it", it has added nothing.
  const cases: WorkflowEvent[][] = [
    [],
    [started()],
    [started(), ev("run-cancelled")],
    [started(), ev("event-waiting", "turn-1-approval")],
    [started(), ev("run-failed", undefined, { error: "boom" })],
    [started(), ev("step-failed", "repo-setup", { error: "auth failed" })],
    ...["finished", "max-steps", "stuck", "settled", "budget-exhausted", "plan-rejected"].map((status) => [started(), completed({ status })]),
  ];
  for (const events of cases) {
    const e = explainRun(events);
    assert.doesNotMatch(e.nextStep, /check the logs?|see the logs?|inspect the logs?/i, `weak advice for: ${e.headline}`);
    assert.ok(e.nextStep.length > 30, `advice too thin for: ${e.headline}`);
    assert.ok(e.headline.length > 0 && e.stoppedAt.length > 0);
  }
});

test("the plain-text rendering keeps every field a reader needs", () => {
  const text = formatExplanation(explainRun([started("fix the parser"), completed({ status: "max-steps", turns: 40 })]));
  assert.match(text, /Asked to:/);
  assert.match(text, /Stopped at:/);
  assert.match(text, /Next:/);
  assert.match(text, /fix the parser/);
});

// --- the CLI seam -----------------------------------------------------------

test("enqueue and explain are real commands, not just usage text", async () => {
  // The product's headline flow is issue -> worker -> pull request, and until
  // `enqueue` existed the only ways to start one were the dashboard form and a
  // webhook: `run --durable` executes in-process and took no repo, and `fix`
  // uses the live loop. The documented flow could not be started from the CLI
  // at all. This pins that both new verbs are dispatched, because a command
  // present only in the usage banner is the exact shape of this repo's house
  // failure mode — correct on both ends, unwired in between.
  const { COMMAND_FLAGS } = await import("./args.js");
  for (const command of ["enqueue", "explain"]) {
    assert.ok(command in COMMAND_FLAGS, `${command} has no flag definition, so parseArgs would reject its flags`);
  }
  assert.ok(COMMAND_FLAGS.enqueue?.value?.includes("repo"), "enqueue must accept --repo or the flow it exists for is unreachable");
  assert.ok(COMMAND_FLAGS.explain?.boolean?.includes("json"));

  const cli = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/cli.ts", import.meta.url), "utf8"));
  assert.match(cli, /case "enqueue":\s*\n\s*return enqueueCommand\(rest\);/, "enqueue is not dispatched");
  assert.match(cli, /case "explain":\s*\n\s*return explainCommand\(rest\);/, "explain is not dispatched");
});
