import assert from "node:assert/strict";
import { test } from "node:test";

import { roughDuration, typicalDuration } from "./expect.js";

const run = (runId: string, status: string, minutes: number) => ({
  runId,
  status,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: new Date(Date.parse("2026-09-15T10:00:00.000Z") + minutes * 60_000).toISOString(),
});

test("typicalDuration: median of completed runs on the same repo, current run and other repos excluded", () => {
  const runs = [run("a", "completed", 10), run("b", "completed", 30), run("c", "completed", 200), run("me", "executing", 5), run("x", "completed", 999)];
  const t = typicalDuration(runs, new Set(["a", "b", "c", "me"]), "me");
  assert.deepEqual(t, { medianMs: 30 * 60_000, n: 3 });
});

test("typicalDuration: fewer than two samples is no expectation; failed runs do not count", () => {
  const runs = [run("a", "completed", 10), run("b", "failed", 30)];
  assert.equal(typicalDuration(runs, new Set(["a", "b"])), null);
  assert.deepEqual(typicalDuration([run("a", "completed", 10), run("b", "completed", 20)], new Set(["a", "b"])), { medianMs: 15 * 60_000, n: 2 });
});

test("roughDuration is coarse", () => {
  assert.equal(roughDuration(20_000), "under a minute");
  assert.equal(roughDuration(4 * 60_000), "4 min");
  assert.equal(roughDuration(80 * 60_000), "1 h 20 min");
  assert.equal(roughDuration(27 * 3_600_000), "1 d 3 h");
});

test("typicalDuration: a run parked at the merge boundary counts as finished work; other parks do not", () => {
  const parked = { ...run("p", "waiting", 20), eventName: "approve-merge" };
  const asking = { ...run("q", "waiting", 5), eventName: "turn-2-ask" };
  assert.deepEqual(typicalDuration([run("a", "completed", 10), parked, asking], new Set(["a", "p", "q"])), { medianMs: 15 * 60_000, n: 2 });
});
