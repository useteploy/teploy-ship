import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilePolicyStore } from "./policies.js";

async function store(): Promise<FilePolicyStore> {
  return new FilePolicyStore(await mkdtemp(join(tmpdir(), "policies-")));
}

test("seed fills only absent sources, never overwriting an existing policy", async () => {
  const s = await store();
  await s.set({ source: "forgejo", policy: "auto" });
  await s.seed({ forgejo: "propose", github: "ignore" });

  const map = new Map((await s.list()).map((p) => [p.source, p.policy]));
  assert.equal(map.get("forgejo"), "auto", "seed must not clobber an explicit policy");
  assert.equal(map.get("github"), "ignore", "seed fills a missing source");
});

test("set round-trips policy and an optional per-source budget; update replaces", async () => {
  const s = await store();
  await s.set({ source: "forgejo", policy: "auto", dailyBudgetUSD: 5 });
  let row = (await s.list()).find((p) => p.source === "forgejo");
  assert.deepEqual(row, { source: "forgejo", policy: "auto", dailyBudgetUSD: 5 });

  // Re-setting with no budget drops the override rather than accumulating.
  await s.set({ source: "forgejo", policy: "propose" });
  row = (await s.list()).find((p) => p.source === "forgejo");
  assert.deepEqual(row, { source: "forgejo", policy: "propose" });
});

test("list on an empty/absent store is [] not a throw", async () => {
  const s = await store();
  assert.deepEqual(await s.list(), []);
});
