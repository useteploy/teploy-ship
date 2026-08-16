import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { deliverEvent, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { runAgent } from "./agent.js";
import { durableRecoveryInput } from "./durable.js";
import { defaultRecoveryConfig } from "./recovery.js";
import { approvalEvent, durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import { enqueueRun } from "./runtime.js";

function reactiveModel(turns: Array<string | ((obs: string) => string)>): ModelAdapter {
  return {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
      const obs = typeof lastUser?.content === "string" ? lastUser.content : "";
      // Index by conversation position, not process-local state — a real
      // model is stateless, so a resumed run (fresh process, replayed
      // history) must land on the right turn.
      const index = options.messages.filter((m) => m.role === "assistant").length;
      const turn = turns[index] ?? "```finish\nout of script\n```";
      const text = typeof turn === "function" ? turn(obs) : turn;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 100 },
        raw: null,
      };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

test("FileEventStore round-trips, dedupes by seq (first writer wins), and sorts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-store-"));
  const conflicts: string[] = [];
  const store = new FileEventStore(dir, (m) => conflicts.push(m));
  const ev = (seq: number, name: string): WorkflowEvent => ({ v: 1, seq, type: "step-completed", at: "t", name, data: { result: name } });

  await store.append("r1", ev(1, "second"));
  await store.append("r1", ev(0, "first"));
  await store.append("r1", ev(1, "dupe-loser"));

  const events = await store.load("r1");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.name, "first");
  assert.equal(events[1]?.name, "second"); // first writer for seq 1 won
  // Resolving the conflict quietly was the defect: two executors disagreeing
  // about a run's history is exactly the thing an operator has to hear about.
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]!, /two different events claim seq 1/);
  assert.deepEqual(await store.load("ghost"), []);
});

test("TS-017: a corrupt line in the MIDDLE of the log is refused, a torn tail is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-store-corrupt-"));
  const store = new FileEventStore(dir);
  const line = (seq: number, name: string): string =>
    JSON.stringify({ v: 1, seq, type: "step-completed", at: "t", name, data: { result: name } });

  // A crash mid-append leaves a partial LAST line. That is an uncommitted
  // event: everything before it is intact, so the log loads.
  await writeFile(join(dir, "torn.events.jsonl"), `${line(0, "a")}\n${line(1, "b")}\n{"v":1,"seq":2,"ty`);
  const torn = await store.load("torn");
  assert.equal(torn.length, 2, "a torn tail is dropped and the rest replays");

  // A malformed line in the MIDDLE cannot be an uncommitted append — it is
  // corruption, and skipping it while loading later events hands replay a
  // history that never happened (re-running a model call, or a push).
  await writeFile(join(dir, "holed.events.jsonl"), `${line(0, "a")}\nnot json at all\n${line(2, "c")}\n`);
  await assert.rejects(() => store.load("holed"), /event log is corrupt at line 2/);
});

test("run ids that would escape the state directory are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-store-path-"));
  const store = new FileEventStore(dir);
  await assert.rejects(() => store.load("../../etc/passwd"), /refusing unsafe run id/);
  await assert.rejects(() => store.append("..", { v: 1, seq: 0, type: "run-started", at: "t" } as WorkflowEvent), /refusing unsafe run id/);
});

test("durable park -> approve -> resume works across store instances (separate CLI invocations)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-durable-"));
  const wsDir = await mkdtemp(join(tmpdir(), "ship-ws-"));
  const provider: ExecutorProvider = {
    async create() {
      return { handle: wsDir };
    },
    attach(handle: string) {
      return new LocalExecutor({ root: handle });
    },
  };
  const makeWf = () =>
    durableAgent({
      model: reactiveModel([
        "```bash\nmkdir -p build && echo x > build/junk && echo seeded\n```",
        "```bash\nrm -rf build\n```", // parks
        (obs) => (obs.includes("exit 0") ? "```bash\ntest ! -d build && echo gone\n```" : "```finish\nbad\n```"),
        (obs) => (obs.includes("gone") ? "```finish\ncleaned.\n```" : "```finish\nnot-gone\n```"),
        (obs) => (obs.includes("Before finishing") ? "```bash\ntest ! -d build && echo gone\n```" : "```finish\nnot-gone\n```"),
        (obs) => (obs.includes("gone") ? "```finish\ncleaned.\n```" : "```finish\nnot-gone\n```"),
      ]),
      executor: provider,
      approveAction: defaultApprovalPolicy,
      workdir: ".",
    });

  // invocation 1: run until parked (fresh store instance)
  const first = await executeRun({ workflow: makeWf(), runId: "r1", store: new FileEventStore(dir), input: { task: "clean" } });
  assert.equal(first.status, "waiting");
  assert.equal(first.eventName, approvalEvent(1));

  // invocation 2: approve + continue (fresh store instance — proves persistence)
  await deliverEvent(new FileEventStore(dir), "r1", approvalEvent(1), { approved: true });
  const second = await executeRun({ workflow: makeWf(), runId: "r1", store: new FileEventStore(dir), input: { task: "clean" } });
  assert.equal(second.status, "completed");
  const { usage: uOut, ...outRest } = second.output as Record<string, unknown>;
  assert.deepEqual(outRest, { status: "finished", summary: "cleaned.", turns: 6 });
});

test("RunMetaStore saves, lists newest-first, and tracks the parked event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-meta-"));
  const meta = new RunMetaStore(dir);
  await meta.save({ runId: "a", task: "t1", status: "waiting", eventName: "turn-1-approval", model: "m", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  await meta.save({ runId: "b", task: "t2", status: "completed", model: "m", createdAt: "2026-01-02", updatedAt: "2026-01-02" });

  const loaded = await meta.load("a");
  assert.equal(loaded?.eventName, "turn-1-approval");
  const all = await meta.list();
  assert.deepEqual(all.map((m) => m.runId), ["b", "a"]);
  assert.equal(await meta.load("ghost"), null);
});

test("runAgent aggregates usage across calls, cache fields included", async () => {
  const executor = new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "ship-usage-")) });
  const result = await runAgent({
    model: reactiveModel([
      "```bash\necho one\n```",
      "```bash\necho two\n```",
      "```finish\ndone\n```",
      "```bash\necho verified\n```", // proof, as the finish gate asks
      "```finish\ndone\n```",
    ]),
    executor,
    task: "count",
    recovery: false,
    condense: false,
  });
  // five model calls (finish is verify-nudged, then proven) at 10/5/15 + 100
  // cache-read each
  assert.equal(result.usage.inputTokens, 50);
  assert.equal(result.usage.outputTokens, 25);
  assert.equal(result.usage.totalTokens, 75);
  assert.equal(result.usage.cacheReadTokens, 500);
});


test("enqueueRun bakes stuck detection into the run INPUT — absent by default, env-settable", async () => {
  // The knob has to be decided at enqueue, not at execution: the thresholds
  // choose which turn a run terminates on, so a worker that disagreed with the
  // log would trip NondeterminismError. This pins where the decision lands.
  const inputOf = async (
    options: Parameters<typeof enqueueRun>[1],
    env: Record<string, string> = {},
  ): Promise<Record<string, unknown>> => {
    const dir = await mkdtemp(join(tmpdir(), "ship-enqueue-"));
    const store = new FileEventStore(dir);
    const runtime = { kind: "file" as const, store, saveMeta: async () => {} };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      await enqueueRun(runtime as unknown as Parameters<typeof enqueueRun>[0], options);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    const started = (await store.load(options.runId)).find((e) => e.type === "run-started");
    return (started?.data as { input: Record<string, unknown> }).input;
  };

  const base = { runId: "r-enq", task: "t", model: "m" };
  const plain = await inputOf(base);
  assert.equal("recovery" in plain, false, "off unless asked for — nothing changes for existing deployments");
  assert.equal("settle" in plain, false);

  const asked = await inputOf({ ...base, recovery: { maxNudges: 1 }, settle: true });
  assert.deepEqual(asked.recovery, { maxNudges: 1 }, "the THRESHOLDS ride in the input too, not just the switch");
  assert.equal(asked.settle, true);

  const viaEnv = await inputOf(base, { SHIP_RECOVERY: "1", SHIP_SETTLE: "true" });
  // The env knob MATERIALISES the thresholds rather than storing a bare `true`.
  // A bare `true` would leave durable.ts resolving them from the
  // defaultRecoveryConfig code constant at run time, so editing that constant
  // would return a replaying run on a different turn, leave recorded steps
  // unconsumed, and raise a NondeterminismError that executeRun THROWS rather
  // than records — bricking every in-flight run enqueued before the edit.
  assert.deepEqual(
    viaEnv.recovery,
    defaultRecoveryConfig,
    "the env knob must bake the thresholds into the log, not defer them to the code constant",
  );
  assert.equal(viaEnv.settle, true);
});

// SEAM: --settle must actually reach the durable run input.
//
// Deleting the one spread that joins the flag to the input left 319/319 green
// while `teploy-ship run --durable --settle` silently did nothing. The flag is
// registered in args.ts and honoured in durable.ts; only that line connected
// them, and nothing pinned it. Worse, the warning that used to tell the
// operator the flag was ignored had been removed, so the failure went from
// loud to silent.
//
// Two assertions, because the mapping and the CALL SITE fail independently.
test("durableRecoveryInput maps --settle onto the durable input", () => {
  assert.deepEqual(durableRecoveryInput({ settle: true }), { recovery: true, settle: true });
  assert.deepEqual(durableRecoveryInput({ settle: false }), {});
  assert.deepEqual(durableRecoveryInput(undefined), {});
  assert.deepEqual(durableRecoveryInput({}), {});
});

test("SEAM: executePass actually calls durableRecoveryInput", async () => {
  // Structural, deliberately: the mapping above stays correct even if the call
  // site is deleted, which is exactly how this broke. `pnpm test` builds before
  // running, so dist/cli.js is current.
  const { readFile } = await import("node:fs/promises");
  const compiled = await readFile(new URL("./cli.js", import.meta.url), "utf8");
  assert.match(
    compiled,
    /durableRecoveryInput\(/,
    "executePass no longer spreads durableRecoveryInput — --settle is a silent no-op on durable runs",
  );
});
