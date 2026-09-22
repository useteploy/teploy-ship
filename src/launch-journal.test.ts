import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import { FileLaunchJournal, launchRequestHash, recoverLaunches, type LaunchIntent } from "./launch-journal.js";

function intent(runId = "run-proof"): LaunchIntent {
  const now = "2026-09-21T00:00:00.000Z";
  return { runId, requestHash: launchRequestHash({task:"Fix a label"}),
    started:{v:1,seq:0,type:"run-started",at:now,data:{workflow:"coding-agent",input:{task:"Fix a label"}}},
    meta:{runId,task:"Fix a label",model:"test",status:"queued",createdAt:now,updatedAt:now} };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),"ship-launch-test-"));
  const store = new FileEventStore(join(dir,"runs"));
  const meta = new RunMetaStore(join(dir,"runs"));
  const journalDir = join(dir,"launches");
  return {store,meta,journalDir,journal:new FileLaunchJournal(store,meta,journalDir)};
}

test("accepted launch survives restart before events and metadata exist", async () => {
  const f = await fixture();
  await f.journal.prepare(intent());
  assert.deepEqual(await f.store.load("run-proof"),[]);
  const restarted = new FileLaunchJournal(f.store,f.meta,f.journalDir);
  assert.deepEqual((await recoverLaunches(restarted)).recovered,["run-proof"]);
  assert.equal((await f.store.load("run-proof")).length,1);
  assert.equal((await f.meta.load("run-proof"))?.status,"queued");
  assert.deepEqual(await restarted.pending(),[]);
});

test("failure after start event repairs metadata without duplicating events", async () => {
  const f = await fixture();
  const broken = new FileLaunchJournal(f.store,{load:f.meta.load.bind(f.meta),save:async()=>{throw new Error("disk failed");}},f.journalDir);
  const accepted = await broken.prepare(intent());
  await assert.rejects(broken.publish(accepted),/disk failed/);
  assert.equal((await f.store.load(accepted.runId)).length,1);
  assert.equal(await f.meta.load(accepted.runId),null);
  await recoverLaunches(f.journal);
  assert.equal((await f.store.load(accepted.runId)).length,1);
  assert.equal((await f.meta.load(accepted.runId))?.status,"queued");
});

test("racing retries share one launch and cannot reset a completed run", async () => {
  const f = await fixture();
  await Promise.all(Array.from({length:20},async()=>f.journal.publish(await f.journal.prepare(intent()))));
  assert.equal((await f.store.load("run-proof")).length,1);
  await f.meta.save({...intent().meta,status:"completed"});
  await f.journal.publish(await f.journal.prepare(intent()));
  assert.equal((await f.meta.load("run-proof"))?.status,"completed");
  await assert.rejects(f.journal.prepare({...intent(),requestHash:launchRequestHash("different task")}),/different launch/);
});

test("advanced state survives a missing publication receipt; conflicting history is refused", async () => {
  const f = await fixture();
  const accepted = await f.journal.prepare(intent());
  await f.store.append(accepted.runId,accepted.started);
  await f.meta.save({...accepted.meta,status:"waiting",eventName:"plan-approval"});
  await f.journal.publish(accepted);
  assert.equal((await f.meta.load(accepted.runId))?.eventName,"plan-approval");
  const bad = await f.journal.prepare(intent("run-conflict"));
  await f.store.append(bad.runId,{...bad.started,data:{workflow:"other"}});
  await assert.rejects(f.journal.publish(bad),/history conflicts/);
  assert.equal(await f.meta.load(bad.runId),null);
});

test("corrupt pending intent does not starve valid records or later pages", async () => {
  const f = await fixture();
  for(let i=0;i<101;i++)await f.journal.prepare(intent(`run-${String(i).padStart(3,"0")}`));
  await writeFile(join(f.journalDir,"run-000.json"),"{broken");
  const errors:string[]=[];
  const page = await recoverLaunches(f.journal,{onError:id=>errors.push(id)});
  assert.equal(page.recovered.length,99);
  assert.equal(page.after,"run-099");
  assert.deepEqual(errors,["run-000"]);
  assert.deepEqual((await recoverLaunches(f.journal,{after:page.after})).recovered,["run-100"]);
  assert.deepEqual(await f.journal.pending(),["run-000"]);
});

test("request identity ignores object key ordering but preserves array ordering", () => {
  assert.equal(launchRequestHash({a:1,b:{c:2,d:3}}),launchRequestHash({b:{d:3,c:2},a:1}));
  assert.notEqual(launchRequestHash([1,2]),launchRequestHash([2,1]));
});


test("long Unicode request stays intact while metadata fits inline storage", async () => {
  const f = await fixture();
  const task = "界".repeat(10000);
  const candidate = intent();
  candidate.meta.task = task;
  candidate.started.data = {workflow:"coding-agent",input:{task}};
  await f.journal.publish(await f.journal.prepare(candidate));
  assert.equal((await f.journal.get(candidate.runId))?.meta.task,task);
  assert.equal(((await f.store.load(candidate.runId))[0]!.data as any).input.task,task);
  const summary = (await f.meta.load(candidate.runId))!.task;
  assert.ok(Buffer.byteLength(summary) <= 4003);
  assert.ok(summary.endsWith("…"));
  assert.ok(!summary.includes("\ufffd"));
});
