import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { auditRow, toCsv, withinWindow } from "./audit.js";
import type { AuditRow } from "./audit.js";
import type { RunMeta } from "./run-store.js";

let seq = 0;
function ev(type: string, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: seq++, type, at: "2026-08-22T00:00:00Z", ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) } as WorkflowEvent;
}

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  runId: "run-1",
  task: "fix the parser",
  status: "completed",
  model: "anthropic/claude-sonnet-5",
  createdAt: "2026-08-20T10:00:00Z",
  updatedAt: "2026-08-20T10:04:00Z",
  ...over,
});

test("a row carries what an auditor asks about", () => {
  const row = auditRow(meta({ source: "github", ranOn: "worker-1" }), [
    ev("run-started", undefined, { input: { task: "fix the parser", repo: "https://git/o/r" } }),
    ev("step-completed", "turn-0-exec"),
    ev("step-completed", "turn-1-exec"),
    ev("run-completed", undefined, { output: { status: "finished", pr: "https://git/o/r/pulls/9", turns: 2, usage: { inputTokens: 1000, outputTokens: 500 } } }),
  ]);

  assert.equal(row.repo, "https://git/o/r");
  assert.equal(row.pr, "https://git/o/r/pulls/9");
  assert.equal(row.turns, 2);
  assert.equal(row.source, "github");
  assert.equal(row.ranOn, "worker-1");
  assert.ok(row.costUSD > 0, "a priced model with recorded usage must produce a cost");
});

// The point of the module, and the thing most likely to be quietly assumed
// away by whoever reads a CSV: Ship records no actor. RunMeta has `source`
// (which intake channel) and `ranOn` (which host) and no user field at all, so
// no row can say who authorised anything. If that is ever silently dropped,
// someone will hand this file to an auditor as if it answered the question.
test("a run with no actor is reported unattributable rather than blank", () => {
  // Runs enqueued before attribution existed carry no actor at all. The row
  // must say so in the column a reader filters on, not merely leave a gap.
  const row = auditRow(meta(), [ev("run-started", undefined, { input: { task: "t" } })]);
  assert.equal(row.attributable, false);
  assert.equal(row.actor, "");
  assert.equal(row.actorKind, "unknown");
  assert.match(toCsv([row]), /attributable/, "the CSV header must carry the caveat, not just the type");
});

test("a run with an actor is attributable, and the KIND rides along with the name", () => {
  const row = auditRow(
    meta({ actor: "https://idp#sub-42", actorKind: "user" }),
    [ev("run-started", undefined, { input: { task: "t" } })],
  );
  assert.equal(row.attributable, true);
  assert.equal(row.actor, "https://idp#sub-42");
  // Exported next to the name on purpose: an authenticated session and a
  // handle a webhook asserted are worth different amounts to an auditor, and
  // without this column they would be indistinguishable.
  assert.equal(row.actorKind, "user");
});

test("an actor Ship could not verify is still attributable, but says it was asserted", () => {
  const row = auditRow(meta({ actor: "github:octocat", actorKind: "intake" }), []);
  assert.equal(row.attributable, true);
  assert.equal(row.actorKind, "intake");
});

test("a kind the store does not recognise degrades to unattributable", () => {
  // actor_kind is TEXT in a store an operator can edit by hand. A value the
  // code does not know must not be presented as a verified identity.
  const row = auditRow(meta({ actor: "someone", actorKind: "root" }), []);
  assert.equal(row.attributable, false);
});

test("approval granters are recorded in order, and an unsigned decision adds nothing", () => {
  const row = auditRow(meta({ actor: "alice", actorKind: "user" }), [
    ev("run-started", undefined, { input: { task: "t" } }),
    ev("event-waiting", "turn-1-approval"),
    ev("event-received", "turn-1-approval", { payload: { approved: true, by: "alice" } }),
    ev("event-waiting", "turn-4-approval"),
    // A decision delivered by a CLI too old to send `by`, or by a session that
    // could not be resolved. It must not contribute an empty entry that reads
    // like a second granter.
    ev("event-received", "turn-4-approval", { payload: { approved: true } }),
    ev("event-waiting", "turn-9-approval"),
    ev("event-received", "turn-9-approval", { payload: { approved: false, by: "bob" } }),
  ]);
  assert.equal(row.approvals, 3);
  assert.equal(row.approvedBy, "alice; bob");
});

test("a run that needed no approval has no granters, which is not the same as an unsigned one", () => {
  const row = auditRow(meta({ actor: "alice", actorKind: "user" }), [
    ev("run-started", undefined, { input: { task: "t" } }),
    ev("run-completed", undefined, { output: { status: "finished" } }),
  ]);
  assert.equal(row.approvals, 0);
  assert.equal(row.approvedBy, "");
});

test("approvals are counted, because 'a person unblocked this' is the closest thing to an actor we have", () => {
  const row = auditRow(meta(), [
    ev("run-started", undefined, { input: { task: "t" } }),
    ev("event-waiting", "turn-1-approval"),
    ev("event-waiting", "turn-4-approval"),
    ev("run-completed", undefined, { output: { status: "finished" } }),
  ]);
  assert.equal(row.approvals, 2);
});

test("an unpriced or usage-less run reports zero rather than guessing", () => {
  const row = auditRow(meta(), [ev("run-started", undefined, { input: { task: "t" } }), ev("run-completed", undefined, { output: { status: "finished" } })]);
  assert.equal(row.costUSD, 0);
});

test("CSV quoting survives a task written by a human", () => {
  // Tasks come from issue bodies. A naive join produces a file that opens in a
  // spreadsheet and is silently wrong, which is worse than one that fails.
  const row = auditRow(meta({ task: 'fix "quoting", then\nnewlines, too' }), [ev("run-started", undefined, { input: { task: "x" } })]);
  const csv = toCsv([row]);
  const header = csv.split("\n")[0]!;
  assert.equal(header.split(",").length, 17, "the header must not itself be ambiguous");
  assert.match(csv, /"fix ""quoting"", then\nnewlines, too"/, "quotes doubled, whole field wrapped");

  // And the row must still be one record: a bare newline inside an unquoted
  // field would split it into two.
  const afterHeader = csv.slice(header.length + 1);
  assert.ok(afterHeader.startsWith("run-1,"), "the record starts where it should");
});

test("the window filter is inclusive at the start and exclusive at the end", () => {
  const rows: AuditRow[] = ["2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z", "2026-09-01T00:00:00Z"].map((createdAt, i) =>
    auditRow(meta({ runId: `run-${i}`, createdAt }), []),
  );
  const august = withinWindow(rows, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual(august.map((r) => r.runId), ["run-0", "run-1"], "start included, end excluded — so adjacent months never double-count");

  assert.equal(withinWindow(rows).length, 3, "no bounds means everything");
  assert.equal(withinWindow(rows, "2026-08-16T00:00:00Z").length, 1);
});

test("column order is fixed, because a moving header breaks every downstream consumer", () => {
  const a = toCsv([auditRow(meta({ runId: "a" }), [])]).split("\n")[0];
  const b = toCsv([auditRow(meta({ runId: "b", source: "slack" }), [])]).split("\n")[0];
  assert.equal(a, b);
  assert.equal(
    a,
    "runId,createdAt,updatedAt,status,source,actor,actorKind,approvedBy,model,ranOn,repo,task,pr,turns,costUSD,approvals,attributable",
  );
});
