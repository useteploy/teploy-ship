import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { CHANGE_EVENT, MERGE_EVENT, REVISION_CANCEL_PREFIX } from "teploy-ship/plan";
import { taskRecord, type TaskAttemptSource } from "teploy-ship/task-record";
import { taskStateView } from "./task-state.js";

let seq = 0;
const at = (n: number) => new Date(Date.parse("2026-10-03T10:00:00Z") + n * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}
function run(runId: string, start: number, statement: string, tail: (m: number) => WorkflowEvent[], parent?: string): TaskAttemptSource {
  seq = 0;
  return {
    meta: { runId, task: statement, status: "completed", model: "m", createdAt: at(0), updatedAt: at(0) },
    events: [ev("run-started", start, undefined, { workflow: "w", input: { userMessage: statement, ...(parent !== undefined ? { parentRunId: parent } : {}) } }), ...tail(start + 1)],
  };
}
const finished = (m: number) => ev("run-completed", m, undefined, { output: { status: "finished" } });
const approve = (m: number, by = "ada") => [ev("event-waiting", m, MERGE_EVENT), ev("event-received", m + 1, MERGE_EVENT, { payload: { approved: true, by } })];

test("negative control: a finished run with no decision is NOT accepted and says not recorded", () => {
  const v = taskStateView(taskRecord("r1", [run("r1", 0, "fix the typo", (m) => [finished(m)])]));
  assert.equal(v.execution.label, "Finished");
  assert.notEqual(v.acceptance.label, "Accepted");
  assert.equal(v.acceptance.label, "Not recorded");
  assert.equal(v.acceptance.recorded, false);
  assert.match(v.execution.meaning, /nothing about whether the work was accepted or delivered/);
  assert.doesNotMatch(v.acceptance.meaning, /pending|waiting|yet/i);
});

test("not-recorded delivery is shown as such, never as pending or proposed", () => {
  const v = taskStateView(taskRecord("r1", [run("r1", 0, "x", (m) => [finished(m)])]));
  assert.equal(v.delivery.label, "Not recorded");
  assert.equal(v.delivery.recorded, false);
  assert.equal(v.delivery.tone, "muted");
});

test("a recorded approval renders as accepted with its granter; delivery stays independent", () => {
  const rec = taskRecord("r1", [run("r1", 0, "x", (m) => [...approve(m), finished(m + 3)])]);
  const v = taskStateView(rec);
  assert.equal(v.acceptance.label, "Accepted");
  assert.match(v.acceptance.meaning, /Approved by ada/);
  assert.equal(v.delivery.label, "Not recorded");
  const confirmed = taskStateView(taskRecord("r1", [run("r1", 0, "x", (m) => [...approve(m), finished(m + 3)])], { state: "confirmed" }));
  assert.equal(confirmed.delivery.label, "Confirmed");
});

test("a revision shows the earlier approval as superseded and the later attempt as current", () => {
  const first = run("r1", 0, "add a button", (m) => [...approve(m), finished(m + 3)]);
  const second = run("r2", 10, "make it blue", (m) => [finished(m)], "r1");
  const v = taskStateView(taskRecord("r1", [first, second]));
  assert.equal(v.acceptance.label, "Superseded");
  assert.notEqual(v.acceptance.label, "Accepted");
  assert.deepEqual(v.superseded, ["Approval by ada on r1 is superseded by a later attempt."]);
  assert.deepEqual(v.requirements.map((r) => [r.statement, r.current]), [["add a button", false], ["make it blue", true]]);
  assert.equal(v.attempts, 2);
});

test("an approval on an earlier attempt stays listed as superseded even when the latest has its own decision", () => {
  const first = run("r1", 0, "a", (m) => [...approve(m, "ada"), finished(m + 3)]);
  const second = run("r2", 10, "b", (m) => [...approve(m, "bo"), finished(m + 3)], "r1");
  const v = taskStateView(taskRecord("r1", [first, second]));
  assert.equal(v.acceptance.label, "Accepted");
  assert.match(v.acceptance.meaning, /by bo/);
  assert.equal(v.superseded.length, 1);
  assert.match(v.superseded[0], /ada on r1/);
});

test("a pending review replaced by a follow-up shows superseded; a decline shows declined", () => {
  const replaced = run("r1", 0, "a", (m) => [ev("event-waiting", m, CHANGE_EVENT), ev("run-cancelled", m + 1, undefined, { reason: `${REVISION_CANCEL_PREFIX}r2` })]);
  assert.equal(taskStateView(taskRecord("r1", [replaced])).acceptance.label, "Superseded");
  const declined = run("r1", 0, "a", (m) => [ev("event-waiting", m, MERGE_EVENT), ev("event-received", m + 1, MERGE_EVENT, { payload: { approved: false, by: "ada" } }), finished(m + 2)]);
  assert.equal(taskStateView(taskRecord("r1", [declined])).acceptance.label, "Declined");
  const parked = run("r1", 0, "a", (m) => [ev("event-waiting", m, MERGE_EVENT)]);
  const p = taskStateView(taskRecord("r1", [parked]));
  assert.equal(p.execution.label, "Waiting on people");
  assert.equal(p.acceptance.label, "Awaiting decision");
});

test("not-recorded fields and anomalies are passed through, not hidden", () => {
  const rec = taskRecord("missing-root", [run("r2", 0, "x", (m) => [finished(m)], "gone")]);
  const v = taskStateView(rec);
  assert.ok(v.notRecorded.length > 0);
  assert.deepEqual(v.notRecorded, rec.notRecorded);
  assert.ok(v.anomalies.some((a) => /root run missing-root/.test(a)));
  assert.ok(v.anomalies.some((a) => /parent gone/.test(a)));
});

test("every state the projection can emit has a label, a tone and a sentence", () => {
  for (const execution of ["not-started", "running", "waiting-on-people", "finished", "incomplete", "failed", "cancelled"] as const) {
    for (const acceptance of ["not-recorded", "pending", "accepted", "rejected", "superseded"] as const) {
      for (const delivery of ["not-recorded", "proposed", "approved", "executing", "confirmed", "unknown", "failed", "held"] as const) {
        const v = taskStateView({ rootRunId: "r", attempts: [], requirements: [], execution, acceptance, acceptedBy: null, delivery, notRecorded: [], anomalies: [] });
        for (const c of [v.execution, v.acceptance, v.delivery]) assert.ok(c.label !== "" && c.meaning !== "" && c.tone !== undefined);
      }
    }
  }
});
