import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { auditRow, toCsv } from "./audit.js";
import { MIN_N_FOR_PERCENTILES, auditTiming, timingSummary } from "./audit-timing.js";
import type { RunTiming } from "./run-timing.js";
import type { RunMeta } from "./run-store.js";

let seq = 0;
function ev(type: string, at: string | undefined, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: seq++, type, ...(at !== undefined ? { at } : {}), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) } as WorkflowEvent;
}
const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  runId: "run-1",
  task: "fix, the \"parser\"",
  status: "completed",
  model: "anthropic/claude-sonnet-5",
  createdAt: "2026-08-20T10:00:00Z",
  updatedAt: "2026-08-20T10:04:00Z",
  ...over,
});

const completedRun = () => [
  ev("run-started", t(0), undefined, { input: { repo: "https://git/o/r" } }),
  ev("step-completed", t(10), "turn-0-exec"),
  ev("event-waiting", t(20), "approval"),
  ev("event-received", t(80), "approval", { payload: { by: "u1" } }),
  ev("run-completed", t(100), undefined, { output: { status: "finished", turns: 1 } }),
];

test("CSV is byte-identical: pinned header+row, and unaffected by timing", () => {
  const row = auditRow(meta(), completedRun());
  const csv = toCsv([row]);
  const header =
    "runId,createdAt,updatedAt,status,source,actor,actorKind,approvedBy,model,ranOn,repo,task,pr,turns,costUSD,costEstimated,approvals,attributable";
  assert.equal(csv.split("\n")[0], header);
  assert.equal(
    csv.split("\n")[1],
    'run-1,2026-08-20T10:00:00Z,2026-08-20T10:04:00Z,completed,unknown,,unknown,u1,anthropic/claude-sonnet-5,,https://git/o/r,"fix, the ""parser""",,1,0,false,1,false',
  );
  // Attaching timing (as the JSON path does) must not change what CSV emits.
  const withTiming = { ...row, timing: auditTiming(completedRun()) };
  assert.equal(toCsv([withTiming as typeof row]), csv);
  assert.equal(csv.includes("timing"), false);
});

test("JSON gains timing: completed run with a resolved wait", () => {
  const timing = auditTiming(completedRun());
  assert.equal(timing.telemetry, "complete");
  assert.equal(timing.terminal, "completed");
  assert.equal(timing.toFirstStepMs, 10_000);
  assert.equal(timing.elapsedMs, 100_000);
  assert.equal(timing.waitingOnPeopleMs, 60_000);
  assert.equal(timing.activeMs, 40_000);
  const json = JSON.parse(JSON.stringify({ ...auditRow(meta(), completedRun()), timing }));
  assert.equal(json.timing.activeMs, 40_000);
  assert.equal(json.runId, "run-1"); // existing fields still present
});

test("an open wait is open, not measured against the clock", () => {
  const timing = auditTiming([
    ev("run-started", t(0)),
    ev("step-completed", t(5), "turn-0-exec"),
    ev("event-waiting", t(6), "approval"),
  ]);
  assert.equal(timing.terminal, "open");
  assert.equal(timing.elapsedMs, null);
  assert.equal(timing.activeMs, null);
  assert.equal(timing.waits[0].resolved, false);
  assert.equal(timing.waits[0].waitedMs, null);
  assert.equal(timing.telemetry, "partial");
});

test("missing timestamps give missing telemetry with null, never 0", () => {
  const timing = auditTiming([ev("run-started", undefined), ev("step-completed", undefined, "turn-0-exec"), ev("run-completed", undefined)]);
  assert.equal(timing.telemetry, "missing");
  for (const k of ["toFirstStepMs", "elapsedMs", "waitingOnPeopleMs", "waitingOnTimersMs", "activeMs"] as const) assert.equal(timing[k], null, k);
});

const timingWith = (elapsedMs: number | null, over: Partial<RunTiming> = {}): RunTiming => ({
  telemetry: elapsedMs === null ? "missing" : "complete",
  terminal: "completed",
  toFirstStepMs: elapsedMs === null ? null : 1,
  elapsedMs,
  waitingOnPeopleMs: elapsedMs === null ? null : 0,
  waitingOnTimersMs: elapsedMs === null ? null : 0,
  activeMs: elapsedMs,
  waits: [],
  unknown: [],
  ...over,
});

test("below the threshold: raw values and n, no median or p90", () => {
  const rows = [3, 1, 2].map((s) => ({ status: "completed", timing: timingWith(s * 1000) }));
  const s = timingSummary(rows).byStatus.completed.metrics.elapsedMs;
  assert.equal(s.n, 3);
  assert.deepEqual(s.raw, [1000, 2000, 3000]);
  assert.equal(s.median, undefined);
  assert.equal(s.p90, undefined);
});

test("at or above the threshold: median and p90 with n stated", () => {
  const n = MIN_N_FOR_PERCENTILES;
  const rows = Array.from({ length: n }, (_, i) => ({ status: "completed", timing: timingWith((i + 1) * 100) }));
  const s = timingSummary(rows);
  const m = s.byStatus.completed.metrics.elapsedMs;
  assert.equal(s.minNForPercentiles, n);
  assert.equal(m.n, n);
  assert.equal(m.median, 1050); // mean of 1000 and 1100
  assert.equal(m.p90, 1800); // nearest rank 18 of 20
  assert.equal(m.raw, undefined);
});

test("partial and missing runs are counted per status and overall", () => {
  const rows = [
    { status: "completed", timing: timingWith(1000) },
    { status: "completed", timing: timingWith(null) },
    { status: "failed", timing: timingWith(500, { telemetry: "partial" }) },
  ];
  const s = timingSummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.missing, 1);
  assert.equal(s.partial, 1);
  assert.equal(s.byStatus.completed.missing, 1);
  assert.equal(s.byStatus.failed.partial, 1);
  assert.equal(s.byStatus.completed.metrics.elapsedMs.unknown, 1);
});

test("negative control: runs with no timestamps never contribute a 0 to a median", () => {
  const n = MIN_N_FOR_PERCENTILES;
  const real = Array.from({ length: n }, () => ({ status: "completed", timing: timingWith(10_000) }));
  const blind = Array.from({ length: n }, () => ({ status: "completed", timing: auditTiming([ev("run-started", undefined), ev("run-completed", undefined)]) }));
  const m = timingSummary([...real, ...blind]).byStatus.completed.metrics;
  // If nulls were coerced to 0, half the sample would be 0 and the median 5000.
  assert.equal(m.elapsedMs.n, n);
  assert.equal(m.elapsedMs.unknown, n);
  assert.equal(m.elapsedMs.median, 10_000);
  assert.equal(m.activeMs.median, 10_000);
  // And an all-blind group yields no median at all, not a median of 0.
  const only = timingSummary(blind).byStatus.completed.metrics.elapsedMs;
  assert.equal(only.n, 0);
  assert.equal(only.median, undefined);
  assert.deepEqual(only.raw, []);
});
