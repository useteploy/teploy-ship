import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, deliverEvent, executeRun } from "@neutron-build/workflow";

import { PLAN_EVENT, durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

/**
 * D4-b — the plan floor, pinned end to end through the RUNTIME, not the loop.
 *
 * journeys.test.ts pins that `requirePlanReview` is materialised into the
 * recorded input; durable.test.ts pins that a `plan: true` input parks. These
 * tests pin the JOIN: a run enqueued against a project that requires plan
 * review records `plan-think` and parks on `event-waiting(plan-approval)`
 * however trivial the task reads — "fix a typo" is a verdict about a diff that
 * does not exist yet, and the floor is a project requirement, never a
 * heuristic on the prompt. The negative control is the regression guard A3
 * asks for: only a scan may omit the park, and it stays a scan by INPUT
 * (`mode: "scan"` materialised at enqueue), never by a classifier verdict on
 * the request text — the scan here carries the same trivial wording.
 */

/** A model that replays fixed turns, counting calls (the durable-test pattern). */
function scriptedModel(turns: string[]): { model: ModelAdapter; callCount: () => number } {
  let index = 0;
  let calls = 0;
  return {
    callCount: () => calls,
    model: {
      provider: "scripted",
      modelId: "s1",
      async doGenerate(): Promise<AdapterGenerateResult> {
        calls++;
        const text = turns[index++] ?? "```finish\nout of script\n```";
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

/** A local bare repo the run can clone, and an executor over one workspace. */
async function repoFixture(name: string): Promise<{ repo: string; provider: ExecutorProvider }> {
  const bareDir = await mkdtemp(join(tmpdir(), `runtime-${name}-bare-`));
  const seedDir = await mkdtemp(join(tmpdir(), `runtime-${name}-seed-`));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'hello\\n' > f.txt && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );
  const work = await mkdtemp(join(tmpdir(), `runtime-${name}-work-`));
  return {
    repo: `file://${bareDir}/owner/repo.git`,
    provider: {
      async create() {
        return { handle: work };
      },
      attach(handle: string) {
        return new LocalExecutor({ root: handle });
      },
    },
  };
}

/** A file-kind runtime whose ONE project requires plan review. */
function stubRuntime(store: MemoryEventStore): ShipRuntime {
  return {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: {
      list: async () => [],
      forRepo: async () => ({ repo: "owner/repo", requirePlanReview: true, harness: "native", autoMerge: false, autoDeploy: false }),
    },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store,
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
}

const recordedInput = (events: Awaited<ReturnType<MemoryEventStore["load"]>>): Record<string, unknown> => {
  const started = events.find((e) => e.type === "run-started");
  const data = started?.data as { input?: Record<string, unknown> } | undefined;
  return data?.input ?? {};
};

test("D4-b: requirePlanReview parks a 'fix a typo' change on the plan, recording plan-think and event-waiting", async () => {
  const fixture = await repoFixture("plan-floor");
  const store = new MemoryEventStore();
  await enqueueRun(stubRuntime(store), {
    runId: "run-plan-floor",
    task: "fix a typo",
    model: "test",
    repo: fixture.repo,
    journey: "change",
    source: "manual",
    // Operator-launched (a person at a surface Ship trusts) so the run may
    // use the test's local executor; the plan floor does not depend on trust.
    trust: "operator",
  });

  const { model, callCount } = scriptedModel(["1. Fix the typo in f.txt\n2. Verify the file reads back"]);
  const parked = await executeRun({
    workflow: durableAgent({ model, executor: fixture.provider, workdir: "." }),
    runId: "run-plan-floor",
    store,
  });
  assert.equal(parked.status, "waiting");
  assert.equal(parked.eventName, PLAN_EVENT);

  const events = await store.load("run-plan-floor");
  assert.equal(recordedInput(events).plan, true, "the floor is materialised into the recorded input at enqueue");
  assert.ok(
    events.some((e) => e.type === "step-completed" && e.name === "plan-think"),
    "the plan-think step is recorded",
  );
  assert.ok(
    events.some((e) => e.type === "event-waiting" && e.name === PLAN_EVENT),
    "the run parks on event-waiting(plan-approval)",
  );
  assert.equal(callCount(), 1, "exactly the plan call happened before the human");
});

test("D4-b: a scan never parks — the same trivial wording on the same project omits the floor by input, not by verdict", async () => {
  const fixture = await repoFixture("scan-floor");
  const store = new MemoryEventStore();
  await enqueueRun(stubRuntime(store), {
    runId: "run-scan-floor",
    task: "fix a typo",
    model: "test",
    repo: fixture.repo,
    journey: "investigate",
    source: "manual",
    trust: "operator",
  });

  const input = recordedInput(await store.load("run-scan-floor"));
  assert.equal(input.mode, "scan");
  assert.notEqual(input.plan, true, "a scan asks no permission to implement work it will not do");

  const { model } = scriptedModel(["```finish\nChecked the tree; nothing to report.\n\nFINDINGS_JSON\n[]\n```"]);
  const done = await executeRun({
    workflow: durableAgent({ model, executor: fixture.provider, workdir: "." }),
    runId: "run-scan-floor",
    store,
  });
  assert.equal(done.status, "completed", "a scan runs to its findings with no human on the path");

  const events = await store.load("run-scan-floor");
  assert.ok(
    !events.some((e) => e.type === "event-waiting"),
    "no event wait exists at all, plan-approval included",
  );
  assert.ok(
    !events.some((e) => e.type === "step-completed" && e.name === "plan-think"),
    "and no plan-think step is recorded",
  );
});

// --- D4-c: thread warmth materialised at enqueue, and never inherited authority ---

import { fingerprintOf, stepFingerprint, WORKFLOW_STEPS } from "./step-fingerprint.js";
import { sandboxOverridesDigest, threadWarmStore } from "./thread-warm.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";

/** Flags for one test body, restored after (the coordination.test.ts pattern). */
async function withWarmThreadFlags<T>(body: () => Promise<T>): Promise<T> {
  const saved = { feature: process.env.SHIP_WARM_THREAD, parks: process.env.SHIP_WARM_PARKS };
  process.env.SHIP_WARM_THREAD = "1";
  process.env.SHIP_WARM_PARKS = "1";
  try {
    return await body();
  } finally {
    if (saved.feature === undefined) delete process.env.SHIP_WARM_THREAD;
    else process.env.SHIP_WARM_THREAD = saved.feature;
    if (saved.parks === undefined) delete process.env.SHIP_WARM_PARKS;
    else process.env.SHIP_WARM_PARKS = saved.parks;
  }
}

/** A runtime whose config store exists (the thread-warm record's home). */
function threadRuntime(store: MemoryEventStore): ShipRuntime {
  const runtime = stubRuntime(store) as ShipRuntime & { config?: unknown };
  runtime.config = new MemoryRuntimeConfig();
  return runtime;
}

test("D4-c: a follow-up with a valid record boots thread-warm; flag OFF gives byte-identical inputs and fingerprints", async () => {
  const fixture = await repoFixture("warm-off");
  const store = new MemoryEventStore();
  await store.append("run-parent", { v: 1, seq: 0, type: "run-started", at: "2026-10-17T00:00:00Z", data: { workflow: "coding-agent", input: { task: "first turn" } } });
  const runtime = threadRuntime(store);

  const options = {
    runId: "run-follow-off",
    task: "second turn",
    model: "test",
    repo: fixture.repo,
    pr: 7 as const,
    journey: "change" as const,
    source: "manual",
    trust: "operator" as const,
    parentRunId: "run-parent",
  };

  // Flags OFF: the recorded input carries NEITHER new key, so it is
  // byte-identical to a pre-D4-c run's, and its fingerprint is exactly what
  // the table WITHOUT the new row would compute — the feature adds nothing.
  const reportOff = await enqueueRun(runtime, options);
  const inputOff = recordedInput(await store.load("run-follow-off"));
  assert.ok(!("warmThread" in inputOff) && !("threadWarm" in inputOff), "flag off: neither key exists");
  assert.equal((reportOff as { threadWarm?: unknown }).threadWarm, undefined, "and the report says nothing either");
  assert.equal(
    stepFingerprint(inputOff as Parameters<typeof stepFingerprint>[0]),
    fingerprintOf(WORKFLOW_STEPS.filter((s) => s.key !== "step:thread-snapshot"), inputOff as Parameters<typeof stepFingerprint>[0]),
    "flag off: the fingerprint is the pre-feature fingerprint",
  );

  // Flags ON with a valid record: the SAME options now materialise both
  // halves, and only them — every other key is unchanged.
  await withWarmThreadFlags(async () => {
    const store2 = new MemoryEventStore();
    await store2.append("run-parent", { v: 1, seq: 0, type: "run-started", at: "2026-10-17T00:00:00Z", data: { workflow: "coding-agent", input: { task: "first turn" } } });
    const runtime2 = threadRuntime(store2);
    await threadWarmStore(runtime2.config as MemoryRuntimeConfig).record({
      taskRootRunId: "run-parent",
      repo: fixture.repo,
      image: "0@teploy-sbx-snap:1",
      hostIndex: 0,
      head: "b".repeat(40),
      overridesDigest: sandboxOverridesDigest(undefined),
      createdAt: new Date().toISOString(),
    });
    const report = await enqueueRun(runtime2, { ...options, runId: "run-follow-on" });
    const inputOn = recordedInput(await store2.load("run-follow-on"));
    assert.equal(inputOn.warmThread, true, "the turn side admits the thread-snapshot step");
    assert.deepEqual(inputOn.threadWarm, { image: "0@teploy-sbx-snap:1", head: "b".repeat(40) }, "the follow-up side carries the boot ref");
    assert.deepEqual(
      Object.keys(inputOn).filter((k) => !(k === "warmThread" || k === "threadWarm")).sort(),
      Object.keys(inputOff).sort(),
      "the two new keys are the ONLY difference",
    );
    assert.deepEqual((report as { threadWarm?: { used: boolean } }).threadWarm, { used: true });
  });
});

test("D4-c negative: an expired record or an egress/shape mismatch refuses threadWarm and names why", async () => {
  const fixture = await repoFixture("warm-stale");
  const base = {
    taskRootRunId: "run-parent",
    repo: fixture.repo,
    image: "0@teploy-sbx-snap:1",
    hostIndex: 0,
    head: "b".repeat(40),
    overridesDigest: sandboxOverridesDigest({ network: "allowlist" }),
  };
  const options = {
    runId: "run-follow-stale",
    task: "second turn",
    model: "test",
    repo: fixture.repo,
    pr: 7 as const,
    journey: "change" as const,
    source: "manual",
    trust: "operator" as const,
    parentRunId: "run-parent",
  };
  await withWarmThreadFlags(async () => {
    // Expired: recorded hours ago under the default 7200s TTL.
    const expired = new MemoryEventStore();
    await expired.append("run-parent", { v: 1, seq: 0, type: "run-started", at: "2026-10-17T00:00:00Z", data: { workflow: "coding-agent", input: { task: "first turn" } } });
    const runtimeExpired = threadRuntime(expired);
    await threadWarmStore(runtimeExpired.config as MemoryRuntimeConfig).record({ ...base, createdAt: "2026-10-16T00:00:00Z" });
    const report = await enqueueRun(runtimeExpired, options);
    assert.match((report as { threadWarm?: { reason?: string } }).threadWarm?.reason ?? "", /expired/);
    const input = recordedInput(await expired.load("run-follow-stale"));
    assert.ok(!("threadWarm" in input), "an expired record boots cold");

    // Shape mismatch: the project's egress tier changed between the turns,
    // so the container the snapshot booted is not the one this run needs.
    const mismatch = new MemoryEventStore();
    await mismatch.append("run-parent", { v: 1, seq: 0, type: "run-started", at: "2026-10-17T00:00:00Z", data: { workflow: "coding-agent", input: { task: "first turn" } } });
    const runtimeMismatch = threadRuntime(mismatch);
    const cfg = runtimeMismatch.config as MemoryRuntimeConfig;
    await cfg.set("thread-warm:run-parent", JSON.stringify({ ...base, createdAt: new Date().toISOString() }), "thread-warm");
    const changed = stubRuntime(mismatch) as ShipRuntime & { config?: unknown; projects?: unknown };
    changed.config = cfg;
    changed.projects = {
      list: async () => [],
      forRepo: async () => ({ repo: "owner/repo", requirePlanReview: false, harness: "native", autoMerge: false, autoDeploy: false, sandboxNetwork: "open" }),
      set: async () => {},
      remove: async () => {},
    };
    const reportMismatch = await enqueueRun(changed as ShipRuntime, options);
    assert.match((reportMismatch as { threadWarm?: { reason?: string } }).threadWarm?.reason ?? "", /sandbox shape changed/);
    assert.ok(!("threadWarm" in recordedInput(await mismatch.load("run-follow-stale"))), "a shape mismatch boots cold");
  });
});

test("D4-b/D4-c: a change follow-up carrying threadWarm still parks for its OWN plan when requirePlanReview is set", async () => {
  const fixture = await repoFixture("warm-plan");
  const store = new MemoryEventStore();
  await store.append("run-parent", { v: 1, seq: 0, type: "run-started", at: "2026-10-17T00:00:00Z", data: { workflow: "coding-agent", input: { task: "first turn" } } });
  // The parent's plan was approved — recorded on ITS log, as an delivered
  // decision. Warmth must not carry that anywhere.
  await deliverEvent(store, "run-parent", PLAN_EVENT, { approved: true });

  const runtime = threadRuntime(store);
  await withWarmThreadFlags(async () => {
    await threadWarmStore(runtime.config as MemoryRuntimeConfig).record({
      taskRootRunId: "run-parent",
      repo: fixture.repo,
      image: "0@teploy-sbx-snap:1",
      hostIndex: 0,
      head: "b".repeat(40),
      overridesDigest: sandboxOverridesDigest(undefined),
      createdAt: new Date().toISOString(),
    });
    const report = await enqueueRun(runtime, {
      runId: "run-warm-plan",
      task: "fix a typo",
      model: "test",
      repo: fixture.repo,
      journey: "change",
      source: "manual",
      trust: "operator",
      parentRunId: "run-parent",
    });
    assert.deepEqual((report as { threadWarm?: { used: boolean } }).threadWarm, { used: true }, "the follow-up is warm");
    const input = recordedInput(await store.load("run-warm-plan"));
    assert.equal(input.plan, true, "and it still asks for its own plan review at enqueue");

    const { model } = scriptedModel(["1. Find and fix the typo\n2. Verify"]);
    const parked = await executeRun({
      workflow: durableAgent({ model, executor: fixture.provider, workdir: "." }),
      runId: "run-warm-plan",
      store,
    });
    assert.equal(parked.status, "waiting");
    assert.equal(parked.eventName, PLAN_EVENT, "the warm follow-up parks on its own approval, the parent's approval inherited nothing");
  });
});
