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
test("every row states that it cannot attribute an action to a person", () => {
  const row = auditRow(meta(), [ev("run-started", undefined, { input: { task: "t" } })]);
  assert.equal(row.attributable, false);
  assert.ok(!("user" in row) && !("approvedBy" in row), "adding an actor field means revisiting attributable, not just the schema");
  assert.match(toCsv([row]), /attributable/, "the CSV header must carry the caveat, not just the type");
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
  assert.equal(header.split(",").length, 14, "the header must not itself be ambiguous");
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
  assert.equal(a, "runId,createdAt,updatedAt,status,source,model,ranOn,repo,task,pr,turns,costUSD,approvals,attributable");
});
