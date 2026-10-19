import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import type { RunMeta, SteerNote } from "teploy-ship/runtime";
import {
  askHistory,
  forkOfInput,
  harnessLabel,
  runThread,
  stackedOnInput,
  steerHistory,
  threadViewEnabled,
  THREAD_SCAN_LIMIT,
} from "./thread-chain.server.js";
import type { ThreadDeps } from "./thread-chain.server.js";

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-15T10:00:00Z") + minute * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}
/** run-started as runtime.ts writes it: anchor beside the input, never inside it. */
function started(minute: number, input: Record<string, unknown>, taskRootRunId?: string): WorkflowEvent {
  return ev("run-started", minute, undefined, { workflow: "coding-agent", input, ...(taskRootRunId !== undefined ? { taskRootRunId } : {}) });
}

test("the flag is on unless explicitly off (unset means on)", () => {
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "on" }), true);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "ON" }), true);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: " on " }), true);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "off" }), false);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "0" }), false);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "false" }), false);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "no" }), false);
  assert.equal(threadViewEnabled({ SHIP_THREAD_VIEW: "" }), true);
  assert.equal(threadViewEnabled({}), true);
});

test("steerHistory pairs drained turn steps with pending notes and keeps their states distinct", () => {
  const events = [
    ev("step-completed", 1, "turn-0-steer", { result: ["focus on the parser"] }),
    ev("step-completed", 3, "attempt-1-turn-2-steer", { result: ["skip the docs"] }),
    ev("step-completed", 5, "turn-3-steer", { result: [] }),
    ev("step-completed", 6, "turn-4-think", { result: "not a steer step" }),
  ];
  const pending: SteerNote[] = [{ runId: "r", text: "one more thing", createdAt: at(7) }];
  assert.deepEqual(steerHistory(events, pending), [
    { text: "focus on the parser", at: at(1), state: "delivered", turn: 0 },
    { text: "skip the docs", at: at(3), state: "delivered", turn: 2 },
    { text: "one more thing", at: at(7), state: "pending" },
  ]);
});

test("steerHistory surfaces the notes an external harness accepted and never delivered", () => {
  const events = [ev("step-completed", 9, "attempt-1-harness-steer-undelivered", { result: ["too late"] }), ev("step-completed", 10, "harness-steer-undelivered", { result: [] })];
  assert.deepEqual(steerHistory(events, []), [{ text: "too late", at: at(9), state: "undelivered" }]);
});

test("askHistory reads each question from its think step and pairs the delivered answer", () => {
  const events = [
    ev("step-completed", 1, "turn-2-think", { result: "Let me check.\n```ask\nShould I drop the table?\n```" }),
    ev("event-waiting", 2, "turn-2-ask"),
    ev("event-received", 4, "turn-2-ask", { payload: { approved: true, answer: "No, keep it", by: "user:ada" } }),
    // A second park, answered by a denial whose reason IS the answer. The
    // think step carries the park's own prefix — pendingQuestion's rule.
    ev("step-completed", 5, "attempt-1-turn-3-think", { result: { text: "```ask\nArchive the logs?\n```" } }),
    ev("event-waiting", 6, "attempt-1-turn-3-ask"),
    ev("event-received", 7, "attempt-1-turn-3-ask", { payload: { approved: false, reason: "not yet" } }),
    // A third park still waiting, with an unreadable think step.
    ev("step-completed", 8, "turn-5-think", { result: "no ask block here" }),
    ev("event-waiting", 9, "turn-5-ask"),
  ];
  assert.deepEqual(askHistory(events), [
    { event: "turn-2-ask", question: "Should I drop the table?", at: at(2), answer: { text: "No, keep it", at: at(4), by: "user:ada" } },
    { event: "attempt-1-turn-3-ask", question: "Archive the logs?", at: at(6), answer: { text: "not yet", at: at(7) } },
    { event: "turn-5-ask", question: null, at: at(9), answer: null },
  ]);
});

test("askHistory: an empty denial is recorded as no text, not as an invented answer", () => {
  const events = [
    ev("step-completed", 1, "turn-0-think", { result: "```ask\nProceed?\n```" }),
    ev("event-waiting", 2, "turn-0-ask"),
    ev("event-received", 3, "turn-0-ask", { payload: { approved: false } }),
  ];
  assert.deepEqual(askHistory(events), [
    { event: "turn-0-ask", question: "Proceed?", at: at(2), answer: { text: null, at: at(3) } },
  ]);
});

test("harnessLabel reads the recorded harness and falls back honestly", () => {
  assert.equal(harnessLabel([started(0, { harness: { id: "claude-code", version: "1" } })]), "claude-code");
  assert.equal(harnessLabel([started(0, { harnessAttempts: [{ id: "native" }, { id: "claude-code" }] })]), "native / claude-code");
  assert.equal(harnessLabel([started(0, {})]), "native");
});

/** The store fake: logs and metas in maps, listMeta bounded newest-first, steer reads counted. */
function deps(fix: {
  logs?: Record<string, WorkflowEvent[]>;
  metas?: RunMeta[];
  pending?: Record<string, SteerNote[]>;
}): { deps: ThreadDeps; steerReads: string[] } {
  const steerReads: string[] = [];
  const metas = fix.metas ?? [];
  const d: ThreadDeps = {
    store: { load: async (runId) => fix.logs?.[runId] ?? [] },
    loadMeta: async (runId) => metas.find((m) => m.runId === runId) ?? null,
    listMeta: async (options) =>
      [...metas].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, options?.limit ?? metas.length),
    steer: {
      pending: async (runId) => {
        steerReads.push(runId);
        return fix.pending?.[runId] ?? [];
      },
    },
  };
  return { deps: d, steerReads };
}

const meta = (runId: string, over: Partial<RunMeta>): RunMeta => ({
  runId,
  task: `Task of ${runId}`,
  status: "completed",
  model: "glm-5.3",
  createdAt: at(0),
  updatedAt: at(10),
  ...over,
});

/** An anchored three-run chain plus unrelated noise, as the live store shapes it. */
function anchoredChain(): { logs: Record<string, WorkflowEvent[]>; metas: RunMeta[]; pending: Record<string, SteerNote[]> } {
  seq = 0;
  return {
    logs: {
      "r1": [
        started(0, { task: "Fix the login bug", userMessage: "Fix the login bug", steer: true }),
        ev("step-completed", 2, "turn-0-steer", { result: ["focus on the parser"] }),
        ev("run-completed", 8, undefined, { output: { summary: "Fixed the parser; tests green." } }),
      ],
      "r2": [
        started(20, { parentRunId: "r1", task: "…", userMessage: "Also fix the docs" }, "r1"),
        ev("step-completed", 21, "turn-1-steer", { result: ["skip the changelog"] }),
        ev("step-completed", 22, "turn-2-think", { result: "```ask\nShould I drop the table?\n```" }),
        ev("event-waiting", 23, "turn-2-ask"),
        ev("event-received", 25, "turn-2-ask", { payload: { approved: true, answer: "No, keep it", by: "user:ada" } }),
      ],
      "r3": [
        started(40, { parentRunId: "r2", task: "…", userMessage: "Add a test for it" }, "r1"),
        ev("run-completed", 48, undefined, { output: { summary: "Added regression test." } }),
      ],
      // Unrelated: a different root, created after — must not appear.
      "r9": [started(50, { task: "Unrelated" }, "r8"), ev("run-completed", 55, undefined, { output: { summary: "done" } })],
      // Unrelated: created BEFORE the root — skipped without a log read.
      "r0": [started(0, { task: "Older than the root" })],
    },
    metas: [
      meta("r3", { status: "completed", createdAt: at(40), updatedAt: at(48) }),
      meta("r9", { status: "completed", createdAt: at(50), updatedAt: at(55) }),
      meta("r2", { status: "waiting", createdAt: at(20), updatedAt: at(25) }),
      meta("r1", { status: "completed", createdAt: at(0), updatedAt: at(8) }),
      meta("r0", { status: "completed", createdAt: at(0), updatedAt: at(1) }),
    ],
    pending: { r2: [{ runId: "r2", text: "one more thing", createdAt: at(26) }] },
  };
}

test("the thread contract: chain ordered by follow-up, per-run steer notes and ask parks", async () => {
  const fix = anchoredChain();
  const { deps: d } = deps(fix);
  const thread = await runThread(d, "r2");
  assert.notEqual(thread, null);
  assert.equal(thread!.run, "r2");
  assert.equal(thread!.root, "r1");
  assert.equal(thread!.truncated, false);
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["r1", "r2", "r3"]);
  const [r1, r2, r3] = thread!.runs;
  assert.equal(r1!.parentRunId, null);
  assert.equal(r1!.status, "completed");
  assert.equal(r1!.createdAt, at(0));
  assert.equal(r1!.model, "glm-5.3");
  assert.equal(r1!.harness, "native");
  assert.equal(r1!.summary, "Fixed the parser; tests green.");
  assert.deepEqual(r1!.steers, [{ text: "focus on the parser", at: at(2), state: "delivered", turn: 0 }]);
  assert.deepEqual(r1!.asks, []);
  assert.equal(r2!.parentRunId, "r1");
  assert.equal(r2!.status, "waiting");
  assert.deepEqual(r2!.steers, [
    { text: "skip the changelog", at: at(21), state: "delivered", turn: 1 },
    { text: "one more thing", at: at(26), state: "pending" },
  ]);
  assert.deepEqual(r2!.asks, [
    { event: "turn-2-ask", question: "Should I drop the table?", at: at(23), answer: { text: "No, keep it", at: at(25), by: "user:ada" } },
  ]);
  assert.equal(r3!.summary, "Added regression test.");
});

test("asking for the root or any member returns the same chain", async () => {
  const fix = anchoredChain();
  const { deps: d } = deps(fix);
  for (const id of ["r1", "r2", "r3"]) {
    const thread = await runThread(d, id);
    assert.deepEqual(thread!.runs.map((r) => r.runId), ["r1", "r2", "r3"], id);
    assert.equal(thread!.root, "r1");
  }
});

test("a single-run task is a one-run chain, not an error", async () => {
  const fix = anchoredChain();
  const { deps: d } = deps({ logs: { solo: fix.logs["r1"]! }, metas: [meta("solo", {})], pending: {} });
  const thread = await runThread(d, "solo");
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["solo"]);
  assert.equal(thread!.root, "solo");
  assert.equal(thread!.truncated, false);
});

test("DF1: a fork carries its lineage and joins the forked run's thread; a fork of a stranger does not", async () => {
  const fix = anchoredChain();
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  fix.logs["f1"] = [
    started(60, { task: "Fork it elsewhere", forkOf: { runId: "r3", sha, branch: "ship/r3" } }, "f1"),
    ev("run-completed", 66, undefined, { output: { summary: "Carried the work to a new PR." } }),
  ];
  fix.metas.push(meta("f1", { createdAt: at(60), updatedAt: at(66) }));
  // A fork of a run outside the chain must not be swept in as a member.
  fix.logs["f9"] = [started(62, { task: "Stranger's fork", forkOf: { runId: "r0" } }, "f9"), ev("run-completed", 63, undefined, { output: {} })];
  fix.metas.push(meta("f9", { createdAt: at(62), updatedAt: at(63) }));

  const { deps: d } = deps(fix);
  const thread = await runThread(d, "r1");
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["r1", "r2", "r3", "f1"], "the fork is a member of the thread it came from");
  assert.deepEqual(thread!.runs[3]!.forkOf, { runId: "r3", sha }, "its lineage reads off the recorded input");
  assert.equal(thread!.runs[3]!.parentRunId, null, "a fork is no run's follow-up");
  assert.equal(thread!.runs.every((r) => r.runId !== "f9"), true, "a fork of an unrelated run stays out");

  // On the fork's own page the chain is the fork alone (it is a new task
  // root), and the lineage is still what the view reports.
  const own = await runThread(d, "f1");
  assert.deepEqual(own!.runs.map((r) => r.runId), ["f1"]);
  assert.deepEqual(own!.runs[0]!.forkOf, { runId: "r3", sha });
});

test("DF1: forkOfInput is shape-checked and absent on a non-fork or a malformed record", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  assert.deepEqual(forkOfInput([started(0, { forkOf: { runId: "r3", sha } })]), { runId: "r3", sha });
  assert.deepEqual(forkOfInput([started(0, { forkOf: { runId: "r3" } })]), { runId: "r3" }, "no sha key when none was recorded");
  assert.equal(forkOfInput([started(0, { task: "t" })]), undefined);
  assert.equal(forkOfInput([started(0, { forkOf: { sha } })]), undefined, "no runId, no lineage");
  assert.equal(forkOfInput([started(0, { forkOf: "run-r3" })]), undefined, "a bare string is not the record");
});

test("DS1: a stacked run carries its lineage and joins the base run's thread; a stack on a stranger does not", async () => {
  const fix = anchoredChain();
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const record = { runId: "r3", pr: 7, branch: "ship/r3", sha };
  fix.logs["s1"] = [
    started(58, { task: "Stack the migration on it", stack: record }, "s1"),
    ev("run-completed", 64, undefined, { output: { summary: "Opened the stacked PR against ship/r3." } }),
  ];
  fix.metas.push(meta("s1", { createdAt: at(58), updatedAt: at(64) }));
  // A stack whose base run is outside the chain must not be swept in as a member.
  fix.logs["s9"] = [started(59, { task: "Stranger's stack", stack: { runId: "r0", pr: 2, branch: "ship/r0", sha } }, "s9"), ev("run-completed", 60, undefined, { output: {} })];
  fix.metas.push(meta("s9", { createdAt: at(59), updatedAt: at(60) }));

  const { deps: d } = deps(fix);
  const thread = await runThread(d, "r1");
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["r1", "r2", "r3", "s1"], "the stack is a member of the thread it rides, like a fork");
  assert.deepEqual(thread!.runs[3]!.stackedOn, record, "its lineage reads off the recorded input");
  assert.equal(thread!.runs[3]!.parentRunId, null, "a stacked run is no run's follow-up");
  assert.ok(thread!.runs.every((r) => r.runId !== "s9"), "a stack on an unrelated run stays out");

  // On the stacked run's own page the chain is the stack alone (it is a new
  // task root, the same shape as a fork), and the lineage is still what the
  // view reports — that is what the strip's "(stack)" label and hover read.
  const own = await runThread(d, "s1");
  assert.deepEqual(own!.runs.map((r) => r.runId), ["s1"]);
  assert.deepEqual(own!.runs[0]!.stackedOn, record);
});

test("DS1: stackedOnInput is shape-checked and absent on a non-stacked or malformed record", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  assert.deepEqual(stackedOnInput([started(0, { stack: { runId: "r3", pr: 7, branch: "ship/r3", sha } })]), { runId: "r3", pr: 7, branch: "ship/r3", sha });
  assert.deepEqual(stackedOnInput([started(0, { stack: { runId: "r3" } })]), { runId: "r3" }, "no optional key when none was recorded");
  assert.equal(stackedOnInput([started(0, { task: "t" })]), undefined);
  assert.equal(stackedOnInput([started(0, { stack: { sha } })]), undefined, "no runId, no lineage");
  assert.equal(stackedOnInput([started(0, { stack: "run-r3" })]), undefined, "a bare string is not the record");
  assert.deepEqual(stackedOnInput([started(0, { stack: { runId: "r3", pr: 0 } })]), { runId: "r3" }, "a non-positive pr is dropped rather than rendered as #0");
  assert.deepEqual(stackedOnInput([started(0, { stack: { runId: "r3", pr: 3.5 } })]), { runId: "r3" }, "a fractional pr is dropped too");
});

test("an unknown run id reads as null (the route 404s)", async () => {
  const { deps: d } = deps({ logs: {}, metas: [], pending: {} });
  assert.equal(await runThread(d, "nope"), null);
});

test("a legacy chain with no anchors is found by walking parents", async () => {
  seq = 0;
  const logs = {
    l1: [started(0, { task: "first" })],
    l2: [started(10, { parentRunId: "l1", task: "second" })],
    l3: [started(20, { parentRunId: "l2", task: "third" })],
  };
  const metas = [
    meta("l3", { createdAt: at(20), updatedAt: at(25) }),
    meta("l2", { createdAt: at(10), updatedAt: at(15) }),
    meta("l1", { createdAt: at(0), updatedAt: at(5) }),
  ];
  const { deps: d } = deps({ logs, metas, pending: {} });
  const thread = await runThread(d, "l3");
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["l1", "l2", "l3"]);
  assert.equal(thread!.root, "l1");
});

test("pending steer notes are read only for runs that could still drain them", async () => {
  const fix = anchoredChain();
  const { deps: d, steerReads } = deps(fix);
  await runThread(d, "r2");
  assert.deepEqual(steerReads, ["r2"], "completed runs' pending is never read");
});

test("a full scan window reports truncated rather than looking complete", async () => {
  const fix = anchoredChain();
  // Older than every family member's updatedAt, so the newest-first window
  // still contains the family — but numerous enough to fill it, which is
  // the condition the flag reports honestly.
  const noise: RunMeta[] = [];
  for (let i = 0; i < THREAD_SCAN_LIMIT; i++) noise.push(meta(`z${i}`, { createdAt: at(0), updatedAt: at(0) }));
  const { deps: d } = deps({ logs: fix.logs, metas: [...fix.metas, ...noise], pending: fix.pending });
  const thread = await runThread(d, "r2");
  assert.equal(thread!.truncated, true);
  // The chain itself still resolves: the window is newest-first and the
  // family is recent. What the flag says is "there may be more".
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["r1", "r2", "r3"]);
});

test("negative control: a run whose parent chain leaves the family is not a member", async () => {
  seq = 0;
  const logs = {
    root: [started(0, { task: "root" })],
    // Parent exists but is NOT in the family, and no anchor names the root.
    stranger: [started(10, { parentRunId: "elsewhere", task: "stranger" })],
  };
  const metas = [
    meta("root", { createdAt: at(0), updatedAt: at(1) }),
    meta("stranger", { createdAt: at(10), updatedAt: at(11) }),
  ];
  const { deps: d } = deps({ logs, metas, pending: {} });
  const thread = await runThread(d, "root");
  assert.deepEqual(thread!.runs.map((r) => r.runId), ["root"]);
});

test("steerHistory shows notes drained by an external harness-steer-N step as delivered (attempt prefixes too)", () => {
  const events = [
    ev("step-completed", 3, "harness-steer-0", { result: ["use the smaller change"] }),
    ev("step-completed", 4, "harness-steer-1", { result: [] }),
    ev("step-completed", 5, "attempt-1-harness-steer-0", { result: ["and add a test"] }),
    ev("step-completed", 6, "harness-steer-undelivered", { result: ["too late"] }),
  ];
  assert.deepEqual(steerHistory(events, []), [
    { text: "use the smaller change", at: at(3), state: "delivered" },
    { text: "and add a test", at: at(5), state: "delivered" },
    { text: "too late", at: at(6), state: "undelivered" },
  ]);
});
