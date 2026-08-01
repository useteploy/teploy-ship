import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileSteerStore } from "./steer.js";

test("steer: add → pending → drain consumes oldest-first, once", async () => {
  const store = new FileSteerStore(await mkdtemp(join(tmpdir(), "steer-")));

  assert.deepEqual(await store.drain("run-1", 0), [], "empty store drains empty");

  await store.add("run-1", "focus on the parser");
  await store.add("run-1", "skip the docs");
  await store.add("run-2", "other run");

  const pending = await store.pending("run-1");
  assert.deepEqual(pending.map((n) => n.text), ["focus on the parser", "skip the docs"]);

  assert.deepEqual(await store.drain("run-1", 0), ["focus on the parser", "skip the docs"]);
  assert.deepEqual(await store.drain("run-1", 1), [], "a later turn sees nothing new");
  assert.deepEqual(await store.pending("run-1"), []);

  // other runs are untouched
  assert.deepEqual(await store.drain("run-2", 0), ["other run"]);

  // notes added after a drain surface on the next turn
  await store.add("run-1", "also fix the tests");
  assert.deepEqual(await store.drain("run-1", 2), ["also fix the tests"]);
});

test("TS-014: re-draining the SAME turn returns the same notes (replay safety)", async () => {
  // The durable loop drains inside a recorded step, so the store is mutated
  // before the step result is committed. A crash in that window replays the
  // callback — which must hand back the notes it already consumed, not an
  // empty list that silently drops the operator's instruction.
  const store = new FileSteerStore(await mkdtemp(join(tmpdir(), "steer-replay-")));
  await store.add("run-9", "use the new parser");
  await store.add("run-9", "and add a test");

  const first = await store.drain("run-9", 3);
  assert.deepEqual(first, ["use the new parser", "and add a test"]);
  assert.deepEqual(await store.drain("run-9", 3), first, "replaying turn 3 replays its notes");
  assert.deepEqual(await store.drain("run-9", 3), first, "and again — the call is pure on replay");

  // A note that arrived after turn 3 claimed its range still belongs to a later turn.
  await store.add("run-9", "one more thing");
  assert.deepEqual(await store.drain("run-9", 3), first, "turn 3's set does not grow");
  assert.deepEqual(await store.drain("run-9", 4), ["one more thing"]);
});
