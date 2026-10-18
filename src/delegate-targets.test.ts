import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { parseAction } from "./actions.js";
import { delegationKey, parseDelegationRecord } from "./delegate.js";
import type { DelegateControl, DelegateSpawnRequest } from "./delegate.js";
import { effectiveDelegateTargets, normalizeDelegateTargetIds, parseDelegateTargets } from "./delegate-targets.js";
import { durableAgent, effectiveRunCap } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { checkCandidate } from "./model-routing.js";
import type { Candidate, RouteTask, RoutingPolicy } from "./model-routing.js";
import { MemorySegmentSink } from "./model-routing-wire.js";
import { normalizeProject } from "./projects.js";
import { systemPrompt } from "./prompt.js";
import { delegateControlFromRuntime, enqueueRun, fileRuntime } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

// DT2: delegate targets. A named target is a new destination for the task's
// data, so every targeted spawn runs the policy's data-class gate, whatever
// the routing mode; each refusal is named.

// ---------------------------------------------------------------- parsing

test("SHIP_DELEGATE_TARGETS parses as JSON (array or object) or as a simple list", () => {
  assert.deepEqual(parseDelegateTargets(undefined), { ok: true, targets: [] });
  assert.deepEqual(parseDelegateTargets("  "), { ok: true, targets: [] });
  const want = [
    { id: "glm", harness: "native", model: "zai/glm-5.3" },
    { id: "cc", harness: "claude-code", model: "glm-5.3" },
  ];
  assert.deepEqual(parseDelegateTargets(JSON.stringify(want)), { ok: true, targets: want });
  assert.deepEqual(parseDelegateTargets(JSON.stringify({ glm: { harness: "native", model: "zai/glm-5.3" }, cc: { harness: "claude-code", model: "glm-5.3" } })), { ok: true, targets: want });
  assert.deepEqual(parseDelegateTargets("glm=native:zai/glm-5.3, cc=claude-code:glm-5.3"), { ok: true, targets: want });
  // A model id may itself contain a colon: only the first one after = splits.
  assert.deepEqual(parseDelegateTargets("q=native:ollama/qwen:7b"), { ok: true, targets: [{ id: "q", harness: "native", model: "ollama/qwen:7b" }] });
});

test("a malformed SHIP_DELEGATE_TARGETS refuses the whole value, never half of it", () => {
  for (const raw of [
    "[not json",
    '[{"id":"Bad Id","harness":"native","model":"m"}]',
    '[{"id":"a","harness":"warp-drive","model":"m"}]',
    '[{"id":"a","harness":"native","model":""}]',
    '[{"id":"a","harness":"native","model":"m"},{"id":"a","harness":"native","model":"n"}]',
    "glm=native",
    "glm:native:m",
    '"a string"',
  ]) {
    const parsed = parseDelegateTargets(raw);
    assert.equal(parsed.ok, false, raw);
  }
});

test("the effective set is deployment ∩ project; a project list can only narrow", () => {
  const parsed = parseDelegateTargets("a=native:m1,b=native:m2");
  assert.ok(parsed.ok);
  const deployment = parsed.targets;
  assert.deepEqual(effectiveDelegateTargets(deployment, undefined).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(effectiveDelegateTargets(deployment, ["b", "zzz"]).map((t) => t.id), ["b"], "an id the deployment does not define allows nothing");
  assert.deepEqual(effectiveDelegateTargets(deployment, []), [], "an empty project list means none");
});

test("a project's delegateTargets is validated at save: [] is kept, a malformed id refuses", () => {
  const base = { repo: "https://forge.example/team/repo.git", autoMerge: false, autoDeploy: false };
  assert.deepEqual(normalizeProject({ ...base, delegateTargets: [" glm ", "glm", "cc"] }).delegateTargets, ["glm", "cc"]);
  assert.deepEqual(normalizeProject({ ...base, delegateTargets: [] }).delegateTargets, []);
  assert.equal(normalizeProject(base).delegateTargets, undefined);
  assert.throws(() => normalizeProject({ ...base, delegateTargets: ["Not OK"] }), /invalid target id/);
  assert.deepEqual(normalizeDelegateTargetIds(undefined), undefined);
});

test("the fence takes target=<id>, and refuses an empty or malformed one", () => {
  const ON = { delegate: true };
  assert.deepEqual(parseAction("```delegate target=glm path=src/foo\nResearch.\n```", ON), { kind: "delegate", task: "Research.", path: "src/foo", target: "glm" });
  assert.deepEqual(parseAction("```delegate path=src/foo target=glm\nResearch.\n```", ON), { kind: "delegate", task: "Research.", path: "src/foo", target: "glm" });
  const empty = parseAction("```delegate target=\nx\n```", ON);
  assert.ok(empty.kind === "invalid" && empty.message.includes("target= is empty"));
  const free = parseAction("```delegate target=anthropic/claude-opus\nx\n```", ON);
  assert.ok(free.kind === "invalid" && free.message.includes("must be a target id"), "a free-form model string is not a target");
});

test("the prompt lists the offered targets, and only when some were offered", () => {
  const plain = systemPrompt({ workdir: "/work", task: "t", delegate: true });
  assert.equal(systemPrompt({ workdir: "/work", task: "t", delegate: true, delegateTargets: [] }), plain, "none offered: the section's exact bytes");
  const listed = systemPrompt({ workdir: "/work", task: "t", delegate: true, delegateTargets: [{ id: "glm", harness: "native", model: "zai/glm-5.3" }] });
  assert.ok(listed.includes("- glm: zai/glm-5.3 on the native harness"));
  assert.ok(listed.includes("target=<id>"));
  assert.ok(!systemPrompt({ workdir: "/work", task: "t", delegateTargets: [{ id: "glm", harness: "native", model: "m" }] }).includes("- glm:"), "no delegation, no list");
});

// ---------------------------------------------------------------- checkCandidate

const cand = (model: string, host: string, retention: Candidate["retention"] = "none"): Candidate => ({
  model,
  effort: "high",
  capabilities: ["tools"],
  dataDestination: { host, class: "hosted" },
  retention,
  maxContext: 200_000,
});
const routeTask = (over: Partial<RouteTask> = {}): RouteTask => ({
  needs: ["tools"],
  contextTokens: 1000,
  maxOutputTokens: 1000,
  dataClass: "private",
  allowedDestinations: ["api.z.ai"],
  reservedBudget: Number.POSITIVE_INFINITY,
  uncertainSideEffects: false,
  ...over,
});

test("checkCandidate judges one named model wherever the policy lists it", () => {
  const policy: RoutingPolicy = { version: "p1", roles: { worker: [cand("zai/glm-5.3", "api.z.ai")], cheap: [cand("other/m", "api.other.example")] }, fallbackOn: [] };
  const ok = checkCandidate(policy, "zai/glm-5.3", routeTask());
  assert.ok(ok.ok && ok.segment.model === "zai/glm-5.3" && ok.segment.policyVersion === "p1" && ok.segment.destination.host === "api.z.ai");
  const missing = checkCandidate(policy, "nope/m", routeTask());
  assert.ok(!missing.ok && missing.code === "not-in-policy");
  const far = checkCandidate(policy, "other/m", routeTask());
  assert.ok(!far.ok && far.code === "destination-not-allowed");
  // Two entries for one model that disagree: the stricter answers.
  const split: RoutingPolicy = { version: "p2", roles: { worker: [cand("zai/glm-5.3", "api.z.ai")], other: [cand("zai/glm-5.3", "api.z.ai", "long")] }, fallbackOn: [] };
  const strict = checkCandidate(split, "zai/glm-5.3", routeTask());
  assert.ok(!strict.ok && strict.code === "retention-exceeds");
  const budget = checkCandidate(policy, "zai/glm-5.3", routeTask({ reservedBudget: 0 }));
  assert.ok(!budget.ok && budget.code === "budget-insufficient");
});

// ---------------------------------------------------------------- the spawn gate

const POLICY = {
  schemaVersion: 1,
  version: "test-2026-10-17",
  roles: {
    worker: [
      cand("zai/glm-5.3", "api.z.ai"),
      cand("glm-5.3", "api.z.ai"),
      cand("vendor/unknown-retention", "api.vendor.example", "unknown"),
      cand("far/model", "api.far.example"),
    ],
  },
};

const TARGETS = [
  { id: "glm", harness: "native", model: "zai/glm-5.3" },
  { id: "unk", harness: "native", model: "vendor/unknown-retention" },
  { id: "far", harness: "native", model: "far/model" },
  { id: "ghost", harness: "native", model: "ghost/not-in-policy" },
  { id: "cc", harness: "claude-code", model: "glm-5.3" },
];

const REPO = "https://forge.example/team/repo.git";

async function setup(extraEnv: Record<string, string | undefined> = {}, opts: { policy?: boolean } = {}): Promise<{
  runtime: ShipRuntime;
  control: DelegateControl;
  sink: MemorySegmentSink;
  env: NodeJS.ProcessEnv;
  restore: () => void;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ship-dt2-"));
  const policyPath = join(dir, "routing-policy.json");
  await writeFile(policyPath, JSON.stringify(POLICY));
  const saved = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  const runtime = fileRuntime();
  const env: NodeJS.ProcessEnv = {
    SHIP_DELEGATE_TARGETS: JSON.stringify(TARGETS),
    SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai,api.vendor.example",
    ...(opts.policy === false ? {} : { SHIP_MODEL_ROUTING_POLICY: policyPath }),
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const sink = new MemorySegmentSink();
  return {
    runtime,
    control: delegateControlFromRuntime(runtime, { segments: sink, env }),
    sink,
    env,
    restore: () => {
      if (saved === undefined) delete process.env.TEPLOY_SHIP_STATE;
      else process.env.TEPLOY_SHIP_STATE = saved;
    },
  };
}

async function parentWithOffer(runtime: ShipRuntime, runId = "run-parent", offer: unknown = TARGETS): Promise<void> {
  const started: WorkflowEvent = {
    v: 1,
    seq: 0,
    type: "run-started",
    at: new Date().toISOString(),
    data: { workflow: "coding-agent", taskRootRunId: runId, input: { task: "parent", repo: REPO, trust: "external", delegate: true, delegateTargets: offer } },
  };
  await runtime.store.append(runId, started);
  await runtime.saveMeta({ runId, task: "parent", model: "parent-model", status: "running", source: "cli", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

const inputOf = async (runtime: ShipRuntime, runId: string): Promise<Record<string, unknown>> => {
  const started = (await runtime.store.load(runId)).find((e) => e.type === "run-started");
  return ((started?.data as { input?: Record<string, unknown> })?.input ?? {}) as Record<string, unknown>;
};

/** A refusal must leave nothing behind: no ledger claim, no child run, no segment. */
async function assertNothingSpawned(runtime: ShipRuntime, sink: MemorySegmentSink): Promise<void> {
  const record = parseDelegationRecord(await runtime.config.get(delegationKey("run-parent")), "run-parent");
  assert.equal(record?.entries.length ?? 0, 0, "no ledger claim");
  assert.equal(sink.records.length, 0, "no segment");
}

const refusal = (outcome: { ok: boolean; reason?: string }): string => {
  assert.equal(outcome.ok, false, "refused");
  return outcome.reason ?? "";
};

test("an allowed target spawns a child on its model, recorded with the decision and a routing segment", async () => {
  const { runtime, control, sink, restore } = await setup();
  try {
    await parentWithOffer(runtime);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 1, task: "Research.", target: "glm" });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.reason);
    const childId = (spawned as { childRunId: string }).childRunId;
    const input = await inputOf(runtime, childId);
    assert.equal(input.model, "zai/glm-5.3", "DT1: the child executes on the target's model");
    assert.deepEqual(input.harness, { id: "native", version: "1" });
    assert.equal(input.mode, "scan", "still a read-only child");
    const recorded = input.delegateTarget as Record<string, unknown>;
    assert.equal(recorded.id, "glm");
    assert.equal(recorded.policyVersion, "test-2026-10-17");
    assert.match(String(recorded.policyDigest), /^[a-f0-9]{64}$/);
    assert.deepEqual(recorded.destination, { host: "api.z.ai", class: "hosted" });
    assert.equal((await runtime.loadMeta(childId))?.model, "zai/glm-5.3", "priced on the target's model");
    assert.equal(sink.records.length, 1);
    const segment = sink.records[0]!;
    assert.equal(segment.kind, "selection");
    assert.equal(segment.enforced, true);
    assert.equal(segment.scope, childId);
    assert.equal(segment.actualModel, "zai/glm-5.3");
    assert.equal(segment.mode, "off", "the gate ran with routing off");
    assert.equal(segment.segment?.destination.host, "api.z.ai");
  } finally {
    restore();
  }
});

test("NEG: a target this run was not offered, or the project narrowed away, or the deployment dropped, is refused by name", async () => {
  const { runtime, control, sink, restore } = await setup();
  try {
    await parentWithOffer(runtime, "run-parent", [TARGETS[0]]);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "unk" })), /^delegation refused \(target-not-allowed\): target unk is not allowed for this project/);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "nope" })), /target-not-allowed/);
    await assertNothingSpawned(runtime, sink);
    // The project narrows after the parent started: still offered, no longer allowed.
    await runtime.projects.set(normalizeProject({ repo: REPO, autoMerge: false, autoDeploy: false, delegateTargets: ["cc"] }));
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /target-not-allowed/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
  const dropped = await setup({ SHIP_DELEGATE_TARGETS: "unk=native:vendor/unknown-retention" });
  try {
    await parentWithOffer(dropped.runtime);
    assert.match(refusal(await dropped.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /target-not-allowed/);
    await assertNothingSpawned(dropped.runtime, dropped.sink);
  } finally {
    dropped.restore();
  }
  const repointed = await setup({ SHIP_DELEGATE_TARGETS: "glm=native:far/model" });
  try {
    await parentWithOffer(repointed.runtime);
    assert.match(refusal(await repointed.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /target-not-allowed\): target glm has changed since this run started/);
  } finally {
    repointed.restore();
  }
});

test("NEG: a model whose policy destination is not allowed is refused with destination-not-allowed", async () => {
  const { runtime, control, sink, restore } = await setup();
  try {
    await parentWithOffer(runtime);
    const reason = refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "far" }));
    assert.match(reason, /^delegation refused \(destination-not-allowed\): target far \(far\/model\): api\.far\.example \(hosted\) is not a permitted destination for private data/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
});

test("NEG: unknown retention for private data is refused with retention-exceeds", async () => {
  const { runtime, control, sink, restore } = await setup();
  try {
    await parentWithOffer(runtime);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "unk" })), /^delegation refused \(retention-exceeds\): .*retention unknown exceeds none/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
});

test("NEG: with no policy file loaded every target is refused, whatever SHIP_MODEL_ROUTING says", async () => {
  for (const mode of [undefined, "off", "shadow", "on"]) {
    const { runtime, control, sink, restore } = await setup({ SHIP_MODEL_ROUTING: mode }, { policy: false });
    try {
      await parentWithOffer(runtime);
      assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /^delegation refused \(no-routing-policy\)/, String(mode));
      await assertNothingSpawned(runtime, sink);
    } finally {
      restore();
    }
  }
  const broken = await setup({ SHIP_MODEL_ROUTING_POLICY: "/nonexistent/routing-policy.json" });
  try {
    await parentWithOffer(broken.runtime);
    assert.match(refusal(await broken.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /routing-policy-invalid/);
  } finally {
    broken.restore();
  }
});

test("NEG: a model the policy does not list, and an unparseable allowlist, are refused by name", async () => {
  const { runtime, control, sink, restore } = await setup();
  try {
    await parentWithOffer(runtime);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "ghost" })), /\(not-in-policy\)/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
  const bad = await setup({ SHIP_DELEGATE_TARGETS: "[oops" });
  try {
    await parentWithOffer(bad.runtime);
    assert.match(refusal(await bad.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "glm" })), /\(targets-invalid\)/);
  } finally {
    bad.restore();
  }
});

const CC_ENV = {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: "test-token-not-real",
  SHIP_HARNESS_MODEL_CLAUDE_CODE: "glm-5.3",
};

test("an external-harness target spawns when its provider host is the policy's destination", async () => {
  const { runtime, control, sink, restore } = await setup(CC_ENV);
  try {
    await parentWithOffer(runtime);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "cc" });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.reason);
    const input = await inputOf(runtime, (spawned as { childRunId: string }).childRunId);
    assert.equal((input.harness as { id: string }).id, "claude-code");
    assert.equal((input.delegateTarget as { destination: { host: string } }).destination.host, "api.z.ai");
    assert.equal(sink.records.length, 1);
    assert.ok(!JSON.stringify(input).includes("test-token-not-real"), "no credential in the recorded input");
    assert.ok(!JSON.stringify(sink.records).includes("test-token-not-real"), "no credential in the segment");
  } finally {
    restore();
  }
});

test("NEG: an external-harness target whose provider host is not the policy's destination is refused", async () => {
  const { runtime, control, sink, restore } = await setup({ ...CC_ENV, ANTHROPIC_BASE_URL: "https://gateway.elsewhere.example/v1" });
  try {
    await parentWithOffer(runtime);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "cc" })), /^delegation refused \(harness-host-mismatch\): .*gateway\.elsewhere\.example.*declares api\.z\.ai/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
  // Nothing derivable (no forwarded credential or base URL): refused, never assumed.
  const blind = await setup({ SHIP_HARNESS_MODEL_CLAUDE_CODE: "glm-5.3" });
  try {
    await parentWithOffer(blind.runtime);
    assert.match(refusal(await blind.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "cc" })), /harness-host-mismatch.*cannot derive/);
  } finally {
    blind.restore();
  }
  // The harness is configured for another model than the target names.
  const other = await setup({ ...CC_ENV, SHIP_HARNESS_MODEL_CLAUDE_CODE: "claude-sonnet" });
  try {
    await parentWithOffer(other.runtime);
    assert.match(refusal(await other.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t", target: "cc" })), /\(harness-model-mismatch\)/);
  } finally {
    other.restore();
  }
});

test("a target-less delegation is unchanged: no gate, no policy, the parent's model, no new input fields", async () => {
  const { runtime, control, sink, restore } = await setup({}, { policy: false });
  try {
    await parentWithOffer(runtime);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 0, task: "t" });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.reason);
    const childId = (spawned as { childRunId: string }).childRunId;
    const input = await inputOf(runtime, childId);
    assert.ok(!("model" in input) && !("delegateTarget" in input) && !("delegateTargets" in input));
    assert.equal((await runtime.loadMeta(childId))?.model, "parent-model");
    assert.equal(sink.records.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- the offer at enqueue

test("enqueue offers deployment ∩ project targets only when delegation is on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-dt2-enq-"));
  const keys = ["TEPLOY_SHIP_STATE", "SHIP_DELEGATE", "SHIP_DELEGATE_TARGETS"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.TEPLOY_SHIP_STATE = dir;
  process.env.SHIP_DELEGATE_TARGETS = "glm=native:zai/glm-5.3,cc=claude-code:glm-5.3";
  try {
    const runtime = fileRuntime();
    await enqueueRun(runtime, { runId: "run-off", task: "t", model: "m" });
    assert.ok(!("delegateTargets" in (await inputOf(runtime, "run-off"))), "SHIP_DELEGATE off: no offer");
    process.env.SHIP_DELEGATE = "1";
    await enqueueRun(runtime, { runId: "run-on", task: "t", model: "m" });
    assert.deepEqual((await inputOf(runtime, "run-on")).delegateTargets, [
      { id: "glm", harness: "native", model: "zai/glm-5.3" },
      { id: "cc", harness: "claude-code", model: "glm-5.3" },
    ]);
    await runtime.projects.set(normalizeProject({ repo: REPO, autoMerge: false, autoDeploy: false, delegateTargets: ["cc"] }));
    await enqueueRun(runtime, { runId: "run-narrow", task: "t", model: "m", repo: REPO, trust: "operator" });
    assert.deepEqual((await inputOf(runtime, "run-narrow")).delegateTargets, [{ id: "cc", harness: "claude-code", model: "glm-5.3" }]);
    await runtime.projects.set(normalizeProject({ repo: REPO, autoMerge: false, autoDeploy: false, delegateTargets: [] }));
    await enqueueRun(runtime, { runId: "run-none", task: "t", model: "m", repo: REPO, trust: "operator" });
    assert.ok(!("delegateTargets" in (await inputOf(runtime, "run-none"))), "an empty project list offers nothing");
    process.env.SHIP_DELEGATE_TARGETS = "[broken";
    await enqueueRun(runtime, { runId: "run-broken", task: "t", model: "m" });
    assert.ok(!("delegateTargets" in (await inputOf(runtime, "run-broken"))), "an unparseable allowlist offers nothing");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------------------------------------------------------- the loop

function scripted(turns: string[]): ModelAdapter {
  let i = 0;
  return {
    provider: "scripted",
    modelId: "s",
    async doGenerate(): Promise<AdapterGenerateResult> {
      const text = turns[i++] ?? "```finish\nout of script\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

test("the loop hands the fence's target to the spawn, and a refusal reaches the model as an observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dt2-loop-"));
  const executor = new LocalExecutor({ root });
  const provider: ExecutorProvider = { async create() { return { handle: `local:${root}` }; }, attach() { return executor; } };
  const requests: DelegateSpawnRequest[] = [];
  const control: DelegateControl = {
    async spawn(request) {
      requests.push(request);
      return { ok: false, reason: "delegation refused (destination-not-allowed): target far ..." };
    },
    async outcome() {
      return null;
    },
  };
  const outcome = await executeRun({
    workflow: durableAgent({ model: scripted(["```delegate target=far\nResearch.\n```", "```bash\necho ok\n```", "```finish\ndone\n```", "```bash\necho proof\n```", "```finish\ndone\n```"]), executor: provider, delegate: control }),
    runId: "run-dt2-loop",
    store: new MemoryEventStore(),
    input: { task: "t", delegate: true, delegateTargets: [{ id: "far", harness: "native", model: "far/model" }] },
  });
  assert.equal(outcome.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.target, "far");
});

// ---------------------------------------------------------------- DT3: the child's cost cap

test("effectiveRunCap narrows and never widens", () => {
  assert.equal(effectiveRunCap(5, 2), 2);
  assert.equal(effectiveRunCap(5, 10), 5, "an input cap above config never widens");
  assert.equal(effectiveRunCap(5, undefined), 5);
  for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(effectiveRunCap(5, junk), 5, String(junk));
  assert.equal(effectiveRunCap(0, 3), 3, "no configured ceiling: the recorded cap is still a bound");
  assert.equal(effectiveRunCap(0, undefined), 0);
});

async function appendParentSteps(runtime: ShipRuntime, runId: string, usages: Array<Record<string, number>>): Promise<void> {
  let seq = (await runtime.store.load(runId)).length;
  for (const [i, usage] of usages.entries()) {
    await runtime.store.append(runId, { v: 1, seq: seq++, type: "step-completed", at: new Date().toISOString(), name: `turn-${i}-think`, data: { result: { text: "x", usage } } } as WorkflowEvent);
  }
}

const PRICING = JSON.stringify({ "parent-model": { inputPer1M: 1, outputPer1M: 1 }, "zai/glm-5.3": { inputPer1M: 10, outputPer1M: 10 } });

test("a child's cap is min(per-run cap, parent remaining), recorded on its input", async () => {
  const { runtime, control, restore } = await setup({ SHIP_MAX_RUN_COST_USD: "1", SHIP_MODEL_PRICING: PRICING });
  try {
    await parentWithOffer(runtime);
    await appendParentSteps(runtime, "run-parent", [{ inputTokens: 300_000, outputTokens: 0, totalTokens: 300_000 }, { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 }]);
    const spawned = await control.spawn({ parentRunId: "run-parent", turn: 2, task: "t" });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.reason);
    const input = await inputOf(runtime, (spawned as { childRunId: string }).childRunId);
    assert.equal(input.maxRunCostUSD, 0.6, "the parent spent $0.40 of $1.00");
  } finally {
    restore();
  }
  // A fresh parent: the child gets the full per-run cap, never more.
  const fresh = await setup({ SHIP_MAX_RUN_COST_USD: "1", SHIP_MODEL_PRICING: PRICING });
  try {
    await parentWithOffer(fresh.runtime);
    const spawned = await fresh.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t" });
    assert.ok(spawned.ok);
    assert.equal((await inputOf(fresh.runtime, (spawned as { childRunId: string }).childRunId)).maxRunCostUSD, 1);
  } finally {
    fresh.restore();
  }
  // No per-run cap configured: nothing to share, nothing recorded.
  const uncapped = await setup({ SHIP_MODEL_PRICING: PRICING });
  try {
    await parentWithOffer(uncapped.runtime);
    const spawned = await uncapped.control.spawn({ parentRunId: "run-parent", turn: 0, task: "t" });
    assert.ok(spawned.ok);
    assert.ok(!("maxRunCostUSD" in (await inputOf(uncapped.runtime, (spawned as { childRunId: string }).childRunId))));
  } finally {
    uncapped.restore();
  }
});

test("NEG: a parent with nothing left gets budget-insufficient, and nothing is spawned", async () => {
  const { runtime, control, sink, restore } = await setup({ SHIP_MAX_RUN_COST_USD: "1", SHIP_MODEL_PRICING: PRICING });
  try {
    await parentWithOffer(runtime);
    await appendParentSteps(runtime, "run-parent", [{ inputTokens: 1_200_000, outputTokens: 0, totalTokens: 1_200_000 }]);
    for (const target of [undefined, "glm"]) {
      const reason = refusal(await control.spawn({ parentRunId: "run-parent", turn: 1, task: "t", ...(target !== undefined ? { target } : {}) }));
      assert.match(reason, /^delegation refused \(budget-insufficient\): this run has spent ~\$1\.20 of its \$1\.00 per-run cost ceiling/);
    }
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
});

test("NEG: a target the child's share cannot afford is refused by the policy's budget check", async () => {
  const { runtime, control, sink, restore } = await setup({ SHIP_MAX_RUN_COST_USD: "1", SHIP_MODEL_PRICING: PRICING });
  try {
    await parentWithOffer(runtime);
    // $0.999 spent: the child's share is $0.001, and the policy reserves
    // 40k tokens on zai/glm-5.3 at $10/1M = $0.40 for the target.
    await appendParentSteps(runtime, "run-parent", [{ inputTokens: 999_000, outputTokens: 0, totalTokens: 999_000 }]);
    assert.match(refusal(await control.spawn({ parentRunId: "run-parent", turn: 1, task: "t", target: "glm" })), /^delegation refused \(budget-insufficient\): target glm \(zai\/glm-5\.3\): needs \$0\.4000/);
    await assertNothingSpawned(runtime, sink);
  } finally {
    restore();
  }
});

test("the loop runs under the narrowed cap: a recorded cap above config never widens, one below narrows", async () => {
  const root = await mkdtemp(join(tmpdir(), "dt3-loop-"));
  const executor = new LocalExecutor({ root });
  const provider: ExecutorProvider = { async create() { return { handle: `local:${root}` }; }, attach() { return executor; } };
  const big = (turns: string[]): ModelAdapter => {
    let i = 0;
    return {
      provider: "scripted",
      modelId: "unknown-vendor/pricey",
      async doGenerate(): Promise<AdapterGenerateResult> {
        const text = turns[i++] ?? "```finish\nout of script\n```";
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    };
  };
  const SCRIPT = ["```bash\necho hi\n```", "```finish\ndone\n```", "```bash\necho proof\n```", "```finish\ndone, proven\n```"];
  const statusOf = (o: unknown): string | undefined => (o as { output?: { status?: string } }).output?.status;
  // Config caps at one cent; the input's $1000 does not lift it.
  const widened = await executeRun({
    workflow: durableAgent({ model: big(SCRIPT), modelId: "unknown-vendor/pricey", executor: provider, maxRunCostUSD: 0.01 }),
    runId: "run-dt3-wide",
    store: new MemoryEventStore(),
    input: { task: "t", maxRunCostUSD: 1000 },
  });
  assert.equal(statusOf(widened), "budget-exhausted");
  // Config allows $1000; the input's one cent binds.
  const narrowed = await executeRun({
    workflow: durableAgent({ model: big(SCRIPT), modelId: "unknown-vendor/pricey", executor: provider, maxRunCostUSD: 1000 }),
    runId: "run-dt3-narrow",
    store: new MemoryEventStore(),
    input: { task: "t", maxRunCostUSD: 0.01 },
  });
  assert.equal(statusOf(narrowed), "budget-exhausted");
  const free = await executeRun({
    workflow: durableAgent({ model: big(SCRIPT), modelId: "unknown-vendor/pricey", executor: provider, maxRunCostUSD: 1000 }),
    runId: "run-dt3-free",
    store: new MemoryEventStore(),
    input: { task: "t" },
  });
  assert.equal(statusOf(free), "finished");
});
