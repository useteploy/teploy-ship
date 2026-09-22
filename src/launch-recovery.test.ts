import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import { FileLaunchJournal, launchRequestHash, type LaunchIntent } from "./launch-journal.js";
import { abandonAcceptedLaunch, launchDispositions, pendingLaunches, retryAcceptedLaunch } from "./launch-recovery.js";

test("operator recovery isolates corrupt records and retries the accepted identity without restarting a completed run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-recovery-"));
  const store = new FileEventStore(join(dir,"runs")), meta = new RunMetaStore(join(dir,"runs"));
  const journal = new FileLaunchJournal(store,meta,join(dir,"launches"));
  const at = new Date().toISOString();
  const intent: LaunchIntent = {runId:"run-good",requestHash:launchRequestHash("good"),meta:{runId:"run-good",task:"A task",status:"queued",model:"test",createdAt:at,updatedAt:at},started:{v:1,seq:0,type:"run-started",at,data:{workflow:"test",input:{task:"A task",secret:"not-in-the-projection"}}}};
  await journal.prepare(intent);
  await writeFile(join(dir,"launches","run-broken.json"),"{broken");
  const page=await pendingLaunches(journal);
  assert.equal(page.rows.length,2); assert.ok(page.rows[0].error);
  assert.doesNotMatch(JSON.stringify(page),/not-in-the-projection/);
  await Promise.all([retryAcceptedLaunch(journal,"run-good"),retryAcceptedLaunch(journal,"run-good")]);
  assert.equal((await store.load("run-good")).length,1);
  await meta.save({...intent.meta,status:"completed"});
  await retryAcceptedLaunch(journal,"run-good");
  assert.equal((await meta.load("run-good"))?.status,"completed");
  assert.deepEqual((await pendingLaunches(journal)).rows.map(r=>r.runId),["run-broken"]);
  await assert.rejects(retryAcceptedLaunch(journal,"run-missing"),/No accepted launch/);
  await assert.rejects(retryAcceptedLaunch(journal,"../bad"),/Invalid/);
});

test("operator recovery cannot override a competing review decision", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ship-recovery-conflict-"));
  const store=new FileEventStore(join(dir,"runs")),meta=new RunMetaStore(join(dir,"runs"));
  const journal=new FileLaunchJournal(store,meta,join(dir,"launches"),async()=>{throw new Error("Review decision already claimed");});
  const at=new Date().toISOString();
  await journal.prepare({runId:"run-child",reviewParent:"run-parent",requestHash:launchRequestHash("child"),meta:{runId:"run-child",task:"Revise",status:"queued",model:"test",createdAt:at,updatedAt:at},started:{v:1,seq:0,type:"run-started",at,data:{workflow:"test",input:{task:"Revise"}}}});
  await assert.rejects(retryAcceptedLaunch(journal,"run-child"),/already claimed/);
  assert.deepEqual(await store.load("run-child"),[]);
  assert.equal((await pendingLaunches(journal)).rows[0].reviewParent,"run-parent");
});

test("A.4: abandoning a permanently conflicting intent needs authority, a reason, and loses to a concurrent publish", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ship-recovery-abandon-"));
  const store=new FileEventStore(join(dir,"runs")),meta=new RunMetaStore(join(dir,"runs"));
  const journal=new FileLaunchJournal(store,meta,join(dir,"launches"));
  const at=new Date().toISOString();
  const of=(runId:string):LaunchIntent=>({runId,requestHash:launchRequestHash(runId),meta:{runId,task:"A task",status:"queued",model:"test",createdAt:at,updatedAt:at},started:{v:1,seq:0,type:"run-started",at,data:{workflow:"test",input:{task:"A task"}}}});
  await journal.prepare(of("run-conflict"));
  await assert.rejects(abandonAcceptedLaunch(journal,"run-conflict",{actor:" ",reason:"a real reason"}),/deciding operator/);
  await assert.rejects(abandonAcceptedLaunch(journal,"run-conflict",{actor:"op",reason:"short"}),/reason/);
  await abandonAcceptedLaunch(journal,"run-conflict",{actor:"op@ship",reason:"history conflicts; the work is superseded"});
  assert.deepEqual((await pendingLaunches(journal)).rows,[],"the disposition clears it from pending");
  const d=await launchDispositions(journal);
  assert.equal(d[0]!.runId,"run-conflict");
  assert.match(d[0]!.reason,/superseded/);
  await assert.rejects(retryAcceptedLaunch(journal,"run-conflict"),/abandoned by an operator/,"recovery cannot resurrect a disposition");

  const live=await journal.prepare(of("run-live"));
  await journal.publish(live);
  await assert.rejects(abandonAcceptedLaunch(journal,"run-live",{actor:"op@ship",reason:"too late, it published"}),/published/);
  await assert.rejects(abandonAcceptedLaunch(journal,"run-ghost",{actor:"op@ship",reason:"never existed at all"}),/No accepted launch/);
});
