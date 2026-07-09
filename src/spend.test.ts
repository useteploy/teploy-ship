import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSpendStore, utcDay } from "./spend.js";

async function store(): Promise<FileSpendStore> {
  return new FileSpendStore(await mkdtemp(join(tmpdir(), "spend-")));
}

const DAY = "2026-07-09";

test("add accumulates per (source, day); get reads the running total", async () => {
  const s = await store();
  await s.add("forgejo", DAY, 0.01);
  await s.add("forgejo", DAY, 0.02);
  await s.add("github", DAY, 0.05);
  assert.equal(await s.get("forgejo", DAY), 0.03);
  assert.equal(await s.get("github", DAY), 0.05);
  assert.equal(await s.get("forgejo", "2026-07-10"), 0, "a new day starts at zero");
  assert.equal(await s.get("nobody", DAY), 0, "unknown source is zero, not NaN");
});

test("add ignores zero, negative, and NaN amounts", async () => {
  const s = await store();
  await s.add("forgejo", DAY, 0.5);
  await s.add("forgejo", DAY, 0);
  await s.add("forgejo", DAY, -1);
  await s.add("forgejo", DAY, Number.NaN);
  assert.equal(await s.get("forgejo", DAY), 0.5, "only the positive add counts");
});

test("list returns every (day, source, amount) bucket", async () => {
  const s = await store();
  await s.add("forgejo", DAY, 0.1);
  await s.add("github", DAY, 0.2);
  await s.add("forgejo", "2026-07-10", 0.3);
  const entries = await s.list();
  assert.equal(entries.length, 3);
  const total = entries.reduce((a, e) => a + e.amountUSD, 0);
  assert.ok(Math.abs(total - 0.6) < 1e-9);
  assert.ok(entries.every((e) => typeof e.day === "string" && typeof e.source === "string"));
});

test("list on an empty store is [] not a throw", async () => {
  assert.deepEqual(await (await store()).list(), []);
});

test("utcDay is a YYYY-MM-DD UTC bucket", () => {
  assert.equal(utcDay(new Date("2026-07-09T23:59:59.000Z")), "2026-07-09");
  assert.equal(utcDay(new Date("2026-07-10T00:00:01.000Z")), "2026-07-10");
});
