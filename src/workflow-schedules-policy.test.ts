import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scheduleKey,
  scheduleReceiptKey,
  scheduleFiredKey,
  sweepWorkflowSchedules,
  validSchedule,
  workflowSchedules,
} from "./workflow-schedules.js";
import { FileRuntimeConfig } from "./runtime-config.js";
import { FileIntakeStore } from "./intake.js";

const legacy = (now: number, extra: Record<string, unknown> = {}) => ({
  id: "test",
  name: "Review",
  repo: "team/repo",
  task: "Inspect only",
  mode: "scan",
  plan: false,
  everyMinutes: 60,
  enabled: true,
  createdAt: new Date(now - 7200000).toISOString(),
  by: "tester",
  ...extra,
});

async function setup(def: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "ship-schedule-policy-"));
  const config = new FileRuntimeConfig(dir);
  const intake = new FileIntakeStore(join(dir, "tasks"));
  const stored = JSON.stringify(def);
  await config.set(scheduleKey(String(def.id)), stored);
  const runtime = { config, intake, projects: { forRepo: async () => ({ url: "https://github.com/team/repo" }) } } as any;
  return { config, intake, runtime, stored };
}

test("legacy schedule: behaviour and stored bytes are unchanged by the S16 fields", async () => {
  const now = Date.now();
  const def = legacy(now);
  const { config, intake, runtime, stored } = await setup(def);
  await sweepWorkflowSchedules(runtime, now);
  await sweepWorkflowSchedules(runtime, now);
  const tasks = await intake.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].dedupeKey, "workflow:test:2");
  assert.equal(await config.get(scheduleReceiptKey("test")), "2");
  assert.equal(await config.get(scheduleKey("test")), stored, "the schedule definition is never rewritten");
  assert.equal(await config.get(scheduleFiredKey("test")), undefined, "no new keys for schedules without debounce");
});

test("legacy schedule after a long outage still coalesces to one proposal", async () => {
  const now = Date.now();
  const { intake, runtime } = await setup(legacy(now, { createdAt: new Date(now - 90 * 86400000).toISOString() }));
  await sweepWorkflowSchedules(runtime, now);
  assert.equal((await intake.list()).length, 1);
});

test("a legacy receipt written by the old sweep is honoured (no double proposal on upgrade)", async () => {
  const now = Date.now();
  const { config, intake, runtime } = await setup(legacy(now));
  await config.set(scheduleReceiptKey("test"), "2");
  await sweepWorkflowSchedules(runtime, now);
  assert.equal((await intake.list()).length, 0);
});

test("validSchedule accepts the optional fields and refuses bad ones", () => {
  const now = Date.now();
  assert.equal(validSchedule(legacy(now)), true);
  const good = legacy(now, {
    everyMinutes: 1440,
    at: { timezone: "America/New_York", time: "09:00", days: ["mon", "fri"] },
    missedPolicy: { kind: "catch-up", max: 3 },
    overlap: "queue",
    debounceMinutes: 30,
  });
  assert.equal(validSchedule(good), true);
  assert.equal(validSchedule({ ...good, at: { timezone: "Mars/Olympus", time: "09:00" } }), false);
  assert.equal(validSchedule({ ...good, at: { timezone: "UTC", time: "9am" } }), false);
  assert.equal(validSchedule({ ...good, missedPolicy: "yolo" }), false);
  assert.equal(validSchedule({ ...good, overlap: "pile-on" }), false);
  assert.equal(validSchedule({ ...good, debounceMinutes: -1 }), false);
});

test("a stored schedule with an invalid timezone is dropped from the list, not fired as UTC", async () => {
  const now = Date.now();
  const { intake, runtime } = await setup(legacy(now, { at: { timezone: "Mars/Olympus", time: "09:00" } }));
  assert.deepEqual(await workflowSchedules(runtime), []);
  await sweepWorkflowSchedules(runtime, now);
  assert.equal((await intake.list()).length, 0);
});

const NY_DAILY = (createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: "daily",
  name: "Morning review",
  repo: "team/repo",
  task: "Look",
  mode: "scan",
  plan: false,
  everyMinutes: 1440,
  enabled: true,
  createdAt,
  by: "tester",
  at: { timezone: "America/New_York", time: "01:30" },
  ...extra,
});

test("timezone schedule: fall-back night produces exactly one proposal across many sweeps", async () => {
  const { intake, runtime } = await setup(NY_DAILY("2026-10-30T00:00:00Z"));
  // Sweep every 10 minutes from Oct 31 20:00Z to Nov 1 12:00Z, spanning both 01:30s.
  for (let t = Date.parse("2026-10-31T20:00:00Z"); t <= Date.parse("2026-11-01T12:00:00Z"); t += 10 * 60000) {
    await sweepWorkflowSchedules(runtime, t);
  }
  const keys = (await intake.list()).map((x) => x.dedupeKey).sort();
  assert.deepEqual(keys, ["workflow:daily:20261031", "workflow:daily:20261101"]);
});

test("timezone schedule: a crash between propose and receipt cannot duplicate (intake dedupeKey)", async () => {
  const { config, intake, runtime } = await setup(NY_DAILY("2026-06-01T00:00:00Z"));
  const now = Date.parse("2026-06-10T12:00:00Z");
  await sweepWorkflowSchedules(runtime, now);
  await config.remove(scheduleReceiptKey("daily")); // simulate dying before the receipt write
  await sweepWorkflowSchedules(runtime, now);
  assert.equal((await intake.list()).length, 1);
});

test("catch-up(3) proposes three distinct occurrences; run-once proposes one", async () => {
  const now = Date.parse("2026-06-11T18:00:00Z");
  const a = await setup(NY_DAILY("2026-06-01T00:00:00Z", { missedPolicy: { kind: "catch-up", max: 3 } }));
  await a.config.set(scheduleReceiptKey("daily"), "20260607");
  await sweepWorkflowSchedules(a.runtime, now);
  assert.deepEqual((await a.intake.list()).map((x) => x.dedupeKey).sort(), [
    "workflow:daily:20260609",
    "workflow:daily:20260610",
    "workflow:daily:20260611",
  ]);
  await sweepWorkflowSchedules(a.runtime, now + 60000);
  assert.equal((await a.intake.list()).length, 3, "a second sweep adds nothing");

  const b = await setup(NY_DAILY("2026-06-01T00:00:00Z"));
  await b.config.set(scheduleReceiptKey("daily"), "20260607");
  await sweepWorkflowSchedules(b.runtime, now);
  assert.equal((await b.intake.list()).length, 1);
});

test("overlap skip/queue are enforced through the sweep when the caller reports a running occurrence", async () => {
  const now = Date.parse("2026-06-10T14:00:00Z");
  const skip = await setup(NY_DAILY("2026-06-01T00:00:00Z", { overlap: "skip", at: { timezone: "America/New_York", time: "09:00" } }));
  await skip.config.set(scheduleReceiptKey("daily"), "20260609");
  await sweepWorkflowSchedules(skip.runtime, now, { isRunning: async () => true });
  assert.equal((await skip.intake.list()).length, 0);
  assert.equal(await skip.config.get(scheduleReceiptKey("daily")), "20260610");

  const queue = await setup(NY_DAILY("2026-06-01T00:00:00Z", { overlap: "queue", at: { timezone: "America/New_York", time: "09:00" } }));
  await queue.config.set(scheduleReceiptKey("daily"), "20260609");
  await sweepWorkflowSchedules(queue.runtime, now, { isRunning: async () => true });
  assert.equal((await queue.intake.list()).length, 0);
  assert.equal(await queue.config.get(scheduleReceiptKey("daily")), "20260609");
  await sweepWorkflowSchedules(queue.runtime, now + 600000, { isRunning: async () => false });
  assert.equal((await queue.intake.list()).length, 1);

  // Without an isRunning callback (what the worker passes today) overlap cannot be detected, so it fires.
  const none = await setup(NY_DAILY("2026-06-01T00:00:00Z", { overlap: "skip", at: { timezone: "America/New_York", time: "09:00" } }));
  await none.config.set(scheduleReceiptKey("daily"), "20260609");
  await sweepWorkflowSchedules(none.runtime, now);
  assert.equal((await none.intake.list()).length, 1);
});

test("debounce persists the last fired slot so dropping slots does not reset the window", async () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const { config, intake, runtime } = await setup(legacy(t0 + 0, { createdAt: new Date(t0).toISOString(), debounceMinutes: 150 }));
  for (let t = t0 + 30 * 60000; t <= t0 + 12.5 * 3600000; t += 10 * 60000) await sweepWorkflowSchedules(runtime, t);
  assert.deepEqual((await intake.list()).map((x) => x.dedupeKey).sort(), [
    "workflow:test:1",
    "workflow:test:10",
    "workflow:test:4",
    "workflow:test:7",
  ]);
  assert.equal(await config.get(scheduleFiredKey("test")), "10");
});
