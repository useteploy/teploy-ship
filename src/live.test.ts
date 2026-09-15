import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileLiveStore, clipDetail, liveSink } from "./live.js";

test("FileLiveStore: set overwrites in place, get reads it back, recent orders newest first, clear forgets", async () => {
  const store = new FileLiveStore(await mkdtemp(join(tmpdir(), "live-")));
  await store.set("run-a", { phase: "thinking", turn: 1 });
  await store.set("run-a", { phase: "running", turn: 1, detail: "bash: pnpm test" });
  const a = await store.get("run-a");
  assert.equal(a?.phase, "running");
  assert.equal(a?.turn, 1);
  assert.equal(a?.detail, "bash: pnpm test");
  assert.ok(a !== null && Date.parse(a.updatedAt) > 0);

  await new Promise((r) => setTimeout(r, 5));
  await store.set("run-b", { phase: "harness", turn: 3, detail: "Edit src/x.ts", attempt: "attempt-1-" });
  const recent = await store.recent(10);
  assert.deepEqual(recent.map((s) => s.runId), ["run-b", "run-a"]);
  assert.equal(recent[0]?.attempt, "attempt-1-");
  assert.equal((await store.recent(1)).length, 1);

  await store.clear("run-a");
  assert.equal(await store.get("run-a"), null);
  assert.equal(await store.get("never"), null);
});

test("liveSink never throws and never awaits: a failing store is a no-op for the loop", async () => {
  let calls = 0;
  const failing = { set: async () => { calls++; throw new Error("store down"); } };
  const sink = liveSink(failing, "run-x", "attempt-0-");
  assert.ok(sink !== undefined);
  sink({ phase: "thinking", turn: 2 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  assert.equal(liveSink(undefined, "run-x"), undefined);
});

test("clipDetail: first line, bounded", () => {
  assert.equal(clipDetail("  pnpm test\nsecond line  "), "pnpm test");
  assert.equal(clipDetail("x".repeat(200), 20), `${"x".repeat(17)}...`);
});
