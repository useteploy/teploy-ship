import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { deliverEvent, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { runAgent } from "./agent.js";
import { approvalEvent, durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import { parseArgs } from "./args.js";

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
  const store = new FileEventStore(dir);
  const ev = (seq: number, name: string): WorkflowEvent => ({ v: 1, seq, type: "step-completed", at: "t", name, data: { result: name } });

  await store.append("r1", ev(1, "second"));
  await store.append("r1", ev(0, "first"));
  await store.append("r1", ev(1, "dupe-loser"));

  const events = await store.load("r1");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.name, "first");
  assert.equal(events[1]?.name, "second"); // first writer for seq 1 won
  assert.deepEqual(await store.load("ghost"), []);
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
        (obs) => (obs.includes("Before finishing") ? "```finish\ncleaned.\n```" : "```finish\nnot-gone\n```"),
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
  assert.deepEqual(outRest, { status: "finished", summary: "cleaned.", turns: 5 });
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
    model: reactiveModel(["```bash\necho one\n```", "```bash\necho two\n```", "```finish\ndone\n```", "```finish\ndone\n```"]),
    executor,
    task: "count",
    recovery: false,
    condense: false,
  });
  // four model calls (finish is verify-nudged once) at 10/5/15 + 100 cache-read each
  assert.equal(result.usage.inputTokens, 40);
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.usage.totalTokens, 60);
  assert.equal(result.usage.cacheReadTokens, 400);
});

test("parseArgs: boolean flags, value flags, positionals", () => {
  const parsed = parseArgs(["do the thing", "--durable", "--model", "anthropic/x", "--yes", "--max-steps", "5"]);
  assert.deepEqual(parsed.positional, ["do the thing"]);
  assert.equal(parsed.flags.durable, true);
  assert.equal(parsed.flags.yes, true);
  assert.equal(parsed.flags.model, "anthropic/x");
  assert.equal(parsed.flags["max-steps"], "5");
});
