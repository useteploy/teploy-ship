import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import {
  createCoordination,
  launchNext,
  listCoordinations,
  loadCoordination,
  observeCoordination,
  retryCoordinationChild,
  coordinationKey,
} from "./coordination.js";
import type { CoordinationRecord } from "./coordination.js";
import type { ShipRuntime, RunMeta } from "./runtime.js";

/**
 * A fake runtime in the captureRuntime tradition (evidence.test.ts): real
 * enqueueRun, in-memory stores. `runs` records every run-started append so
 * duplicate-launch assertions can count actual launches, not claims.
 */
function fakeRuntime(): {
  runtime: ShipRuntime;
  config: Map<string, string>;
  runs: Map<string, Array<Record<string, unknown>>>;
  metas: Map<string, RunMeta>;
  deliveries: Map<string, { state: string }>;
} {
  const config = new Map<string, string>();
  const runs = new Map<string, Array<Record<string, unknown>>>();
  const metas = new Map<string, RunMeta>();
  const deliveries = new Map<string, { state: string }>();
  const runtime = {
    kind: "file",
    config: {
      get: async (key: string) => config.get(key),
      set: async (key: string, value: string) => {
        config.set(key, value);
      },
      remove: async (key: string) => {
        config.delete(key);
      },
      list: async () => [],
    },
    evidence: { forRepo: async () => null },
    projects: { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (runId: string, event: Record<string, unknown>) => {
        const log = runs.get(runId) ?? [];
        log.push(event);
        runs.set(runId, log);
      },
      load: async (runId: string) => ((runs.get(runId) ?? []) as unknown) as never,
    },
    saveMeta: async (meta: RunMeta) => {
      metas.set(meta.runId, meta);
    },
    loadMeta: async (runId: string) => metas.get(runId) ?? null,
    deliveryRecords: {
      get: async (runId: string) => (deliveries.get(runId) ?? null) as never,
    },
  } as unknown as ShipRuntime;
  return { runtime, config, runs, metas, deliveries };
}

const API_REPO = "https://forge.example/team/api.git";
const CLIENT_REPO = "https://forge.example/team/client.git";

async function newPair() {
  const fake = fakeRuntime();
  // Keep the recorded input minimal and env-independent so run identities and
  // materialised flags stay stable across whatever machine runs this.
  delete process.env.SHIP_TESTS;
  delete process.env.SHIP_TELEMETRY;
  delete process.env.SHIP_PREVIEW;
  delete process.env.SHIP_REPO_ALLOWLIST;
  const record = await createCoordination(fake.runtime, {
    parentIntent: "Add the /v2/quotes endpoint and surface it in the app.",
    apiRepo: API_REPO,
    clientRepo: CLIENT_REPO,
    model: "zai/glm-5.3",
  });
  return { ...fake, record };
}

/** The run id coordination derives for one attempt — the duplicate-launch key. */
function derivedRunId(record: CoordinationRecord, which: "api" | "client", attempt: number): string {
  const digest = createHash("sha256").update(`${record.id}:${which}:${attempt}`).digest("hex").slice(0, 24);
  return `run-coord-${digest}`;
}

/** The recorded input of a run, as enqueueRun wrote it. */
function recordedInput(fake: ReturnType<typeof fakeRuntime>, runId: string): { task: string; repo?: string; parentRunId?: string } {
  const started = fake.runs.get(runId)!.find((e) => e.type === "run-started")!;
  return ((started.data as { input: Record<string, unknown> }).input) as { task: string; repo?: string; parentRunId?: string };
}

/** Drive one child's run to a merged outcome the way the worker's log would. */
function mergeRun(fake: ReturnType<typeof fakeRuntime>, runId: string, sha: string): void {
  // Keep the real run-started (enqueueRun wrote it): its input is what
  // task-session.ts walks when the client run threads under this one.
  const started = fake.runs.get(runId)!.find((e) => e.type === "run-started")!;
  fake.runs.set(runId, [
    started,
    { type: "step-completed", name: "repo-push", seq: 1, data: { result: { kind: "pushed", sha: `feed${sha}`.slice(0, 12) } } },
    { type: "step-completed", name: "merge-decision", seq: 2, data: { result: { kind: "merged", sha } } },
  ]);
  fake.metas.set(runId, { ...(fake.metas.get(runId) as RunMeta), status: "completed" });
}

function failRun(fake: ReturnType<typeof fakeRuntime>, runId: string, status = "failed"): void {
  fake.metas.set(runId, { ...(fake.metas.get(runId) as RunMeta), status });
}

test("createCoordination validates the pair, records it, and launches nothing", async () => {
  const { runtime, record } = await newPair();
  assert.equal(record.api.state, "pending");
  assert.equal(record.client.state, "pending");
  assert.equal(record.api.repo, "https://forge.example/team/api", "the repo is canonicalised");
  assert.equal((await loadCoordination(runtime, record.id))?.id, record.id, "the record round-trips through the store");
  assert.deepEqual((await listCoordinations(runtime)).map((r) => r.id), [record.id]);

  await assert.rejects(
    createCoordination(runtime, { parentIntent: "x", apiRepo: "team/api", clientRepo: CLIENT_REPO, model: "m" }),
    /full clone URL/,
  );
  await assert.rejects(
    createCoordination(runtime, { parentIntent: "x", apiRepo: API_REPO, clientRepo: API_REPO, model: "m" }),
    /two different repositories/,
  );
  // The allowlist binds even for operator-typed repos: with one configured,
  // the client repo is refused at the door, before any run exists.
  process.env.SHIP_REPO_ALLOWLIST = API_REPO;
  try {
    await assert.rejects(
      createCoordination(runtime, { parentIntent: "x", apiRepo: API_REPO, clientRepo: CLIENT_REPO, model: "m" }),
      /is not an origin this deployment allows/,
    );
  } finally {
    delete process.env.SHIP_REPO_ALLOWLIST;
  }
});

test("full lifecycle: pending, api-running (guarded), merged, client-running anchored, delivered", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;

  // 1. The API child launches FIRST; the client is not enqueued at all.
  let out = await launchNext(runtime, record.id);
  assert.equal(out.launched, "api");
  const apiRun = out.runId!;
  assert.equal(apiRun, derivedRunId(record, "api", 1), "the run id is derived from the attempt");
  assert.ok(fake.runs.has(apiRun), "the api run exists in the store");
  assert.equal(fake.metas.get(apiRun)!.status, "queued");
  assert.equal(out.record.api.state, "running");
  assert.equal(out.record.client.state, "pending");
  assert.equal(fake.runs.size, 1, "no client run exists yet");
  const apiInput = recordedInput(fake, apiRun);
  assert.match(apiInput.task, /API side/);
  assert.match(apiInput.task, /quotes endpoint/);
  assert.equal(apiInput.repo, "https://forge.example/team/api");

  // 2. Duplicate guard: calling launchNext again must not create a second run.
  out = await launchNext(runtime, record.id);
  assert.equal(out.launched, null);
  assert.equal(out.record.api.attempts, 1);
  assert.equal(fake.runs.size, 1);

  // 3. The API change merges: the client launches against the merged SHA.
  mergeRun(fake, apiRun, "abc123def456");
  out = await launchNext(runtime, record.id);
  assert.equal(out.record.api.state, "merged");
  assert.equal(out.record.api.anchorSha, "abc123def456");
  assert.equal(out.launched, "client");
  const clientRun = out.runId!;
  const clientInput = recordedInput(fake, clientRun);
  assert.match(clientInput.task, /client side/);
  assert.match(clientInput.task, /abc123def456/, "the compatibility anchor is embedded in the recorded task");
  assert.equal(clientInput.parentRunId, apiRun, "the client run threads under the API run");
  assert.equal(out.record.client.anchorSha, "abc123def456");

  // 4. Both sides delivered: the delivery record's confirmation upgrades state.
  mergeRun(fake, clientRun, "fff000ccc111");
  fake.deliveries.set(apiRun, { state: "confirmed" });
  fake.deliveries.set(clientRun, { state: "confirmed" });
  const observed = await observeCoordination(runtime, out.record);
  assert.equal(observed.api.state, "delivered");
  assert.equal(observed.client.state, "delivered");
  assert.equal((await launchNext(runtime, record.id)).launched, null, "nothing left to launch");
});

test("a failed API child holds the client until a human retries; retry relaunches and releases", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;

  const first = await launchNext(runtime, record.id);
  const apiRun = first.runId!;
  failRun(fake, apiRun);
  const out = await launchNext(runtime, record.id);
  assert.equal(out.record.api.state, "failed");
  assert.equal(out.record.client.state, "held");
  assert.match(out.record.client.holdReason ?? "", /failed before merging/);
  assert.equal(out.launched, null, "a hold enqueues nothing");
  assert.equal(fake.runs.size, 1, "still exactly one run — the client was never launched");

  // The hold is forever-until-human: repeated sweeps change nothing.
  assert.equal((await launchNext(runtime, record.id)).record.client.state, "held");

  // The human retry: API side returns to pending, the held client is released
  // with it, and the SAME launchNext door enqueues a NEW api attempt.
  const retried = await retryCoordinationChild(runtime, record.id, "api");
  assert.equal(retried.record.api.state, "running");
  assert.equal(retried.record.api.attempts, 2);
  assert.equal(retried.record.client.state, "pending");
  assert.notEqual(retried.runId, apiRun, "a retry is a new attempt under a new run id");
  assert.equal(fake.runs.size, 2);

  // The retried API merges; the client proceeds as in the happy path.
  mergeRun(fake, retried.runId!, "dead00beef00");
  const done = await launchNext(runtime, record.id);
  assert.equal(done.launched, "client");
  assert.match(recordedInput(fake, done.runId!).task, /dead00beef00/);
});

test("a failed client preserves the merged API work; its retry re-anchors to the same sha", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;

  const api = await launchNext(runtime, record.id);
  mergeRun(fake, api.runId!, "abc123def456");
  const client = await launchNext(runtime, record.id);
  assert.equal(client.launched, "client");
  failRun(fake, client.runId!);

  const out = await launchNext(runtime, record.id);
  assert.equal(out.record.api.state, "merged", "the API side is untouched — merged is merged, nothing rolls back");
  assert.equal(out.record.client.state, "failed");
  assert.match(out.record.client.failReason ?? "", /failed/);
  assert.equal(out.launched, null);

  const retried = await retryCoordinationChild(runtime, record.id, "client");
  assert.equal(retried.record.client.state, "running");
  assert.equal(retried.record.api.state, "merged");
  assert.match(recordedInput(fake, retried.runId!).task, /abc123def456/, "same compatibility anchor");
});

test("a run that finishes without merging is a failed dependency, never a silent pass", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  const api = await launchNext(runtime, record.id);
  failRun(fake, api.runId!, "completed");
  const out = await launchNext(runtime, record.id);
  assert.equal(out.record.api.state, "failed");
  assert.match(out.record.api.failReason ?? "", /without a merged change/);
  assert.equal(out.record.client.state, "held");
});

test("two racing launchNext calls produce exactly one run (fenced claim)", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  const outs = await Promise.all([launchNext(runtime, record.id), launchNext(runtime, record.id)]);
  const launches = outs.filter((o) => o.launched !== null);
  assert.equal(launches.length, 1, "exactly one caller enqueued");
  assert.equal(outs[0].record.api.attempts, 1);
  assert.equal(fake.runs.size, 1);
});

test("a claimed launch that never landed is retried under the same derived run id", async () => {
  const fake = await newPair();
  const { runtime, config, record } = fake;
  // Simulate a crash between claim and enqueue: state running under the id
  // attempt 1 derives, with no run anywhere and no journal intent to republish.
  const claimedId = derivedRunId(record, "api", 1);
  const orphan: CoordinationRecord = {
    ...record,
    api: { ...record.api, state: "running", attempts: 1, runId: claimedId },
    updatedAt: new Date().toISOString(),
  };
  config.set(coordinationKey(record.id), JSON.stringify(orphan));

  const out = await launchNext(runtime, record.id);
  assert.equal(out.launched, "api");
  assert.equal(out.runId, claimedId, "the claim was given back and the same id retried");
  assert.equal(out.record.api.attempts, 1);
  assert.ok(fake.runs.has(claimedId));
});

test("a sha-less merge holds the client rather than guessing an anchor", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  const api = await launchNext(runtime, record.id);
  fake.runs.set(api.runId!, [
    { type: "run-started", seq: 0 },
    // The boundary path with no sha anywhere: merged, but unproven which tree.
    { type: "step-completed", name: "merge-rebase", seq: 1, data: { result: { kind: "up-to-date" } } },
    { type: "step-completed", name: "merge-decision", seq: 2, data: { result: { kind: "merged" } } },
  ]);
  fake.metas.set(api.runId!, { ...(fake.metas.get(api.runId!) as RunMeta), status: "completed" });
  const out = await launchNext(runtime, record.id);
  assert.equal(out.record.api.state, "merged");
  assert.equal(out.record.client.state, "held");
  assert.match(out.record.client.holdReason ?? "", /without a commit sha/);
});
