import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sweepScheduleDigests,
  scheduleDigestHistory,
  scheduleDigestKey,
  DIGEST_LIMIT,
} from "./workflow-schedules.js";
import { FileRuntimeConfig } from "./runtime-config.js";
import type { RunMeta } from "./run-store.js";

const T0 = "2026-09-22T10:00:00.000Z";
const T1 = "2026-09-22T10:40:00.000Z";

const meta = (runId: string, status: string, source = "workflow"): RunMeta => ({
  runId,
  task: "Scheduled review",
  status,
  model: "test-model",
  createdAt: T0,
  updatedAt: T1,
  ...(source !== undefined ? { source } : {}),
});

const eventsOf = (
  dedupeKey: string | undefined,
  terminal: { type: string; data?: unknown; at?: string } | undefined,
): any[] => [
  {
    type: "run-started",
    at: T0,
    seq: 0,
    data: {
      input: {
        task: "Scheduled review",
        ...(dedupeKey !== undefined ? { origin: { source: "workflow", dedupeKey } } : {}),
      },
    },
  },
  ...(terminal !== undefined
    ? [{ type: terminal.type, at: terminal.at ?? T1, seq: 1, data: terminal.data }]
    : []),
];

function runtime(dir: string, metas: RunMeta[], events: Map<string, any[]>) {
  return {
    config: new FileRuntimeConfig(dir),
    listMeta: async () => metas,
    store: { load: async (runId: string) => events.get(runId) ?? [] },
  } as any;
}

test("a settled schedule occurrence is digested with outcome, summary and cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-digest-test-"));
  const rt = runtime(
    dir,
    [meta("run-ok", "completed")],
    new Map([
      [
        "run-ok",
        eventsOf("workflow:test:3", {
          type: "run-completed",
          data: { output: { summary: "Two findings, both advisory", usage: { totalTokens: 100, costUSD: 0.25 } } },
        }),
      ],
    ]),
  );
  assert.equal(await sweepScheduleDigests(rt), 1);
  const [entry] = await scheduleDigestHistory(rt, "test");
  assert.equal(entry.runId, "run-ok");
  assert.equal(entry.scheduleId, "test");
  assert.equal(entry.outcome, "completed");
  assert.equal(entry.summary, "Two findings, both advisory");
  assert.equal(entry.costUSD, 0.25);
  assert.equal(entry.at, T1);
});

test("restarts never duplicate: the recorded key makes re-sweeps and fresh processes no-ops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-digest-idem-"));
  const metas = [meta("run-once", "completed")];
  const events = new Map([
    ["run-once", eventsOf("workflow:test:4", { type: "run-completed", data: { output: { summary: "Done" } } })],
  ]);
  const first = runtime(dir, metas, events);
  await sweepScheduleDigests(first);
  const bytes = await first.config.get(scheduleDigestKey("run-once"));
  // Same process re-sweeps (overlapping ticks), then a brand-new process over
  // the same store "restarts": neither may add or mutate anything.
  assert.equal(await sweepScheduleDigests(first), 0);
  const restarted = runtime(dir, metas, events);
  assert.equal(await sweepScheduleDigests(restarted), 0);
  assert.equal(await restarted.config.get(scheduleDigestKey("run-once")), bytes);
  assert.equal((await scheduleDigestHistory(restarted, "test")).length, 1);
});

test("failed occurrences carry the failure reason; foreign and unsettled runs are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-digest-fail-"));
  const rt = runtime(
    dir,
    [meta("run-bad", "failed"), meta("run-foreign", "completed", "github"), meta("run-open", "waiting")],
    new Map([
      ["run-bad", eventsOf("workflow:test:5", { type: "run-failed", data: { error: "sandbox create failed" } })],
      ["run-foreign", eventsOf("workflow:test:6", { type: "run-completed", data: { output: { summary: "x" } } })],
      ["run-open", eventsOf("workflow:test:7", undefined)],
    ]),
  );
  assert.equal(await sweepScheduleDigests(rt), 1);
  const [entry] = await scheduleDigestHistory(rt, "test");
  assert.equal(entry.runId, "run-bad");
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.summary, "sandbox create failed");
  // A waiting run contributed no entry at all.
  assert.equal((await scheduleDigestHistory(rt)).length, 1);
});

test("history is bounded: only the newest occurrences surface and the store prunes the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-digest-cap-"));
  const count = 25;
  const metas: RunMeta[] = [];
  const events = new Map<string, any[]>();
  for (let i = 0; i < count; i++) {
    const runId = `run-${String(i).padStart(2, "0")}`;
    metas.push(meta(runId, "completed"));
    events.set(
      runId,
      eventsOf(`workflow:capped:${i}`, {
        type: "run-completed",
        data: { output: { summary: `occurrence ${i}` } },
        at: new Date(Date.parse(T0) + i * 60000).toISOString(),
      }),
    );
  }
  const rt = runtime(dir, metas, events);
  await sweepScheduleDigests(rt);
  const stored = await scheduleDigestHistory(rt, "capped");
  // Store cap keeps the run's history bounded; the digest surface reads the
  // newest DIGEST_LIMIT of whatever is stored.
  assert.ok(stored.length <= 20);
  assert.equal(stored.at(-1)!.runId, "run-24");
  const shown = stored.slice(-DIGEST_LIMIT);
  assert.equal(shown.length, DIGEST_LIMIT);
  assert.equal(shown[0].runId, "run-15");
  assert.equal(shown.at(-1)!.summary, "occurrence 24");
});
