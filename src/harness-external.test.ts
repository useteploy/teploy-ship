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
import { envFile, externalAdapters, externalHarnessConfig, externalPrompt, parseClaudeStream, parseOpencodeStream, shq } from "./harness-external.js";

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
  assert.equal(out.summary, "Appended the fix and ran the tests.");
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
  assert.match(out.summary, /opencode is not available in the sandbox image/);
  const steps = (await store.load("run-nobin")).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(steps, ["sandbox", "harness-preflight"]);
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
    assert.equal(out.summary, "Fixed lib.ts");
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
