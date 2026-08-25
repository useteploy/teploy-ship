import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSpendStore, FileUnpricedRunStore, utcDay } from "./spend.js";

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

test("unpriced runs are counted per source and day, once per run id", async () => {
  const store = new FileUnpricedRunStore(await mkdtemp(join(tmpdir(), "unpriced-")));
  assert.equal(await store.count("forgejo", "2026-08-24"), 0);
  await store.add("forgejo", "2026-08-24", "run-1");
  await store.add("forgejo", "2026-08-24", "run-2");
  await store.add("forgejo", "2026-08-24", "run-2"); // a double settle is not a third run
  await store.add("github", "2026-08-24", "run-3");
  await store.add("forgejo", "2026-08-23", "run-0");
  assert.equal(await store.count("forgejo", "2026-08-24"), 2);
  assert.equal(await store.count("github", "2026-08-24"), 1);
  const list = (await store.list()).sort((a, b) => `${a.day}${a.source}`.localeCompare(`${b.day}${b.source}`));
  assert.deepEqual(list, [
    { day: "2026-08-23", source: "forgejo", runs: 1 },
    { day: "2026-08-24", source: "forgejo", runs: 2 },
    { day: "2026-08-24", source: "github", runs: 1 },
  ]);
});
