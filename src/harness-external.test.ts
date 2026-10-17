import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentOutput, ExecutorProvider } from "./durable.js";
import { FileRepoMemory } from "./repo-memory.js";
import { envFile, externalAdapters, externalHarnessConfig, externalPrompt, codexGatewayConfigFlags, opencodeV2Refusal, parseClaudeStream, parseCodexExecStream, parseOpencodeStream, shq, versionMajor } from "./harness-external.js";

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

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  result: "Appended the fix and ran the tests.",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
};

test("parseClaudeStream reads the result event; cost is recorded only under a priced credential", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
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

  const subscription = parseClaudeStream(stream, false);
  assert.equal(subscription.usage.priced, false);
  assert.equal(subscription.usage.costUSD, undefined, "a subscription estimate must not become spend");
  assert.equal(subscription.usage.inputTokens, 10, "tokens are still recorded");

  assert.equal(parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_max_turns" }), true).status, "max-steps");
  assert.equal(parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_max_budget_usd" }), true).status, "budget-exhausted");
  const failed = parseClaudeStream(JSON.stringify({ ...CLAUDE_RESULT, subtype: "error_during_execution", is_error: true, errors: ["boom"] }), true);
  assert.equal(failed.status, "error");
  assert.match(failed.summary, /boom/);
  const none = parseClaudeStream(JSON.stringify({ type: "assistant" }), true);
  assert.equal(none.status, "error");
  assert.equal(none.sawResult, false);
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
      `printf '%s\\n' "$*" > ${shq(join(opts.recordTo, "args"))}`,
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

test("claude-code adapter: preflight + one recorded run, prompt and credentials delivered, subscription run unpriced, replay never re-runs the binary", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "fake-harness-rec-"));
  const stream = [JSON.stringify({ type: "system", subtype: "init" }), JSON.stringify({ type: "assistant" }), JSON.stringify(CLAUDE_RESULT)].join("\n");
  const { provider, runs } = await workspaceWithFakeClaude({ recordTo, stream });
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake", SHIP_HARNESS_MODEL: "sonnet" };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env }), maxSteps: 7 });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-claude",
    store,
    input: { task: "Fix the thing", harness: { id: "claude-code", version: "1" } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "finished");
  assert.equal(out.agentSummary, "Appended the fix and ran the tests.");
  assert.equal(out.turns, 3);
  assert.equal(out.usage?.priced, false, "an OAuth-token run is a subscription run: unpriced");
  assert.equal(out.usage?.costUSD, undefined);
  assert.equal(out.usage?.inputTokens, 10);

  const steps = (await store.load("run-claude")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(steps, ["sandbox", "harness-preflight", "harness-run"]);
  const runStep = (await store.load("run-claude")).find((e) => e.type === "step-completed" && e.name === "harness-run");
  const record = (runStep?.data as { result: { forwarded: string[]; exitCode: number } }).result;
  assert.deepEqual(record.forwarded, ["CLAUDE_CODE_OAUTH_TOKEN"], "names only, never values");
  assert.equal(record.exitCode, 0);
  assert.ok(!JSON.stringify(runStep).includes("sk-ant-oat-fake"), "the credential must not be in the log");

  assert.match(await readFile(join(recordTo, "prompt"), "utf8"), /^Fix the thing[\s\S]*do not commit/);
  assert.equal(await readFile(join(recordTo, "env"), "utf8"), "OAUTH=sk-ant-oat-fake KEY= SANDBOX=1\n");
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.match(args, /--output-format stream-json/);
  assert.match(args, /--permission-mode bypassPermissions/);
  assert.match(args, /--max-turns 7/);
  assert.match(args, /--model sonnet/);
  assert.doesNotMatch(args, /--max-budget-usd/, "no dollar budget on an unpriced run");
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
  const outcome = await executeRun({ workflow: wf, runId: "run-claude-api", store, input: { task: "t", harness: { id: "claude-code", version: "1" } } });
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
  const outcome = await executeRun({ workflow: wf, runId: "run-nobin", store, input: { task: "t", harness: { id: "opencode", version: "1" } } });
  assert.equal(outcome.status, "completed");
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /opencode is not on PATH in the sandbox image/);
  // The message has to carry the FIX, not just the fact: harnesses are baked,
  // and an operator who has just met that word needs the command.
  assert.match(out.summary, /images\/build\.sh --harness opencode/);
  assert.match(out.summary, /opencode-ai@/);
  const steps = (await store.load("run-nobin")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(steps, ["sandbox", "harness-preflight"]);
});

test("versionMajor reads the major out of a --version line, or nothing", () => {
  assert.equal(versionMajor("opencode 1.18.23"), 1);
  assert.equal(versionMajor("1.2.3"), 1);
  assert.equal(versionMajor("opencode 2.0.26 (brew)"), 2);
  assert.equal(versionMajor("2.0.0-beta.4"), 2, "a 2.0.0 pre-release is still the 2.x contract");
  assert.equal(versionMajor("opencode (custom build)"), undefined, "no x.y.z, no guess");
  assert.equal(versionMajor(""), undefined);
});

test("opencodeV2Refusal names the resolved version, the pin, and the tracked adoption receipt", () => {
  const message = opencodeV2Refusal("opencode 2.0.26", "1.18.23");
  assert.match(message, /2\.0\.26/);
  assert.match(message, /opencode-ai@1\.18\.23/);
  assert.match(message, /images\/versions\.json/);
  assert.match(message, /--pure/);
  assert.match(message, /evals\/receipts\/2026-10-14-opencode-v2-events\.txt/);
  // No pin known (no images/versions.json entry): still refuses, still points
  // at the receipt — the guard must not depend on the pin being present.
  const unpinned = opencodeV2Refusal("opencode 2.0.26");
  assert.match(unpinned, /2\.0\.26/);
  assert.match(unpinned, /2026-10-14-opencode-v2-events\.txt/);
  assert.doesNotMatch(unpinned, /versions\.json/);
});

/** A fake `opencode` whose --version line the caller picks; records whether its run path ever executed. */
async function workspaceWithFakeOpencode(opts: { recordTo: string; versionLine: string; stream: string }): Promise<ExecutorProvider> {
  const bin = await mkdtemp(join(tmpdir(), "fake-oc-bin-"));
  await fakeBin(
    bin,
    "opencode",
    [
      `if [ "$1" = "--version" ]; then printf '%s\\n' ${shq(opts.versionLine)}; exit 0; fi`,
      `echo run >> ${shq(join(opts.recordTo, "runs"))}`,
      `echo edited > edited.txt`,
      `cat <<'EOF'\n${opts.stream}\nEOF`,
    ].join("\n"),
  );
  const work = await mkdtemp(join(tmpdir(), "fake-oc-work-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
}

const OPENCODE_OK_STREAM = [
  JSON.stringify({ type: "step_start", part: {} }),
  JSON.stringify({ type: "text", part: { type: "text", text: "Done: fixed lib.ts" } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
].join("\n");

test("opencode adapter refuses a >= 2.0.0 binary at preflight: recorded error with the named pin and receipt, nothing runs, replay agrees", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "oc-v2-rec-"));
  const runs = async () => (await readFile(join(recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length;
  const provider = await workspaceWithFakeOpencode({ recordTo, versionLine: "opencode 2.0.26", stream: OPENCODE_OK_STREAM });
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const input = { task: "t", harness: { id: "opencode", version: "1" } };
  const outcome = await executeRun({ workflow: wf, runId: "run-oc-v2", store, input });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary, /2\.0\.26/);
  assert.match(out.summary, /opencode-ai@1\.18\.23/);
  assert.match(out.summary, /evals\/receipts\/2026-10-14-opencode-v2-events\.txt/);
  assert.match(out.summary, /Nothing ran\./);
  const steps = (await store.load("run-oc-v2")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(steps, ["sandbox", "harness-preflight"], "no harness-run step: the refusal stops the attempt where the missing-binary one does");
  // The refusal is on the recorded preflight value, so the version the guard
  // saw is in the log even without the summary.
  const preStep = (await store.load("run-oc-v2")).find((e) => e.type === "step-completed" && e.name === "harness-preflight");
  const pre = preStep?.data as { result: { found: boolean; version: string; expected: string; pinned: boolean; refused: string } };
  assert.equal(pre.result.found, true);
  assert.equal(pre.result.version, "opencode 2.0.26");
  assert.equal(pre.result.pinned, false);
  assert.match(pre.result.refused, /2\.0\.26/);
  assert.equal(await runs(), 0, "the binary's run path must never execute");
  const replay = await executeRun({ workflow: wf, runId: "run-oc-v2", store, input });
  assert.equal((replay.output as DurableAgentOutput).status, "error");
  assert.equal(await runs(), 0, "replay must not re-run the harness");
});

test("opencode adapter runs a 1.x binary and an unparseable-version binary exactly as before the guard", async () => {
  for (const [runId, versionLine, label] of [
    ["run-oc-pass-v1", "1.18.23", "v1.x version string passes"],
    ["run-oc-pass-noversion", "opencode (source build)", "missing version info behaves as today"],
  ] as const) {
    const recordTo = await mkdtemp(join(tmpdir(), "oc-v1-rec-"));
    const runs = async () => (await readFile(join(recordTo, "runs"), "utf8").catch(() => "")).split("\n").filter((l) => l === "run").length;
    const provider = await workspaceWithFakeOpencode({ recordTo, versionLine, stream: OPENCODE_OK_STREAM });
    const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
    const store = new MemoryEventStore();
    const outcome = await executeRun({ workflow: wf, runId, store, input: { task: "t", harness: { id: "opencode", version: "1" } } });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const out = outcome.output as DurableAgentOutput;
    assert.equal(out.status, "finished", label);
    assert.equal(out.agentSummary, "Done: fixed lib.ts");
    assert.equal(await runs(), 1, `${label}: the binary ran`);
    const steps = (await store.load(runId)).filter((e) => e.type === "step-completed").map((e) => e.name);
    assert.deepEqual(steps, ["sandbox", "harness-preflight", "harness-run"], label);
  }
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
      input: { task: "append b", repo: `file://${bareDir}/owner/repo.git`, trust: "operator", harness: { id: "opencode", version: "1" } },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const out = outcome.output as DurableAgentOutput;
    assert.equal(out.status, "finished");
    assert.equal(out.agentSummary, "Fixed lib.ts");
    assert.equal(out.pr, "file:///owner/repo/pulls/3");
    assert.equal(out.usage?.priced, false);
    const steps = (await store.load("run-oc-repo")).filter((e) => e.type === "step-completed").map((e) => e.name);
    assert.deepEqual(steps, ["sandbox", "repo-setup", "repo-context", "harness-preflight", "harness-run", "repo-push", "repo-pr", "repo-memory"]);
    assert.ok(calls.some((c) => c.startsWith("POST ") && c.endsWith("/pulls")), "the PR was opened by Ship, not the harness");
    // The pushed commit is the harness's tree, made by Ship.
    const log = await seeder.exec(`git --git-dir=${bareDir}/owner/repo.git log --all --oneline`);
    assert.match(log.stdout, /append b/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("claudeLiveTracker: turns and the last tool call, across torn chunks; only changes are reported", async () => {
  const { claudeLiveTracker, opencodeLiveTracker } = await import("./harness-external.js");
  const t = claudeLiveTracker();
  const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the parser." }] } });
  const line2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/parser.ts", old_string: "a" } }] } });
  assert.equal(t.feed(`${JSON.stringify({ type: "system", subtype: "init" })}\n`), null, "init is not progress");
  const half = line1.slice(0, 20);
  assert.equal(t.feed(half), null, "a torn line is held");
  assert.deepEqual(t.feed(`${line1.slice(20)}\n${line2}\n`), { phase: "harness", turn: 2, detail: "Edit src/parser.ts" });
  assert.equal(t.feed("garbage not json\n"), null);

  const o = opencodeLiveTracker();
  assert.deepEqual(o.feed(`${JSON.stringify({ type: "tool", part: { tool: "bash", state: { input: { command: "pnpm test" } } } })}\n`), { phase: "harness", turn: 0, detail: "bash pnpm test" });
  assert.deepEqual(o.feed(`${JSON.stringify({ type: "step_finish", part: { tokens: {} } })}\n`), { phase: "harness", turn: 1 });
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
  const outcome = await executeRun({ workflow: wf, runId: "run-claude-stream", store, input: { task: "Fix the thing", harness: { id: "claude-code", version: "1" } } });
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
  const input = { task: "Fix it", plan: true, harness: { id: "claude-code", version: "1" } };
  const outcome = await executeRun({ workflow: wf, runId: "run-direct-plan", store, input });
  assert.equal((outcome.output as DurableAgentOutput).status, "error");
  assert.match((outcome.output as DurableAgentOutput).summary, /Plan review requires the native harness/);
  assert.equal(await runs(), 0);
  const replay = await executeRun({ workflow: wf, runId: "run-direct-plan", store, input });
  assert.equal((replay.output as DurableAgentOutput).status, "error");
  assert.equal(await runs(), 0);
});
