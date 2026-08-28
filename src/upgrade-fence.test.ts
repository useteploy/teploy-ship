import assert from "node:assert/strict";
import { test } from "node:test";

import { LeaseManager, WIRE_FORMAT_VERSION } from "@neutron-build/workflow";
import type { RunOutcome, WorkflowEvent } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { releaseUpgradeHolds, startWorker } from "./worker.js";
import type { ExecutorProvider } from "./durable.js";
import type { NucleusShipRuntime } from "./runtime.js";
import type { RunMeta } from "./run-store.js";
import { FINGERPRINT_SCHEME, UPGRADE_HOLD_EVENT, stepFingerprint } from "./step-fingerprint.js";
import type { RecordedInput } from "./step-fingerprint.js";
import type { AdmissionControl } from "./admission.js";
import type { Outbox } from "./outbox.js";

/**
 * The fence, exercised through the real drive loop rather than around it.
 *
 * A control that is only unit-tested where it is DECIDED can be wired up wrong
 * and stay green: the previous pass over this codebase found guards that were
 * entirely inert while their tests passed. So these drive a real `startWorker`
 * and assert on what the run's storage looks like afterwards — in particular
 * that the lease is never taken (the run was never executed) and the event log
 * is never appended to (the hold is invisible to replay).
 */

function startedEvent(input: RecordedInput, fingerprint: string): WorkflowEvent {
  return {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: "2026-08-27T00:00:00.000Z",
    data: { workflow: "coding-agent", input, stepFingerprint: fingerprint },
  };
}

/**
 * One cursor event. A run the fence should HOLD has executed something —
 * replayDrift lets a log with no cursor events through (it is a fresh start
 * under any build), so a held-run fixture without one stopped being held the
 * day that landed and these helpers make the shape explicit.
 */
function cursorEvent(): WorkflowEvent {
  return { v: WIRE_FORMAT_VERSION, seq: 1, type: "step-completed", name: "sandbox", at: "2026-08-27T00:00:00.500Z", data: { result: null } };
}

interface Fake {
  runtime: NucleusShipRuntime;
  metas: Map<string, RunMeta>;
  indexed: Array<{ runId: string; outcome: RunOutcome }>;
  woken: string[];
  leaseAttempts: string[];
  appends: WorkflowEvent[];
  logs: string[];
  loaded: string[];
}

/**
 * A worker-shaped runtime with nothing real behind it. Only the surfaces the
 * drive loop and the startup beat touch are implemented; everything else is a
 * no-op, because a sweep never runs in these tests (the interval is longer than
 * the test) and the co-location probe short-circuits on an empty allowlist.
 */
function fakeRuntime(
  runs: Map<string, WorkflowEvent[]>,
  due: Array<{ runId: string; sleeping: boolean }>,
  hooks: { onLoad?: (runId: string) => Promise<void>; onPlacement?: () => Promise<void>; nextDue?: () => Array<{ runId: string; sleeping: boolean }> } = {},
): Fake {
  const metas = new Map<string, RunMeta>();
  const indexed: Array<{ runId: string; outcome: RunOutcome }> = [];
  const woken: string[] = [];
  const leaseAttempts: string[] = [];
  const appends: WorkflowEvent[] = [];
  const logs: string[] = [];
  const loaded: string[] = [];
  const kv = {
    async setNX(key: string): Promise<boolean> {
      leaseAttempts.push(key);
      return true;
    },
    async cdel(): Promise<boolean> {
      return true;
    },
    async cexpire(): Promise<boolean> {
      return true;
    },
  };
  const runtime = {
    kind: "nucleus",
    owner: "worker-under-test",
    store: {
      load: async (runId: string) => {
        loaded.push(runId);
        await hooks.onLoad?.(runId);
        return runs.get(runId) ?? [];
      },
      append: async (_runId: string, event: WorkflowEvent) => void appends.push(event),
    },
    leases: new LeaseManager(kv, { prefix: "test:lease" }),
    index: {
      due: async () => (due.length > 0 ? due.splice(0, due.length) : (hooks.nextDue?.() ?? [])),
      record: async (runId: string, _wf: string, outcome: RunOutcome) => void indexed.push({ runId, outcome }),
      markWake: async (runId: string) => void woken.push(runId),
    },
    loadMeta: async (runId: string) => metas.get(runId) ?? null,
    saveMeta: async (meta: RunMeta) => void metas.set(meta.runId, meta),
    listMeta: async () => [...metas.values()],
    placement: { set: async () => hooks.onPlacement?.() },
    fleet: { heartbeat: async () => {}, prune: async () => 0 },
    policies: { seed: async () => {}, list: async () => [] },
    spend: { release: async () => {}, get: async () => 0, reserve: async () => {} },
    attributedSpend: { add: async () => {} },
    unpricedRuns: { add: async () => {} },
    projects: { forRepo: async () => null, list: async () => [] },
    memory: {},
    steer: {},
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    intake: { list: async () => [] },
    bulletin: { list: async () => [] },
    config: { get: async () => null, all: async () => [] },
    akirooCursor: {},
    evidence: { forRepo: async () => null },
    db: { kv: { setNX: async () => true, cdel: async () => true } },
  } as unknown as NucleusShipRuntime;
  return { runtime, metas, indexed, woken, leaseAttempts, appends, logs, loaded };
}

const silentModel: ModelAdapter = {
  provider: "fence",
  modelId: "fence",
  async doGenerate() {
    throw new Error("a held run must never reach a model");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

const refusingExecutor: ExecutorProvider = {
  async create() {
    throw new Error("a held run must never create a sandbox");
  },
  attach() {
    throw new Error("a held run must never attach to a sandbox");
  },
};

const noAdmission = {
  renewSlots: async () => {},
  releaseSlot: async () => {},
  tryTake: async () => true,
  active: async () => 0,
} as unknown as AdmissionControl;

const noOutbox = {
  enqueue: async () => {},
  due: async () => [],
  succeed: async () => {},
  fail: async () => {},
} as unknown as Outbox;

function makeWorker(fake: Fake, overrides: Partial<Parameters<typeof startWorker>[0]> = {}): ReturnType<typeof startWorker> {
  return startWorker({
    runtime: fake.runtime,
    model: silentModel,
    modelId: "fence",
    executor: refusingExecutor,
    workdir: ".",
    // Longer than the test, so the only pass that runs is the immediate one
    // startWorker fires at startup. Nothing here depends on a sweep.
    intervalMs: 600_000,
    // Load-aware admission would otherwise decide this test's outcome: on a
    // busy laptop the worker holds every launch and the fence is never reached,
    // which would make the test pass for the wrong reason. Pinned so the only
    // thing deciding whether the run executes is the fence.
    minFreeMB: 0,
    maxLoadPerCpu: Number.MAX_SAFE_INTEGER,
    minFreeDiskMB: 0,
    maxInodeUsedPct: 100,
    maxConcurrentRuns: 4,
    admission: noAdmission,
    outbox: noOutbox,
    log: (line) => fake.logs.push(line),
    ...overrides,
  });
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runWorkerOnce(fake: Fake): Promise<void> {
  const worker = makeWorker(fake);
  // The drive pass is fired synchronously at startup and awaited nowhere; give
  // it the event-loop turns it needs, then stop taking work.
  for (let i = 0; i < 50 && fake.indexed.length === 0; i++) await tick();
  await worker.stop();
}

/** Keep SHIP_SELFWATCH_INTERVAL_S out of a worker test's way, and put it back. */
function withoutSelfwatch(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.SHIP_SELFWATCH_INTERVAL_S;
  process.env.SHIP_SELFWATCH_INTERVAL_S = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.SHIP_SELFWATCH_INTERVAL_S;
    else process.env.SHIP_SELFWATCH_INTERVAL_S = previous;
  });
}

const HELD_INPUT: RecordedInput = { task: "fix the thing", repo: "https://git.example.com/o/r", tests: true };

test("the fence holds a run this build cannot replay, without executing or touching its log", async (t) => {
  withoutSelfwatch(t);

  const events = [startedEvent(HELD_INPUT, `${FINGERPRINT_SCHEME}:0000000000000000`), cursorEvent()];
  const fake = fakeRuntime(new Map([["run-drift", events]]), [{ runId: "run-drift", sleeping: false }]);
  fake.metas.set("run-drift", {
    runId: "run-drift",
    task: "fix the thing",
    status: "queued",
    model: "fence",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });

  await runWorkerOnce(fake);

  assert.deepEqual(
    fake.indexed.map((r) => [r.runId, r.outcome.status, r.outcome.eventName]),
    [["run-drift", "waiting", UPGRADE_HOLD_EVENT]],
    "the run must be parked in the index so it stops coming due every tick",
  );
  assert.equal(fake.metas.get("run-drift")!.eventName, UPGRADE_HOLD_EVENT);
  assert.equal(fake.metas.get("run-drift")!.status, "waiting");
  assert.deepEqual(fake.leaseAttempts, [], "a held run must never be executed — no lease may be taken for it");
  assert.deepEqual(
    fake.appends,
    [],
    "the hold must not append to the event log: an event-waiting is a CURSOR event, so recording the hold " +
      "would itself change the sequence the hold exists to protect",
  );
  assert.ok(
    fake.logs.some((l) => l.includes("HOLDING") && l.includes("run-drift")),
    "the hold must be visible in the worker log",
  );
});

test("the fence lets a run this build agrees with through to execution", async (t) => {
  withoutSelfwatch(t);

  // Same run, same worker, the only difference being the recorded fingerprint.
  // Execution fails immediately (the executor refuses to make a sandbox), which
  // is the point: reaching the executor at all proves the fence let it past.
  const events = [startedEvent(HELD_INPUT, stepFingerprint(HELD_INPUT))];
  const fake = fakeRuntime(new Map([["run-ok", events]]), [{ runId: "run-ok", sleeping: false }]);
  fake.metas.set("run-ok", {
    runId: "run-ok",
    task: "fix the thing",
    status: "queued",
    model: "fence",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });

  await runWorkerOnce(fake);

  assert.ok(fake.leaseAttempts.length > 0, "an agreeing run must be executed, not held");
  assert.equal(
    fake.indexed.some((r) => r.outcome.eventName === UPGRADE_HOLD_EVENT),
    false,
    "an agreeing run must not be parked on the upgrade hold",
  );
});

test("a replay that diverges anyway is held, not retried forever", async (t) => {
  withoutSelfwatch(t);
  // The backstop. The fingerprint is computed from the SOURCE ORDER of step
  // calls, so a reordering achieved by swapping two helper call sites leaves it
  // unchanged — the engine catches that on replay, and before this the worker
  // logged the error and left the run due, so it re-attempted every tick
  // forever and nobody was told. Here the divergence is a log that belongs to
  // another workflow, which is the same NondeterminismError by a shorter route.
  const input: RecordedInput = { task: "t" };
  const foreign: WorkflowEvent = {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: "2026-08-27T00:00:00.000Z",
    data: { workflow: "some-other-workflow", input, stepFingerprint: stepFingerprint(input) },
  };
  const fake = fakeRuntime(new Map([["run-diverged", [foreign]]]), [{ runId: "run-diverged", sleeping: false }]);

  await runWorkerOnce(fake);

  assert.deepEqual(
    fake.indexed.map((r) => [r.runId, r.outcome.status, r.outcome.eventName]),
    [["run-diverged", "waiting", UPGRADE_HOLD_EVENT]],
    "a NondeterminismError must park the run rather than leave it due for the next tick",
  );
  assert.ok(
    fake.logs.some((l) => l.includes("diverged from its recorded log")),
    "and it must say what happened",
  );
});

// ---------------------------------------------------------------------------
// releasing the hold
// ---------------------------------------------------------------------------

function heldMeta(runId: string): RunMeta {
  return {
    runId,
    task: "t",
    status: "waiting",
    eventName: UPGRADE_HOLD_EVENT,
    model: "m",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

test("a hold is released once the running build agrees with the run again", async () => {
  // The rollback half. An operator who has just rolled back should not also
  // have to remember which runs to resume.
  const input: RecordedInput = { task: "t", repo: "r" };
  const saved: RunMeta[] = [];
  const woken: string[] = [];
  const released = await releaseUpgradeHolds({
    listMeta: async () => [heldMeta("run-a")],
    loadEvents: async () => [startedEvent(input, stepFingerprint(input))],
    markWake: async (runId) => void woken.push(runId),
    saveMeta: async (meta) => void saved.push(meta),
    log: () => {},
  });
  assert.deepEqual(released, ["run-a"]);
  assert.deepEqual(woken, ["run-a"], "a released run has to become due again or it is still stopped");
  assert.equal(saved[0]!.eventName, "", "the hold's name must be cleared, not merely overwritten by the index");
  assert.equal(saved[0]!.status, "queued");
});

test("a hold that is still real is not released", async () => {
  const input: RecordedInput = { task: "t", repo: "r" };
  const woken: string[] = [];
  const released = await releaseUpgradeHolds({
    listMeta: async () => [heldMeta("run-a")],
    loadEvents: async () => [startedEvent(input, `${FINGERPRINT_SCHEME}:3333333333333333`), cursorEvent()],
    markWake: async (runId) => void woken.push(runId),
    saveMeta: async () => {},
    log: () => {},
  });
  assert.deepEqual(released, []);
  assert.deepEqual(woken, []);
});

test("an unreadable log leaves the hold in place rather than assuming it is over", async () => {
  const woken: string[] = [];
  const released = await releaseUpgradeHolds({
    listMeta: async () => [heldMeta("run-a")],
    loadEvents: async () => {
      throw new Error("store unreachable");
    },
    markWake: async (runId) => void woken.push(runId),
    saveMeta: async () => {},
    log: () => {},
  });
  assert.deepEqual(released, []);
  assert.deepEqual(woken, []);
});

test("ordinary parks are left alone — only the upgrade hold is swept", async () => {
  const input: RecordedInput = { task: "t" };
  const woken: string[] = [];
  const released = await releaseUpgradeHolds({
    listMeta: async () => [{ ...heldMeta("run-approval"), eventName: "turn-3-approval" }],
    loadEvents: async () => [startedEvent(input, stepFingerprint(input))],
    markWake: async (runId) => void woken.push(runId),
    saveMeta: async () => {},
    log: () => {},
  });
  assert.deepEqual(released, [], "waking a run that is waiting for a human would discard the decision it needs");
  assert.deepEqual(woken, []);
});

// ---------------------------------------------------------------------------
// The drain: what a shutdown is actually waiting for
// ---------------------------------------------------------------------------

function terminalEvent(): WorkflowEvent {
  return { v: WIRE_FORMAT_VERSION, seq: 1, type: "run-completed", at: "2026-08-27T00:00:01.000Z", data: { output: null } };
}

test("busy() covers the completion work a shutdown must not cut off", async (t) => {
  withoutSelfwatch(t);
  // A finished run leaves `inflight` BEFORE its settlement starts, so a
  // shutdown that waited on runs alone saw busy() go false immediately and
  // closed the connection pool underneath the spend write. A run's cost
  // reaching the ledger is the only part of a shutdown the next worker cannot
  // redo, so busy() has to still be true here.
  let releasePlacement: () => void = () => {};
  const placementDone = new Promise<void>((resolve) => {
    releasePlacement = resolve;
  });
  const events = [startedEvent({ task: "t" }, stepFingerprint({ task: "t" })), terminalEvent()];
  const fake = fakeRuntime(new Map([["run-done", events]]), [{ runId: "run-done", sleeping: false }], {
    onPlacement: () => placementDone,
  });

  const worker = makeWorker(fake);
  for (let i = 0; i < 50 && fake.indexed.length === 0; i++) await tick();
  await worker.stop();

  assert.equal(fake.indexed.length, 1, "the terminal run was finalised in the index");
  assert.ok(worker.unsettled() > 0, "completion work is still owed to the store");
  assert.equal(worker.busy(), true, "busy() must report work a shutdown would interrupt, not just executing runs");

  releasePlacement();
  for (let i = 0; i < 100 && worker.unsettled() > 0; i++) await tick();
  assert.equal(worker.unsettled(), 0, "and it must come back down once the work lands");
});

test("a stopping worker does not pick up new work from its own completion chain", async (t) => {
  withoutSelfwatch(t);
  // Clearing the interval is not enough: a run that makes progress re-enters
  // drive() from its completion handler to fill the freed slot, so a worker
  // that had been told to stop could still claim a brand-new run — and then be
  // killed mid-step by the shutdown that had just asked it to stop.
  let releaseLoad: () => void = () => {};
  const slowLoad = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const input: RecordedInput = { task: "t" };
  const runs = new Map([
    ["run-first", [startedEvent(input, stepFingerprint(input)), terminalEvent()]],
    ["run-second", [startedEvent(input, stepFingerprint(input)), terminalEvent()]],
  ]);
  // Offered only once the worker has been told to stop, so the first pass
  // cannot pick it up for an unrelated reason (launchDueBounded drains `due()`
  // until it is empty, so an always-available second run would launch straight
  // away and the test would prove nothing).
  let stopped = false;
  let offered = false;
  const fake = fakeRuntime(runs, [{ runId: "run-first", sleeping: false }], {
    onLoad: (runId) => (runId === "run-first" ? slowLoad : Promise.resolve()),
    // Offered exactly once: launchDueBounded drains `due()` in a loop, so an
    // endlessly-available run would spin rather than fail if the stop guard
    // were removed, and a hang is a worse test result than an assertion.
    nextDue: () => (stopped && !offered ? ((offered = true), [{ runId: "run-second", sleeping: false }]) : []),
  });

  const worker = makeWorker(fake);
  for (let i = 0; i < 50 && !fake.loaded.includes("run-first"); i++) await tick();
  await worker.stop();
  stopped = true;
  releaseLoad();
  for (let i = 0; i < 40; i++) await tick();

  assert.equal(
    fake.loaded.includes("run-second"),
    false,
    "a worker that has been told to stop must not start another run",
  );
});

test("stop() does not return while an intake sweep is still in flight", async (t) => {
  withoutSelfwatch(t);
  // Clearing the timers abandoned a sweep mid-pass: it could hold claimed
  // intake tasks whose enqueue never landed, or an Akiroo pull between fetch
  // and ack. busy() knew about `sweeping`, but nothing in the rewritten
  // shutdown called busy() — the wait was simply dropped. stop() itself has
  // to hold the door: every caller (the signal handler, embedders, these
  // tests) gets it for free there and nowhere else.
  let releasePolicies: () => void = () => {};
  const policiesGate = new Promise<void>((resolve) => {
    releasePolicies = resolve;
  });
  const fake = fakeRuntime(new Map(), []);
  (fake.runtime as unknown as { policies: { seed(): Promise<void>; list(): Promise<never[]> } }).policies = {
    seed: async () => {},
    list: async () => {
      await policiesGate;
      return [];
    },
  };

  const worker = makeWorker(fake, { intervalMs: 5 });
  for (let i = 0; i < 200 && !worker.busy(); i++) await tick();
  assert.equal(worker.busy(), true, "the gated sweep must be observable as busy before stopping");

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(stopped, false, "stop() must not return while a sweep is mid-pass");
  assert.equal(worker.busy(), true, "and the sweep is still the thing shutdown would interrupt");

  releasePolicies();
  await stopping;
  assert.equal(stopped, true, "stop() returns once the in-flight sweep settles");
  assert.equal(worker.busy(), false);
});
