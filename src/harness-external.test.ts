import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentOutput, ExecutorProvider } from "./durable.js";
import { FileRepoMemory } from "./repo-memory.js";
import { HARNESS_VERSIONS, selectAdapter } from "./harness.js";
import { STEER_CLOSED_MESSAGE, steerLoopExited, steerRefusal } from "./harness-capabilities.js";
import { admittedSteps } from "./step-fingerprint.js";
import {
  codexGatewayConfigFlags, envFile, STEER_ROUNDS_MAX, externalAdapters, externalHarnessConfig, externalPrompt, opencodeFutureLineRefusal, opencodeSessionId,
  parseClaudeStream, parseCodexExecStream, parseOpencode2Stream, parseOpencodeStream, shq, versionMajor,
} from "./harness-external.js";

const neverModel: ModelAdapter = {
  provider: "never",
  modelId: "never",
  async doGenerate() {
    throw new Error("an external harness run must never call Ship's model");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

const REF = `evals/receipts/2026-10-14-opencode-v2-events.txt`;

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  result: "Appended the fix and ran the tests.",
  session_id: "6f47a1d0-8d2c-4b0a-9d3f-2a1b4c5d6e7f",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
};

test("parseClaudeStream reads the result event and its session id; cost is recorded only under a priced credential", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "6f47a1d0-8d2c-4b0a-9d3f-2a1b4c5d6e7f" }),
    JSON.stringify({ type: "assistant", message: {} }),
    "not json",
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify(CLAUDE_RESULT),
  ].join("\n");
  const priced = parseClaudeStream(stream, true);
  assert.equal(priced.status, "finished");
  assert.equal(priced.turns, 3);
  assert.equal(priced.usage.priced, true);
  assert.equal(priced.usage.costUSD, 0.0123);
  assert.equal(priced.usage.totalTokens, 1130);
  assert.equal(priced.usage.cacheReadTokens, 1000);
  // D7: the session id is the durable handle --resume steering needs.
  assert.equal(priced.sessionId, "6f47a1d0-8d2c-4b0a-9d3f-2a1b4c5d6e7f");

  const subscription = parseClaudeStream(stream, false);
  assert.equal(subscription.usage.priced, false);
  assert.equal(subscription.usage.costUSD, undefined, "a subscription estimate must not become spend");
  assert.equal(subscription.usage.inputTokens, 10, "tokens are still recorded");
  assert.equal(subscription.sessionId, "6f47a1d0-8d2c-4b0a-9d3f-2a1b4c5d6e7f");

  assert.equal(parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_max_turns" }), true).status, "max-steps");
  assert.equal(parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_max_budget_usd" }), true).status, "budget-exhausted");
  const failed = parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_during_execution", is_error: true, errors: ["boom"] }), true);
  assert.equal(failed.status, "error");
  assert.match(failed.summary, /boom/);
  const none = parseClaudeStream(JSON.stringify({ type: "assistant" }), true);
  assert.equal(none.status, "error");
  assert.equal(none.sawResult, false);
  assert.equal(none.sessionId, undefined, "no events, no session");
  // A crashed run printed its init but no result: the session id survives,
  // because the first event that names one is the fallback.
  const crashed = parseClaudeStream(`${JSON.stringify({ type: "system", subtype: "init", session_id: "early-session" })}\n`, true);
  assert.equal(crashed.sessionId, "early-session");
});

test("parseOpencodeStream sums step_finish tokens and prices the run only when opencode reports cost", () => {
  const step = (cost: number) =>
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 50, write: 10 } }, cost } });
  const text = JSON.stringify({ type: "text", part: { type: "text", text: "Done: fixed lib.ts" } });
  const free = parseOpencodeStream([step(0), text, step(0)].join("\n"));
  assert.equal(free.turns, 2);
  assert.equal(free.summary, "Done: fixed lib.ts");
  assert.equal(free.usage.inputTokens, 200);
  assert.equal(free.usage.outputTokens, 14);
  assert.equal(free.usage.cacheReadTokens, 100);
  assert.equal(free.usage.priced, false);
  assert.equal(free.usage.costUSD, undefined);

  const paid = parseOpencodeStream([step(0.01), text, step(0.02)].join("\n"));
  assert.equal(paid.usage.priced, true);
  assert.ok(Math.abs((paid.usage.costUSD ?? 0) - 0.03) < 1e-9);

  const errored = parseOpencodeStream([step(0), JSON.stringify({ type: "error", error: { message: "no provider" } })].join("\n"));
  assert.equal(errored.error, "no provider");
});

/**
 * The v2 event contract, VERBATIM from the measured 2.0.26 streams in
 * evals/receipts/2026-10-14-opencode-v2-events.txt (§2 pure reply, §3 resume,
 * §4 tool run, §2 auth error). Timestamps trimmed for width; shapes kept.
 */
const V2_PURE_STREAM = [
  `{"type":"step_start","timestamp":1792036067715,"sessionID":"ses_ec253b380ffe4G3XXxX9u4Zt9n","part":{"id":"prt_13dac5983001Guo0Azxo9jI56y","sessionID":"ses_ec253b380ffe4G3XXxX9u4Zt9n","messageID":"msg_13dac4cae00196O13d6CYO3mz0","type":"step-start"}}`,
  `{"type":"text","timestamp":1792036067734,"sessionID":"ses_ec253b380ffe4G3XXxX9u4Zt9n","part":{"id":"prt_13dac4cae00196O13d6CYO3mz0_text-0","sessionID":"ses_ec253b380ffe4G3XXxX9u4Zt9n","messageID":"msg_13dac4cae00196O13d6CYO3mz0","type":"text","text":"CONTRACT-OK","time":{"start":1792036064434,"end":1792036067734}}}`,
].join("\n");

const V2_TOOL_STREAM = [
  `{"type":"step_start","timestamp":1792036130000,"sessionID":"ses_toolrun0000000000000000001","part":{"id":"prt_t1","sessionID":"ses_toolrun0000000000000000001","messageID":"msg_13dad4482001MqdthUwB3Tb2q","type":"step-start"}}`,
  `{"type":"tool_use","timestamp":1792036130100,"sessionID":"ses_toolrun0000000000000000001","part":{"partID":"prt_t2","messageID":"msg_13dad4482001MqdthUwB3Tb2q","type":"tool","id":"call_2e39ea5f07f14a06b848ca3f","tool":"shell","state":{"status":"completed","input":{"command":"ls -a"},"output":"...listing...","title":"shell","metadata":{},"time":{"start":1792036130000,"end":1792036130050}}}}`,
  `{"type":"step_finish","timestamp":1792036130200,"sessionID":"ses_toolrun0000000000000000001","part":{"id":"prt_t3","messageID":"msg_13dad4482001MqdthUwB3Tb2q","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":4861,"output":13,"reasoning":51,"cache":{"read":3584,"write":0}}}}`,
  `{"type":"step_start","timestamp":1792036130300,"sessionID":"ses_toolrun0000000000000000001","part":{"id":"prt_t4","sessionID":"ses_toolrun0000000000000000001","messageID":"msg_13dac4fe400113Qo8X3uBrsGD9","type":"step-start"}}`,
  `{"type":"text","timestamp":1792036130400,"sessionID":"ses_toolrun0000000000000000001","part":{"id":"prt_t5","sessionID":"ses_toolrun0000000000000000001","messageID":"msg_13dac4fe400113Qo8X3uBrsGD9","type":"text","text":"12","time":{"start":1792036130300,"end":1792036130400}}}`,
].join("\n");

const V2_RESUME_STREAM = [
  `{"type":"step_start","timestamp":1792036114146,"sessionID":"ses_shipproof_v2contract","part":{"id":"prt_r1","sessionID":"ses_shipproof_v2contract","messageID":"msg_13dadfa56001Tnla33rCwbpIj9","type":"step-start"}}`,
  `{"type":"text","timestamp":1792036114161,"sessionID":"ses_shipproof_v2contract","part":{"id":"prt_r2","sessionID":"ses_shipproof_v2contract","messageID":"msg_13dadfa56001Tnla33rCwbpIj9","type":"text","text":"You asked me to remember the codeword ZULU-7 and to reply with exactly \\"NOTED\\".","time":{"start":1792036108892,"end":1792036114161}}}`,
].join("\n");

const V2_ERROR_STREAM = [
  `{"type":"step_start","timestamp":1792036034116,"sessionID":"ses_ec2542a35ffeOd4SukP1pZcV3y","part":{"id":"prt_e1","sessionID":"ses_ec2542a35ffeOd4SukP1pZcV3y","messageID":"msg_e1","type":"step-start"}}`,
  `{"type":"error","timestamp":1792036034649,"sessionID":"ses_ec2542a35ffeOd4SukP1pZcV3y","error":{"type":"provider.auth","message":"Provider request failed with HTTP 401","status":401,"response":{"body":"IDE token expired: unauthorized: token expired\\n"}}}`,
].join("\n");

test("parseOpencode2Stream reads the measured 2.0.26 contract: messageID turns, step_finish usage where it exists, the session id", () => {
  // A PURE reply: one message, no step_finish at all — the measured v1-parser
  // degradation was turns 0 / usage all-zero; turns now count the message.
  const pure = parseOpencode2Stream(V2_PURE_STREAM);
  assert.equal(pure.summary, "CONTRACT-OK");
  assert.equal(pure.turns, 1);
  assert.deepEqual(
    { ...pure.usage },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, priced: false },
    "a pure reply carries no usage anywhere in the stream (receipt §2) — recorded as such, never invented",
  );
  assert.equal(pure.sessionId, "ses_ec253b380ffe4G3XXxX9u4Zt9n");

  // The tool run from receipt §4: two messages, usage only on the tool step.
  const tool = parseOpencode2Stream(V2_TOOL_STREAM);
  assert.equal(tool.summary, "12");
  assert.equal(tool.turns, 2, "turns count step_start messageIDs, not step_finish (the terminal text step emits none)");
  assert.equal(tool.usage.inputTokens, 4861);
  assert.equal(tool.usage.outputTokens, 64, "output + reasoning, as on 1.x");
  assert.equal(tool.usage.cacheReadTokens, 3584);
  assert.equal(tool.usage.totalTokens, 8509);
  assert.equal(tool.usage.priced, false, "cost 0 with the subscription provider: counted, not priced");
  assert.equal(tool.sessionId, "ses_toolrun0000000000000000001");

  // A cost the stream DID report, on a run whose terminal text step has no
  // step_finish (receipt §4: it never does): the figure is a lower bound, so
  // the run is unpriced rather than priced-but-short.
  const priced = parseOpencode2Stream(V2_TOOL_STREAM.replace('"cost":0,', '"cost":0.0123,'));
  assert.equal(priced.usage.priced, false, "two model steps, one step_finish: usage is incomplete, not priced");
  assert.equal(priced.usage.costUSD, undefined);
  assert.equal(priced.usage.inputTokens, 4861, "the tokens it does carry are kept");

  // Resume stream (receipt §3 Run B): context is the vendor's problem; Ship
  // records what came back.
  const resumed = parseOpencode2Stream(V2_RESUME_STREAM);
  assert.equal(resumed.turns, 1);
  assert.match(resumed.summary, /ZULU-7/);
  assert.equal(resumed.sessionId, "ses_shipproof_v2contract");

  // In-stream error (receipt §2): same role as 1.x, richer fields.
  const errored = parseOpencode2Stream(V2_ERROR_STREAM);
  assert.equal(errored.error, "Provider request failed with HTTP 401");
  assert.equal(errored.sessionId, "ses_ec2542a35ffeOd4SukP1pZcV3y", "the session is known even from a failed run");
});

test("envFile forwards only named, present, well-formed variables and quotes for sh", () => {
  const { text, names } = envFile(["CLAUDE_CODE_OAUTH_TOKEN", "MISSING", "bad-name", "ANTHROPIC_API_KEY"], {
    CLAUDE_CODE_OAUTH_TOKEN: "tok'en",
    ANTHROPIC_API_KEY: "",
  });
  assert.deepEqual(names, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.equal(text, `CLAUDE_CODE_OAUTH_TOKEN='tok'\\''en'\n`);
  assert.equal(shq("a b"), "'a b'");
});

test("externalHarnessConfig reads its env with defaults", () => {
  const d = externalHarnessConfig("claude-code", {});
  assert.equal(d.timeoutMs, 30 * 60_000);
  assert.equal(d.model, undefined);
  assert.equal(d.claudeBare, false);
  assert.deepEqual(d.forward, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
  const c = externalHarnessConfig("opencode", { SHIP_HARNESS_TIMEOUT_MS: "1000", SHIP_HARNESS_MODEL: "zai/glm-5.3", SHIP_HARNESS_ENV: "ZAI_API_KEY, X", SHIP_CLAUDE_BARE: "1" });
  assert.equal(c.timeoutMs, 1000);
  assert.equal(c.model, "zai/glm-5.3");
  assert.deepEqual(c.forward, ["ZAI_API_KEY", "X"]);
  assert.equal(c.claudeBare, true);
});

test("externalPrompt states the tree-is-the-deliverable contract", () => {
  const p = externalPrompt("Fix the bug");
  assert.match(p, /^Fix the bug/);
  assert.match(p, /do not commit, push/);
});

test("opencodeSessionId is deterministic, ses-prefixed, and scoped per attempt", () => {
  assert.match(opencodeSessionId("run-abc", ""), /^ses_ship_run-abc$/);
  assert.equal(opencodeSessionId("run-abc", "attempt-1-"), "ses_ship_run-abc_attempt-1-");
  assert.equal(opencodeSessionId("run-abc", ""), opencodeSessionId("run-abc", ""), "a replay rebuilds the same id");
  // Receipt §3: arbitrary ids are rejected — the ses prefix is required.
  assert.ok(opencodeSessionId("x", "").startsWith("ses"));
});

/**
 * A fake `claude` on PATH: records the prompt and the environment it saw,
 * edits the tree, and prints a recorded stream-json. The adapter must then
 * report the recorded result, and a replay must not run the binary again.
 */
async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

async function workspaceWithFakeClaude(opts: { recordTo: string; stream: string }): Promise<{ provider: ExecutorProvider; runs: () => Promise<number> }> {
  const bin = await mkdtemp(join(tmpdir(), "fake-harness-bin-"));
  const work = await mkdtemp(join(tmpdir(), "fake-harness-work-"));
  await fakeBin(
    bin,
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi`,
      `echo run >> ${shq(join(opts.recordTo, "runs"))}`,
      `printf '%s' "$2" > ${shq(join(opts.recordTo, "prompt"))}`,
      `printf '%s\\n' "$*" >> ${shq(join(opts.recordTo, "args"))}`,
      `printf 'OAUTH=%s KEY=%s SANDBOX=%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN" "$ANTHROPIC_API_KEY" "$IS_SANDBOX" > ${shq(join(opts.recordTo, "env"))}`,
      `echo edited > edited.txt`,
      `cat <<'EOF'\n${opts.stream}\nEOF`,
    ].join("\n"),
  );
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return {
    provider: { isolated: true, async create() { return { handle: work }; }, attach() { return executor; } },
    runs: async () => (await readFile(join(opts.recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length,
  };
}

const stepsOf = (events: readonly WorkflowEvent[]): string[] => events.filter((e) => e.type === "step-completed").map((e) => e.name as string);
const stepResult = <T>(events: readonly WorkflowEvent[], name: string): T =>
  (events.find((e) => e.type === "step-completed" && e.name === name)?.data as { result: T }).result;

test("claude-code adapter: preflight + one recorded run, prompt and credentials delivered, subscription run unpriced, replay never re-runs the binary", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-harness-rec-"));
  const stream = [JSON.stringify({ type: "system", subtype: "init", session_id: CLAUDE_RESULT.session_id }), JSON.stringify({ type: "assistant" }), JSON.stringify(CLAUDE_RESULT)].join("\n");
  const { provider, runs } = await workspaceWithFakeClaude({ recordTo, stream });
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake", SHIP_HARNESS_MODEL: "sonnet" };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env }), maxSteps: 7 });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-claude",
    store,
    input: { task: "Fix the thing", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.agentSummary, "Appended the fix and ran the tests.");
  assert.equal(out.turns, 3);
  assert.equal(out.usage?.priced, false, "an OAuth-token run is a subscription run: unpriced");
  assert.equal(out.usage?.costUSD, undefined);
  assert.equal(out.usage?.inputTokens, 10);

  const events = await store.load("run-claude");
  // No steer flag in the input: the exact two-step sequence every earlier
  // external log carries — the D6/D7 steps are gated on it.
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run"]);
  const record = stepResult<{ forwarded: string[]; exitCode: number; sessionId?: string }>(events, "harness-run");
  assert.deepEqual(record.forwarded, ["CLAUDE_CODE_OAUTH_TOKEN"], "names only, never values");
  assert.equal(record.exitCode, 0);
  assert.equal(record.sessionId, CLAUDE_RESULT.session_id, "the session id is durable in the log (D7)");
  const runStep = events.find((e) => e.type === "step-completed" && e.name === "harness-run");
  assert.ok(!JSON.stringify(runStep).includes("sk-ant-oat-fake"), "the credential must not be in the log");

  assert.match(await readFile(join(recordTo, "prompt"), "utf8"), /^Fix the thing[\s\S]*do not commit/);
  assert.equal(await readFile(join(recordTo, "env"), "utf8"), "OAUTH=sk-ant-oat-fake KEY= SANDBOX=1\n");
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.match(args, /--output-format stream-json/);
  assert.match(args, /--permission-mode bypassPermissions/);
  assert.match(args, /--max-turns 7/);
  assert.match(args, /--model sonnet/);
  assert.doesNotMatch(args, /--max-budget-usd/, "no dollar budget on an unpriced run");
  assert.doesNotMatch(args, /--resume/, "no resume without steering");
  assert.equal(await runs(), 1);

  // Replay: same outcome, the binary is not run again.
  const again = await executeRun({ workflow: wf, runId: "run-claude", store, input: { task: "Fix the thing" } });
  assert.equal(again.status, "completed");
  assert.equal(await runs(), 1, "replay must not re-run the harness");
});

test("claude-code adapter: an API-key run is priced, carries claude's cost, and gets the dollar ceiling", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-harness-rec-"));
  const { provider } = await workspaceWithFakeClaude({ recordTo, stream: JSON.stringify(CLAUDE_RESULT) });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_API_KEY: "sk-ant-api-fake" } }),
    maxRunCostUSD: 2,
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-claude-api",
    store,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.usage?.priced, true);
  assert.equal(out.usage?.costUSD, 0.0123);
  assert.match(await readFile(join(recordTo, "args"), "utf8"), /--max-budget-usd 2\.00/);
});

test("a missing binary is a recorded error result, not a thrown step", async () => {
  const work = await mkdtemp(join(tmpdir(), "fake-harness-nobin-"));
  const bin = await mkdtemp(join(tmpdir(), "fake-harness-emptybin-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: bin } });
  const provider: ExecutorProvider = { async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-nobin",
    store,
    input: { task: "t", harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } },
  });
  assert.equal(outcome.status, "completed");
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /opencode is not on PATH in the sandbox image/);
  // The message has to carry the FIX, not just the fact: harnesses are baked,
  // and an operator who has just met that word needs the command.
  assert.match(out.summary, /images\/build\.sh --harness opencode/);
  assert.match(out.summary, /@opencode\/cli@/);
  assert.deepEqual(stepsOf(await store.load("run-nobin")), ["sandbox", "harness-preflight"]);
});

test("versionMajor reads the major out of a --version line, or nothing", () => {
  assert.equal(versionMajor("opencode 1.18.23"), 1);
  assert.equal(versionMajor("1.2.3"), 1);
  assert.equal(versionMajor("opencode 2.0.26 (brew)"), 2);
  assert.equal(versionMajor("2.0.0-beta.4"), 2, "a 2.0.0 pre-release is still the 2.x contract");
  assert.equal(versionMajor("opencode (custom build)"), undefined, "no x.y.z, no guess");
  assert.equal(versionMajor(""), undefined);
});

test("the version guard now refuses only an opencode PAST the measured 2.x line", () => {
  const message = opencodeFutureLineRefusal("opencode 3.1.0", "2.0.26");
  assert.match(message, /3\.1\.0/);
  assert.match(message, /@opencode\/cli@2\.0\.26/);
  assert.match(message, new RegExp(REF.replace(/\//g, "\\/")));
  const unpinned = opencodeFutureLineRefusal("opencode 3.1.0");
  assert.match(unpinned, /3\.1\.0/);
  assert.doesNotMatch(unpinned, /versions\.json/);
});

/** A fake `opencode` whose --version line the caller picks; records whether its run path ever executed. */
async function workspaceWithFakeOpencode(opts: {
  recordTo: string;
  versionLine: string;
  stream: string;
  resumeStream?: string;
}): Promise<{ provider: ExecutorProvider; runs: () => Promise<number>; args: () => Promise<string> }> {
  const bin = await mkdtemp(join(tmpdir(), "fake-oc-bin-"));
  await fakeBin(
    bin,
    "opencode",
    [
      `if [ "$1" = "--version" ]; then printf '%s\\n' ${shq(opts.versionLine)}; exit 0; fi`,
      `echo run >> ${shq(join(opts.recordTo, "runs"))}`,
      `printf '%s\\n' "$*" >> ${shq(join(opts.recordTo, "args"))}`,
      // The resume exec reads a different prompt file; print the other stream for it.
      `if [ -f .teploy-agent/harness-steer.md ]; then printf '%s\\n' ${shq(opts.resumeStream ?? opts.stream)}; else printf '%s\\n' ${shq(opts.stream)}; fi`,
    ].join("\n"),
  );
  const work = await mkdtemp(join(tmpdir(), "fake-oc-work-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return {
    provider: { isolated: true, async create() { return { handle: work }; }, attach: () => executor },
    runs: async () => (await readFile(join(opts.recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length,
    args: () => readFile(join(opts.recordTo, "args"), "utf8").catch(() => ""),
  };
}

const OPENCODE_V1_OK_STREAM = [
  JSON.stringify({ type: "step_start", part: {} }),
  JSON.stringify({ type: "text", part: { type: "text", text: "Done: fixed lib.ts" } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
].join("\n");

test("opencode adapter refuses an opencode PAST 2.x at preflight: recorded error, nothing runs, replay agrees", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-future-rec-"));
  const runs = async () => (await readFile(join(recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length;
  const provider = (await workspaceWithFakeOpencode({ recordTo, versionLine: "opencode 3.1.0", stream: OPENCODE_V1_OK_STREAM })).provider;
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const input = { task: "t", harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } };
  const outcome = await executeRun({ workflow: wf, runId: "run-oc-future", store, input });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /3\.1\.0/);
  assert.match(out.summary, /Nothing ran\./);
  assert.deepEqual(stepsOf(await store.load("run-oc-future")), ["sandbox", "harness-preflight"], "no harness-run step: the refusal stops the attempt where the missing-binary one does");
  const pre = stepResult<{ found: boolean; version: string; refused: string }>((await store.load("run-oc-future")), "harness-preflight");
  assert.equal(pre.found, true);
  assert.match(pre.refused, /3\.1\.0/);
  assert.equal(await runs(), 0, "the binary's run path must never execute");
  const replay = await executeRun({ workflow: wf, runId: "run-oc-future", store, input });
  assert.equal((replay.output as DurableAgentOutput).status, "error");
  assert.equal(await runs(), 0, "replay must not re-run the harness");
});

test("opencode adapter still drives a 1.x binary through the v1 invocation, and an unparseable version behaves as before", async () => {
  for (const [runId, versionLine, label] of [
    ["run-oc-pass-v1", "1.18.23", "v1.x version string passes"],
    ["run-oc-pass-noversion", "opencode (source build)", "missing version info behaves as today"],
  ] as const) {
    const recordTo = await mkdtemp(join(tmpdir(), "oc-v1-rec-"));
    const { provider, runs, args } = await workspaceWithFakeOpencode({ recordTo, versionLine, stream: OPENCODE_V1_OK_STREAM });
    const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId,
      store,
      input: { task: "t", harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const out = outcome.output as DurableAgentOutput;
    assert.equal(out.status, "finished", label);
    assert.equal(out.agentSummary, "Done: fixed lib.ts");
    assert.equal(await runs(), 1, `${label}: the binary ran`);
    assert.match(await args(), /--pure --dir \./, `${label}: the v1 invocation, unchanged`);
    const events = await store.load(runId);
    assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run"], label);
    assert.equal(stepResult<{ sessionId?: string }>(events, "harness-run").sessionId, undefined, `${label}: the 1.x line records no session`);
  }
});

test("opencode v2 (D6): the 2.x binary runs the v2 invocation with a caller-chosen session, the session id is recorded, replay never re-runs it", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-v2-rec-"));
  const { provider, runs, args } = await workspaceWithFakeOpencode({ recordTo, versionLine: "2.0.26", stream: V2_TOOL_STREAM });
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const input = { task: "t", harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } };
  const outcome = await executeRun({ workflow: wf, runId: "run-oc-v2", store, input });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.agentSummary, "12");
  assert.equal(out.turns, 2, "the v2 parser counts step_start messageIDs");
  assert.equal(out.usage?.inputTokens, 4861);
  assert.equal(out.usage?.priced, false, "cost 0: counted, not priced");

  const events = await store.load("run-oc-v2");
  const record = stepResult<{ sessionId?: string; exitCode: number }>(events, "harness-run");
  // The recorded session is the one the stream reported — which for a
  // caller-chosen id is the id Ship passed.
  assert.equal(record.sessionId, "ses_toolrun0000000000000000001");
  const invocation = await args();
  assert.match(invocation, /--session ses_[a-z0-9_-]+/);
  assert.equal(opencodeSessionId("run-oc-v2", ""), "ses_ship_run-oc-v2");
  assert.doesNotMatch(invocation, /--pure|--dir/, "v2 removed both flags; the invocation must not pass them");

  // Replay: the recorded steps return, the binary is not run again.
  const replay = await executeRun({ workflow: wf, runId: "run-oc-v2", store, input });
  assert.equal((replay.output as DurableAgentOutput).status, "finished");
  assert.equal(await runs(), 1, "v1-path replay: the vendor process never re-runs");
  assert.deepEqual(stepsOf(await store.load("run-oc-v2")), ["sandbox", "harness-preflight", "harness-run"], "no steer flag: no steer steps");
});

/** A steer store scripted per round — the drain the worker wires, faked. */
function scriptedSteer(rounds: Record<string, string[]>): { drain: (runId: string, turn: string | number) => Promise<string[]> } {
  return { drain: async (_runId, turn) => rounds[String(turn)] ?? [] };
}

test("opencode v2 steering (D6): a pending note is drained at the process boundary and delivered by resuming the recorded session; replay never re-runs the vendor", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-v2-steer-rec-"));
  const { provider, runs, args } = await workspaceWithFakeOpencode({
    recordTo,
    versionLine: "2.0.26",
    stream: V2_TOOL_STREAM,
    resumeStream: V2_RESUME_STREAM,
  });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-0": ["prefer the smaller change"] }) }),
  });
  const store = new MemoryEventStore();
  const input = { task: "t", steer: true, harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } };
  const outcome = await executeRun({ workflow: wf, runId: "run-oc-steer", store, input });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  // The final account is the RESUME's (the work ended there); turns and usage
  // accumulate across both execs.
  assert.equal(out.status, "finished");
  assert.match(out.agentSummary!, /ZULU-7/);
  assert.equal(out.turns, 2 + 1);
  assert.equal(out.usage?.inputTokens, 4861 + 0, "usage sums across the execs of the session");

  const events = await store.load("run-oc-steer");
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run", "harness-steer-0", "harness-resume-0", "harness-steer-1", "harness-steer-undelivered"]);
  assert.deepEqual(stepResult<string[]>(events, "harness-steer-0"), ["prefer the smaller change"], "the drained notes are the recorded step value");
  assert.deepEqual(stepResult<string[]>(events, "harness-steer-1"), [], "the terminating drain is recorded too, so replay breaks at the same round");
  const resume = stepResult<{ exitCode: number; sessionId?: string; turns: number }>(events, "harness-resume-0");
  assert.equal(resume.sessionId, "ses_shipproof_v2contract", "the resume record carries the session it resumed");
  const invocation = await args();
  // The fake records "$*" after the shell expanded the quotes, so flags and
  // the note text appear unquoted.
  assert.match(invocation, /--session ses_[a-z0-9_-]+ .*Operator steering — adjust course accordingly: prefer the smaller change/);
  assert.equal(await runs(), 2, "main run + one resume");

  // Replay: the recorded steer/resume steps return; no vendor process runs.
  const replay = await executeRun({ workflow: wf, runId: "run-oc-steer", store, input });
  assert.equal((replay.output as DurableAgentOutput).agentSummary, out.agentSummary);
  assert.equal(await runs(), 2, "replay must not re-run the harness or resume it");
  assert.deepEqual(stepsOf(await store.load("run-oc-steer")), ["sandbox", "harness-preflight", "harness-run", "harness-steer-0", "harness-resume-0", "harness-steer-1", "harness-steer-undelivered"]);
});

test("claude-code steering (D7): the note resumes the recorded claude session with --resume", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "cc-steer-rec-"));
  const stream = [JSON.stringify({ type: "system", subtype: "init", session_id: CLAUDE_RESULT.session_id }), JSON.stringify(CLAUDE_RESULT)].join("\n");
  const { provider, runs } = await workspaceWithFakeClaude({ recordTo, stream });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-0": ["also add a test"] }) }),
  });
  const store = new MemoryEventStore();
  const input = { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } };
  const outcome = await executeRun({ workflow: wf, runId: "run-cc-steer", store, input });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.turns, 3 + 3, "turns accumulate across the main run and the resume");

  const events = await store.load("run-cc-steer");
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run", "harness-steer-0", "harness-resume-0", "harness-steer-1", "harness-steer-undelivered"]);
  const invocation = await readFile(join(recordTo, "args"), "utf8");
  assert.match(invocation, new RegExp(`--resume ${CLAUDE_RESULT.session_id}`));
  assert.match(invocation, /Operator steering — adjust course accordingly: also add a test/);
  assert.match(invocation, /--permission-mode bypassPermissions/);
  assert.equal(await runs(), 2);
});

test("negative control: a note accepted for an opencode run on a 1.x binary is refused on the record, never silently dropped", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-v1-steer-rec-"));
  const { provider, runs } = await workspaceWithFakeOpencode({ recordTo, versionLine: "1.18.23", stream: OPENCODE_V1_OK_STREAM });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-0": ["note that cannot land"] }) }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-oc-v1-steer",
    store,
    input: { task: "t", steer: true, harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const events = await store.load("run-oc-v1-steer");
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run", "harness-steer-0", "harness-resume-0", "harness-steer-undelivered"]);
  const refusal = stepResult<{ delivered: false; reason: string }>(events, "harness-resume-0");
  assert.equal(refusal.delivered, false);
  assert.match(refusal.reason, /no session to resume/);
  assert.equal(await runs(), 1, "no second process: there is nothing to resume");
});

test("steering is bounded: a drain that always has notes runs 1 + STEER_ROUNDS_MAX execs in total, and the note it never read is recorded as undelivered", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-v2-bound-rec-"));
  const { provider, runs } = await workspaceWithFakeOpencode({
    recordTo,
    versionLine: "2.0.26",
    stream: V2_PURE_STREAM,
    resumeStream: V2_PURE_STREAM,
  });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: { drain: async () => ["keep going"] } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-oc-bound",
    store,
    input: { task: "t", steer: true, harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const events = await store.load("run-oc-bound");
  const names = stepsOf(events);
  const resumes = names.filter((n) => /^harness-resume-\d+$/.test(n));
  const drains = names.filter((n) => /^harness-steer-\d+$/.test(n));
  assert.equal(resumes.length, STEER_ROUNDS_MAX, "STEER_ROUNDS_MAX resumes");
  assert.equal(drains.length, STEER_ROUNDS_MAX);
  assert.equal(await runs(), 1 + STEER_ROUNDS_MAX, "1 main + STEER_ROUNDS_MAX resumes, as documented");
  // The drain the loop never got to read from is not lost: the closing step
  // takes it into the undelivered record, visible in the run's output.
  assert.deepEqual(stepResult<string[]>(events, "harness-steer-undelivered"), ["keep going"]);
  assert.match((outcome.output as DurableAgentOutput).agentSummary!, /NOT delivered to the agent \(1\): keep going/);
});

test("a run recorded under version 1 still runs and replays under the v1 alias; an unknown version is still refused", async () => {
  for (const [id, versionLine, stream] of [
    ["opencode", "1.18.23", OPENCODE_V1_OK_STREAM],
    ["claude-code", "9.9.9", JSON.stringify(CLAUDE_RESULT)],
  ] as const) {
    const recordTo = await mkdtemp(join(tmpdir(), "xver-rec-"));
    const rig = id === "opencode" ? await workspaceWithFakeOpencode({ recordTo, versionLine, stream }) : await workspaceWithFakeClaude({ recordTo, stream });
    const drained: string[] = [];
    const wf = durableAgent({
      model: neverModel,
      executor: rig.provider,
      workdir: ".",
      harnesses: externalAdapters({ env: {}, steer: { drain: async (_r, key) => (drained.push(String(key)), ["a note"]) } }),
    });
    const store = new MemoryEventStore();
    // The ref a pre-D6/D7 enqueue recorded — with the steer flag every new run carries.
    const input = { task: "t", steer: true, harness: { id, version: "1" } };
    const outcome = await executeRun({ workflow: wf, runId: `run-${id}-v1`, store, input });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal((outcome.output as DurableAgentOutput).status, "finished");
    assert.deepEqual(stepsOf(await store.load(`run-${id}-v1`)), ["sandbox", "harness-preflight", "harness-run"], "contract 1 records no steer steps");
    assert.deepEqual(drained, [], "the alias never drains notes it cannot deliver");
    assert.equal(await rig.runs(), 1);
    const replay = await executeRun({ workflow: wf, runId: `run-${id}-v1`, store, input });
    assert.equal(replay.status, "completed");
    assert.equal(await rig.runs(), 1, "replay never re-runs the vendor");

    const unknown = await executeRun({ workflow: wf, runId: `run-${id}-v3`, store: new MemoryEventStore(), input: { task: "t", harness: { id, version: "3" } } });
    assert.equal(unknown.status, "failed");
    assert.match(unknown.error?.detail ?? "", /refuses to replay under a different program/);
  }
});

test("the step-fingerprint table admits the steer steps only for contracts that record them", () => {
  const steps = (version: string) => admittedSteps({ task: "t", steer: true, harness: { id: "claude-code", version } });
  const steerSteps = (keys: string[]) => keys.filter((k) => /harness-(steer|resume)/.test(k));
  assert.deepEqual(steerSteps(steps("1")), [], "a version-1 external run records no steer steps, so its fingerprint stays what it was");
  assert.equal(steerSteps(steps("2")).length, 3);
});

test("opencode adapter on a repo run: the tree it leaves goes through Ship's publish gate", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "oc-bare-"));
  const seedDir = await mkdtemp(join(tmpdir(), "oc-seed-"));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'a\\n' > lib.ts && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );
  const bin = await mkdtemp(join(tmpdir(), "oc-bin-"));
  const stream = [
    JSON.stringify({ type: "step_start", part: {} }),
    JSON.stringify({ type: "text", part: { type: "text", text: "Fixed lib.ts" } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
  ].join("\n");
  await fakeBin(bin, "opencode", [`if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi`, `printf 'b\\n' >> lib.ts`, `cat <<'EOF'\n${stream}\nEOF`].join("\n"));
  const work = await mkdtemp(join(tmpdir(), "oc-work-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { async create() { return { handle: work }; }, attach: () => executor };
  const memory = new FileRepoMemory(await mkdtemp(join(tmpdir(), "oc-mem-")));

  // The file:// remote has no PR API; stub it the way the fixture generator did.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("file:///api/v1/")) return realFetch(url, init);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${u}`);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/pulls") && method === "GET") return json([]);
    if (u.endsWith("/pulls") && method === "POST") return json({ number: 3, html_url: "file:///owner/repo/pulls/3" }, 201);
    return json({ number: 3, body: "" });
  }) as typeof fetch;
  try {
    const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", repoMemory: memory, harnesses: externalAdapters({ env: {} }) });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-oc-repo",
      store,
      input: {
        task: "append b",
        repo: `file://${bareDir}/owner/repo.git`,
        trust: "operator",
        harness: { id: "opencode", version: HARNESS_VERSIONS.opencode },
      },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const out = outcome.output as DurableAgentOutput;
    assert.equal(out.status, "finished");
    assert.equal(out.agentSummary, "Fixed lib.ts");
    assert.equal(out.pr, "file:///owner/repo/pulls/3");
    assert.equal(out.usage?.priced, false);
    assert.deepEqual(stepsOf(await store.load("run-oc-repo")), [
      "sandbox", "repo-setup", "repo-context", "harness-preflight", "harness-run", "repo-push", "repo-pr", "repo-memory",
    ]);
    assert.ok(calls.some((c) => c.startsWith("POST ") && c.endsWith("/pulls")), "the PR was opened by Ship, not the harness");
    // The pushed commit is the harness's tree, made by Ship.
    const log = await seeder.exec(`git --git-dir=${bareDir}/owner/repo.git log --all --oneline`);
    assert.match(log.stdout, /append b/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("live trackers: v1 tool events and v2 tool_use/messageID turns, across torn chunks; only changes are reported", async () => {
  const { claudeLiveTracker, opencodeLiveTracker } = await import("./harness-external.js");
  const t = claudeLiveTracker();
  const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the parser." }] } });
  const line2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/parser.ts", old_string: "a" } }] } });
  assert.equal(t.feed(`${JSON.stringify({ type: "system", subtype: "init" })}\n`), null, "init is not progress");
  const half = line1.slice(0, 20);
  assert.equal(t.feed(half), null, "a torn line is held");
  assert.deepEqual(t.feed(`${line1.slice(20)}\n${line2}\n`), { phase: "harness", turn: 2, detail: "Edit src/parser.ts" });
  assert.equal(t.feed("garbage not json\n"), null);

  // v1 opencode: unchanged — step_finish ticks the turn, `tool` gives detail.
  const v1 = opencodeLiveTracker();
  assert.deepEqual(v1.feed(`${JSON.stringify({ type: "tool", part: { tool: "bash", state: { input: { command: "pnpm test" } } } })}\n`), { phase: "harness", turn: 0, detail: "bash pnpm test" });
  assert.deepEqual(v1.feed(`${JSON.stringify({ type: "step_finish", part: { tokens: {} } })}\n`), { phase: "harness", turn: 1 });

  // v2 opencode, the receipt's measured tool stream: the turn ticks at each
  // NEW step_start messageID (the terminal text step emits no step_finish),
  // tool_use carries the detail the v1 tracker was blind to.
  const v2 = opencodeLiveTracker();
  const updates = V2_TOOL_STREAM.split("\n").map((line) => v2.feed(`${line}\n`));
  assert.deepEqual(updates[0], { phase: "harness", turn: 1 });
  assert.deepEqual(updates[1], { phase: "harness", turn: 1, detail: "shell ls -a" });
  assert.equal(updates[2], null, "step_finish does not double-tick a message it already ticked");
  assert.deepEqual(updates[3], { phase: "harness", turn: 2 });
  assert.deepEqual(updates[4], { phase: "harness", turn: 2, detail: "12" });
});

test("claude-code adapter streams through execStream when the workspace has one, and the live store sees the harness's turns", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-harness-rec-"));
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "go test ./..." } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
    JSON.stringify(CLAUDE_RESULT),
  ].join("\n");
  const { provider } = await workspaceWithFakeClaude({ recordTo, stream });
  const chunks: string[] = [];
  const streaming: ExecutorProvider = {
    ...provider,
    // A streamed exec over the same local executor: the output is handed to
    // onChunk as it would arrive from the daemon's SSE, then returned whole.
    async execStream(handle, command, options, onChunk) {
      const result = await provider.attach(handle).exec(command, options);
      for (let i = 0; i < result.stdout.length; i += 37) {
        const piece = result.stdout.slice(i, i + 37);
        chunks.push(piece);
        onChunk("stdout", piece);
      }
      return result;
    },
  };
  const phases: Array<{ phase: string; turn?: number; detail?: string }> = [];
  const live = { set: async (_runId: string, u: { phase: string; turn?: number; detail?: string }) => { phases.push(u); } };
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" };
  const wf = durableAgent({ model: neverModel, executor: streaming, workdir: ".", harnesses: externalAdapters({ env }), maxSteps: 7, live });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-claude-stream",
    store,
    input: { task: "Fix the thing", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  assert.equal((outcome.output as DurableAgentOutput).status, "finished");
  assert.ok(chunks.length > 1, "the exec was streamed in pieces");
  assert.deepEqual(phases[0], { phase: "harness", turn: 0, detail: "claude starting" });
  assert.ok(phases.some((p) => p.phase === "harness" && p.turn === 1 && p.detail === "Bash go test ./..."), JSON.stringify(phases));
  assert.ok(phases.some((p) => p.phase === "harness" && p.turn === 2 && p.detail === "Done."), JSON.stringify(phases));
});

test("external scan prompt asks for findings without an edited tree", () => {
  const p = externalPrompt("Verify the environment", "scan");
  assert.match(p, /read-only investigation/);
  assert.match(p, /Nothing will be published/);
  assert.doesNotMatch(p, /EDITED WORKING TREE|what you changed/);
});

// --- codex -----------------------------------------------------------------

const CODEX_EVENTS = [
  JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
  JSON.stringify({ type: "turn.started" }),
  "not json at all",
  JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "bash -lc ls", status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bash -lc ls", aggregated_output: "src\n", exit_code: 0, status: "completed" } }),
  JSON.stringify({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "interim" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: "src/lib.ts", kind: "update" }, { path: "src/new.ts", kind: "add" }], status: "completed" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Fixed lib.ts and added new.ts." } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 12, output_tokens: 122, reasoning_output_tokens: 10 } }),
].join("\n");

test("parseCodexExecStream reads thread id, summary, file changes, commands; usage nests the way codex counts", () => {
  const parsed = parseCodexExecStream(CODEX_EVENTS);
  assert.equal(parsed.status, "finished");
  assert.equal(parsed.summary, "Fixed lib.ts and added new.ts.");
  assert.equal(parsed.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.commands, 1, "only completed command_execution items count");
  assert.deepEqual(parsed.fileChanges, ["update src/lib.ts", "add src/new.ts"]);
  assert.equal(parsed.sawCompletion, true);
  // cached input and reasoning output are nested INSIDE input/output tokens
  // (codex-rs Usage; T3's CodexTurnTokenUsage reads them the same way), so
  // total is their sum — never a sum over every field.
  assert.equal(parsed.usage.inputTokens, 24763);
  assert.equal(parsed.usage.outputTokens, 122);
  assert.equal(parsed.usage.cacheReadTokens, 24448);
  assert.equal(parsed.usage.cacheWriteTokens, 12);
  assert.equal(parsed.usage.totalTokens, 24885);
  assert.equal(parsed.usage.priced, false, "codex reports no dollars: unpriced, tokens recorded");
  assert.equal(parsed.usage.costUSD, undefined);
});

test("parseCodexExecStream: turn.failed, stream errors and missing completion are errors; junk lines are skipped", () => {
  const failed = parseCodexExecStream([JSON.stringify({ type: "thread.started", thread_id: "t1" }), JSON.stringify({ type: "turn.failed", error: { message: "stream error: timeout" } })].join("\n"));
  assert.equal(failed.status, "error");
  assert.match(failed.summary, /stream error: timeout/);
  assert.equal(failed.threadId, "t1");

  const streamError = parseCodexExecStream([JSON.stringify({ type: "error", message: "boom" })].join("\n"));
  assert.equal(streamError.status, "error");
  assert.match(streamError.summary, /boom/);

  const none = parseCodexExecStream(["{not json", JSON.stringify({ type: "turn.started" })].join("\n"));
  assert.equal(none.status, "error");
  assert.equal(none.sawCompletion, false);
  assert.match(none.summary, /no turn\.completed/);
});

test("codex defaults forward the automation credentials and the gateway pair; SHIP_HARNESS_ENV overrides as elsewhere", () => {
  const d = externalHarnessConfig("codex", {});
  assert.deepEqual(d.forward, ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "AI_GATEWAY_URL", "AI_GATEWAY_KEY"]);
  const over = externalHarnessConfig("codex", { SHIP_HARNESS_ENV: "CODEX_API_KEY" });
  assert.deepEqual(over.forward, ["CODEX_API_KEY"]);
});

test("codexGatewayConfigFlags declare the teploy-gateway provider only when AI_GATEWAY_URL is forwarded", () => {
  assert.equal(codexGatewayConfigFlags(["CODEX_API_KEY"]), "");
  const flags = codexGatewayConfigFlags(["CODEX_API_KEY", "AI_GATEWAY_URL", "AI_GATEWAY_KEY"]);
  assert.match(flags, /--config 'model_providers\.teploy-gateway\.name="teploy-gateway"'/);
  // The base_url rides in single quotes inside a double-quoted shell word, so
  // $AI_GATEWAY_URL expands inside the sandbox after harness.env is sourced —
  // the URL never appears in the command Ship builds.
  assert.match(flags, /--config "model_providers\.teploy-gateway\.base_url='\$AI_GATEWAY_URL'"/);
  assert.match(flags, /--config 'model_providers\.teploy-gateway\.env_key="AI_GATEWAY_KEY"'/);
  assert.match(flags, /--config 'model_provider="teploy-gateway"'/);
});

async function workspaceWithFakeCodex(opts: { recordTo: string; stream: string; exitCode?: number }): Promise<{ provider: ExecutorProvider; runs: () => Promise<number> }> {
  const bin = await mkdtemp(join(tmpdir(), "fake-codex-bin-"));
  const work = await mkdtemp(join(tmpdir(), "fake-codex-work-"));
  await fakeBin(
    bin,
    "codex",
    [
      `if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0 (fake)"; exit 0; fi`,
      `echo run >> ${shq(join(opts.recordTo, "runs"))}`,
      `printf '%s\\n' "$@" > ${shq(join(opts.recordTo, "args"))}`,
      `cat > ${shq(join(opts.recordTo, "prompt"))}`,
      `env > ${shq(join(opts.recordTo, "env"))}`,
      `echo edited > edited.txt`,
      ...(opts.exitCode !== undefined ? [`echo "boom" >&2`, `exit ${opts.exitCode}`] : []),
      `cat <<'EOF'\n${opts.stream}\nEOF`,
    ].join("\n"),
  );
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return {
    provider: { isolated: true, async create() { return { handle: work }; }, attach() { return executor; } },
    runs: async () => (await readFile(join(opts.recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length,
  };
}

test("codex adapter: preflight + one exec, prompt on stdin, thread id and claims recorded, unpriced, undeclared worker secrets never forwarded, replay never re-runs", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-codex-rec-"));
  const { provider, runs } = await workspaceWithFakeCodex({ recordTo, stream: CODEX_EVENTS });
  const env = { CODEX_API_KEY: "sk-codex-fake", UNRELATED_WORKER_SECRET: "keep-me-out" };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-codex",
    store,
    input: { task: "Fix the thing", harness: { id: "codex", version: "1" } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.agentSummary, "Fixed lib.ts and added new.ts.");
  assert.equal(out.usage?.priced, false, "codex reports no dollars: the run is counted, not priced");
  assert.equal(out.usage?.inputTokens, 24763);

  const steps = (await store.load("run-codex")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(steps, ["sandbox", "harness-preflight", "harness-run"]);
  const runStep = (await store.load("run-codex")).find((e) => e.type === "step-completed" && e.name === "harness-run");
  const record = (runStep?.data as { result: { forwarded: string[]; exitCode: number; threadId?: string; fileChanges?: string[]; commands?: number } }).result;
  assert.deepEqual(record.forwarded, ["CODEX_API_KEY"], "names only, never values");
  assert.equal(record.exitCode, 0);
  assert.equal(record.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53", "the vendor session id is durable: it is on the recorded step");
  assert.deepEqual(record.fileChanges, ["update src/lib.ts", "add src/new.ts"]);
  assert.equal(record.commands, 1);
  assert.ok(!JSON.stringify(runStep).includes("sk-codex-fake"), "the credential must not be in the log");

  // The prompt travelled on stdin (codex exec `-`), and carried the contract.
  assert.match(await readFile(join(recordTo, "prompt"), "utf8"), /^Fix the thing[\s\S]*do not commit/);
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.match(args, /--json/);
  assert.match(args, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(args, /--skip-git-repo-check/);
  assert.doesNotMatch(args, /--config/, "no gateway provider without AI_GATEWAY_URL forwarded");
  const seenEnv = await readFile(join(recordTo, "env"), "utf8");
  assert.match(seenEnv, /CODEX_API_KEY=sk-codex-fake/);
  assert.ok(!seenEnv.includes("UNRELATED_WORKER_SECRET"), "a worker secret outside the forward list must not reach the harness");
  assert.equal(await runs(), 1);

  const again = await executeRun({ workflow: wf, runId: "run-codex", store, input: { task: "Fix the thing" } });
  assert.equal(again.status, "completed");
  assert.equal(await runs(), 1, "replay must not re-run the harness");
});

test("codex adapter: a gateway-routed run declares the teploy-gateway provider and passes the URL through the environment", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-codex-gw-"));
  const { provider } = await workspaceWithFakeCodex({ recordTo, stream: CODEX_EVENTS });
  const env = { AI_GATEWAY_URL: "http://ship-gateway:8089/v1", AI_GATEWAY_KEY: "gw-key-fake" };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-codex-gw", store, input: { task: "t", harness: { id: "codex", version: "1" } } });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.match(args, /model_providers\.teploy-gateway\.name="teploy-gateway"/);
  // $AI_GATEWAY_URL expands inside the sandbox after harness.env is sourced,
  // so the binary's argv carries the expanded, TOML-quoted URL — while the
  // flags Ship built (unit test above) and the recorded step carry names only.
  assert.match(args, /model_providers\.teploy-gateway\.base_url='http:\/\/ship-gateway:8089\/v1'/);
  assert.match(args, /model_providers\.teploy-gateway\.env_key="AI_GATEWAY_KEY"/);
  assert.match(args, /model_provider="teploy-gateway"/);
  const seenEnv = await readFile(join(recordTo, "env"), "utf8");
  assert.match(seenEnv, /AI_GATEWAY_URL=http:\/\/ship-gateway:8089\/v1/);
  assert.match(seenEnv, /AI_GATEWAY_KEY=gw-key-fake/);
  // The gateway KEY travels only through the sourced env file, never in argv.
  assert.ok(!args.includes("gw-key-fake"));
});

test("codex adapter: a non-zero exit before a completed turn is an error carrying the stderr tail", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-codex-exit-"));
  const { provider } = await workspaceWithFakeCodex({ recordTo, stream: CODEX_EVENTS, exitCode: 3 });
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-codex-exit", store, input: { task: "t", harness: { id: "codex", version: "1" } } });
  assert.equal(outcome.status, "completed");
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /codex exited 3/);
  assert.match(out.summary, /boom/);
});

test("codex adapter: a stream with no parsable event is a recorded error, never a thrown step", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-codex-junk-"));
  const { provider } = await workspaceWithFakeCodex({ recordTo, stream: "waiting for model\n{\broken" });
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-codex-junk", store, input: { task: "t", harness: { id: "codex", version: "1" } } });
  assert.equal(outcome.status, "completed");
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /no turn\.completed/);
});

test("a missing codex binary names the package and the build command", async () => {
  const work = await mkdtemp(join(tmpdir(), "fake-codex-nobin-"));
  const bin = await mkdtemp(join(tmpdir(), "fake-codex-emptybin-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: bin } });
  const provider: ExecutorProvider = { async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-codex-nobin", store, input: { task: "t", harness: { id: "codex", version: "1" } } });
  assert.equal(outcome.status, "completed");
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /codex is not on PATH in the sandbox image/);
  assert.match(out.summary, /images\/build\.sh --harness codex/);
  assert.match(out.summary, /@openai\/codex@/);
});

test("codexLiveTracker: turns, the running command, edits and the agent's message; torn chunks held", async () => {
  const { codexLiveTracker } = await import("./harness-external.js");
  const t = codexLiveTracker();
  const threadStart = JSON.stringify({ type: "thread.started", thread_id: "t1" });
  const turnStart = JSON.stringify({ type: "turn.started" });
  const cmd = JSON.stringify({ type: "item.started", item: { id: "i0", type: "command_execution", command: "bash -lc 'pnpm test'", status: "in_progress" } });
  const edit = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: "src/lib.ts", kind: "update" }], status: "completed" } });
  const msg = JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done: fixed lib.ts" } });
  assert.equal(t.feed(`${threadStart}\n`), null, "thread start is not progress");
  assert.deepEqual(t.feed(`${turnStart}\n`), { phase: "harness", turn: 1 });
  assert.deepEqual(t.feed(`${cmd}\n`), { phase: "harness", turn: 1, detail: "exec bash -lc 'pnpm test'" });
  const half = edit.slice(0, 25);
  assert.equal(t.feed(half), null, "a torn line is held");
  assert.deepEqual(t.feed(`${edit.slice(25)}\n`), { phase: "harness", turn: 1, detail: "edit src/lib.ts" });
  assert.deepEqual(t.feed(`${msg}\n`), { phase: "harness", turn: 1, detail: "Done: fixed lib.ts" });
  assert.equal(t.feed("garbage\n"), null);
});


test("direct external execution cannot bypass requested plan review", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-harness-plan-"));
  const { provider, runs } = await workspaceWithFakeClaude({ recordTo, stream: JSON.stringify(CLAUDE_RESULT) });
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const input = { task: "Fix it", plan: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } };
  const outcome = await executeRun({ workflow: wf, runId: "run-direct-plan", store, input });
  assert.equal((outcome.output as DurableAgentOutput).status, "error");
  assert.match((outcome.output as DurableAgentOutput).summary, /Plan review requires the native harness/);
  assert.equal(await runs(), 0);
  const replay = await executeRun({ workflow: wf, runId: "run-direct-plan", store, input });
  assert.equal((replay.output as DurableAgentOutput).status, "error");
  assert.equal(await runs(), 0);
});

// --- steering follow-ups (review of D6/D7) ---------------------------------

/** A fake `claude` whose main and resume execs print different streams; the resume can fail. */
async function workspaceWithScriptedClaude(opts: {
  recordTo: string;
  main: string;
  resumes: string[];
  resumeExit?: number;
}): Promise<{ provider: ExecutorProvider; runs: () => Promise<number>; args: () => Promise<string[]> }> {
  const bin = await mkdtemp(join(tmpdir(), "fake-cc-script-bin-"));
  const work = await mkdtemp(join(tmpdir(), "fake-cc-script-work-"));
  const resumeCases = opts.resumes
    .map((stream, i) => `  ${i}) cat <<'EOF'\n${stream}\nEOF\n;;`)
    .join("\n");
  await fakeBin(
    bin,
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi`,
      `echo run >> ${shq(join(opts.recordTo, "runs"))}`,
      `echo "$*" | tr '\\n' ' ' >> ${shq(join(opts.recordTo, "args"))}; echo >> ${shq(join(opts.recordTo, "args"))}`,
      `case "$*" in *--resume*)`,
      `  n=$(cat ${shq(join(opts.recordTo, "resume-count"))} 2>/dev/null || echo 0)`,
      `  echo $((n+1)) > ${shq(join(opts.recordTo, "resume-count"))}`,
      `  case $n in`,
      resumeCases,
      `  esac`,
      ...(opts.resumeExit !== undefined ? [`  exit ${opts.resumeExit}`] : []),
      `  exit 0;;`,
      `esac`,
      `cat <<'EOF'\n${opts.main}\nEOF`,
    ].join("\n"),
  );
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return {
    provider: { isolated: true, async create() { return { handle: work }; }, attach() { return executor; } },
    runs: async () => (await readFile(join(opts.recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length,
    args: async () => (await readFile(join(opts.recordTo, "args"), "utf8").catch(() => "")).split("\n").filter((l) => l !== ""),
  };
}

const claudeResult = (over: Record<string, unknown>) => JSON.stringify({ ...CLAUDE_RESULT, ...over });

test("steered resumes get only the REMAINING turn and dollar budget, never the full caps again", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "cc-budget-rec-"));
  const { provider, args } = await workspaceWithScriptedClaude({
    recordTo,
    main: claudeResult({ num_turns: 3, total_cost_usd: 0.5 }),
    resumes: [claudeResult({ num_turns: 2, total_cost_usd: 0.25, result: "resumed once" }), claudeResult({ num_turns: 1, total_cost_usd: 0.1, result: "resumed twice" })],
  });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_API_KEY: "sk-ant-api-fake" }, steer: scriptedSteer({ "ext-0": ["one"], "ext-1": ["two"] }) }),
    maxSteps: 10,
    maxRunCostUSD: 2,
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-cc-budget",
    store,
    input: { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const [main, first, second] = await args();
  assert.match(main!, /--max-turns 10 /);
  assert.match(main!, /--max-budget-usd 2\.00/);
  assert.match(first!, /--max-turns 7 /, "10 - 3 turns already spent");
  assert.match(first!, /--max-budget-usd 1\.50/, "2.00 - 0.50 already spent");
  assert.match(second!, /--max-turns 5 /, "10 - 3 - 2");
  assert.match(second!, /--max-budget-usd 1\.25/, "2.00 - 0.50 - 0.25");
});

test("a steer with no turn or dollar budget left is refused on the record and no resume process starts", async () => {
  for (const [name, config, main] of [
    ["turns", { maxSteps: 3, maxRunCostUSD: 5 }, claudeResult({ num_turns: 3, total_cost_usd: 0.1 })],
    ["dollars", { maxSteps: 40, maxRunCostUSD: 1 }, claudeResult({ num_turns: 1, total_cost_usd: 1.2 })],
  ] as const) {
    const recordTo = await mkdtemp(join(tmpdir(), "cc-nobudget-rec-"));
    const { provider, runs } = await workspaceWithScriptedClaude({ recordTo, main, resumes: [] });
    const wf = durableAgent({
      model: neverModel,
      executor: provider,
      workdir: ".",
      harnesses: externalAdapters({ env: { ANTHROPIC_API_KEY: "sk-ant-api-fake" }, steer: scriptedSteer({ "ext-0": ["more please"] }) }),
      ...config,
    });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: `run-cc-nobudget-${name}`,
      store,
      input: { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const events = await store.load(`run-cc-nobudget-${name}`);
    const refusal = stepResult<{ delivered: false; reason: string }>(events, "harness-resume-0");
    assert.equal(refusal.delivered, false, name);
    assert.match(refusal.reason, /no budget left/, name);
    assert.equal(await runs(), 1, `${name}: nothing ran`);
    assert.deepEqual(stepResult<string[]>(events, "harness-steer-undelivered"), ["more please"], name);
  }
});

test("notes that arrive after the last drain are recorded as undelivered, and the run page refuses further steering once the loop has exited", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "cc-late-rec-"));
  const { provider } = await workspaceWithScriptedClaude({ recordTo, main: claudeResult({}), resumes: [] });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-final": ["too late"] }) }),
  });
  const store = new MemoryEventStore();
  const input = { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } };
  const outcome = await executeRun({ workflow: wf, runId: "run-cc-late", store, input });
  const events = await store.load("run-cc-late");
  assert.deepEqual(stepResult<string[]>(events, "harness-steer-undelivered"), ["too late"]);
  assert.match((outcome.output as DurableAgentOutput).agentSummary!, /NOT delivered to the agent \(1\): too late/);
  assert.equal(steerLoopExited(input, events), true);
  assert.equal(steerLoopExited(input, events.filter((e) => e.name !== "harness-steer-undelivered")), false);
  assert.equal(steerRefusal(input, true), STEER_CLOSED_MESSAGE);
  assert.equal(steerRefusal(input, false), undefined);
});

test("a failed resume does not flip a finished attempt, and a good resume's summary is appended to the original, not substituted", async () => {
  // Failure: the main run finished; the resume dies. The attempt keeps `finished`.
  const failRec = await mkdtemp(join(tmpdir(), "cc-failresume-rec-"));
  const failing = await workspaceWithScriptedClaude({
    recordTo: failRec,
    main: claudeResult({ result: "ORIGINAL-SUMMARY" }),
    resumes: [JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, result: "boom", session_id: CLAUDE_RESULT.session_id })],
    resumeExit: 1,
  });
  const run = async (rig: typeof failing, runId: string) => {
    const wf = durableAgent({
      model: neverModel,
      executor: rig.provider,
      workdir: ".",
      harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-0": ["steer me"] }) }),
    });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId,
      store,
      input: { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
    });
    return { out: outcome.output as DurableAgentOutput, events: await store.load(runId) };
  };
  const failed = await run(failing, "run-cc-failresume");
  assert.equal(failed.out.status, "finished", "a resume failure must not downgrade the main run's outcome");
  assert.match(failed.out.agentSummary!, /ORIGINAL-SUMMARY/);
  assert.match(failed.out.agentSummary!, /Steering not delivered/);
  assert.deepEqual(stepResult<string[]>(failed.events, "harness-steer-undelivered"), ["steer me"], "the consumed note is accounted as undelivered");

  // Success: both summaries survive.
  const okRec = await mkdtemp(join(tmpdir(), "cc-okresume-rec-"));
  const ok = await run(
    await workspaceWithScriptedClaude({ recordTo: okRec, main: claudeResult({ result: "ORIGINAL-SUMMARY" }), resumes: [claudeResult({ result: "RESUME-SUMMARY" })] }),
    "run-cc-okresume",
  );
  assert.equal(ok.out.status, "finished");
  assert.match(ok.out.agentSummary!, /ORIGINAL-SUMMARY/);
  assert.match(ok.out.agentSummary!, /RESUME-SUMMARY/);
});

test("each steer round resumes the latest session id the previous exec reported, not the first", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "cc-session-rec-"));
  const { provider, args } = await workspaceWithScriptedClaude({
    recordTo,
    main: claudeResult({ session_id: "sess-A" }),
    resumes: [claudeResult({ session_id: "sess-B" }), claudeResult({ session_id: "sess-C" })],
  });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: scriptedSteer({ "ext-0": ["one"], "ext-1": ["two"] }) }),
  });
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-cc-session",
    store: new MemoryEventStore(),
    input: { task: "t", steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const [, first, second] = await args();
  assert.match(first!, /--resume sess-A/);
  assert.match(second!, /--resume sess-B/, "the second round continues the session the first resume reported");
});

test("a plan-review refusal starts nothing and the steer loop does not run", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "cc-planrefuse-rec-"));
  const { provider, runs } = await workspaceWithScriptedClaude({ recordTo, main: claudeResult({}), resumes: [] });
  const drained: string[] = [];
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, steer: { drain: async (_r, key) => (drained.push(String(key)), ["a note"]) } }),
  });
  const store = new MemoryEventStore();
  await executeRun({
    workflow: wf,
    runId: "run-cc-planrefuse",
    store,
    input: { task: "t", plan: true, steer: true, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  const names = stepsOf(await store.load("run-cc-planrefuse"));
  assert.ok(!names.some((n) => /^harness-(steer|resume)-\d+$/.test(n)), names.join(","));
  assert.equal(await runs(), 0);
  assert.ok(!drained.some((k) => k.startsWith("ext-") && k !== "ext-final"), "no per-round drain ran: " + drained.join(","));
});

test("selectAdapter matches id AND version across the registered aliases", () => {
  const adapters = externalAdapters({ env: {} });
  assert.equal(selectAdapter(adapters, { id: "claude-code", version: "1" }).version, "1");
  assert.equal(selectAdapter(adapters, { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }).version, HARNESS_VERSIONS["claude-code"]);
  assert.equal(selectAdapter(adapters, { id: "opencode", version: "1" }).version, "1");
  assert.throws(() => selectAdapter(adapters, { id: "opencode", version: "7" }), /refuses to replay under a different program/);
  assert.throws(() => selectAdapter(adapters, { id: "codex", version: "2" }), /refuses to replay under a different program/);
});
