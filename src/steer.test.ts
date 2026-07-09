import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileSteerStore } from "./steer.js";

test("steer: add → pending → drain consumes oldest-first, once", async () => {
  const store = new FileSteerStore(await mkdtemp(join(tmpdir(), "steer-")));

  assert.deepEqual(await store.drain("run-1"), [], "empty store drains empty");

  await store.add("run-1", "focus on the parser");
  await store.add("run-1", "skip the docs");
  await store.add("run-2", "other run");

  const pending = await store.pending("run-1");
  assert.deepEqual(pending.map((n) => n.text), ["focus on the parser", "skip the docs"]);

  assert.deepEqual(await store.drain("run-1"), ["focus on the parser", "skip the docs"]);
  assert.deepEqual(await store.drain("run-1"), [], "drained notes are gone");
  assert.deepEqual(await store.pending("run-1"), []);

  // other runs are untouched
  assert.deepEqual(await store.drain("run-2"), ["other run"]);

  // notes added after a drain surface on the next drain
  await store.add("run-1", "also fix the tests");
  assert.deepEqual(await store.drain("run-1"), ["also fix the tests"]);
});
