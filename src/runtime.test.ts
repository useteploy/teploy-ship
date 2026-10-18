import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

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
