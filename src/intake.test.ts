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
