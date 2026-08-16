import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterCallOptions, AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";

import { runAgent } from "./agent.js";
import type { AgentEvent } from "./agent.js";
import { SETTLE_NUDGE } from "./recovery.js";

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
    // 4. the finish guard holds the first finish and asks for proof — verify
    (obs) => (obs.includes("Before finishing") ? "```bash\ncat sum.py\n```" : "```bash\necho unexpected-nudge\n```"),
    // 5. proven — finish again
    "```finish\nsum.py prints 55.\n```",
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

test("python variables persist across actions through the loop (kernel)", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```python\ntotal = sum(range(11))\nprint('computed')\n```",
    (obs) => (obs.includes("computed") ? "```python\nprint(f'total={total}')\n```" : "```finish\nno-compute\n```"),
    (obs) => (obs.includes("total=55") ? "```finish\nkernel state persisted.\n```" : "```finish\nstate lost!\n```"),
    // Prove it when asked: re-read the namespace instead of repeating the claim.
    (obs) => (obs.includes("Before finishing") ? "```python\nprint(f'total={total}')\n```" : "```finish\nstate lost!\n```"),
    (obs) => (obs.includes("total=55") ? "```finish\nkernel state persisted.\n```" : "```finish\nstate lost!\n```"),
  ]);
  const result = await runAgent({ model, executor, task: "sum with state", recovery: false, condense: false });
  assert.equal(result.summary, "kernel state persisted.");
});

test("edit and create actions work through the loop with real verification", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    '```create greet.py\ndef greet():\n    return "helo"\n```',
    "```edit greet.py\n<<<<<<< SEARCH\n    return \"helo\"\n=======\n    return \"hello\"\n>>>>>>> REPLACE\n```",
    "```bash\npython3 -c \"import greet; print(greet.greet())\"\n```",
    (obs) => (obs.includes("hello") ? "```finish\nedited and verified.\n```" : "```finish\nedit failed\n```"),
    // The gate asks for proof, so prove it — re-run the program rather than
    // just asserting again (a finish with nothing executed is held once more).
    (obs) => (obs.includes("Before finishing") ? '```bash\npython3 -c "import greet; print(greet.greet())"\n```' : "```finish\nedit failed\n```"),
    (obs) => (obs.includes("hello") ? "```finish\nedited and verified.\n```" : "```finish\nedit failed\n```"),
  ]);
  const result = await runAgent({ model, executor, task: "fix the typo", recovery: false, condense: false });
  assert.equal(result.summary, "edited and verified.");
});

test("live loop gates approval-required actions via onApprovalRequest", async () => {
  const executor = await localExecutor();
  const seen: string[] = [];
  const { model } = scriptedModel([
    "```bash\nrm -rf important/\n```",
    "```finish\nSkipped the destructive command.\n```",
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "clean up",
    approveAction: (a) => (a.kind === "bash" && a.code.includes("rm -rf") ? "required" : "auto"),
    onApprovalRequest: (a) => {
      seen.push(a.kind === "bash" ? a.code : a.kind);
      return false; // deny
    },
  });
  assert.equal(result.status, "finished");
  assert.match(seen[0] ?? "", /rm -rf/);
  // the denial was fed back and the agent adapted
  assert.equal(result.steps[0]?.result, undefined); // action never executed
});

test("large observations are truncated before going back to the model", async () => {
  const executor = await localExecutor();
  const { model, calls } = scriptedModel([
    "```bash\nfor i in $(seq 1 5000); do echo line-$i; done\n```",
    "```finish\ndone\n```",
  ]);
  await runAgent({ model, executor, task: "spew", maxObservationChars: 500, condense: false });
  const observation = calls[1]?.messages.find((m, i) => m.role === "user" && i > 1);
  assert.ok(String(observation?.content).includes("truncated"));
});

test("the live loop breaks a repeated-action loop with a recovery nudge", async () => {
  const executor = await localExecutor();
  // the model stubbornly repeats the same failing command
  const { model } = scriptedModel(Array(10).fill("```bash\ncat /no-such-file\n```"));
  const result = await runAgent({
    model,
    executor,
    task: "read a file that doesn't exist",
    maxSteps: 12,
    recovery: { loopThreshold: 3, failureThreshold: 99, maxNudges: 2, noProgressThreshold: 99 },
    condense: false,
  });
  // recovery aborts rather than burning all 12 steps in the loop
  assert.equal(result.status, "error");
  assert.match(result.summary, /repeating the same action|failing/);
  assert.ok(result.steps.length < 12);
});

test("the live loop condenses an overgrown conversation before the next model call", async () => {
  const executor = await localExecutor();
  let sawCondensed = false;
  let turn = 0;
  const model: ModelAdapter = {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options) {
      // once history is condensed, a "Progress so far" message appears
      if (options.messages.some((m) => typeof m.content === "string" && m.content.includes("Progress so far"))) {
        sawCondensed = true;
      }
      // a summarizer call has the recap system prompt — answer briefly
      if (options.messages.some((m) => m.role === "system" && String(m.content).includes("progress recap"))) {
        return { content: [{ type: "text", text: "recap: made progress" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      }
      turn++;
      const text = turn > 3 ? "```finish\ndone\n```" : "```bash\nyes | head -c 20000\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
  const result = await runAgent({
    model,
    executor,
    task: "generate output",
    maxSteps: 8,
    condense: { maxTokens: 4_200, keepRecent: 4, maxSummaryLayers: 3 },
    recovery: false,
  });
  assert.equal(result.status, "finished");
  assert.ok(sawCondensed, "an overgrown conversation should have been condensed before a later model call");
});

test("verified-finish guard: an immediate finish is held twice, then honored", async () => {
  const executor = await localExecutor();
  const { model, calls } = scriptedModel([
    "```finish\nAll done! (nothing was actually done)\n```", // premature — nudged
    "```finish\nStill claiming done.\n```", // still nothing executed — held again
    "```finish\nStill claiming done.\n```", // honored: the gate always terminates
  ]);
  const result = await runAgent({ model, executor, task: "do something", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0]?.action.kind, "finish"); // rejected first attempt recorded
  assert.match(String(calls[1]?.messages.at(-1)?.content), /finishing without having successfully executed/);
  assert.match(String(calls[2]?.messages.at(-1)?.content), /did not run anything between being asked to verify/);
});

test("TS-002: finishing twice without executing anything does not pass the gate on the second try", async () => {
  const executor = await localExecutor();
  const nudges: string[] = [];
  const { model } = scriptedModel([
    "```bash\necho work\n```",
    "```finish\nDone.\n```",
    (obs) => {
      nudges.push(obs);
      return "```finish\nDone, I promise.\n```"; // nothing ran in between
    },
    (obs) => {
      nudges.push(obs);
      return "```finish\nDone.\n```";
    },
  ]);
  const result = await runAgent({ model, executor, task: "work", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.match(nudges[0] ?? "", /Before finishing, verify your work/);
  assert.match(nudges[1] ?? "", /did not run anything between being asked to verify/);
  assert.equal(result.steps.length, 4, "two holds, then honored — bounded, never a refusal loop");
});

test("verified-finish guard: an agent that ACTUALLY verifies is honored on its second finish", async () => {
  const executor = await localExecutor();
  const nudges: string[] = [];
  const { model } = scriptedModel([
    "```bash\necho done-work\n```",
    "```finish\nDid the work.\n```",
    (obs) => {
      nudges.push(obs);
      return "```bash\necho proof-it-works\n```"; // real verification, as asked
    },
    "```finish\nDid the work.\n```",
  ]);
  const result = await runAgent({ model, executor, task: "work", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "Did the work.");
  // the deliverable-verification nudge (not the do-the-work one) was sent
  assert.match(nudges[0] ?? "", /Before finishing, verify your work/);
  assert.equal(result.steps.length, 4, "verifying costs one turn and is then accepted");
});

test("critic pass (options.critic): a rejected finish is sent back once, then the retry is honored", async () => {
  const executor = await localExecutor();
  await executor.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  const nudges: string[] = [];
  const { model, calls } = scriptedModel([
    "```bash\necho changed > f.txt\n```", // a real change -> a non-empty diff for the critic to review
    "```finish\nfirst claim\n```", // held by the verify nudge
    "```bash\ncat f.txt\n```", // verified, as asked — clears the evidence gate
    "```finish\nsecond claim\n```", // verify nudge spent + evidence shown -> the critic pass runs
    "Needs more work: the change is incomplete.", // critic's verdict — no APPROVE, so it's a rejection
    (obs) => {
      nudges.push(obs);
      return "```finish\nthird claim\n```"; // critic already ran once this run -> honored immediately
    },
  ]);
  const result = await runAgent({ model, executor, task: "improve f.txt", critic: true, recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "third claim");
  // 2 bash + 3 finish attempts + 1 critic review; bounded to a single
  // critic-triggered retry, never a loop.
  assert.equal(calls.length, 6);
  assert.match(nudges[0] ?? "", /independent review of your changes found problems/);
});

test("critic pass approves and the run finishes without a retry", async () => {
  const executor = await localExecutor();
  await executor.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  const { model, calls } = scriptedModel([
    "```bash\necho changed > f.txt\n```",
    "```finish\nfirst claim\n```",
    "```bash\ncat f.txt\n```", // verification, clearing the evidence gate
    "```finish\nsecond claim\n```", // the critic pass runs and approves
    "Looks correct.\nAPPROVE",
  ]);
  const result = await runAgent({ model, executor, task: "improve f.txt", critic: true, recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "second claim");
  assert.equal(calls.length, 5);
});

test("critic pass is off by default: no extra review call even with a real diff", async () => {
  const executor = await localExecutor();
  await executor.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  const { model, calls } = scriptedModel([
    "```bash\necho changed > f.txt\n```",
    "```finish\nfirst claim\n```",
    "```bash\ncat f.txt\n```",
    "```finish\nsecond claim\n```", // honored: critic was never requested
  ]);
  const result = await runAgent({ model, executor, task: "improve f.txt", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "second claim");
  assert.equal(calls.length, 4, "no critic call without options.critic");
});

test("verified-finish guard: a finish on the final step is honored immediately", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```bash\necho work\n```",
    "```finish\nlast-step finish\n```",
  ]);
  const result = await runAgent({ model, executor, task: "work", maxSteps: 2, recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "last-step finish");
});

test("verified-finish guard: failed actions do not count as verification", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```bash\nfalse\n```", // executes but fails
    "```finish\ndone\n```", // still premature — nudged
    "```bash\ntrue\n```",
    "```finish\nnow done\n```",
  ]);
  const result = await runAgent({ model, executor, task: "work", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "now done");
});

test("verified-finish guard can be disabled", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel(["```finish\ninstant\n```"]);
  const result = await runAgent({ model, executor, task: "x", requireVerifiedFinish: false, recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.steps.length, 1);
});

test("verified-finish guard: a finish right after a FAILED execution is held with a fix-it nudge", async () => {
  const executor = await localExecutor();
  const nudges: string[] = [];
  const { model } = scriptedModel([
    "```bash\necho work\n```",
    "```finish\ndone\n```", // first finish -> verify nudge
    "```bash\nfalse\n```", // verification FAILS
    "```finish\ndone anyway\n```", // held: last exec failed
    (obs) => {
      nudges.push(obs);
      return "```bash\ntrue\n```"; // fix proven
    },
    "```finish\nactually done\n```",
  ]);
  const result = await runAgent({ model, executor, task: "work", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "actually done");
  assert.match(nudges[0] ?? "", /FAILED/);
});

test("verified-finish guard: fail-nudges are capped so a stuck agent still terminates", async () => {
  const executor = await localExecutor();
  const { model } = scriptedModel([
    "```bash\nfalse\n```",
    "```finish\ngive up\n```", // first finish -> do-the-work nudge
    "```bash\nfalse\n```",
    "```finish\ngive up\n```", // fail nudge 1
    "```bash\nfalse\n```",
    "```finish\ngive up\n```", // fail nudge 2
    "```bash\nfalse\n```",
    "```finish\ngive up\n```", // cap reached -> honored
  ]);
  const result = await runAgent({ model, executor, task: "impossible", recovery: false, condense: false });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "give up");
});

// --- finishWhenSettled: stopping deliberately instead of thrashing to an abort ---

/**
 * A git repo the agent can dirty, plus a script that: does one thing, tries to
 * finish (the gate holds it), and then verifies forever without ever finishing
 * again. That is the exact 2026-08-16 pathology — 15/50 runs died this way at
 * steps 28-38 of 40, most of them holding a real patch.
 */
async function settleRepo(): Promise<LocalExecutor> {
  const executor = await localExecutor();
  await executor.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  return executor;
}

const PROBES = Array.from({ length: 20 }, (_, i) => `\`\`\`bash\necho probe-${i}\n\`\`\``);
const SETTLE_RECOVERY = { loopThreshold: 99, failureThreshold: 99, maxNudges: 1, noProgressThreshold: 2 } as const;

test("finishWhenSettled: a run that stops changing an edited tree ends as settled, in the agent's own words", async () => {
  const executor = await settleRepo();
  const { model } = scriptedModel([
    '```create fix.py\ndef f(n):\n    return n + 1\n```', // the tree is now dirty
    "```finish\nFixed the off-by-one in fix.py.\n```", // held by the verify gate
    ...PROBES, // verifying forever, changing nothing
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 20,
    recovery: { ...SETTLE_RECOVERY },
    condense: false,
    finishWhenSettled: true,
  });

  assert.equal(result.status, "settled");
  // The run ends on the agent's held finish, not on a harness sentence: the
  // whole point is that this exit preserves the run instead of wasting it.
  assert.equal(result.summary, "Fixed the off-by-one in fix.py.");
  assert.ok(
    result.messages.some((m) => m.role === "user" && m.content === SETTLE_NUDGE),
    "the agent was offered the finish before the run was stopped",
  );
  assert.ok(result.steps.length < 20, "it stopped well short of the step budget");
});

test("finishWhenSettled SEAM: the same script over a CLEAN tree still aborts", async () => {
  // The twin of the test above, differing in one thing: turn 1 changes no
  // files. If `dirty` ever stops flowing from workspaceFingerprint into
  // recovery.observe, the test above keeps passing on a hardcoded true and
  // this one fails — which is why both exist.
  const executor = await settleRepo();
  const { model } = scriptedModel([
    "```bash\necho looked-around\n```", // succeeds, writes nothing
    "```finish\nI believe this is done.\n```",
    ...PROBES,
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 20,
    recovery: { ...SETTLE_RECOVERY },
    condense: false,
    finishWhenSettled: true,
  });

  assert.equal(result.status, "error", "nothing was built, so there is nothing to settle on");
  assert.match(result.summary, /without changing anything/);
  assert.ok(
    !result.messages.some((m) => m.role === "user" && m.content === SETTLE_NUDGE),
    "a clean tree is never told it may already be done",
  );
});

test("finishWhenSettled: harness scratch in the tree is not work — a scratch-only run still aborts", async () => {
  // The kernel writes .teploy-agent/ into the workspace. The repo and
  // benchmark paths git-exclude it, but a plain `run` in an arbitrary
  // directory does not — and scratch alone must never make a run that built
  // nothing look like a finished change.
  const executor = await settleRepo();
  const { model } = scriptedModel([
    "```bash\nmkdir -p .teploy-agent && echo 1234 > .teploy-agent/kernel.pid\n```",
    "```finish\nI believe this is done.\n```",
    ...PROBES,
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 20,
    recovery: { ...SETTLE_RECOVERY },
    condense: false,
    finishWhenSettled: true,
  });

  assert.equal(result.status, "error");
  assert.match(result.summary, /without changing anything/);
});

test("finishWhenSettled is off by default: the identical run still ends as an error", async () => {
  const executor = await settleRepo();
  const { model } = scriptedModel([
    '```create fix.py\ndef f(n):\n    return n + 1\n```',
    "```finish\nFixed the off-by-one in fix.py.\n```",
    ...PROBES,
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 20,
    recovery: { ...SETTLE_RECOVERY },
    condense: false,
  });

  assert.equal(result.status, "error");
  assert.equal(result.summary, "Aborting: the agent kept running commands without changing anything after repeated nudges.");
});

test("finishWhenSettled rides on stuck detection: with recovery off it is inert", async () => {
  // Documented footgun, pinned as a contract: the settle path is a branch of
  // the stuck detector, so disabling recovery disables it too.
  const executor = await settleRepo();
  const { model } = scriptedModel([
    '```create fix.py\ndef f(n):\n    return n + 1\n```',
    "```finish\nFixed the off-by-one in fix.py.\n```",
    ...PROBES,
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 6,
    recovery: false,
    condense: false,
    finishWhenSettled: true,
  });

  assert.equal(result.status, "max-steps");
  assert.ok(!result.messages.some((m) => m.role === "user" && m.content === SETTLE_NUDGE));
});

test("an empty model response never becomes an empty stored turn", async () => {
  const executor = await localExecutor();
  // Turn 1 is empty (a rare API hiccup). Before the fix this stored an
  // empty assistant text block, which Anthropic rejects on the NEXT call —
  // killing the run. Turn 2 recovers with a finish.
  const { model } = scriptedModel([
    "", // empty response
    "```finish\nrecovered\n```",
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "handle an empty turn",
    recovery: false,
    condense: false,
    requireVerifiedFinish: false,
  });
  assert.equal(result.status, "finished");
  assert.equal(result.summary, "recovered");
  // No assistant turn in the transcript is empty/whitespace-only — the
  // guarantee that keeps the next model call wire-legal.
  for (const m of result.messages) {
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      assert.notEqual(text.trim(), "", "an assistant turn was stored empty");
    }
  }
});

test("finishWhenSettled: a REJECTED finish never becomes the run's summary", async () => {
  // Regression. `lastHeldFinish` was set on every hold, so a claim the run had
  // explicitly refused — here the hallucinated-verification catch — was adopted
  // as result.summary when the run later settled. That summary is not cosmetic:
  // it becomes the git commit message (cli.ts) and the PR body, so this shipped
  // a rejected claim as the description of the change.
  const executor = await settleRepo();
  const { model } = scriptedModel([
    "```create fix.py\ndef f(n):\n    return n + 1\n```", // tree is dirty
    "```finish\nFixed it and ran the full suite; everything passes.\n```", // held: verify
    "```finish\nI already told you the suite passes.\n```", // held: NO_EVIDENCE — ran nothing
    ...PROBES, // now spins without changing anything
  ]);
  const result = await runAgent({
    model,
    executor,
    task: "fix the off-by-one",
    maxSteps: 20,
    recovery: { ...SETTLE_RECOVERY },
    condense: false,
    finishWhenSettled: true,
  });

  assert.equal(result.status, "settled");
  assert.doesNotMatch(
    result.summary,
    /I already told you/,
    "the rejected claim must not be laundered into the summary",
  );
  assert.doesNotMatch(
    result.summary,
    /everything passes/,
    "an earlier accepted claim must not survive a later rejection either",
  );
});
