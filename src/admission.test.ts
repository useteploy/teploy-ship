import assert from "node:assert/strict";
import test from "node:test";

import { LocalAdmission, NucleusAdmission, SLOT_TTL_S } from "./admission.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/** A KV that behaves like Nucleus's setNX/cdel/cexpire, with visible state. */
function kvDb(): { db: NucleusPgwire; keys: Map<string, string> } {
  const keys = new Map<string, string>();
  const db = {
    kv: {
      setNX: async (key: string, value: string): Promise<boolean> => {
        if (keys.has(key)) return false;
        keys.set(key, value);
        return true;
      },
      cdel: async (key: string, expected: string): Promise<boolean> => {
        if (keys.get(key) !== expected) return false;
        keys.delete(key);
        return true;
      },
      cexpire: async (key: string, expected: string): Promise<boolean> => keys.get(key) === expected,
    },
  } as unknown as NucleusPgwire;
  return { db, keys };
}

test("TS-004: concurrency slots are a shared semaphore across workers", async () => {
  const { db, keys } = kvDb();
  // Two workers, one Nucleus: a ceiling of 2 must hold across both.
  const a = new NucleusAdmission(db);
  const b = new NucleusAdmission(db);

  assert.equal(await a.acquireSlot("run-1", 2), true);
  assert.equal(await b.acquireSlot("run-2", 2), true);
  assert.equal(await a.acquireSlot("run-3", 2), false, "third run exceeds the fleet ceiling");
  assert.equal(await b.acquireSlot("run-4", 2), false);

  await a.releaseSlot("run-1");
  assert.equal(await b.acquireSlot("run-4", 2), true, "a freed slot is reusable by any worker");
  assert.equal(keys.size, 2);
});

test("a released slot only frees the run's own slot, never someone else's", async () => {
  const { db, keys } = kvDb();
  const a = new NucleusAdmission(db);
  const b = new NucleusAdmission(db);
  await a.acquireSlot("run-1", 1);
  // Simulate a's TTL lapsing and b taking the slot underneath it.
  keys.set("ship:slot:0", "run-2");
  await a.releaseSlot("run-1");
  assert.equal(keys.get("ship:slot:0"), "run-2", "cdel is value-conditional, so b keeps its slot");
});

test("acquireSlot is idempotent for a run that already holds one", async () => {
  const { db, keys } = kvDb();
  const a = new NucleusAdmission(db);
  assert.equal(await a.acquireSlot("run-1", 1), true);
  assert.equal(await a.acquireSlot("run-1", 1), true, "a retried sweep must not deadlock on itself");
  assert.equal(keys.size, 1);
});

test("a zero or negative ceiling means no ceiling", async () => {
  const { db } = kvDb();
  const a = new NucleusAdmission(db);
  assert.equal(await a.acquireSlot("run-1", 0), true);
  assert.equal(await a.takeDailyLaunch("forgejo", "2026-08-01", 0), true);
});

test("TS-004: the daily launch counter is shared and does not reset per worker", async () => {
  const { db } = kvDb();
  const a = new NucleusAdmission(db);
  const b = new NucleusAdmission(db);
  const day = "2026-08-01";

  assert.equal(await a.takeDailyLaunch("forgejo", day, 3), true);
  assert.equal(await b.takeDailyLaunch("forgejo", day, 3), true);
  assert.equal(await a.takeDailyLaunch("forgejo", day, 3), true);
  assert.equal(await b.takeDailyLaunch("forgejo", day, 3), false, "the fourth launch is over the shared cap");

  // Other sources and other days have their own budgets.
  assert.equal(await a.takeDailyLaunch("slack", day, 3), true);
  assert.equal(await a.takeDailyLaunch("forgejo", "2026-08-02", 3), true);
});

test("renewSlots keeps only the slots this worker holds alive", async () => {
  const { db, keys } = kvDb();
  const a = new NucleusAdmission(db);
  await a.acquireSlot("run-1", 2);
  await a.renewSlots();
  assert.equal(keys.get("ship:slot:0"), "run-1");
  assert.ok(SLOT_TTL_S > 0, "slots must expire so a dead worker cannot wedge the fleet");
});

test("LocalAdmission enforces the same contract for the single-process file runtime", async () => {
  const local = new LocalAdmission();
  assert.equal(await local.acquireSlot("run-1", 1), true);
  assert.equal(await local.acquireSlot("run-2", 1), false);
  await local.releaseSlot("run-1");
  assert.equal(await local.acquireSlot("run-2", 1), true);

  assert.equal(await local.takeDailyLaunch("s", "d", 1), true);
  assert.equal(await local.takeDailyLaunch("s", "d", 1), false);
});
