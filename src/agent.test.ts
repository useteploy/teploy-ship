import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterCallOptions, AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";

import { runAgent } from "./agent.js";
import type { AgentEvent } from "./agent.js";

// A model that replies with scripted turns AND can react to the last
// observation — enough to prove the loop feeds output back correctly.
function scriptedModel(
  turns: Array<string | ((lastObservation: string) => string)>,
): { model: ModelAdapter; calls: AdapterCallOptions[] } {
  const calls: AdapterCallOptions[] = [];
  let index = 0;
  return {
    calls,
    model: {
      provider: "scripted",
      modelId: "scripted-1",
      async doGenerate(options): Promise<AdapterGenerateResult> {
        calls.push(structuredClone(options));
        const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
        const lastObservation = typeof lastUser?.content === "string" ? lastUser.content : "";
        const turn = turns[index++] ?? "```finish\nout of script\n```";
        const text = typeof turn === "function" ? turn(lastObservation) : turn;
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      },
      async *doStream() {
        throw new Error("not used");
      },
    },
  };
}

async function localExecutor(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "agent-test-")) });
}

test("runs a full CodeAct session against a real executor and finishes", async () => {
  const executor = await localExecutor();
  const { model, calls } = scriptedModel([
    // 1. write a script
    "I'll create the script.\n```bash\necho 'print(sum(range(11)))' > sum.py\n```",
    // 2. run it
    "```bash\npython3 sum.py\n```",
    // 3. finish ONLY if the real program output came back — proving the loop fed it in
    (obs) => (obs.includes("55") ? "```finish\nsum.py prints 55.\n```" : "```bash\necho wrong-output-was-fed\n```"),
  ]);

  const events: AgentEvent[] = [];
  const result = await runAgent({
    model,
    executor,
    task: "Write sum.py that prints the sum 0..10 and run it.",
    workdir: "/workspace",
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.status, "finished");
  assert.equal(result.summary, "sum.py prints 55.");

  // the loop actually executed and fed real output back: step 2's
  // observation must contain the program's real output (55)
  const ranStep = result.steps.find((s) => s.action.kind === "bash" && s.action.code.includes("python3"));
  assert.match(ranStep?.observation ?? "", /55/);
  assert.match(ranStep?.observation ?? "", /exit 0/);

  // the system prompt carried the task
  assert.match(String(calls[0]?.messages[0]?.content), /Write sum\.py/);
  assert.ok(events.some((e) => e.type === "finish"));
});

test("python actions run via a written file and report tracebacks", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```python\nraise ValueError('boom')\n```",
    (obs) => (obs.includes("ValueError") ? "```finish\nSaw the error.\n```" : "```bash\necho no-error\n```"),
  ]);
  const result = await runAgent({ model, executor, task: "trigger an error" });
  assert.equal(result.status, "finished");
  const pyStep = result.steps.find((s) => s.action.kind === "python");
  assert.match(pyStep?.observation ?? "", /ValueError: boom/);
  assert.notEqual(pyStep?.result?.exitCode, 0);
});

test("a failing command's nonzero exit and stderr reach the agent", async () => {
  const executor = await localExecutor();
  const seen: string[] = [];
  const { model } = scriptedModel([
    "```bash\ncat /nonexistent-file-xyz\n```",
    (obs) => {
      seen.push(obs);
      return "```finish\ndone\n```";
    },
  ]);
  await runAgent({ model, executor, task: "read a missing file" });
  assert.match(seen[0] ?? "", /exit [^0]/);
  assert.match(seen[0] ?? "", /stderr:/);
});

test("no-action responses are nudged, not fatal", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "I'm thinking about the best approach here.", // no code block
    "```bash\necho recovered\n```",
    "```finish\nrecovered after a nudge\n```",
  ]);
  const result = await runAgent({ model, executor, task: "x", maxSteps: 5 });
  assert.equal(result.status, "finished");
  assert.equal(result.steps[0]?.action.kind, "none");
  assert.equal(result.steps[1]?.action.kind, "bash");
});

test("stops at the step budget without finishing", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```bash\necho 1\n```",
    "```bash\necho 2\n```",
    "```bash\necho 3\n```",
  ]);
  const result = await runAgent({ model, executor, task: "loop forever", maxSteps: 2 });
  assert.equal(result.status, "max-steps");
  assert.equal(result.steps.length, 2);
});

test("model errors end the run cleanly", async () => {
  const executor = await localExecutor();
  const model: ModelAdapter = {
    provider: "broken",
    modelId: "broken-1",
    async doGenerate() {
      throw new Error("model exploded");
    },
    async *doStream() {
      throw new Error("not used");
    },
  };
  const result = await runAgent({ model, executor, task: "x" });
  assert.equal(result.status, "error");
  assert.match(result.summary, /model exploded/);
});

test("large observations are truncated before going back to the model", async () => {
  const executor = await localExecutor();
  const { model, calls } = scriptedModel([
    "```bash\nfor i in $(seq 1 5000); do echo line-$i; done\n```",
    "```finish\ndone\n```",
  ]);
  await runAgent({ model, executor, task: "spew", maxObservationChars: 500 });
  const observation = calls[1]?.messages.find((m, i) => m.role === "user" && i > 1);
  assert.ok(String(observation?.content).includes("truncated"));
});
