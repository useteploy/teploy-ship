import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";

import { checkCommand, runEval } from "./eval.js";
import type { EvalTask } from "./eval.js";

// A model that reacts to the last observation (so it can actually solve a
// task against the real LocalExecutor).
function reactiveModel(turns: Array<string | ((obs: string) => string)>): ModelAdapter {
  let index = 0;
  return {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
      const obs = typeof lastUser?.content === "string" ? lastUser.content : "";
      const turn = turns[index++] ?? "```finish\nout of script\n```";
      const text = typeof turn === "function" ? turn(obs) : turn;
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

const writeAnswerTask: EvalTask = {
  name: "write-answer",
  prompt: "write 42 to answer.txt",
  verify: checkCommand("test \"$(cat answer.txt)\" = \"42\""),
};

test("scores a genuinely-solved task as PASS via independent verification", async () => {
  const model = reactiveModel(["```bash\necho 42 > answer.txt\n```", "```finish\nWrote 42 to answer.txt.\n```"]);
  const report = await runEval({ tasks: [writeAnswerTask], model });
  assert.equal(report.passRate, 1);
  assert.equal(report.results[0]?.passed, true);
  assert.equal(report.results[0]?.agentStatus, "finished");
});

test("a LYING agent that claims success without doing the work scores FAIL", async () => {
  // the agent finishes immediately, having written nothing
  const model = reactiveModel(["```finish\nAll done! answer.txt contains 42.\n```"]);
  const report = await runEval({ tasks: [writeAnswerTask], model });
  assert.equal(report.results[0]?.agentStatus, "finished"); // it CLAIMED success
  assert.equal(report.results[0]?.passed, false); // but verification caught the lie
  assert.equal(report.passRate, 0);
  assert.match(report.results[0]?.detail ?? "", /exited/);
});

test("an agent that does the WRONG work scores FAIL", async () => {
  const model = reactiveModel(["```bash\necho 99 > answer.txt\n```", "```finish\ndone\n```"]);
  const report = await runEval({ tasks: [writeAnswerTask], model });
  assert.equal(report.results[0]?.passed, false);
});

test("setup seeds the workspace and verify sees the agent's edits", async () => {
  const task: EvalTask = {
    name: "double-it",
    prompt: "double the number in seed.txt and write it to out.txt",
    setup: async (executor) => {
      await executor.putFile("seed.txt", "21");
    },
    verify: checkCommand("test \"$(cat out.txt)\" = \"42\""),
  };
  const model = reactiveModel([
    "```bash\nexpr $(cat seed.txt) \\* 2 > out.txt\n```",
    "```finish\ndoubled\n```",
  ]);
  const report = await runEval({ tasks: [task], model });
  assert.equal(report.results[0]?.passed, true);
});

test("tasks are isolated — one task's files do not leak into the next", async () => {
  const leaky: EvalTask = {
    name: "leaky",
    prompt: "x",
    verify: checkCommand("echo leaked > /tmp/should-not-matter; test ! -f from-previous.txt"),
  };
  const first: EvalTask = {
    name: "first",
    prompt: "x",
    setup: async (e) => e.putFile("from-previous.txt", "hi"),
    verify: checkCommand("true"),
  };
  const report = await runEval({ tasks: [first, leaky], model: reactiveModel(["```finish\nx\n```", "```finish\nx\n```"]) });
  // leaky passes only because from-previous.txt does NOT exist in its fresh workspace
  assert.equal(report.results.find((r) => r.task === "leaky")?.passed, true);
});

test("repeats report pass@k and an attempt pass rate", async () => {
  // solves on odd attempts, fails on even — deterministic via a counter
  let n = 0;
  const flaky: EvalTask = {
    name: "flaky",
    prompt: "write ok to answer.txt",
    verify: checkCommand("test \"$(cat answer.txt)\" = \"ok\""),
  };
  const model: ModelAdapter = {
    provider: "s", modelId: "s",
    async doGenerate() {
      const solve = n++ % 2 === 0;
      const text = solve ? "```bash\necho ok > answer.txt\n```" : "```finish\nskipped\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() { throw new Error("unused"); },
  };
  const report = await runEval({ tasks: [flaky], model, repeats: 2, agentOptions: { maxSteps: 2 } });
  // one of the two attempts solved it → pass@2 = passed
  assert.equal(report.passedTasks, 1);
  assert.equal(report.results.length, 2);
});

test("a verify that throws is a clean FAIL, not a crash", async () => {
  const task: EvalTask = {
    name: "boom",
    prompt: "x",
    verify: async () => {
      throw new Error("verify blew up");
    },
  };
  const report = await runEval({ tasks: [task], model: reactiveModel(["```finish\nx\n```"]) });
  assert.equal(report.results[0]?.passed, false);
  assert.match(report.results[0]?.detail ?? "", /verify threw/);
});
