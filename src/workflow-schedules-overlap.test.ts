// S16 overlap enforcement through the REAL sweep path (sweepSchedulesForWorker,
// the function the worker calls) with a fake store holding a running run. The
// flag (SHIP_SCHEDULE_OVERLAP) is off by default; off must behave exactly as
// before, i.e. overlap policies stay inert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scheduleKey,
  scheduleReceiptKey,
  scheduleOverlapEnabled,
  makeScheduleIsRunning,
  sweepSchedulesForWorker,
} from "./workflow-schedules.js";
import { FileRuntimeConfig } from "./runtime-config.js";
import { FileIntakeStore } from "./intake.js";

const NOW = Date.parse("2026-06-10T14:00:00Z");
const def = (overlap?: string) => ({
  id: "daily",
  name: "Morning review",
  repo: "team/repo",
  task: "Look",
  mode: "scan",
  plan: false,
  everyMinutes: 1440,
  enabled: true,
  createdAt: "2026-06-01T00:00:00Z",
  by: "tester",
  at: { timezone: "America/New_York", time: "09:00" },
  ...(overlap !== undefined ? { overlap } : {}),
});

const startedEvents = (dedupeKey: string) => [
  { type: "run-started", at: "2026-06-09T13:00:00Z", seq: 0, data: { input: { task: "x", origin: { source: "workflow", dedupeKey } } } },
];

interface FakeRun { runId: string; status: string; source?: string; dedupeKey: string; unreadable?: boolean }

async function setup(overlap: string | undefined, runs: FakeRun[]) {
  const dir = await mkdtemp(join(tmpdir(), "ship-schedule-overlap-"));
  const config = new FileRuntimeConfig(dir);
  const intake = new FileIntakeStore(join(dir, "tasks"));
  await config.set(scheduleKey("daily"), JSON.stringify(def(overlap)));
  await config.set(scheduleReceiptKey("daily"), "20260609");
  const loads: string[] = [];
  const runtime = {
    config,
    intake,
    projects: { forRepo: async () => ({ url: "https://github.com/team/repo" }) },
    listMeta: async () =>
      runs.map((r) => ({ runId: r.runId, task: "t", status: r.status, model: "m", createdAt: "", updatedAt: "", source: r.source ?? "workflow" })),
    store: {
      load: async (id: string) => {
        loads.push(id);
        const r = runs.find((x) => x.runId === id)!;
        if (r.unreadable) throw new Error("boom");
        return startedEvents(r.dedupeKey);
      },
    },
  } as any;
  return { config, intake, runtime, loads };
}

const running: FakeRun = { runId: "r1", status: "running", dedupeKey: "workflow:daily:20260609" };
const ON = { SHIP_SCHEDULE_OVERLAP: "on" } as NodeJS.ProcessEnv;
const log = (_line: string) => {};

test("flag parsing: off unless explicitly on", () => {
  assert.equal(scheduleOverlapEnabled({}), false);
  assert.equal(scheduleOverlapEnabled({ SHIP_SCHEDULE_OVERLAP: "off" }), false);
  assert.equal(scheduleOverlapEnabled({ SHIP_SCHEDULE_OVERLAP: "ON" }), true);
});

test("flag on, skip: a running occurrence skips the slot and advances the receipt", async () => {
  const s = await setup("skip", [running]);
  await sweepSchedulesForWorker(s.runtime, log, ON, NOW);
  assert.equal((await s.intake.list()).length, 0);
  assert.equal(await s.config.get(scheduleReceiptKey("daily")), "20260610");
});

test("flag on, queue: defers (receipt held), fires once the run settles", async () => {
  const runs = [{ ...running }];
  const s = await setup("queue", runs);
  await sweepSchedulesForWorker(s.runtime, log, ON, NOW);
  assert.equal((await s.intake.list()).length, 0);
  assert.equal(await s.config.get(scheduleReceiptKey("daily")), "20260609");
  runs[0].status = "completed";
  await sweepSchedulesForWorker(s.runtime, log, ON, NOW + 600000);
  assert.equal((await s.intake.list()).length, 1);
});

test("flag on, allow (and no policy): still fires while a run is live", async () => {
  for (const policy of ["allow", undefined]) {
    const s = await setup(policy, [running]);
    await sweepSchedulesForWorker(s.runtime, log, ON, NOW);
    assert.equal((await s.intake.list()).length, 1, String(policy));
  }
});

test("flag off (default): skip policy is ignored exactly as before, and no run logs are loaded", async () => {
  const s = await setup("skip", [running]);
  await sweepSchedulesForWorker(s.runtime, log, {}, NOW);
  assert.equal((await s.intake.list()).length, 1);
  assert.deepEqual(s.loads, []);
});

test("a different schedule's running occurrence does not block this one", async () => {
  const s = await setup("skip", [{ ...running, dedupeKey: "workflow:other:20260609" }]);
  await sweepSchedulesForWorker(s.runtime, log, ON, NOW);
  assert.equal((await s.intake.list()).length, 1);
});

test("the index loads only non-terminal workflow runs, once per sweep", async () => {
  const s = await setup("skip", [
    running,
    { runId: "done", status: "completed", dedupeKey: "workflow:daily:1" },
    { runId: "manual", status: "running", source: "manual", dedupeKey: "workflow:daily:2" },
  ]);
  const isRunning = makeScheduleIsRunning(s.runtime);
  assert.equal(await isRunning("daily"), true);
  assert.equal(await isRunning("daily"), true);
  assert.deepEqual(s.loads, ["r1"]);
});

test("an unreadable live run log fails closed (treated as running)", async () => {
  const s = await setup("skip", [{ ...running, unreadable: true }]);
  await sweepSchedulesForWorker(s.runtime, log, ON, NOW);
  assert.equal((await s.intake.list()).length, 0);
});
