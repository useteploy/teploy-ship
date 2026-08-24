import assert from "node:assert/strict";
import { test } from "node:test";

import { computeHealth, healthWarnings, makeObserveLogEmitter, selfwatchOnce, WORKER_STALE_S } from "./selfwatch.js";
import type { RunMeta } from "./run-store.js";

interface FakeEvents {
  [runId: string]: Array<{ type: string; at: string; name?: string; v?: number; seq?: number }>;
}

function fakeRuntime(metas: RunMeta[], events: FakeEvents) {
  return {
    listMeta: async () => metas,
    store: {
      load: async (runId: string) => events[runId] ?? [],
    },
  };
}

function fakeFleet(workers: Array<{ owner: string; host: string; lastSeen: string; activeRuns: number }>) {
  return {
    list: async () =>
      workers.map((w) => ({
        owner: w.owner,
        host: w.host,
        sandbox: "host",
        maxConcurrent: 3,
        activeRuns: w.activeRuns,
        startedAt: w.lastSeen,
        lastSeen: w.lastSeen,
      })),
  };
}

const NOW = new Date("2026-08-24T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function meta(runId: string, status: string, updatedAt: string): RunMeta {
  return { runId, status, task: "t", model: "m", createdAt: updatedAt, updatedAt } as RunMeta;
}

test("a run with progress and an old last event is stuck; one with no progress never started", async () => {
  const events: FakeEvents = {
    "run-stuck": [
      { type: "run-started", at: ago(90) },
      { type: "step-completed", name: "turn-0-think", at: ago(75) },
      { type: "step-completed", name: "turn-0-exec", at: ago(61) },
    ],
    "run-never": [{ type: "run-started", at: ago(61) }],
    "run-fresh": [
      { type: "run-started", at: ago(10) },
      { type: "step-completed", name: "turn-0-think", at: ago(2) },
    ],
  };
  const metas = [
    meta("run-stuck", "wake", ago(61)),
    meta("run-never", "wake", ago(61)),
    meta("run-fresh", "wake", ago(2)),
    meta("run-done", "completed", ago(5)),
    meta("run-parked", "waiting", ago(70)),
  ];
  const snapshot = await computeHealth({
    runtime: fakeRuntime(metas, events),
    fleet: fakeFleet([{ owner: "w1", host: "h1", lastSeen: ago(0), activeRuns: 1 }]),
    owner: "w1",
    activeRuns: 1,
    now: () => NOW,
  });

  assert.deepEqual(
    snapshot.stuck.map((s) => s.runId),
    ["run-stuck"],
    "progress then silence = stuck",
  );
  assert.equal(snapshot.stuck[0]!.lastEventAgeS, 61 * 60);
  assert.deepEqual(
    snapshot.neverStarted.map((s) => s.runId),
    ["run-never"],
    "no progress at all = never started",
  );
  assert.equal(snapshot.parked, 1, "a parked run is waiting on a human, not stuck");
  // open = stuck + never + fresh = 3; fleet says 1 executing.
  assert.equal(snapshot.queueDepth, 2);
  assert.equal(snapshot.workers[0]!.stale, false);
});

test("worker staleness is heartbeat age past the mark", async () => {
  const snapshot = await computeHealth({
    runtime: fakeRuntime([], {}),
    fleet: fakeFleet([
      { owner: "live", host: "h", lastSeen: ago(0), activeRuns: 0 },
      { owner: "dead", host: "h", lastSeen: ago(WORKER_STALE_S + 30), activeRuns: 0 },
    ]),
    owner: "live",
    activeRuns: 0,
    now: () => NOW,
  });
  const dead = snapshot.workers.find((w) => w.owner === "dead")!;
  assert.equal(dead.stale, true);
  const warnings = healthWarnings(snapshot);
  assert.ok(warnings.some((l) => l.includes("worker dead@h") && l.includes("stale")));
});

test("warnings name the stuck and never-started runs with their ages", async () => {
  const events: FakeEvents = {
    "run-s": [
      { type: "run-started", at: ago(90) },
      { type: "step-completed", name: "x", at: ago(45) },
    ],
    "run-n": [{ type: "run-started", at: ago(45) }],
  };
  const snapshot = await computeHealth({
    runtime: fakeRuntime([meta("run-s", "wake", ago(45)), meta("run-n", "sleeping", ago(45))], events),
    fleet: fakeFleet([]),
    owner: "w",
    activeRuns: 0,
    now: () => NOW,
  });
  const warnings = healthWarnings(snapshot);
  assert.ok(warnings.some((l) => l === "run run-s looks stuck: no event for 45m (status wake)"));
  assert.ok(warnings.some((l) => l === "run run-n was enqueued 45m ago and never started"));
});

test("an unreadable event log degrades to updatedAt instead of throwing", async () => {
  const rt = {
    listMeta: async () => [meta("run-x", "wake", ago(120))],
    store: {
      load: async () => {
        throw new Error("store unreachable");
      },
    },
  };
  const snapshot = await computeHealth({
    runtime: rt,
    fleet: fakeFleet([]),
    owner: "w",
    activeRuns: 0,
    now: () => NOW,
  });
  assert.deepEqual(snapshot.neverStarted.map((s) => s.runId), ["run-x"]);
});

test("selfwatchOnce emits the snapshot to Observe and logs anomalies locally", async () => {
  const logs: string[] = [];
  const emitted: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
  const emitter = {
    enabled: true,
    emitLog: (e: { level: string; message: string; attributes?: Record<string, unknown> }) => {
      emitted.push(e);
    },
  };
  const events: FakeEvents = {
    "run-s": [
      { type: "run-started", at: ago(90) },
      { type: "step-completed", name: "x", at: ago(40) },
    ],
  };
  await selfwatchOnce({
    runtime: fakeRuntime([meta("run-s", "wake", ago(40))], events),
    fleet: fakeFleet([]),
    owner: "w",
    activeRuns: 0,
    now: () => NOW,
    emitter,
    log: (line) => logs.push(line),
  });

  assert.ok(logs.some((l) => l.includes("run-s looks stuck")), "the anomaly is logged locally");
  assert.equal(emitted.length, 2, "one snapshot line + one per stuck run");
  assert.equal(emitted[0]!.level, "warn");
  assert.match(emitted[0]!.message, /1 stuck/);
  assert.equal(emitted[0]!.attributes!.queueDepth, 1);
  assert.equal(emitted[1]!.attributes!.runId, "run-s");
});

test("makeObserveLogEmitter is a no-op without the env pair", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_API_KEY;
  assert.equal(makeObserveLogEmitter().enabled, false);
});
