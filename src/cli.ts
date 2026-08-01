#!/usr/bin/env node
// teploy-ship — the Ship CLI: run coding-agent tasks live in your
// terminal (streamed, interactive approvals) or as durable runs that
// park on approval, survive exits/crashes, and resume later.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { anthropic, createAnthropic } from "@neutron-build/ai/anthropic";
import { openai, createOpenAI } from "@neutron-build/ai/openai";
import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor, SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { cancelRun, deliverEvent } from "@neutron-build/workflow";
import type { RunOutcome } from "@neutron-build/workflow";

import { ArgError, COMMAND_FLAGS, enumFlag, numberFlag, parseArgs } from "./args.js";
import type { NumberRange } from "./args.js";
import { commitAndPush, fixPrompt, openPullRequest, setupRepo } from "./git.js";
import type { RepoRef } from "./git.js";
import { assertRepoAllowed, credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import { runAgent } from "./agent.js";
import { refusalMessage } from "./publish-policy.js";
import { defaultApprovalPolicy } from "./approval.js";
import { secretEnvNames } from "./guard.js";
import { durableAgent, repoKeyOf, sandboxProvider } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { formatReport, runEval } from "./eval.js";
import type { EvalTask } from "./eval.js";
import { stateDir } from "./run-store.js";
import { buildFeed } from "./inbox.js";
import { fileRuntime, nucleusRuntime } from "./runtime.js";
import type { NucleusShipRuntime, ShipRuntime } from "./runtime.js";
import { NucleusCodeIndex } from "./code-index.js";
import type { CodeSearch } from "./code-index.js";
import { startWorker } from "./worker.js";
import { costUSD, isPricedModel } from "./pricing.js";
import { defaultRetryPolicy, withRetry } from "./provider.js";
import { builtinSuite } from "./tasks.js";
import { hardSuite } from "./hard-tasks.js";
import { extremeSuite } from "./extreme-tasks.js";
import { bold, dim, green, promptApproval, red, renderEvent, renderUsage, yellow } from "./ui.js";

const USAGE = `teploy-ship — coding agent on your own stack

Usage:
  teploy-ship run "<task>"            live run in the terminal (streamed, interactive approvals)
      [--model provider/model]        default anthropic/claude-sonnet-5
      [--sandbox <url> --sandbox-token <t> [--sandbox-image <img>] [--sandbox-network none|egress]]
      [--max-steps N] [--yes] [--json] [--critic]
                     --critic adds an independent review pass before finishing
  teploy-ship run --durable "<task>"  durable run: parks on approvals, survives exits
                     add --plan to review/approve the agent's plan before it acts
                     add --critic for an independent review pass before it finishes
  teploy-ship runs                    list durable runs
  teploy-ship resume <run-id>         continue a durable run (after a crash or park)
  teploy-ship approve <run-id>        approve a parked action and continue
      [--handoff]                     deliver the decision, let a worker finish the run
  teploy-ship deny <run-id> [reason]  deny a parked action and continue
  teploy-ship cancel <run-id> [reason]  stop a durable run (parked or mid-flight)
  teploy-ship inbox                   what needs a decision, newest state first
      [--json]                        teploy.inbox/v1 feed (for the inbox TUI)
  teploy-ship fix --repo <url> "<task>"  clone, fix on a branch, push, open a PR
      [--git-token <t>]               also SHIP_GIT_TOKEN or gitToken in config
      [--base <branch>]               PR target (default: repo default branch)
      (accepts run flags: --model, --sandbox…, --max-steps, --yes, --json, --critic)
      NOTE: fix always needs network to clone/push — pass
      --sandbox-network egress (or sandboxNetwork:"egress" in config)
      whenever --sandbox is used; plain --sandbox defaults to "none".
  teploy-ship worker                  resident worker: picks up due nucleus-store runs
      [--interval seconds]            poll interval (default 5)
      [--max-concurrent N]            cap simultaneously-running auto runs (default 3, SHIP_MAX_CONCURRENT_RUNS)
      [--daily-budget USD]            per-source daily spend cap (default 10, SHIP_DAILY_BUDGET_USD; <=0 off)
      run in a sandbox (needed for repo tasks whose tests want tools the
      worker image lacks): SHIP_SANDBOX_URL + SHIP_SANDBOX_TOKEN
      [+ SHIP_SANDBOX_IMAGE, SHIP_SANDBOX_NETWORK=egress]
  teploy-ship web                     serve the runs dashboard (browser approve/deny)
      [--port N] [--token <t>]        token also via SHIP_WEB_TOKEN (required)
      [--dev]                         vite dev server instead of the built app
  teploy-ship eval [--suite builtin|hard|extreme|all] [--repeats N] [--json] [--critic]

Config: flags > env > ~/.config/teploy-ship/config.json
  (model, sandboxUrl, sandboxToken, sandboxImage, store, nucleusUrl)
Gateway: set AI_GATEWAY_URL + AI_GATEWAY_KEY to route through teploy-gateway.
Durable store: local files by default (${stateDir()}, override: TEPLOY_SHIP_STATE).
  With --store nucleus (+ --nucleus-url or NUCLEUS_URL), runs live in a shared
  Nucleus: any machine can list/approve them, and a worker completes them —
  approve from your laptop, close it, the worker carries the run home.`;

interface Config {
  model?: string;
  sandboxUrl?: string;
  sandboxToken?: string;
  sandboxImage?: string;
  /** Sandbox network mode for spawned runs (default "none"; "egress" for git/network-needing tasks). */
  sandboxNetwork?: "none" | "egress";
  store?: string;
  nucleusUrl?: string;
  gitToken?: string;
  /** Token used instead for github.com repos (also SHIP_GITHUB_TOKEN). */
  githubToken?: string;
  /** Per-source intake policies for the worker: { forgejo: "auto", … } */
  intake?: Record<string, "ignore" | "propose" | "auto">;
  /** Worker: max simultaneously-executing auto-launched runs (default 3). */
  maxConcurrentRuns?: number;
  /** Worker: per-source daily spend cap in USD (default 10; <= 0 disables). */
  dailyBudgetUSD?: number;
  /** Worker: per-source budget overrides in USD/day. */
  intakeBudgets?: Record<string, number>;
}

/**
 * One-line usage summary with the cost tail. An unpriced model is marked as a
 * guess rather than shown as a fact — costUSD estimates it at the highest known
 * rate so the spend cap cannot fail open, and presenting that as a real price
 * would be misleading.
 */
function usageLine(modelId: string, usage: Parameters<typeof renderUsage>[0]): string {
  const cost = costUSD(modelId, usage);
  if (cost <= 0) return renderUsage(usage);
  const tail = isPricedModel(modelId) ? `~$${cost.toFixed(4)}` : `≤$${cost.toFixed(4)} (model not priced)`;
  return `${renderUsage(usage)} · ${tail}`;
}

/**
 * Load ~/.config/teploy-ship/config.json.
 *
 * A MISSING file means "no config", which is a real and expected state. Every
 * other failure is reported. It used to catch everything and return {}, so a
 * permission error, a truncated write, or a stray comma silently selected the
 * default model, dropped the sandbox settings (falling back to running agent
 * commands on the host), discarded the Nucleus URL, and threw away per-source
 * budgets — a configuration file that exists to constrain Ship, ignored
 * precisely when it is malformed.
 */
function loadConfig(): Config {
  const path = join(homedir(), ".config", "teploy-ship", "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${path} must contain a JSON object`);
  }
  return validateConfig(parsed as Record<string, unknown>, path);
}

/** Reject wrong-typed and out-of-range settings rather than letting them through as undefined behaviour. */
function validateConfig(raw: Record<string, unknown>, path: string): Config {
  const config: Config = {};
  const str = (key: keyof Config): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "string") fail(`${path}: "${key}" must be a string`);
    (config as Record<string, unknown>)[key] = v;
  };
  for (const key of ["model", "sandboxUrl", "sandboxToken", "sandboxImage", "store", "nucleusUrl", "gitToken", "githubToken"] as const) {
    str(key);
  }
  if (raw.sandboxNetwork !== undefined) {
    if (raw.sandboxNetwork !== "none" && raw.sandboxNetwork !== "egress") {
      fail(`${path}: "sandboxNetwork" must be "none" or "egress"`);
    }
    config.sandboxNetwork = raw.sandboxNetwork;
  }
  if (raw.store !== undefined && raw.store !== "file" && raw.store !== "nucleus") {
    fail(`${path}: "store" must be "file" or "nucleus"`);
  }
  if (raw.intake !== undefined) {
    if (typeof raw.intake !== "object" || raw.intake === null || Array.isArray(raw.intake)) {
      fail(`${path}: "intake" must be an object of source -> ignore|propose|auto`);
    }
    const intake: Record<string, "ignore" | "propose" | "auto"> = {};
    for (const [source, policy] of Object.entries(raw.intake as Record<string, unknown>)) {
      if (policy !== "ignore" && policy !== "propose" && policy !== "auto") {
        fail(`${path}: intake.${source} must be ignore|propose|auto`);
      }
      intake[source] = policy;
    }
    config.intake = intake;
  }
  const num = (key: "maxConcurrentRuns" | "dailyBudgetUSD", min: number): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(`${path}: "${key}" must be a number >= ${min}`);
    config[key] = v;
  };
  num("maxConcurrentRuns", 1);
  num("dailyBudgetUSD", 0);
  if (raw.intakeBudgets !== undefined) {
    if (typeof raw.intakeBudgets !== "object" || raw.intakeBudgets === null || Array.isArray(raw.intakeBudgets)) {
      fail(`${path}: "intakeBudgets" must be an object of source -> USD`);
    }
    const budgets: Record<string, number> = {};
    for (const [source, amount] of Object.entries(raw.intakeBudgets as Record<string, unknown>)) {
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
        fail(`${path}: intakeBudgets.${source} must be a number >= 0`);
      }
      budgets[source] = amount;
    }
    config.intakeBudgets = budgets;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) fail(`${path}: unknown setting "${key}"`);
  }
  return config;
}

const KNOWN_CONFIG_KEYS = new Set([
  "model",
  "sandboxUrl",
  "sandboxToken",
  "sandboxImage",
  "sandboxNetwork",
  "store",
  "nucleusUrl",
  "gitToken",
  "githubToken",
  "intake",
  "maxConcurrentRuns",
  "dailyBudgetUSD",
  "intakeBudgets",
]);

/**
 * Gateway-aware model resolution: with AI_GATEWAY_URL (+_KEY) set, all
 * calls route through teploy-gateway using the project key — provider
 * keys never reach the app; caching stays on either way.
 */
function resolveModel(modelId: string): ModelAdapter {
  // Ship's own retry policy sits above whatever the SDK does: a durable run
  // that has already paid for ten turns should not die to one 429.
  return withRetry(baseModel(modelId), defaultRetryPolicy, {
    log: (line) => process.stderr.write(`${dim(line)}\n`),
  });
}

function baseModel(modelId: string): ModelAdapter {
  const gatewayURL = process.env.AI_GATEWAY_URL;
  const gatewayKey = process.env.AI_GATEWAY_KEY;
  if (gatewayURL !== undefined && gatewayURL !== "") {
    if (gatewayKey === undefined || gatewayKey === "") {
      fail("AI_GATEWAY_URL is set but AI_GATEWAY_KEY is missing.");
    }
    if (modelId.startsWith("anthropic/")) {
      return createAnthropic({ baseURL: gatewayURL, apiKey: gatewayKey })(modelId, { cache: true });
    }
    return createOpenAI({ baseURL: gatewayURL, apiKey: gatewayKey, provider: "gateway" })(modelId);
  }
  return modelId.startsWith("anthropic/")
    ? anthropic(modelId.slice("anthropic/".length), { cache: true })
    : openai(modelId.replace(/^openai\//, ""));
}

/** Parse a numeric flag within a range, turning an ArgError into a clean CLI exit. */
function numFlag(value: string | boolean | undefined, name: string, fallback: number, range?: NumberRange): number {
  try {
    return numberFlag(value, name, fallback, range);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message: string): never {
  process.stderr.write(`${red("error:")} ${message}\n`);
  process.exit(2);
}


// ---------------------------------------------------------------------------
// live run
// ---------------------------------------------------------------------------

async function runCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(rest);
  const task = args.positional[0];
  if (task === undefined || task === "") fail('a task is required: teploy-ship run "fix the failing test"');

  if (args.flags.durable === true) {
    await startDurable(task, args, config);
    return;
  }

  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const model = resolveModel(modelId);
  const { executor, workdir } = await makeExecutor(args, config);

  const abort = new AbortController();
  process.on("SIGINT", () => {
    process.stderr.write(`\n${yellow("interrupting after the current action…")}\n`);
    abort.abort();
  });

  const interactive = process.stdin.isTTY === true && args.flags.yes !== true && args.flags.headless !== true;
  // try/finally, not a trailing statement: an error anywhere in the run used
  // to skip destroy() entirely, leaking a sandbox container (until its TTL) or
  // a local workspace directory (forever).
  let result;
  try {
    result = await runAgent({
      model,
      executor,
      task,
      workdir,
      maxSteps: numFlag(args.flags["max-steps"], "max-steps", 20, { min: 1, max: 500, integer: true }),
      approveAction: defaultApprovalPolicy,
      onApprovalRequest: interactive ? (action) => promptApproval(action) : () => args.flags.yes === true,
      onEvent: args.flags.json === true ? undefined : renderEvent,
      abortSignal: abort.signal,
      critic: args.flags.critic === true,
    });
  } finally {
    await executor.destroy().catch(() => {});
  }
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify({ status: result.status, summary: result.summary, steps: result.steps.length, usage: result.usage, costUSD: costUSD(modelId, result.usage) }, null, 2) + "\n");
  } else {
    const mark = result.status === "finished" ? green(result.status) : red(result.status);
    process.stderr.write(`\n${mark} — ${result.summary}\n${dim(usageLine(modelId, result.usage))}\n`);
  }
  process.exit(result.status === "finished" ? 0 : 1);
}

interface SandboxSettings {
  url: string;
  token: string;
  image: string;
  network: "none" | "egress";
}

/**
 * Sandbox executor settings, resolved flags > env > config file. A
 * teploy-deployed worker has no config file, so the SHIP_SANDBOX_* env vars
 * are the only way to point it at a sandbox daemon. Returns undefined when
 * no sandbox is configured (the caller falls back to a LocalExecutor).
 */
function resolveSandbox(args: ReturnType<typeof parseArgs>, config: Config): SandboxSettings | undefined {
  const url = (args.flags.sandbox as string) ?? process.env.SHIP_SANDBOX_URL ?? config.sandboxUrl;
  if (url === undefined || url === "") return undefined;
  const token = (args.flags["sandbox-token"] as string) ?? process.env.SHIP_SANDBOX_TOKEN ?? config.sandboxToken;
  if (token === undefined || token === "") {
    fail("a sandbox URL is set but no token — use --sandbox-token, SHIP_SANDBOX_TOKEN, or sandboxToken in config");
  }
  const image = (args.flags["sandbox-image"] as string) ?? process.env.SHIP_SANDBOX_IMAGE ?? config.sandboxImage ?? "python:3.12-slim";
  // Validated, not cast: an unrecognised value used to reach the sandbox
  // daemon as-is and be interpreted by it however it saw fit.
  let network: "none" | "egress";
  try {
    network = enumFlag(
      (args.flags["sandbox-network"] as string) ?? process.env.SHIP_SANDBOX_NETWORK ?? config.sandboxNetwork,
      "sandbox-network",
      ["none", "egress"] as const,
      "none",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return { url, token, image, network };
}

/**
 * Refuse to execute untrusted work on the host.
 *
 * The approval policy is a set of command regexes. That is a useful warning —
 * it catches `rm -rf`, `curl`, `sudo` — but it is not a boundary: the same
 * effects are one `node -e`, `nc`, `find -delete`, or `getattr(os, "sys"+"tem")`
 * away, and the agent writes the commands. Against a LocalExecutor the blast
 * radius is the machine, including whatever the worker process can reach.
 *
 * So a run whose task text came from outside — a webhook, a chat message, an
 * issue body — requires a sandbox. An operator typing a task into their own
 * terminal is trusting their own machine, which is theirs to trust, and keeps
 * working exactly as before. SHIP_ALLOW_UNSANDBOXED_INTAKE=1 exists for a
 * deliberately disposable box; it says what it is.
 */
function assertSandboxedForUntrusted(sandboxConfigured: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (sandboxConfigured) return;
  const override = (env.SHIP_ALLOW_UNSANDBOXED_INTAKE ?? "").toLowerCase();
  if (override === "1" || override === "true" || override === "yes") return;
  fail(
    "this worker accepts tasks from external sources but has no sandbox configured, so agent commands would run " +
      "on the host. Set SHIP_SANDBOX_URL + SHIP_SANDBOX_TOKEN (see docs/DEPLOY.md), or set " +
      "SHIP_ALLOW_UNSANDBOXED_INTAKE=1 if this machine is genuinely disposable.",
  );
}

async function makeExecutor(
  args: ReturnType<typeof parseArgs>,
  config: Config,
): Promise<{ executor: AgentExecutor; workdir: string }> {
  const sandbox = resolveSandbox(args, config);
  if (sandbox !== undefined) {
    const executor = await SandboxExecutor.start({
      baseURL: sandbox.url,
      token: sandbox.token,
      create: { image: sandbox.image, network: sandbox.network },
    });
    return { executor, workdir: "/work" };
  }
  const workdir = join(stateDir(), "workspaces", `live-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });
  process.stderr.write(dim(`workspace: ${workdir}\n`));
  return { executor: new LocalExecutor({ root: workdir, envDenylist: secretEnvNames() }), workdir };
}

// ---------------------------------------------------------------------------
// fix: issue in, PR out
// ---------------------------------------------------------------------------

async function fixCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(rest);
  const task = args.positional[0];
  if (task === undefined || task === "") fail('a task is required: teploy-ship fix --repo <url> "make the failing test pass"');
  const repoUrl = args.flags.repo as string | undefined;
  if (repoUrl === undefined) fail("--repo <url> is required");

  // An operator typed this URL, so it is allowed when no allowlist is set —
  // but when one IS set it binds here too, and credentialFor refuses to hand a
  // token to an origin outside it either way.
  const repoPolicy: RepoPolicyConfig = {
    ...policyFromEnv(),
    ...(config.gitToken !== undefined ? { gitToken: config.gitToken } : {}),
    ...(config.githubToken !== undefined ? { githubToken: config.githubToken } : {}),
    ...(typeof args.flags["git-token"] === "string" ? { gitToken: args.flags["git-token"] } : {}),
  };
  let ref: RepoRef;
  let token: string;
  try {
    ref = assertRepoAllowed(repoUrl, { trust: "operator", config: repoPolicy });
    token = credentialFor(ref, repoPolicy);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (token === "") fail("a git token is required: --git-token, SHIP_GIT_TOKEN, SHIP_GIT_TOKENS, or gitToken in config");
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const model = resolveModel(modelId);
  const { executor } = await makeExecutor(args, config);

  // Everything below runs under a cleanup guard; see the finally at the end.
  let cleanupDone = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    await runtimeRef?.close().catch(() => {});
    await executor.destroy().catch(() => {});
  };
  let runtimeRef: ShipRuntime | undefined;
  try {
  process.stderr.write(dim(`cloning ${ref.owner}/${ref.repo}…\n`));
  const checkout = await setupRepo(executor, { ref, token, runId });
  process.stderr.write(dim(`on ${checkout.branch} (from ${checkout.base})\n`));

  const runtime = await makeRuntime(args, config);
  // Same origin-scoped key the durable path uses, so a repo's history is
  // one history whichever surface produced it.
  const repoKey = repoKeyOf(repoUrl);
  const context = await loadRepoContext(executor, { repo: repoKey, memory: runtime.memory });
  if (context !== "") process.stderr.write(dim("injecting repo playbook/history\n"));

  const interactive = process.stdin.isTTY === true && args.flags.yes !== true && args.flags.headless !== true;
  const result = await runAgent({
    model,
    executor,
    task: fixPrompt({ task, branch: checkout.branch, base: (args.flags.base as string) ?? checkout.base, context }),
    workdir: ".",
    maxSteps: numFlag(args.flags["max-steps"], "max-steps", 30, { min: 1, max: 500, integer: true }),
    approveAction: defaultApprovalPolicy,
    onApprovalRequest: interactive ? (action) => promptApproval(action) : () => args.flags.yes === true,
    onEvent: args.flags.json === true ? undefined : renderEvent,
    critic: args.flags.critic === true,
  });

  // The deliverable is the tree, whatever the agent believes happened —
  // push any non-empty diff even off a max-steps exit (SWE-bench lesson:
  // real fixes die in runs that never got to say "finish").
  const pushed = await commitAndPush(executor, {
    ref,
    token,
    checkout,
    message: `${task.slice(0, 68)}\n\nTeploy Ship ${runId}\n${result.summary.slice(0, 400)}`,
  });
  if (pushed.kind === "refused") {
    await cleanup();
    process.stderr.write(`${red("not published")} — ${refusalMessage(pushed.screen)}\n`);
    process.exit(1);
  }
  if (pushed.kind === "empty") {
    await runtime.memory.record({ repo: repoKey, note: runNote({ task, summary: result.summary }), runId }).catch(() => {});
    await cleanup();
    process.stderr.write(`${red("no changes")} — the run produced an empty diff (status: ${result.status}).\n`);
    process.exit(1);
  }

  // A live `fix` run that ran out of steps carries the same "partial work"
  // risk as the durable path, so it publishes the same way: as a draft.
  const incomplete = result.status !== "finished";
  const pr = await openPullRequest({
    ref,
    token,
    head: checkout.branch,
    base: (args.flags.base as string) ?? checkout.base,
    draft: incomplete,
    title: incomplete
      ? `[incomplete] ${task.length > 60 ? `${task.slice(0, 60)}…` : task}`
      : task.length > 72
        ? `${task.slice(0, 72)}…`
        : task,
    body: `${result.summary}\n\n---\nTask: ${task}\nRun: ${runId} · ${result.steps.length} steps · agent status: ${result.status}\nGenerated by Teploy Ship.`,
  });
  await runtime.memory.record({ repo: repoKey, note: runNote({ task, summary: result.summary, pr: pr.url }), runId }).catch(() => {});
  await cleanup();
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify({ status: result.status, pr: pr.url, number: pr.number, sha: pushed.sha, runId, usage: result.usage, costUSD: costUSD(modelId, result.usage) }, null, 2) + "\n");
  } else {
    process.stderr.write(`\n${green("PR opened")} — ${bold(pr.url)}\n${dim(usageLine(modelId, result.usage))}\n`);
  }
  process.exit(0);
  } finally {
    // Reached on any error path; the success paths above already ran it.
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// durable runs
// ---------------------------------------------------------------------------

/** flags > env > config: pick where durable runs live. */
async function makeRuntime(args: ReturnType<typeof parseArgs>, config: Config): Promise<ShipRuntime> {
  const storeKind = (args.flags.store as string) ?? config.store ?? "file";
  if (storeKind === "file") return fileRuntime();
  if (storeKind !== "nucleus") fail(`unknown --store: ${storeKind} (expected file or nucleus)`);
  const url = (args.flags["nucleus-url"] as string) ?? process.env.NUCLEUS_URL ?? config.nucleusUrl;
  if (url === undefined || url === "") {
    fail("--store nucleus needs --nucleus-url, NUCLEUS_URL, or nucleusUrl in config");
  }
  return nucleusRuntime(url, `cli-${hostname()}-${process.pid}`);
}

function durableProvider(args: ReturnType<typeof parseArgs>, config: Config): ExecutorProvider {
  const sandbox = resolveSandbox(args, config);
  if (sandbox !== undefined) {
    return sandboxProvider({
      baseURL: sandbox.url,
      token: sandbox.token,
      image: sandbox.image,
      network: sandbox.network,
    });
  }
  // Local durable runs: a persistent per-run workspace under the state
  // dir. It survives parks trivially (no TTL), so snapshot support is
  // unnecessary here — that's the sandbox path's concern.
  return {
    async create() {
      const dir = join(stateDir(), "workspaces", `run-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      return { handle: dir };
    },
    attach(handle: string) {
      // Secret scoping: the worker's own tokens never reach agent commands.
      return new LocalExecutor({ root: handle, envDenylist: secretEnvNames() });
    },
  };
}

/**
 * The Nucleus code index, when this executor can do real work with it:
 * a nucleus runtime + an embedding model (SHIP_EMBED_MODEL, served from
 * SHIP_EMBED_URL — any OpenAI-compatible /v1/embeddings endpoint — with
 * SHIP_EMBED_KEY, falling back to the gateway key). Absent config just
 * means repo-index records "disabled" and ```search points at grep.
 */
function resolveCodeSearch(runtime: ShipRuntime): CodeSearch | undefined {
  const modelId = process.env.SHIP_EMBED_MODEL;
  if (modelId === undefined || modelId === "" || runtime.kind !== "nucleus") return undefined;
  const baseURL = process.env.SHIP_EMBED_URL ?? process.env.AI_GATEWAY_URL;
  const apiKey = process.env.SHIP_EMBED_KEY ?? process.env.AI_GATEWAY_KEY ?? process.env.OPENAI_API_KEY;
  const provider = createOpenAI({
    provider: "embeddings",
    ...(baseURL !== undefined && baseURL !== "" ? { baseURL } : {}),
    ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
  });
  return new NucleusCodeIndex((runtime as NucleusShipRuntime).db, provider.embedding(modelId));
}

async function executePass(
  runtime: ShipRuntime,
  runId: string,
  task: string,
  args: ReturnType<typeof parseArgs>,
  config: Config,
  opts?: { plan?: boolean; critic?: boolean },
): Promise<RunOutcome | null> {
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const usingSandbox = resolveSandbox(args, config) !== undefined;
  const wf = durableAgent({
    model: resolveModel(modelId),
    executor: durableProvider(args, config),
    approveAction: defaultApprovalPolicy,
    // Local workspaces root every path at the run's own dir, so "." is
    // the honest working directory to show the agent.
    workdir: usingSandbox ? "/work" : ".",
    steer: runtime.steer,
    ...((): { codeSearch?: CodeSearch } => {
      const codeSearch = resolveCodeSearch(runtime);
      return codeSearch !== undefined ? { codeSearch } : {};
    })(),
  });
  // Input only matters on a fresh log (resume replays the recorded input).
  const outcome = await runtime.execute(wf, runId, {
    task,
    steer: true,
    index: true,
    guard: true,
    ...(opts?.plan === true ? { plan: true } : {}),
    ...(opts?.critic === true ? { critic: true } : {}),
  });
  if (outcome === null) return null; // another executor holds the lease
  const previous = await runtime.loadMeta(runId);
  await runtime.saveMeta({
    runId,
    task,
    model: modelId,
    status: outcome.status,
    ...(outcome.eventName !== undefined ? { eventName: outcome.eventName } : {}),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return outcome;
}

function reportOutcome(runId: string, outcome: RunOutcome | null): void {
  if (outcome === null) {
    process.stderr.write(
      `${yellow("handed off")} — another executor (a worker?) holds this run; it continues there.\n  watch: ${bold("teploy-ship runs")}\n`,
    );
    return;
  }
  switch (outcome.status) {
    case "completed":
      process.stderr.write(`${green("completed")} — ${JSON.stringify(outcome.output)}\n`);
      break;
    case "waiting":
      process.stderr.write(
        `${yellow("parked")} — waiting for approval.\n  approve: ${bold(`teploy-ship approve ${runId}`)}\n  deny:    ${bold(`teploy-ship deny ${runId} [reason]`)}\n`,
      );
      break;
    case "cancelled":
      process.stderr.write(`${yellow("cancelled")}${outcome.error?.detail !== undefined ? ` — ${outcome.error.detail}` : ""}\n`);
      break;
    case "failed":
      process.stderr.write(`${red("failed")} — ${outcome.error?.detail ?? ""}\n`);
      break;
    default:
      process.stderr.write(`${outcome.status}\n`);
  }
}

async function startDurable(task: string, args: ReturnType<typeof parseArgs>, config: Config): Promise<void> {
  const runtime = await makeRuntime(args, config);
  const runId = `run-${randomUUID().slice(0, 8)}`;
  process.stderr.write(`${dim(`durable run ${runId}`)}\n`);
  const outcome = await executePass(runtime, runId, task, args, config, {
    ...(args.flags.plan === true ? { plan: true } : {}),
    ...(args.flags.critic === true ? { critic: true } : {}),
  });
  reportOutcome(runId, outcome);
  await runtime.close();
  process.exit(outcome?.status === "failed" ? 1 : 0);
}

async function resumeCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  const runId = args.positional[0];
  if (runId === undefined) fail("usage: teploy-ship resume <run-id>");
  const runtime = await makeRuntime(args, config);
  const meta = await runtime.loadMeta(runId);
  if (meta === null) fail(`unknown run: ${runId}`);
  const outcome = await executePass(runtime, runId, meta.task, args, config);
  reportOutcome(runId, outcome);
  await runtime.close();
  process.exit(outcome?.status === "failed" ? 1 : 0);
}

async function decideCommand(rest: string[], approved: boolean): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  const runId = args.positional[0];
  if (runId === undefined) fail(`usage: teploy-ship ${approved ? "approve" : "deny"} <run-id>`);
  const runtime = await makeRuntime(args, config);
  const meta = await runtime.loadMeta(runId);
  if (meta === null) fail(`unknown run: ${runId}`);
  if (meta.eventName === undefined) fail(`run ${runId} is not waiting for approval (status: ${meta.status})`);

  const reason = args.positional[1];
  // Claim the park before delivering: another operator (or the dashboard) may
  // be answering the same one, and two decisions reaching one run is worse
  // than being told to look again.
  const eventName = meta.eventName;
  if (!(await runtime.claimDecision(runId, eventName))) {
    await runtime.close();
    fail(`run ${runId} is no longer waiting on ${eventName} — someone decided it first. Check: teploy-ship runs`);
  }
  try {
    await deliverEvent(runtime.store, runId, eventName, {
      approved,
      ...(reason !== undefined ? { reason } : {}),
    });
  } catch (error) {
    await runtime.releaseDecision(runId, eventName).catch(() => {});
    throw error;
  }
  // Flag the run due so a resident worker can take it; racing is safe —
  // whoever wins the lease continues, the other reports the handoff.
  await runtime.markWake?.(runId);
  if (args.flags.handoff === true) {
    if (runtime.kind !== "nucleus") fail("--handoff needs --store nucleus (a worker must see the run)");
    process.stderr.write(
      `${approved ? green("approved") : red("denied")} — handed to workers.\n  watch: ${bold("teploy-ship runs --store nucleus")}\n`,
    );
    await runtime.close();
    process.exit(0);
  }
  process.stderr.write(`${approved ? green("approved") : red("denied")} — continuing run…\n`);
  const outcome = await executePass(runtime, runId, meta.task, args, config);
  reportOutcome(runId, outcome);
  await runtime.close();
  process.exit(outcome?.status === "failed" ? 1 : 0);
}

async function cancelCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  const runId = args.positional[0];
  if (runId === undefined) fail("usage: teploy-ship cancel <run-id> [reason]");
  const runtime = await makeRuntime(args, config);
  const meta = await runtime.loadMeta(runId);
  if (meta === null) fail(`unknown run: ${runId}`);
  await cancelRun(runtime.store, runId, args.positional[1]);
  // Wake the run so whichever executor gets it settles the cancel; a
  // mid-flight worker stops at its next step either way. In file mode
  // there is no worker, so settle it here.
  await runtime.markWake?.(runId);
  if (runtime.kind === "file") {
    const outcome = await executePass(runtime, runId, meta.task, args, config);
    reportOutcome(runId, outcome);
  } else {
    await runtime.saveMeta({ ...meta, status: "cancelled", updatedAt: new Date().toISOString() });
    process.stderr.write(`${yellow("cancelled")} — a worker settles it at its next step.\n`);
  }
  await runtime.close();
  process.exit(0);
}

async function runsCommand(rest: string[]): Promise<void> {
  const runtime = await makeRuntime(parseArgs(rest), loadConfig());
  const metas = await runtime.listMeta();
  if (metas.length === 0) {
    process.stderr.write(dim("no durable runs\n"));
  }
  for (const meta of metas) {
    const status =
      meta.status === "completed" ? green(meta.status) : meta.status === "waiting" ? yellow(meta.status) : meta.status === "failed" ? red(meta.status) : meta.status;
    process.stdout.write(`${meta.runId}  ${status}  ${dim(meta.updatedAt)}  ${meta.task.slice(0, 60)}\n`);
  }
  await runtime.close();
}

/**
 * The teploy.inbox/v1 producer. `--json` is the contract envelope the inbox
 * TUI consumes; bare `inbox` renders the same feed for a human, which is what
 * `runs` should have been for the one question that actually matters — what is
 * waiting on me.
 */
async function inboxCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const runtime = await makeRuntime(args, loadConfig());
  const publicUrl = process.env.SHIP_PUBLIC_URL;
  let feed;
  try {
    feed = await buildFeed(await runtime.listMeta(), {
      loadEvents: (runId) => runtime.store.load(runId),
      ...(publicUrl !== undefined && publicUrl !== "" ? { webBase: publicUrl } : {}),
    });
  } finally {
    await runtime.close();
  }

  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify(feed, null, 2) + "\n");
    return;
  }

  const decisions = feed.items.filter((item) => item.attention === "decision");
  if (feed.items.length === 0) {
    process.stderr.write(dim("inbox empty\n"));
    return;
  }
  for (const item of feed.items) {
    const tag =
      item.attention === "decision" ? yellow("decision") : item.attention === "failure" ? red("failure ") : dim("info    ");
    process.stdout.write(`${tag}  ${bold(item.id)}  ${item.title.slice(0, 60)}\n`);
    if (item.needs === undefined) continue;
    process.stdout.write(`          ${item.needs.prompt}\n`);
    for (const action of item.needs.actions) {
      process.stdout.write(`          ${dim(action.run.join(" "))}\n`);
    }
  }
  process.stderr.write(
    decisions.length === 0
      ? dim(`\nnothing waiting on you (${feed.items.length} shown)\n`)
      : `\n${yellow(`${decisions.length} waiting on you`)}${feed.truncated === true ? dim(" — older finished runs omitted") : ""}\n`,
  );
}

/**
 * Per-source intake policies from the config file, with SHIP_INTAKE_POLICIES
 * (a JSON object like {"forgejo":"auto"}) merged over them — the only way to
 * set them on a teploy-deployed worker, which has no config file. Returns
 * undefined when neither source defines any, so the worker's own default
 * (nothing auto) stands.
 */
function resolveIntakePolicies(config: Config): Config["intake"] | undefined {
  const merged: Record<string, "ignore" | "propose" | "auto"> = { ...(config.intake ?? {}) };
  const raw = process.env.SHIP_INTAKE_POLICIES;
  if (raw !== undefined && raw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("SHIP_INTAKE_POLICIES must be JSON, e.g. {\"forgejo\":\"auto\"}");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("SHIP_INTAKE_POLICIES must be a JSON object of source -> ignore|propose|auto");
    }
    for (const [source, policy] of Object.entries(parsed as Record<string, unknown>)) {
      if (policy !== "ignore" && policy !== "propose" && policy !== "auto") {
        fail(`SHIP_INTAKE_POLICIES.${source} must be ignore|propose|auto, got ${String(policy)}`);
      }
      merged[source] = policy;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function workerCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  if (((args.flags.store as string) ?? config.store) !== "nucleus") {
    fail("worker needs the shared store: --store nucleus (+ --nucleus-url or NUCLEUS_URL)");
  }
  // Resolve and range-check everything BEFORE touching the network. A bad
  // --interval should not cost a database connection and a migration pass to
  // discover, and the sandbox rule should not be enforced after the fact.
  const intervalMs = numFlag(args.flags.interval, "interval", 5, { min: 1, max: 3600 }) * 1000;
  const maxConcurrentFlag =
    args.flags["max-concurrent"] !== undefined
      ? numFlag(args.flags["max-concurrent"], "max-concurrent", 3, { min: 1, max: 100, integer: true })
      : undefined;
  const dailyBudgetFlag =
    args.flags["daily-budget"] !== undefined
      ? numFlag(args.flags["daily-budget"], "daily-budget", 10, { min: 0 })
      : undefined;
  const usingSandbox = resolveSandbox(args, config) !== undefined;
  assertSandboxedForUntrusted(usingSandbox);

  const runtime = await makeRuntime(args, config);
  if (runtime.kind !== "nucleus") fail("worker needs --store nucleus");
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const gitToken = (args.flags["git-token"] as string) ?? process.env.SHIP_GIT_TOKEN ?? config.gitToken;
  const githubToken = process.env.SHIP_GITHUB_TOKEN ?? config.githubToken;
  // A teploy-deployed worker has no config file — everything is env. Intake
  // policies via SHIP_INTAKE_POLICIES (JSON, e.g. {"forgejo":"auto"}) merged
  // over the file's; auto is still earned per source, never a default.
  const intakePolicies = resolveIntakePolicies(config);
  const codeSearch = resolveCodeSearch(runtime);
  const worker = startWorker({
    runtime: runtime as import("./runtime.js").NucleusShipRuntime,
    model: resolveModel(modelId),
    modelId,
    executor: durableProvider(args, config),
    workdir: usingSandbox ? "/work" : ".",
    ...(codeSearch !== undefined ? { codeSearch } : {}),
    intervalMs,
    ...(gitToken !== undefined ? { gitToken } : {}),
    ...(githubToken !== undefined ? { githubToken } : {}),
    repoPolicy: {
      ...policyFromEnv(),
      ...(gitToken !== undefined ? { gitToken } : {}),
      ...(githubToken !== undefined ? { githubToken } : {}),
    },
    ...(intakePolicies !== undefined ? { intakePolicies } : {}),
    ...(maxConcurrentFlag !== undefined
      ? { maxConcurrentRuns: maxConcurrentFlag }
      : config.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: config.maxConcurrentRuns }
        : {}),
    ...(dailyBudgetFlag !== undefined
      ? { dailyBudgetUSD: dailyBudgetFlag }
      : config.dailyBudgetUSD !== undefined
        ? { dailyBudgetUSD: config.dailyBudgetUSD }
        : {}),
    ...(config.intakeBudgets !== undefined ? { intakeBudgets: config.intakeBudgets } : {}),
  });
  // The scheduler's own timer is unref'd; this ref'd no-op holds the
  // process resident until a signal stops it.
  const keepAlive = setInterval(() => {}, 60_000);

  /**
   * Ordered shutdown.
   *
   * The old handler called worker.stop() and then immediately started
   * runtime.close(), so a scheduler callback, heartbeat, usage settlement or
   * notification still in flight found the pool closed underneath it — the
   * failure looks like a store error at exactly the moment nobody is watching.
   * Both signals also registered the same handler with no guard, so a second
   * Ctrl-C re-entered it. Now: stop accepting work, wait for what is running
   * (bounded), then close.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stderr.write(`\n${dim("still stopping — send SIGKILL if you need it gone now")}\n`);
      return;
    }
    shuttingDown = true;
    process.stderr.write(`\n${dim(`worker stopping (${signal})…`)}\n`);
    clearInterval(keepAlive);
    void (async () => {
      const deadline = Date.now() + 30_000;
      try {
        await worker.stop();
        // Give in-flight completion work (spend settlement, the outbox flush,
        // meta writes) a chance to land before the connection pool goes.
        while (Date.now() < deadline && worker.busy()) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (worker.busy()) {
          process.stderr.write(`${yellow("shutdown timed out")} — closing with work still in flight\n`);
        }
      } finally {
        await runtime.close().catch(() => {});
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Credentials the WEB process never legitimately uses.
 *
 * teploy secrets are app-scoped, so a deploy injects every secret into both
 * containers — which handed the dashboard the git deploy token and the model
 * key, and made any web-route bug a repository and provider credential
 * exposure. The web surface renders pages and verifies webhook signatures; it
 * never clones, never pushes, and never calls a model (the worker does all
 * three). Removing them from the child's environment is least privilege Ship
 * can enforce on its own, without waiting for per-process secret scoping.
 */
const WORKER_ONLY_SECRETS = [
  "SHIP_GIT_TOKEN",
  "SHIP_GITHUB_TOKEN",
  "SHIP_GIT_TOKENS",
  "SHIP_SANDBOX_TOKEN",
  "AI_GATEWAY_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SHIP_EMBED_KEY",
];

async function webCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  const token = (args.flags.token as string) ?? process.env.SHIP_WEB_TOKEN;
  if (token === undefined || token === "") {
    fail("web needs an access token: --token <t> or SHIP_WEB_TOKEN (the browser login uses it)");
  }
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const dropped = WORKER_ONLY_SECRETS.filter((name) => process.env[name] !== undefined && process.env[name] !== "");
  if (!existsSync(join(webDir, "package.json"))) fail(`web app not found at ${webDir}`);

  const storeKind = (args.flags.store as string) ?? config.store ?? "file";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHIP_WEB_TOKEN: token,
    SHIP_STORE: storeKind,
    ...(args.flags.port !== undefined ? { SHIP_WEB_PORT: String(args.flags.port) } : {}),
    ...(args.flags.model !== undefined ? { SHIP_MODEL: String(args.flags.model) } : config.model !== undefined ? { SHIP_MODEL: config.model } : {}),
  };
  if (storeKind === "nucleus") {
    const url = (args.flags["nucleus-url"] as string) ?? process.env.NUCLEUS_URL ?? config.nucleusUrl;
    if (url === undefined || url === "") fail("--store nucleus needs --nucleus-url, NUCLEUS_URL, or nucleusUrl in config");
    env.NUCLEUS_URL = url;
  }
  // Strip what the dashboard has no business holding.
  for (const name of WORKER_ONLY_SECRETS) delete env[name];
  if (dropped.length > 0) {
    // Pass the NAMES (never the values) so the settings page can still report
    // them accurately. Without this it reads a dropped variable as absent and
    // tells the operator a configured credential is missing — sending them off
    // to re-set something that was never wrong.
    env.SHIP_WORKER_ONLY_SECRETS = dropped.join(",");
    process.stderr.write(dim(`dropping worker-only secrets from the web process: ${dropped.join(", ")}\n`));
  }

  // The web app is a Neutron TS app living in web/; dev serves via Vite,
  // otherwise the production preview server runs the built output.
  const mode = args.flags.dev === true ? "dev" : "preview";
  if (mode === "preview" && !existsSync(join(webDir, "dist"))) {
    fail(`web app is not built (${join(webDir, "dist")} missing) — run: pnpm --dir "${webDir}" build`);
  }
  // Spawn the app's own installed bin: `pnpm exec` re-resolves (and in a
  // container without a pnpm lockfile, re-INSTALLS) instead of using
  // node_modules/.bin, which both npm and pnpm populate.
  const bin = join(webDir, "node_modules", ".bin", "neutron-ts");
  if (!existsSync(bin)) fail(`web app dependencies are not installed (${bin} missing) — run: pnpm install in ${webDir}`);
  const child = spawn(bin, [mode], { cwd: webDir, env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// ---------------------------------------------------------------------------
// eval (unchanged behavior)
// ---------------------------------------------------------------------------

async function evalCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(rest);
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const model = resolveModel(modelId);
  const repeats = numFlag(args.flags.repeats, "repeats", 1, { min: 1, max: 100, integer: true });
  const suiteName = (args.flags.suite as string) ?? "builtin";
  const tasks: EvalTask[] =
    suiteName === "hard" ? hardSuite : suiteName === "extreme" ? extremeSuite : suiteName === "all" ? [...builtinSuite, ...hardSuite, ...extremeSuite] : builtinSuite;

  process.stderr.write(`Running ${tasks.length} tasks (${suiteName}) against ${modelId} (${repeats}x)...\n\n`);
  const report = await runEval({
    tasks,
    model,
    repeats,
    ...(args.flags.critic === true ? { agentOptions: { critic: true } } : {}),
    onResult: (r) => process.stderr.write(`  [${r.passed ? "PASS" : "FAIL"}] ${r.task} (attempt ${r.attempt + 1}, ${r.steps} steps)\n`),
  });
  process.stdout.write(`\n${formatReport(report)}\n`);
  if (args.flags.json === true) process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.passRate === 1 ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // Validate against the command's schema up front, so a typo is an error
  // rather than a run with a limit nobody chose.
  if (command !== undefined && COMMAND_FLAGS[command] !== undefined) {
    try {
      parseArgs(rest, COMMAND_FLAGS[command]);
    } catch (error) {
      if (error instanceof ArgError) fail(`${error.message}\n\nSee: teploy-ship (no arguments) for usage.`);
      throw error;
    }
  }
  switch (command) {
    case "run":
      return runCommand(rest);
    case "runs":
      return runsCommand(rest);
    case "resume":
      return resumeCommand(rest);
    case "approve":
      return decideCommand(rest, true);
    case "deny":
      return decideCommand(rest, false);
    case "cancel":
      return cancelCommand(rest);
    case "inbox":
      return inboxCommand(rest);
    case "fix":
      return fixCommand(rest);
    case "worker":
      return workerCommand(rest);
    case "web":
      return webCommand(rest);
    case "eval":
      return evalCommand(rest);
    default:
      process.stderr.write(USAGE + "\n");
      process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${red("error:")} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
