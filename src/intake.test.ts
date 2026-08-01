import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileIntakeStore } from "./intake.js";

test("intake: propose dedupes on key, dismiss frees the key, launch links the run", async () => {
  const store = new FileIntakeStore(await mkdtemp(join(tmpdir(), "intake-")));

  const first = await store.propose({ source: "forgejo", kind: "issue", title: "fix median", dedupeKey: "forgejo:o/r#1", repo: "http://x/o/r.git" });
  assert.equal(first.created, true);

  // storm: same key re-proposed -> the existing task, no duplicate
  const again = await store.propose({ source: "forgejo", kind: "issue", title: "fix median (redelivered)", dedupeKey: "forgejo:o/r#1" });
  assert.equal(again.created, false);
  assert.equal(again.task.taskId, first.task.taskId);
  assert.equal((await store.list("proposed")).length, 1);

  // launch links the run and leaves the key occupied
  await store.setState(first.task.taskId, "launched", "run-abc");
  assert.equal((await store.get(first.task.taskId))?.runId, "run-abc");
  const relaunched = await store.propose({ source: "forgejo", kind: "issue", title: "x", dedupeKey: "forgejo:o/r#1" });
  assert.equal(relaunched.created, false, "launched tasks still hold their dedupe key");

  // a different issue is a different task
  const other = await store.propose({ source: "forgejo", kind: "issue", title: "y", dedupeKey: "forgejo:o/r#2" });
  assert.equal(other.created, true);

  // dismissing releases the key for future proposals
  await store.setState(other.task.taskId, "dismissed");
  const reopened = await store.propose({ source: "forgejo", kind: "issue", title: "y again", dedupeKey: "forgejo:o/r#2" });
  assert.equal(reopened.created, true);
});

test("intake: claim wins once on a proposed task and refuses everything else", async () => {
  const store = new FileIntakeStore(await mkdtemp(join(tmpdir(), "intake-")));
  const { task } = await store.propose({ source: "forgejo", kind: "issue", title: "z", dedupeKey: "forgejo:o/r#9" });

  assert.equal(await store.claim(task.taskId), true, "first claim wins");
  assert.equal((await store.get(task.taskId))?.state, "launched");
  assert.equal(await store.claim(task.taskId), false, "a claimed task cannot be claimed again");

  // Releasing (launch failed) makes it claimable again.
  await store.setState(task.taskId, "proposed");
  assert.equal(await store.claim(task.taskId), true);

  const { task: gone } = await store.propose({ source: "forgejo", kind: "issue", title: "w", dedupeKey: "forgejo:o/r#10" });
  await store.setState(gone.taskId, "dismissed");
  assert.equal(await store.claim(gone.taskId), false, "dismissed tasks are not claimable");
  assert.equal(await store.claim("task-missing"), false, "unknown ids are not claimable");
});

test("TS-012: a claim records the run id, so a launch that never landed can be released", async () => {
  const store = new FileIntakeStore(await mkdtemp(join(tmpdir(), "intake-reconcile-")));
  const { task } = await store.propose({
    source: "forgejo",
    kind: "issue",
    title: "fix it",
    dedupeKey: "forgejo:1",
  });

  // The worker claims for a run it is about to enqueue, then dies.
  assert.equal(await store.claim(task.taskId, "run-ghost"), true);
  const claimed = await store.get(task.taskId);
  assert.equal(claimed?.state, "launched");
  assert.equal(claimed?.runId, "run-ghost", "the run id is written WITH the claim, not after it");

  // Reconcile sees a task pointing at a run with no events and puts it back.
  const released = await store.reconcile(async () => false);
  assert.deepEqual(released, [task.taskId]);
  assert.equal((await store.get(task.taskId))?.state, "proposed");

  // A task whose run really exists is left alone.
  assert.equal(await store.claim(task.taskId, "run-real"), true);
  assert.deepEqual(await store.reconcile(async () => true), []);
  assert.equal((await store.get(task.taskId))?.state, "launched");
});

test("a claim still collapses two racing launchers to one", async () => {
  const store = new FileIntakeStore(await mkdtemp(join(tmpdir(), "intake-race-")));
  const { task } = await store.propose({ source: "slack", kind: "mention", title: "t", dedupeKey: "slack:1" });
  assert.equal(await store.claim(task.taskId, "run-a"), true);
  assert.equal(await store.claim(task.taskId, "run-b"), false, "the second launcher loses");
  assert.equal((await store.get(task.taskId))?.runId, "run-a");
});
