import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileDeliveryLog, NucleusDeliveryLog } from "./deliveries.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

test("TS-029: a replayed delivery id is claimed once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-deliveries-"));
  try {
    const log = new FileDeliveryLog(dir);
    assert.equal(await log.claim("github", "abc-123"), true, "first delivery is new");
    assert.equal(await log.claim("github", "abc-123"), false, "replay is refused");
    assert.equal(await log.claim("github", "abc-124"), true, "a different delivery still passes");
    // Ids are namespaced by source: two forges can mint the same id.
    assert.equal(await log.claim("forgejo", "abc-123"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Nucleus log claims through an atomic setNX with a TTL", async () => {
  const seen = new Map<string, string>();
  const calls: Array<{ key: string; ttl?: number }> = [];
  const db = {
    kv: {
      setNX: async (key: string, value: string, opts?: { ttl?: number }): Promise<boolean> => {
        calls.push({ key, ...(opts?.ttl !== undefined ? { ttl: opts.ttl } : {}) });
        if (seen.has(key)) return false;
        seen.set(key, value);
        return true;
      },
    },
  } as unknown as NucleusPgwire;

  const log = new NucleusDeliveryLog(db);
  assert.equal(await log.claim("github", "d1"), true);
  assert.equal(await log.claim("github", "d1"), false);
  assert.equal(calls[0]!.key, "ship:delivery:github:d1");
  assert.ok((calls[0]!.ttl ?? 0) > 0, "entries must expire so the ledger cannot grow forever");
});
