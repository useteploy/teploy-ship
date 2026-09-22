import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { taskRootRunId } from "./task-session.js";

function start(parentRunId?: string, root?: string): WorkflowEvent {
  return {v:1,seq:0,type:"run-started",at:"2026-09-21",data:{workflow:"coding-agent",input:parentRunId ? {parentRunId} : {},...(root ? {taskRootRunId:root} : {})}};
}
test("legacy question, plan and change resolve one root without rewriting history", async () => {
  const histories: Record<string,WorkflowEvent[]> = {question:[start()],plan:[start("question")],change:[start("plan")]};
  const before = JSON.stringify(histories);
  const store = {load:async(id:string)=>histories[id] ?? []};
  assert.equal(await taskRootRunId(store,"change"),"question");
  assert.equal(JSON.stringify(histories),before);
});
test("recorded anchors resolve without walking every prior attempt", async () => {
  const reads:string[]=[];
  const store = {load:async(id:string)=>{
    reads.push(id);
    return id === "latest" ? [start("previous","original")] : id === "original" ? [start(undefined,"original")] : [];
  }};
  assert.equal(await taskRootRunId(store,"latest"),"original");
  assert.deepEqual(reads,["latest","original"]);
});
test("missing, cyclic and invalid conversation lineage cannot silently start a different task", async () => {
  const histories: Record<string,WorkflowEvent[]> = {a:[start("b")],b:[start("a")],broken:[start("absent")],falseRoot:[start("a","falseRoot")],unsafe:[start("../outside")]};
  const store={load:async(id:string)=>histories[id]??[]};
  await assert.rejects(taskRootRunId(store,"a"),/cycle/);
  await assert.rejects(taskRootRunId(store,"broken"),/missing/);
  await assert.rejects(taskRootRunId(store,"falseRoot"),/not a root/);
  await assert.rejects(taskRootRunId(store,"unsafe"),/unsafe/);
});
