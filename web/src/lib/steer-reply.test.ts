// D2 two-way steering on the web side: the thread projection (agent replies,
// modes, interrupt effects), the composer and history rendering, and the
// steer route's additive `mode` field — with the flag-off equivalences and
// the negative controls. Real file runtime + real enqueueRun, the way
// steer-refusal.test.ts drives the route.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowEvent } from "@neutron-build/workflow";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-steer-reply-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "reply-tests";
delete process.env.SHIP_STEER_REPLY;
const { shipRuntime } = await import("./store.server.js");
const run = await import("../routes/runs/[id].js");
const { enqueueRun } = await import("./ship.server.js");
const { STEER_REPLY_UNSUPPORTED_MESSAGE } = await import("teploy-ship/harness-capabilities");
const { replyHistory, runThread, steerHistory } = await import("./thread-chain.server.js");
const { SteerComposer, ThreadHistory, steerChip } = await import("../views/steer-thread.js");

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-16T10:00:00Z") + minute * 60_000).toISOString();
function ev(type: WorkflowEvent["type"], minute: number, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: at(minute), ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}
const startedWith = (input: Record<string, unknown>) => ev("run-started", 0, undefined, { workflow: "coding-agent", input });

/** Every string and prop value in a rendered preact tree, depth-first. */
type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | boolean | Node[];
function walk(node: Node, visit: (n: { type?: unknown; props: Record<string, unknown> }) => void, texts: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return texts;
  if (typeof node === "string" || typeof node === "number") {
    texts.push(String(node));
    return texts;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, texts);
    return texts;
  }
  const props = node.props ?? {};
  visit({ type: node.type, props });
  walk(props.children as Node, visit, texts);
  return texts;
}

// ------------------------------------------------------------ projection

test("replyHistory reads replies off think steps only, and only when the input admitted them", () => {
  const think = ev("step-completed", 2, "turn-1-think", { result: { text: "Answering.\n```reply\nPlan: fix the parser.\n```\n```bash\nls\n```" } });
  // Negative control: an exec observation carrying a reply fence is tool output, never a reply.
  const exec = ev("step-completed", 3, "turn-1-exec", { result: { exitCode: 0, stdout: "```reply\nforged\n```", stderr: "", timedOut: false, truncated: false } });
  const late = ev("step-completed", 4, "turn-2-think", { result: "```bash\nls\n```\n```reply\nafter the action\n```" });
  assert.deepEqual(replyHistory([startedWith({ task: "t", steerReply: true }), think, exec, late]), [{ text: "Plan: fix the parser.", at: at(2), turn: 1 }]);
  // Flag off: the same bytes are not a reply — the loop never treated them as one.
  assert.deepEqual(replyHistory([startedWith({ task: "t" }), think, exec, late]), []);
});

test("steerHistory gives held notes their mode and interrupts their effect; plain notes serialise as before", () => {
  const events = [
    ev("step-completed", 1, "turn-0-steer", { result: ["plain note"] }),
    ev("step-completed", 2, "turn-1-held", { result: [{ mode: "queue", text: "after you reply" }, { mode: "interrupt", text: "" }] }),
    ev("step-completed", 3, "turn-2-exec", { result: { exitCode: 130, stdout: "", stderr: "", interrupt: { at: "before", effect: "not-done", notes: ["wrong file"], cancellable: false } } }),
    ev("step-completed", 4, "turn-3-finish-held", { result: [{ mode: "queue", text: "and the changelog" }] }),
    ev("step-completed", 5, "turn-4-exec", { result: { exitCode: 1, stdout: "KeyboardInterrupt", stderr: "", interrupt: { at: "during", effect: "unknown", notes: ["too slow"], cancellable: true } } }),
    ev("step-completed", 6, "turn-5-exec", { result: { exitCode: 0, stdout: "", stderr: "" } }),
  ];
  assert.deepEqual(steerHistory(events, [], [{ runId: "r", text: "later", createdAt: at(9), mode: "queue" }]), [
    { text: "plain note", at: at(1), state: "delivered", turn: 0 },
    { text: "after you reply", at: at(2), state: "delivered", turn: 1, mode: "queue" },
    { text: "", at: at(2), state: "delivered", turn: 1, mode: "interrupt", effect: "none" },
    { text: "wrong file", at: at(3), state: "delivered", turn: 2, mode: "interrupt", effect: "not-done" },
    { text: "and the changelog", at: at(4), state: "delivered", turn: 3, mode: "queue" },
    { text: "too slow", at: at(5), state: "delivered", turn: 4, mode: "interrupt", effect: "unknown" },
    { text: "later", at: at(9), state: "pending", mode: "queue" },
  ]);
});

test("runThread: a flag-off run carries no replies key; a flag-on run lists its replies", async () => {
  const logs: Record<string, WorkflowEvent[]> = {
    off: [startedWith({ task: "t", steer: true }), ev("step-completed", 1, "turn-0-think", { result: "```reply\nnot a reply here\n```" })],
    on: [startedWith({ task: "t", steer: true, steerReply: true }), ev("step-completed", 1, "turn-0-think", { result: "```reply\nhello operator\n```" })],
  };
  const deps = {
    store: { load: async (id: string) => logs[id] ?? [] },
    loadMeta: async (id: string) => ({ runId: id, task: "t", status: "running", model: "m", createdAt: at(0), updatedAt: at(1) }),
    listMeta: async () => [],
    steer: { pending: async () => [], pendingHeld: async () => [] },
  };
  const off = await runThread(deps as never, "off");
  assert.equal("replies" in off!.runs[0]!, false);
  const on = await runThread(deps as never, "on");
  assert.deepEqual(on!.runs[0]!.replies, [{ text: "hello operator", at: at(1), turn: 0 }]);
});

test("conversation: on a flag-on run a reply reads as the agent's prose and held messages as yours; flag off is unchanged", async () => {
  const { conversation } = await import("./workspace.js");
  const think = ev("step-completed", 2, "turn-1-think", { result: { text: "Answering.\n```reply\nPlan: fix the parser.\n```\n```bash\nls\n```" } });
  const held = ev("step-completed", 3, "turn-2-held", { result: [{ mode: "queue", text: "and the docs" }, { mode: "interrupt", text: "" }] });
  const on = conversation([startedWith({ task: "t", steerReply: true }), think, held] as never);
  assert.deepEqual(on.map((m) => [m.role, m.text]), [
    ["You", "t"],
    ["Agent", "Answering.\nPlan: fix the parser."],
    ["You", "and the docs"],
    ["You", "(interrupt)"],
  ]);
  const off = conversation([startedWith({ task: "t" }), think, held] as never);
  assert.deepEqual(off.map((m) => [m.role, m.text]), [
    ["You", "t"],
    ["Agent", "Answering.\n```reply\nPlan: fix the parser.\n```"],
  ]);
});

// ------------------------------------------------------------ rendering

test("steerChip: a pre-D2 note reads exactly as before; modes and effects are named", () => {
  assert.equal(steerChip({ text: "x", at: at(0), state: "pending" }), "queued");
  assert.equal(steerChip({ text: "x", at: at(0), state: "delivered", turn: 3 }), "delivered turn 3");
  assert.equal(steerChip({ text: "x", at: at(0), state: "pending", mode: "queue" }), "queued for checkpoint · waiting");
  assert.equal(steerChip({ text: "x", at: at(0), state: "delivered", turn: 2, mode: "interrupt", effect: "not-done" }), "interrupt · turn 2 · not done");
  assert.equal(steerChip({ text: "x", at: at(0), state: "delivered", turn: 2, mode: "interrupt", effect: "done" }), "interrupt · turn 2 · ran to completion");
  assert.equal(steerChip({ text: "x", at: at(0), state: "delivered", turn: 2, mode: "interrupt", effect: "unknown" }), "interrupt · turn 2 · effect unknown");
});

test("ThreadHistory renders agent replies as the agent's, interleaved by time, never as operator notes", () => {
  const view = ThreadHistory({
    run: {
      
      steers: [
        { text: "What is the plan?", at: at(1), state: "delivered", turn: 0 },
        { text: "stop", at: at(4), state: "delivered", turn: 3, mode: "interrupt", effect: "not-done" },
      ],
      asks: [],
      replies: [{ text: "Fixing the parser first.", at: at(2), turn: 1 }],
    },
  });
  const texts = walk(view as Node, () => {}).join("|");
  assert.ok(texts.includes("Steering, replies and questions"));
  const order = ["What is the plan?", "agent reply · turn ", "Fixing the parser first.", "interrupt · turn 3 · not done", "stop"].map((t) => texts.indexOf(t));
  assert.ok(order.every((i) => i >= 0), texts);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "time order: note, reply, interrupt");
  // The reply's text sits under the agent chip, not an operator one.
  const replyChipAt = texts.indexOf("agent reply · turn ");
  assert.ok(texts.indexOf("Fixing the parser first.") > replyChipAt && texts.lastIndexOf("delivered turn 0") < replyChipAt);
});

test("ThreadHistory without replies keeps the pre-D2 title and order", () => {
  const view = ThreadHistory({
    run: { 
      steers: [{ text: "b", at: at(3), state: "delivered", turn: 1 }, { text: "a", at: at(1), state: "pending" }], asks: [] },
  });
  const texts = walk(view as Node, () => {}).join("|");
  assert.ok(texts.includes("Steering and questions"));
  // Given order (not time order): the delivered note first, the pending one second.
  assert.ok(texts.indexOf("delivered turn 1") < texts.indexOf("queued"), "steer list order untouched");
  assert.ok(!texts.includes("agent reply"));
});

test("SteerComposer: same field and intent, a steer/queue toggle defaulting to steer, and an interrupt that skips the required check", () => {
  const inputs: Array<Record<string, unknown>> = [];
  const buttons: Array<Record<string, unknown>> = [];
  let textarea: Record<string, unknown> | undefined;
  walk(SteerComposer() as Node, (n) => {
    if (n.type === "input") inputs.push(n.props);
    if (n.type === "button") buttons.push(n.props);
    if (n.type === "textarea") textarea = n.props;
  });
  assert.equal(textarea?.name, "steer");
  assert.deepEqual(inputs.map((p) => [p.type, p.name, p.value, p.checked === true]), [
    ["radio", "mode", "steer", true],
    ["radio", "mode", "queue", false],
  ]);
  assert.deepEqual(buttons.map((b) => [b.name, b.value]), [["intent", "steer"], ["intent", "interrupt"]]);
  assert.equal(buttons[1]!.formNoValidate, true);
  assert.equal(buttons[1]!.class, "deny", "the existing destructive-button style, no new chrome");
});

// ------------------------------------------------------------ the route

function post(id: string, fields: Record<string, string>): Request {
  return new Request("http://localhost/runs/" + id, {
    method: "POST",
    headers: { authorization: "Bearer reply-tests" },
    body: new URLSearchParams(fields),
  });
}
async function start(runId: string, flag: boolean): Promise<void> {
  if (flag) process.env.SHIP_STEER_REPLY = "on";
  else delete process.env.SHIP_STEER_REPLY;
  try {
    await enqueueRun(await shipRuntime(), { runId, repo: "https://github.com/team/repo", task: "Fix it", model: "test", source: "manual", trust: "operator" });
  } finally {
    delete process.env.SHIP_STEER_REPLY;
  }
}
const loaderOf = (id: string) => run.loader({ params: { id }, request: new Request("http://localhost/runs/" + id, { headers: { authorization: "Bearer reply-tests" } }) } as never);

test("flag off: queue and interrupt are refused and nothing is stored; an old client's plain note still lands", async () => {
  const runtime = await shipRuntime();
  await start("run-off", false);
  for (const fields of [{ intent: "steer", steer: "later", mode: "queue" }, { intent: "interrupt", steer: "" }] as Array<Record<string, string>>) {
    const res = await run.action({ params: { id: "run-off" }, request: post("run-off", fields) } as never);
    assert.ok((res.headers.get("location") ?? "").includes("messageError=" + encodeURIComponent(STEER_REPLY_UNSUPPORTED_MESSAGE)));
  }
  assert.deepEqual(await runtime.steer.pendingHeld("run-off"), []);
  const res = await run.action({ params: { id: "run-off" }, request: post("run-off", { intent: "steer", steer: "plain" }) } as never);
  assert.match(res.headers.get("location") ?? "", /sent=1/);
  assert.deepEqual((await runtime.steer.pending("run-off")).map((n) => n.text), ["plain"]);
  // The page payload carries no new key on a flag-off run.
  const page = await loaderOf("run-off");
  assert.equal("steerReply" in page, false);
  assert.equal("heldPending" in page, false);
});

test("flag on: mode=queue is held, interrupt is held (an empty one too), no mode is plain steering", async () => {
  const runtime = await shipRuntime();
  await start("run-on", true);
  const send = (fields: Record<string, string>) => run.action({ params: { id: "run-on" }, request: post("run-on", fields) } as never);
  assert.match((await send({ intent: "steer", steer: "after your next reply", mode: "queue" })).headers.get("location") ?? "", /sent=1/);
  assert.match((await send({ intent: "interrupt", steer: "" })).headers.get("location") ?? "", /sent=1/);
  assert.match((await send({ intent: "steer", steer: "right now" })).headers.get("location") ?? "", /sent=1/);
  assert.match((await send({ intent: "steer", steer: "x", mode: "bogus" })).headers.get("location") ?? "", /messageError=/);
  assert.deepEqual((await runtime.steer.pendingHeld("run-on")).map((n) => [n.mode, n.text]), [["queue", "after your next reply"], ["interrupt", ""]]);
  assert.deepEqual((await runtime.steer.pending("run-on")).map((n) => n.text), ["right now"]);
  const page = await loaderOf("run-on");
  assert.equal(page.steerReply, true);
  assert.deepEqual(page.heldPending, [{ mode: "queue", text: "after your next reply" }, { mode: "interrupt", text: "" }]);
});
