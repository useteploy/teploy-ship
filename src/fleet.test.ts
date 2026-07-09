import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileFleetStore, FilePlacementStore } from "./fleet.js";
import type { WorkerInfo } from "./fleet.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-"));
}

function worker(owner: string, activeRuns: number, lastSeen: string): WorkerInfo {
  return { owner, host: "h1", sandbox: "host", maxConcurrent: 5, activeRuns, startedAt: "2026-07-09T00:00:00Z", lastSeen };
}

test("heartbeat upserts by owner — a second beat updates, not duplicates", async () => {
  const s = new FileFleetStore(await tmp());
  await s.heartbeat(worker("w1", 1, "2026-07-09T00:00:00Z"));
  await s.heartbeat(worker("w1", 3, "2026-07-09T00:00:15Z"));
  await s.heartbeat(worker("w2", 0, "2026-07-09T00:00:15Z"));
  const all = await s.list();
  assert.equal(all.length, 2, "w1 updated in place, w2 added");
  const w1 = all.find((w) => w.owner === "w1");
  assert.equal(w1?.activeRuns, 3, "latest heartbeat wins");
  assert.equal(w1?.lastSeen, "2026-07-09T00:00:15Z");
});

test("list on an empty registry is [] not a throw", async () => {
  assert.deepEqual(await new FileFleetStore(await tmp()).list(), []);
});

test("placement set/get/all round-trips; set overwrites", async () => {
  const p = new FilePlacementStore(await tmp());
  assert.equal(await p.get("run-1"), null, "unknown run is null");
  await p.set("run-1", "host-a");
  await p.set("run-2", "host-b");
  await p.set("run-1", "host-c"); // overwrite
  assert.equal(await p.get("run-1"), "host-c");
  assert.deepEqual(await p.all(), { "run-1": "host-c", "run-2": "host-b" });
});

test("placement all() on an empty store is {} not a throw", async () => {
  assert.deepEqual(await new FilePlacementStore(await tmp()).all(), {});
});
