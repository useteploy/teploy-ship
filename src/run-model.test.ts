import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent, runModelConfig } from "./durable.js";
import type { DurableAgentConfig, DurableAgentInput, ExecutorProvider } from "./durable.js";
import { enqueueRun, fileRuntime } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { stepFingerprint } from "./step-fingerprint.js";

// DT1: per-run model for the native harness. A run whose input names a model
// executes and is priced on it; a run without one takes the exact path it
// always took.

function countingModel(id: string, turns: string[], usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }): { model: ModelAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      provider: "scripted",
      modelId: id,
      async doGenerate(): Promise<AdapterGenerateResult> {
        const text = turns[calls++] ?? "```finish\nout of script\n```";
        return { content: [{ type: "text", text }], finishReason: "stop", usage, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

async function localProvider(): Promise<ExecutorProvider> {
  const root = await mkdtemp(join(tmpdir(), "run-model-"));
  const executor = new LocalExecutor({ root });
  return {
    async create() {
      return { handle: `local:${root}` };
    },
    attach() {
      return executor;
    },
  };
}

const SCRIPT = ["```bash\necho hi\n```", "```finish\ndone\n```", "```bash\necho proof\n```", "```finish\ndone, proven\n```"];

test("a run with input.model executes on the adapter modelFor builds for it, never on the worker default", async () => {
  const main = countingModel("worker-default", SCRIPT);
  const target = countingModel("zai/glm-5.3", SCRIPT);
  const built: string[] = [];
  const wf = durableAgent({
    model: main.model,
    modelId: "worker-default",
    modelFor: (id) => {
      built.push(id);
      return target.model;
    },
    executor: await localProvider(),
  });
  const outcome = await executeRun({ workflow: wf, runId: "run-model-on", store: new MemoryEventStore(), input: { task: "t", model: "zai/glm-5.3" } });
  assert.equal(outcome.status, "completed");
  assert.deepEqual(built, ["zai/glm-5.3"], "resolved once, from the recorded input");
  assert.ok(target.calls() > 0, "the named model took the turns");
  assert.equal(main.calls(), 0, "the worker default never ran");
});

test("a run without input.model is untouched: the worker default runs and the config is the same object", async () => {
  const main = countingModel("worker-default", SCRIPT);
  let built = 0;
  const config: DurableAgentConfig = {
    model: main.model,
    modelId: "worker-default",
    modelFor: () => {
      built++;
      return countingModel("other", SCRIPT).model;
    },
    executor: await localProvider(),
  };
  assert.equal(runModelConfig(config, {}), config, "identity: no copy, no adapter built");
  assert.equal(runModelConfig(config, { model: "worker-default" }), config, "naming the worker's own model changes nothing");
  const outcome = await executeRun({ workflow: durableAgent(config), runId: "run-model-off", store: new MemoryEventStore(), input: { task: "t" } });
  assert.equal(outcome.status, "completed");
  assert.equal(built, 0);
  assert.ok(main.calls() > 0);
});

test("the cost ceiling prices on input.model, not on the worker's model", async () => {
  // The worker's model is local (free); the run's model is unknown and priced
  // at the highest known rate. One turn of a million tokens on it crosses a
  // one-cent ceiling; the same turn on the local model never would.
  const big = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
  const config = (model: ModelAdapter, runModel: ModelAdapter, executor: ExecutorProvider): DurableAgentConfig => ({
    model,
    modelId: "ollama/local-free",
    modelFor: () => runModel,
    executor,
    maxRunCostUSD: 0.01,
  });
  const priced = await executeRun({
    workflow: durableAgent(config(countingModel("ollama/local-free", SCRIPT, big).model, countingModel("unknown-vendor/pricey", SCRIPT, big).model, await localProvider())),
    runId: "run-model-capped",
    store: new MemoryEventStore(),
    input: { task: "t", model: "unknown-vendor/pricey" },
  });
  assert.equal(priced.status, "completed");
  assert.equal((priced as { output?: { status?: string } }).output?.status, "budget-exhausted");
  const free = await executeRun({
    workflow: durableAgent(config(countingModel("ollama/local-free", SCRIPT, big).model, countingModel("unused", SCRIPT, big).model, await localProvider())),
    runId: "run-model-free",
    store: new MemoryEventStore(),
    input: { task: "t" },
  });
  assert.equal((free as { output?: { status?: string } }).output?.status, "finished");
});

test("a run naming a model on a worker without modelFor fails before a sandbox is allocated", async () => {
  const main = countingModel("worker-default", SCRIPT);
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: durableAgent({ model: main.model, modelId: "worker-default", executor: await localProvider() }),
    runId: "run-model-unwired",
    store,
    input: { task: "t", model: "zai/glm-5.3" },
  });
  assert.equal(outcome.status, "failed");
  assert.match(JSON.stringify(outcome), /cannot build per-run models/);
  assert.equal(main.calls(), 0, "never executed on the default model");
  const steps = (await store.load("run-model-unwired")).filter((e) => e.type === "step-completed");
  assert.equal(steps.length, 0, "no sandbox step");
});

async function fileRuntimeIn(): Promise<{ runtime: ShipRuntime; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "ship-run-model-"));
  const saved = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  return {
    runtime: fileRuntime(),
    restore: () => {
      if (saved === undefined) delete process.env.TEPLOY_SHIP_STATE;
      else process.env.TEPLOY_SHIP_STATE = saved;
    },
  };
}

const startedOf = async (runtime: ShipRuntime, runId: string): Promise<{ input: DurableAgentInput; stepFingerprint?: string }> => {
  const started = (await runtime.store.load(runId)).find((e) => e.type === "run-started");
  return started?.data as { input: DurableAgentInput; stepFingerprint?: string };
};

test("enqueue materialises input.model only when runModel is set, and prices the meta on it", async () => {
  const { runtime, restore } = await fileRuntimeIn();
  try {
    await enqueueRun(runtime, { runId: "run-plain", task: "t", model: "worker-default" });
    await enqueueRun(runtime, { runId: "run-named", task: "t", model: "worker-default", runModel: "zai/glm-5.3" });
    const plain = await startedOf(runtime, "run-plain");
    const named = await startedOf(runtime, "run-named");
    assert.ok(!("model" in plain.input), "absent unless named: the input carries no model key at all");
    assert.equal((await runtime.loadMeta("run-plain"))?.model, "worker-default");
    assert.equal(named.input.model, "zai/glm-5.3");
    assert.equal((await runtime.loadMeta("run-named"))?.model, "zai/glm-5.3", "the worker settles spend on the meta's model");
    // Fingerprint pinned: the field admits no step, so the recorded print is
    // the one an input without it has, and the plain run's print is the one
    // its own input gives.
    assert.equal(named.stepFingerprint, plain.stepFingerprint);
    assert.equal(plain.stepFingerprint, stepFingerprint(plain.input));
    const { model: _model, ...withoutModel } = named.input;
    assert.deepEqual(withoutModel, plain.input, "the named run differs from the plain one by the model field alone");
    await assert.rejects(enqueueRun(runtime, { runId: "run-blank", task: "t", model: "m", runModel: " " }), /runModel must name a model/);
  } finally {
    restore();
  }
});
