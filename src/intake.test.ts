import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileIntakeStore, NucleusIntakeStore, normalizeDedupeKey } from "./intake.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

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

test("file intake serializes simultaneous proposals and launch claims across store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-concurrent-"));
  const stores = [new FileIntakeStore(dir), new FileIntakeStore(dir)];
  const proposed = await Promise.all(Array.from({length:20}, (_,i) => stores[i%2]!.propose({source:"team-request",kind:"task",title:"One request",dedupeKey:"team-request:user:one"})));
  assert.equal(proposed.filter(p => p.created).length,1);
  assert.equal(new Set(proposed.map(p => p.task.taskId)).size,1);
  const taskId = proposed[0]!.task.taskId;
  const claims = await Promise.all(Array.from({length:20}, (_,i) => stores[i%2]!.claim(taskId,`run-${i}`)));
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal((await stores[0]!.get(taskId))?.runId,`run-${claims.indexOf(true)}`);
});

test("unreadable intake cannot silently discard a deduplication record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-corrupt-"));
  await writeFile(join(dir,"task-corrupt.json"),'{"taskId":');
  const store = new FileIntakeStore(dir);
  await assert.rejects(store.propose({source:"team-request",kind:"task",title:"Retry",dedupeKey:"same"}), /unreadable/);
});

test("a dismissed team request remains deduplicated after a lost response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-dismissed-"));
  const store = new FileIntakeStore(dir);
  const input = {source:"team-request",kind:"task",title:"One request",dedupeKey:"team-request:user:one"};
  const first = await store.propose(input);
  await store.setState(first.task.taskId,"dismissed");
  const retry = await new FileIntakeStore(dir).propose(input);
  assert.equal(retry.created,false);
  assert.equal(retry.task.taskId,first.task.taskId);
  assert.equal(retry.task.state,"dismissed");
});

test("Nucleus intake never inserts after losing the dedupe guard while the winner is not yet visible", async () => {
  let inserts = 0;
  const db = {query:async(sql:string) => { if(sql.startsWith("INSERT")) inserts++; return []; }, kv:{setNX:async()=>false}} as unknown as NucleusPgwire;
  await assert.rejects(new NucleusIntakeStore(db).propose({source:"team-request",kind:"task",title:"One",dedupeKey:"same"}), /still being recorded/);
  assert.equal(inserts,0);
});

test("intake: the owner/repo segment of a forge key is case-insensitive", async () => {
  const store = new FileIntakeStore(await mkdtemp(join(tmpdir(), "intake-")));

  const webhook = await store.propose({ source: "forgejo", kind: "issue", title: "one issue", dedupeKey: "forgejo:Tyler/x#1" });
  const akiroo = await store.propose({ source: "forgejo", kind: "issue", title: "one issue", dedupeKey: "forgejo:tyler/x#1" });
  assert.equal(webhook.created, true);
  assert.equal(akiroo.created, false);
  assert.equal(akiroo.task.taskId, webhook.task.taskId);
  assert.equal(webhook.task.dedupeKey, "forgejo:tyler/x#1");

  assert.equal(normalizeDedupeKey("forgejo:Tyler/Repo#comment-42"), "forgejo:tyler/repo#comment-42");
  assert.equal(normalizeDedupeKey("ci:Org/Repo#7:ABCDEF"), "ci:org/repo#7:ABCDEF");
  assert.equal(normalizeDedupeKey("slack:C0AB12:1712.5"), "slack:C0AB12:1712.5");
  assert.equal(normalizeDedupeKey("linear:Abc-123"), "linear:Abc-123");
  assert.equal(normalizeDedupeKey("akiroo:room-scan:9"), "akiroo:room-scan:9");
});
