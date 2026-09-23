import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import {
  acceptCheckRisk,
  coordinationComplete,
  createCoordination,
  gradeCheck,
  launchNext,
  listCoordinations,
  loadCoordination,
  observeCoordination,
  proposeCheckFixTask,
  retryCoordinationCheck,
  retryCoordinationChild,
  rollupCoordinationCost,
  sweepCoordinations,
  coordinationKey,
} from "./coordination.js";
import type { CoordinationRecord } from "./coordination.js";
import type { ParsedFindings } from "./findings.js";
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
  evidence: Map<string, { testCommand?: string }>;
  proposals: Array<Record<string, unknown>>;
  failLoads: Set<string>;
} {
  const config = new Map<string, string>();
  const runs = new Map<string, Array<Record<string, unknown>>>();
  const metas = new Map<string, RunMeta>();
  const deliveries = new Map<string, { state: string }>();
  const evidence = new Map<string, { testCommand?: string }>();
  const proposals: Array<Record<string, unknown>> = [];
  /** Run ids whose event read rejects — for sweep-error paths. */
  const failLoads = new Set<string>();
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
    evidence: { forRepo: async (repo: string) => evidence.get(repo) ?? null },
    projects: { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (runId: string, event: Record<string, unknown>) => {
        const log = runs.get(runId) ?? [];
        log.push(event);
        runs.set(runId, log);
      },
      load: async (runId: string) => {
        if (failLoads.has(runId)) throw new Error("store unreadable");
        return ((runs.get(runId) ?? []) as unknown) as never;
      },
    },
    intake: {
      propose: async (input: Record<string, unknown>) => {
        const existing = proposals.find(
          (p) => p.dedupeKey === input.dedupeKey,
        );
        if (existing !== undefined) return { created: false, task: { taskId: existing.taskId } };
        const task = { taskId: `task-${input.dedupeKey}`, ...input };
        proposals.push(task);
        return { created: true, task };
      },
    },
    saveMeta: async (meta: RunMeta) => {
      metas.set(meta.runId, meta);
    },
    loadMeta: async (runId: string) => metas.get(runId) ?? null,
    deliveryRecords: {
      get: async (runId: string) => (deliveries.get(runId) ?? null) as never,
    },
  } as unknown as ShipRuntime;
  return { runtime, config, runs, metas, deliveries, evidence, proposals, failLoads };
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

/** The run id coordination derives for one CHECK attempt. */
function derivedCheckRunId(record: CoordinationRecord, attempt: number): string {
  const digest = createHash("sha256").update(`${record.id}:check:${attempt}`).digest("hex").slice(0, 24);
  return `run-coord-check-${digest}`;
}

/** Drive a check run to a settled scan outcome the way the loop would record it. */
function completeCheckRun(
  fake: ReturnType<typeof fakeRuntime>,
  runId: string,
  parsed: ParsedFindings,
  summary: string,
): void {
  const started = fake.runs.get(runId)!.find((e) => e.type === "run-started")!;
  fake.runs.set(runId, [
    started,
    { type: "step-completed", name: "scan-findings", seq: 1, data: { result: parsed } },
    { type: "run-completed", seq: 2, data: { output: { status: "finished", summary, usage: {} } } },
  ]);
  fake.metas.set(runId, { ...(fake.metas.get(runId) as RunMeta), status: "completed" });
}

/** One recorded model call, so cost rollups have real usage to sum. */
function thinkStep(fake: ReturnType<typeof fakeRuntime>, runId: string, seq: number, usage: Record<string, unknown>): void {
  const log = fake.runs.get(runId) ?? [];
  const insertAt = log.findIndex((e) => e.type === "run-completed" || e.type === "run-failed");
  const step = { type: "step-completed", name: `turn-${seq}-think`, seq, data: { result: { text: "thinking", usage } } };
  if (insertAt === -1) log.push(step);
  else log.splice(insertAt, 0, step);
  fake.runs.set(runId, log);
}

/** The happy path up to a merged client: api merged, client merged, no check yet. */
async function pairWithClientMerged(fake: ReturnType<typeof fakeRuntime> & { record: CoordinationRecord }) {
  const api = await launchNext(fake.runtime, fake.record.id);
  mergeRun(fake, api.runId!, "abc123def456");
  const client = await launchNext(fake.runtime, fake.record.id);
  mergeRun(fake, client.runId!, "fff000ccc111");
  return { apiRun: api.runId!, clientRun: client.runId! };
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
  // 5. S18: a merged client owes its compatibility check — the pair is not
  // done until the check says compatible (or a human accepts otherwise).
  const check = await launchNext(runtime, record.id);
  assert.equal(check.launched, "check");
  assert.equal(check.record.client.mergedSha, "fff000ccc111", "the client's own merged sha is recorded at the merge");
  completeCheckRun(fake, check.runId!, { found: true, errors: [], findings: [] }, "Every endpoint the client calls exists at the anchor.\nConfidence: high");
  const settled = await launchNext(runtime, record.id);
  assert.equal(settled.record.client.clientCheck, "compatible");
  assert.equal(coordinationComplete(settled.record), true);
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

// ------------------------------------------------------------- S18: the check

const CITED_MISMATCH: ParsedFindings = {
  found: true,
  errors: [],
  findings: [
    {
      title: "client calls /v2/quotes, which the anchor's API does not serve",
      severity: "high",
      file: "src/api-client.ts",
      line: 42,
      detail: "the client calls GET /v2/quotes; at anchor abc123def456 the API serves /v1/quotes only",
      fix: "move the call back to /v1/quotes or re-coordinate on a new API change",
    },
  ],
};

test("the client merge owes a read-only compatibility check whose task is grounded in both repos", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  // Both projects declare a suite, so the pair-level integration question
  // arises — and the module must answer it with the honest refusal.
  fake.evidence.set("https://forge.example/team/api", { testCommand: "pnpm test" });
  fake.evidence.set("https://forge.example/team/client", { testCommand: "pnpm test" });
  const { apiRun, clientRun } = await pairWithClientMerged(fake);

  const out = await launchNext(runtime, record.id);
  assert.equal(out.launched, "check");
  const checkRun = out.runId!;
  assert.equal(checkRun, derivedCheckRunId(record, 1), "the check run id is derived from the attempt");
  assert.equal(out.record.client.state, "merged", "the client stays merged — the check is a sub-state, not a child state");
  assert.equal(out.record.client.clientCheck, "running");
  assert.equal(out.record.client.checkAttempts, 1);
  assert.equal(out.record.client.integrationTest, "not-executed (scan is read-only)");

  const input = recordedInput(fake, checkRun) as { task: string; repo?: string; mode?: string };
  assert.equal(input.mode, "scan", "the check is a scan run — read-only by construction, never by prose");
  assert.equal(input.repo, "https://forge.example/team/client", "the check runs on the CLIENT repo");
  assert.match(input.task, /fff000ccc111/, "the client's merged sha is embedded");
  assert.match(input.task, /abc123def456/, "the API anchor is embedded");
  assert.match(input.task, /https:\/\/forge\.example\/team\/api\.git|https:\/\/forge\.example\/team\/api/, "the API repo is referenced");
  assert.match(input.task, /read-only/, "the task states the read-only contract");
  assert.match(input.task, /compatibility anchor/, "the anchor's meaning is stated");
  assert.match(input.task, /not-executed \(scan is read-only\)/, "the integration-test refusal is in the task");
  assert.match(input.task, /do not present suite output as check evidence/, "the check is static by instruction");
  assert.doesNotMatch(input.task, /run the (client'?s)? test (command|suite)/i, "the task never instructs executing the suite");

  // Fenced: a second call enqueues nothing.
  assert.equal((await launchNext(runtime, record.id)).launched, null);
  assert.equal(fake.runs.size, 3, "api + client + exactly one check run");

  // Without both suites declared the question does not arise, and the field
  // says that instead of pretending a refusal happened.
  const bare = await newPair();
  await pairWithClientMerged(bare);
  const bareOut = await launchNext(bare.runtime, bare.record.id);
  assert.equal(bareOut.launched, "check");
  assert.equal(bareOut.record.client.integrationTest, "not-applicable (both projects must declare a test command)");
  void apiRun;
  void clientRun;
});

test("check verdict grading: cited clean is compatible, uncited claims are uncertain, cited mismatch is incompatible", () => {
  const clean: ParsedFindings = { found: true, errors: [], findings: [] };
  assert.deepEqual(
    gradeCheck(clean, "Checked every call site. Nothing drifted.\nConfidence: high"),
    { verdict: "compatible", confidence: "high", rationale: "stated high with an explicit no-mismatch findings array" },
  );
  // An uncited clean claim: no confidence line, no verdict.
  assert.equal(gradeCheck(clean, "all good").verdict, "uncertain");
  assert.equal(gradeCheck(clean, "Confidence: low").verdict, "uncertain");
  // A mismatch the findings cannot carry: incidents' low-confidence teardown.
  const uncited: ParsedFindings = {
    found: true,
    errors: [],
    findings: [{ title: "maybe drift", severity: "med", file: "src/api-client.ts", detail: "uncertain" }],
  };
  assert.equal(gradeCheck(uncited, "I think it drifted").verdict, "uncertain", "a claimed mismatch with no citations is a human question");
  // An explicit, cited mismatch.
  const graded = gradeCheck(CITED_MISMATCH, "The client drifted.\nConfidence: high");
  assert.equal(graded.verdict, "incompatible");
  assert.equal(graded.confidence, "high");
  // No findings array at all.
  assert.equal(gradeCheck({ found: false, findings: [], errors: ["no array"] }, "prose only").verdict, "uncertain");
});

test("an incompatible verdict holds the pair on a human with recorded evidence; compatible completes", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  await pairWithClientMerged(fake);
  const launched = await launchNext(runtime, record.id);
  const checkRun = launched.runId!;
  completeCheckRun(fake, checkRun, CITED_MISMATCH, "The client drifted from the anchor.\nConfidence: high\nWould raise: a pinned fixture of the anchor's routes.");

  const out = await launchNext(runtime, record.id);
  assert.equal(out.launched, null, "a verdict enqueues nothing");
  assert.equal(out.record.client.clientCheck, "incompatible");
  assert.equal(out.record.client.state, "merged", "merged is a fact; the HOLD is the check's");
  assert.equal(out.record.client.checkVerdict?.verdict, "incompatible");
  assert.equal(out.record.client.checkVerdict?.findings.length, 1);
  assert.match(out.record.client.checkVerdict?.runId ?? "", new RegExp(checkRun.slice("run-coord-check-".length)));
  assert.equal(coordinationComplete(out.record), false, "an incompatible verdict is not complete");

  // Human action 1: re-run the check — a NEW attempt under a new run id.
  const rerun = await retryCoordinationCheck(runtime, record.id);
  assert.equal(rerun.launched, "check");
  assert.equal(rerun.record.client.checkAttempts, 2);
  assert.notEqual(rerun.runId, checkRun);
  assert.equal(rerun.record.client.checkVerdict, undefined, "the old verdict is cleared with the retry");
  completeCheckRun(fake, rerun.runId!, { found: true, errors: [], findings: [] }, "Re-checked against the anchor tree.\nConfidence: medium");
  const settled = await launchNext(runtime, record.id);
  assert.equal(settled.record.client.clientCheck, "compatible");
  assert.equal(coordinationComplete(settled.record), true, "api merged + client merged + check compatible is the complete shape");

  // The retry refuses states that are not a verdict parked on a human.
  await assert.rejects(retryCoordinationCheck(runtime, record.id), /only an incompatible or uncertain verdict/);
});

test("accept-risk records the human decision over an uncertain verdict and completes the pair exactly once", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  await pairWithClientMerged(fake);
  const launched = await launchNext(runtime, record.id);
  // An uncertain check: clean claim, no confidence line.
  completeCheckRun(fake, launched.runId!, { found: true, errors: [], findings: [] }, "looked fine to me");
  const held = await launchNext(runtime, record.id);
  assert.equal(held.record.client.clientCheck, "uncertain");
  assert.equal(coordinationComplete(held.record), false);

  // Human action 2: accept the risk — recorded who and when.
  const accepted = await acceptCheckRisk(runtime, record.id, { id: "tyler", kind: "user" });
  assert.equal(accepted.client.checkAccepted?.by, "tyler");
  assert.equal(coordinationComplete(accepted), true, "an accepted imperfect verdict completes the pair");
  await assert.rejects(acceptCheckRisk(runtime, record.id, { id: "tyler", kind: "user" }), /already accepted/);
  // Accepting is fenced to verdict states: a check still running has no risk
  // to accept yet.
  const other = await newPair();
  await pairWithClientMerged(other);
  await launchNext(other.runtime, other.record.id);
  await assert.rejects(acceptCheckRisk(other.runtime, other.record.id, { id: "tyler", kind: "user" }), /there is no verdict risk to accept/);
});

test("the fix-task action proposes deduped intake work carrying the check's evidence", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  await pairWithClientMerged(fake);
  const launched = await launchNext(runtime, record.id);
  completeCheckRun(fake, launched.runId!, CITED_MISMATCH, "The client drifted.\nConfidence: high");
  await launchNext(runtime, record.id);

  const first = await proposeCheckFixTask(runtime, record.id, { id: "tyler", kind: "user" });
  assert.equal(first.created, true);
  const proposal = fake.proposals[0] as { repo?: string; dedupeKey?: string; detail?: string; requestedBy?: string };
  assert.equal(proposal.repo, "https://forge.example/team/client");
  assert.match(proposal.dedupeKey ?? "", new RegExp(`coordination:${record.id}:check-fix:1`));
  assert.match(proposal.detail ?? "", /src\/api-client\.ts:42/, "the cited evidence rides the task");
  assert.equal(proposal.requestedBy, "tyler");
  const again = await proposeCheckFixTask(runtime, record.id);
  assert.equal(again.created, false, "a repeat click is deduped, not a second task");
});

test("a check run that fails or delivers nothing settles uncertain, never silently clean", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  await pairWithClientMerged(fake);
  const launched = await launchNext(runtime, record.id);
  failRun(fake, launched.runId!);
  const out = await launchNext(runtime, record.id);
  assert.equal(out.record.client.clientCheck, "uncertain");
  assert.match(out.record.client.checkVerdict?.rationale ?? "", /cancelled before delivering|failed before delivering/);

  // READ-ONLY GUARD: a linked run that is not a scan is refused, not graded.
  const fake2 = await newPair();
  await pairWithClientMerged(fake2);
  const l2 = await launchNext(fake2.runtime, fake2.record.id);
  const started = fake2.runs.get(l2.runId!)!.find((e) => e.type === "run-started")!;
  (started.data as { input: Record<string, unknown> }).input.mode = "fix";
  completeCheckRun(fake2, l2.runId!, { found: true, errors: [], findings: [] }, "Confidence: high");
  const out2 = await launchNext(fake2.runtime, fake2.record.id);
  assert.equal(out2.record.client.clientCheck, "uncertain");
  assert.match(out2.record.client.checkVerdict?.rationale ?? "", /not a read-only scan/);
});

test("a claimed check that never landed is retried under the same derived run id", async () => {
  const fake = await newPair();
  const { runtime, config, record } = fake;
  await pairWithClientMerged(fake);
  const claimedId = derivedCheckRunId(record, 1);
  const current = (await loadCoordination(runtime, record.id))!;
  const orphan: CoordinationRecord = {
    ...current,
    client: { ...current.client, clientCheck: "running", checkAttempts: 1, checkRunId: claimedId },
    updatedAt: new Date().toISOString(),
  };
  config.set(coordinationKey(record.id), JSON.stringify(orphan));
  const out = await launchNext(runtime, record.id);
  assert.equal(out.launched, "check");
  assert.equal(out.runId, claimedId, "the claim was given back and the same id retried");
  assert.equal(out.record.client.checkAttempts, 1);
});

// ------------------------------------------------------ S18: aggregate cost

test("cost rollup sums per-child attempts and the check, and unknown spend is never zero", async () => {
  const fake = await newPair();
  const { runtime, record } = fake;
  // zai/glm-5.3 lists at $1/M input, $3.2/M output (pricing.ts).
  const api = await launchNext(runtime, record.id);
  thinkStep(fake, api.runId!, 0, { inputTokens: 100_000, outputTokens: 10_000 }); // $0.132
  failRun(fake, api.runId!);
  await launchNext(runtime, record.id); // observe the failure (and hold the client)
  const retried = await retryCoordinationChild(runtime, record.id, "api");
  mergeRun(fake, retried.runId!, "abc123def456");
  thinkStep(fake, retried.runId!, 0, { inputTokens: 200_000, outputTokens: 0 }); // $0.20 (after mergeRun, which rewrites the log)
  const client = await launchNext(runtime, record.id);
  mergeRun(fake, client.runId!, "fff000ccc111");
  thinkStep(fake, client.runId!, 0, { costUSD: 0.25 }); // harness-reported dollars win (after mergeRun, which rewrites the log)
  const check = await launchNext(runtime, record.id);
  thinkStep(fake, check.runId!, 0, { inputTokens: 50_000, outputTokens: 0, priced: false }); // quota, not dollars

  const cost = await rollupCoordinationCost(runtime, (await loadCoordination(runtime, record.id))!);
  assert.ok(Math.abs(cost.api.costUsd - 0.332) < 1e-9, "multi-attempt api spend sums across the failed attempt and the merge");
  assert.equal(cost.api.runs, 2);
  assert.ok(Math.abs(cost.client.costUsd - 0.25) < 1e-9);
  assert.equal(cost.client.unknown, false);
  assert.equal(cost.check.unknown, true, "an unpriced check consumes a quota — unknown, never $0");
  assert.equal(cost.check.costUsd, 0);
  assert.equal(cost.total.unknown, true);
  assert.ok(Math.abs(cost.total.costUsd - 0.582) < 1e-9, "the total sums the known sides only");

  // An old record with no check attempts rolls a zero check without unknown.
  const old = await newPair();
  const oldApi = await launchNext(old.runtime, old.record.id);
  thinkStep(old, oldApi.runId!, 0, { inputTokens: 10_000, outputTokens: 0 });
  mergeRun(old, oldApi.runId!, "abc123def456");
  const oldClient = await launchNext(old.runtime, old.record.id);
  thinkStep(old, oldClient.runId!, 0, { inputTokens: 10_000, outputTokens: 0 });
  const oldCost = await rollupCoordinationCost(old.runtime, (await loadCoordination(old.runtime, old.record.id))!);
  assert.deepEqual(oldCost.check, { costUsd: 0, unknown: false, runs: 0 });
  assert.equal(oldCost.total.unknown, false);
});

// ------------------------------------------------- S18: old records replay

test("starter-shaped records replay unchanged through launchNext until the client merges", async () => {
  const fake = await newPair();
  const { runtime, config, record } = fake;
  // A record exactly as the starter wrote it: api running against a run that
  // exists, no field S18 added. The sweep observes and does nothing new.
  const first = await launchNext(runtime, record.id);
  const apiRun = first.runId!;
  const orphan: CoordinationRecord = {
    ...record,
    api: { repo: record.api.repo, state: "running", attempts: 1, runId: apiRun },
    updatedAt: new Date().toISOString(),
  };
  config.set(coordinationKey(record.id), JSON.stringify(orphan));
  const out = await launchNext(runtime, record.id);
  assert.equal(out.launched, null);
  assert.equal(out.note, "api running, client pending; nothing to do");
  assert.equal(out.record.client.clientCheck, undefined, "no check fields are invented for an in-flight starter record");

  // A starter record whose client ALREADY merged (anchorSha was overloaded
  // with the client's own merged sha by the starter's observe): the check
  // launches against that sha as the client's merged commit — the fallback
  // the field's comment documents.
  const merged: CoordinationRecord = {
    ...record,
    api: { repo: record.api.repo, state: "merged", attempts: 1, runId: apiRun, anchorSha: "aaa000bbb111" },
    client: { repo: record.client.repo, state: "merged", attempts: 1, runId: derivedRunId(record, "client", 1), anchorSha: "fff000ccc111" },
    updatedAt: new Date().toISOString(),
  };
  config.set(coordinationKey(record.id), JSON.stringify(merged));
  const check = await launchNext(runtime, record.id);
  assert.equal(check.launched, "check");
  const input = recordedInput(fake, check.runId!) as { task: string };
  assert.match(input.task, /fff000ccc111/, "the overloaded anchorSha stands in for the client's merged sha");
  assert.match(input.task, /aaa000bbb111/, "the API anchor comes from the api child");
});

test("sweepCoordinations advances every coordination and collects per-record errors", async () => {
  const fake = await newPair();
  const { runtime } = fake;
  const result = await sweepCoordinations(runtime);
  assert.equal(result.advanced, 1, "the api child launched");
  assert.deepEqual(result.errors, []);
  // A second coordination whose run store read rejects is an ERROR, not a
  // stop: the sweep collects it and still tends the healthy one.
  const second = await createCoordination(runtime, {
    parentIntent: "second pair",
    apiRepo: API_REPO,
    clientRepo: CLIENT_REPO,
    model: "zai/glm-5.3",
  });
  const secondLaunch = await launchNext(runtime, second.id);
  fake.failLoads.add(secondLaunch.runId!);
  const again = await sweepCoordinations(runtime);
  assert.equal(again.errors.length, 1);
  assert.equal(again.errors[0]!.id, second.id);
  assert.match(again.errors[0]!.error, /store unreadable/);
  // An invalid record on the index is skipped by the list, never fatal — and
  // with the store readable again, the healed pair settles with no errors.
  fake.failLoads.clear();
  fake.config.set(coordinationKey("coord-broken"), JSON.stringify({ id: "coord-broken" }));
  fake.config.set("SHIP_COORDINATIONS", JSON.stringify(["coord-broken", fake.record.id, second.id]));
  const third = await sweepCoordinations(runtime);
  assert.deepEqual((await listCoordinations(runtime)).map((r) => r.id).sort(), [fake.record.id, second.id].sort(), "the broken record never lists");
  assert.equal(third.errors.length, 0);
});
