import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { CHANGE_EVENT, MERGE_EVENT, PLAN_EVENT, REVISION_CANCEL_PREFIX } from "./plan.js";
import type { RunMeta } from "./run-store.js";
import { taskRecord, type TaskAttemptSource } from "./task-record.js";

let seq = 0;
const at = (n: number) => new Date(Date.parse("2026-10-03T10:00:00Z") + n * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}
function meta(runId: string): RunMeta {
  return { runId, task: "t", status: "completed", model: "m", createdAt: at(0), updatedAt: at(0) };
}
function attempt(
  runId: string,
  start: number,
  opts: { statement: string; parent?: string; steps?: WorkflowEvent[]; end?: WorkflowEvent },
): TaskAttemptSource {
  seq = 0;
  const started = ev("run-started", start, undefined, {
    workflow: "w",
    input: { task: `${opts.statement}\n\njourney text`, userMessage: opts.statement, ...(opts.parent !== undefined ? { parentRunId: opts.parent } : {}) },
  });
  return { meta: meta(runId), events: [started, ...(opts.steps ?? []), ...(opts.end !== undefined ? [opts.end] : [])] };
}
const done = (minute: number, status = "finished", incomplete = false) => ev("run-completed", minute, undefined, { output: { status, incomplete } });
const decide = (minute: number, name: string, payload: object) => [ev("event-waiting", minute, name), ev("event-received", minute + 1, name, { payload })];

test("S03: a finished run with no decision is not accepted", () => {
  const root = attempt("r1", 0, { statement: "add search", end: done(5) });
  const t = taskRecord("r1", [root]);
  assert.equal(t.execution, "finished");
  assert.equal(t.acceptance, "not-recorded");
  assert.equal(t.delivery, "not-recorded");
  assert.deepEqual(t.requirements, [{ runId: "r1", statement: "add search" }]);
  assert.ok(t.notRecorded.includes("requirement waivers"));
});

test("S03: an approved merge decision is the recorded acceptance, with its granter", () => {
  const root = attempt("r1", 0, { statement: "add search", steps: decide(2, MERGE_EVENT, { approved: true, by: "user-7" }), end: done(5) });
  const t = taskRecord("r1", [root]);
  assert.equal(t.acceptance, "accepted");
  assert.equal(t.acceptedBy, "user-7");
});

test("S03: a denied decision is rejected, a parked one is pending", () => {
  const denied = attempt("r1", 0, { statement: "x", steps: decide(2, CHANGE_EVENT, { approved: false, reason: "no" }), end: done(5) });
  assert.equal(taskRecord("r1", [denied]).acceptance, "rejected");

  const parked = attempt("r2", 0, { statement: "x", steps: [ev("event-waiting", 2, MERGE_EVENT)] });
  const t = taskRecord("r2", [parked]);
  assert.equal(t.execution, "waiting-on-people");
  assert.equal(t.acceptance, "pending");
  assert.equal(t.attempts[0]!.waitingOn, MERGE_EVENT);
});

test("S03: a revision supersedes the earlier acceptance and does not inherit it", () => {
  const first = attempt("r1", 0, { statement: "add search", steps: decide(2, MERGE_EVENT, { approved: true, by: "u" }), end: done(5) });
  const second = attempt("r2", 10, { statement: "also match email", parent: "r1", end: done(15) });
  const t = taskRecord("r1", [second, first]);
  assert.deepEqual(t.attempts.map(a => a.runId), ["r1", "r2"]);
  assert.equal(t.acceptance, "superseded", "r1's approval was for earlier bytes");
  assert.equal(t.acceptedBy, null);
  assert.deepEqual(t.requirements.map(r => r.statement), ["add search", "also match email"]);
});

test("S03: a pending review replaced by a follow-up records who replaced it", () => {
  const parent = attempt("r1", 0, {
    statement: "x",
    steps: [ev("event-waiting", 2, MERGE_EVENT)],
    end: ev("run-cancelled", 6, undefined, { reason: `${REVISION_CANCEL_PREFIX}r2` }),
  });
  const t = taskRecord("r1", [parent]);
  assert.equal(t.attempts[0]!.execution, "cancelled");
  assert.equal(t.attempts[0]!.supersededBy, "r2");
  assert.equal(t.acceptance, "superseded");
});

test("S03: execution outcomes keep incomplete and failed apart from finished", () => {
  assert.equal(taskRecord("a", [attempt("a", 0, { statement: "x", end: done(1, "max-steps", true) })]).execution, "incomplete");
  assert.equal(taskRecord("b", [attempt("b", 0, { statement: "x", end: done(1, "finished", true) })]).execution, "incomplete");
  assert.equal(taskRecord("c", [attempt("c", 0, { statement: "x", end: ev("run-failed", 1, undefined, { error: { message: "boom" } }) })]).execution, "failed");
  assert.equal(taskRecord("d", [attempt("d", 0, { statement: "x" })]).execution, "running");
});

test("S03: plan decisions record edits without storing plan text; delivery stays separate", () => {
  const root = attempt("r1", 0, {
    statement: "x",
    steps: decide(1, PLAN_EVENT, { approved: true, plan: "edited plan", by: "u1" }),
    end: done(9),
  });
  const t = taskRecord("r1", [root], { state: "confirmed" });
  assert.deepEqual(t.attempts[0]!.decisions[0], { event: PLAN_EVENT, approved: true, by: "u1", at: at(2), edited: true });
  assert.equal(JSON.stringify(t).includes("edited plan"), false);
  assert.equal(t.delivery, "confirmed");
  assert.equal(t.acceptance, "not-recorded", "a confirmed delivery and an approved plan do not manufacture acceptance");
});

test("S03: malformed records are reported as anomalies, not thrown and not counted", () => {
  const bad = attempt("r1", 0, { statement: "x", steps: decide(1, MERGE_EVENT, { by: "u" }), end: done(5) });
  const t = taskRecord("r1", [bad]);
  assert.equal(t.acceptance, "not-recorded");
  assert.ok(t.anomalies.some(a => a.includes('without a boolean "approved"')));
  const orphan = taskRecord("r1", [attempt("r2", 0, { statement: "x", parent: "gone" })]);
  assert.ok(orphan.anomalies.some(a => a.includes("root run r1 is not among")));
  assert.ok(orphan.anomalies.some(a => a.includes("parent gone is not among")));
});
