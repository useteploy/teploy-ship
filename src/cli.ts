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
import { explainRun } from "./explain.js";
import { resolveModelId, usesAnthropicWire } from "./model-id.js";
import { auditRow, toCsv, withinWindow } from "./audit.js";
import type { NumberRange } from "./args.js";
import { commitAndPush, fixPrompt, openPullRequest, setupRepo } from "./git.js";
import { runTests, testTargetFromEnv } from "./tests.js";
import { attachEvidence, envAsked } from "./fix-evidence.js";
import type { Evidence } from "./verification.js";
import type { RepoRef } from "./git.js";
import { assertRepoAllowed, credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import { runAgent } from "./agent.js";
import { refusalMessage } from "./publish-policy.js";
import { defaultApprovalPolicy } from "./approval.js";
import { secretEnvNames } from "./guard.js";
import { durableAgent, durableRecoveryInput, repoKeyOf, sandboxProvider } from "./durable.js";
import { externalAdapters } from "./harness-external.js";
import type { ExecutorProvider } from "./durable.js";
import { formatReport, runEval } from "./eval.js";
import type { EvalTask } from "./eval.js";
import { stateDir } from "./run-store.js";
import { buildFeed } from "./inbox.js";
import { enqueueRun, fileRuntime, nucleusRuntime } from "./runtime.js";
import { cliActor, formatActor, actorFromMeta } from "./actor.js";
import { AUTHORITY_ACTIONS, GLOBAL_WINDOW, autoAllowedNow, formatWindow, parseDays, windowFor } from "./governance.js";
import type { AuthorityAction } from "./governance.js";
import { repoSlug } from "./observe.js";
import type { NucleusShipRuntime, ShipRuntime } from "./runtime.js";
import type { Project } from "./projects.js";
import type { IntakePolicy } from "./intake.js";
import { NucleusCodeIndex } from "./code-index.js";
import type { CodeSearch } from "./code-index.js";
import { startWorker } from "./worker.js";
import { costUSD, isPricedModel } from "./pricing.js";
import { defaultRetryPolicy, withRetry, withCallTimeout, modelTimeoutFromEnv } from "./provider.js";
import { builtinSuite } from "./tasks.js";
import { hardSuite } from "./hard-tasks.js";
import { extremeSuite } from "./extreme-tasks.js";
import { bold, dim, green, promptApproval, red, renderEvent, renderUsage, yellow } from "./ui.js";

const USAGE = `teploy-ship — coding agent on your own stack

Usage:
  teploy-ship run "<task>"            live run in the terminal (streamed, interactive approvals)
      [--model provider/model]        default SHIP_MODEL, else anthropic/claude-sonnet-5
      [--sandbox <url> --sandbox-token <t> [--sandbox-image <img>] [--sandbox-network none|egress]]
      [--max-steps N] [--yes] [--json] [--critic] [--settle]
                     --critic adds an independent review pass before finishing
                     --settle lets a run that has stopped changing an already
                     edited tree stop deliberately (status "settled") instead
                     of spinning to an abort.
  teploy-ship run --durable "<task>"  durable run: parks on approvals, survives exits
                     add --plan to review/approve the agent's plan before it acts
                     add --critic for an independent review pass before it finishes
                     add --settle for stuck detection + the deliberate stop
                     (off by default on durable runs; SHIP_RECOVERY/SHIP_SETTLE
                     turn it on for worker- and dashboard-enqueued runs)
  teploy-ship enqueue "<task>"        hand a task to a worker (the issue -> PR flow)
      [--repo <url>]                  the repository to work in
      [--model …] [--plan] [--critic] [--settle] [--json]
  teploy-ship evidence set <repo>     per-repo evidence: the suite command and the
      [--test-command "<cmd>"]        Observe service that belong to ONE repo, so
      [--test-timeout-ms N]           one worker can serve many repos (resolved at
      [--observe-service <svc>]       enqueue; a flag omitted clears its field)
  teploy-ship evidence list [--json]
  teploy-ship evidence remove <repo>
  teploy-ship project set <repo>      one record per repo: clone URL (joins the
      --url <clone-url>                allowlist), sandbox image/network/limits,
      [--image <img>] [--network none|egress] [--memory-mb N] [--cpus N]
      [--policy inherit|ignore|propose|auto] [--budget <usd>]
      [--test-command <cmd>] [--test-timeout-ms N] [--observe-service <svc>]
      [--label <text>]                 flags you pass are set; others keep their value
  teploy-ship project list [--json]
  teploy-ship project remove <repo>
  teploy-ship policy show [--json]    who may do what, auto windows, required reviewers
  teploy-ship policy authority <approve|auto|steer|policies> --roles admin,editor [--users a,b]
  teploy-ship policy window set [--source <s>] --days mon-fri --start 09:00 --end 18:00 --tz <zone>
  teploy-ship policy window remove [--source <s>]      (no --source = the global window)
  teploy-ship policy window check [--source <s>]       is auto allowed right now?
  teploy-ship policy reviewers set <repo> [--users a,b] [--teams t]   (both empty = remove)
  teploy-ship audit                   export the run history (what ran, cost, PRs)
      [--format csv|json] [--since <iso>] [--until <iso>]
  teploy-ship runs                    list durable runs
  teploy-ship explain <run-id>        why a run ended the way it did, and what to do
      [--json]                        the same, as an object
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
      [--tests] [--telemetry] [--preview]  attach evidence to the PR body:
                                      the suite (SHIP_TEST_COMMAND), the
                                      service before/after (OBSERVE_*), and a
                                      preview of the branch (SHIP_PREVIEW_DIR).
                                      --preview deploys to a real server.
      (accepts run flags: --model, --sandbox…, --max-steps, --yes, --json, --critic, --settle)
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
  teploy-ship eval [--suite builtin|hard|extreme|all] [--repeats N] [--json] [--critic] [--settle]

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
  // Ship's own policies sit above whatever the SDK does: a durable run that
  // has already paid for ten turns should not die to one 429 (retry), and a
  // hung model call must fail the run visibly rather than wedge it past even
  // cancel (per-call timeout — P3-7, found live 2026-08-24).
  return withCallTimeout(
    withRetry(baseModel(modelId), defaultRetryPolicy, {
      log: (line) => process.stderr.write(`${dim(line)}\n`),
    }),
    modelTimeoutFromEnv(),
  );
}

function baseModel(modelId: string): ModelAdapter {
  const gatewayURL = process.env.AI_GATEWAY_URL;
  const gatewayKey = process.env.AI_GATEWAY_KEY;
  if (gatewayURL !== undefined && gatewayURL !== "") {
    if (gatewayKey === undefined || gatewayKey === "") {
      fail("AI_GATEWAY_URL is set but AI_GATEWAY_KEY is missing.");
    }
    if (usesAnthropicWire(modelId)) {
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

  const modelId = resolveModelId(args.flags.model, process.env, config.model);
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
      finishWhenSettled: args.flags.settle === true,
    });
  } finally {
    await executor.destroy().catch(() => {});
  }
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify({ status: result.status, summary: result.summary, steps: result.steps.length, usage: result.usage, costUSD: costUSD(modelId, result.usage) }, null, 2) + "\n");
  } else {
    // "settled" is neither a success nor a failure: work is in the tree and
    // the agent stopped changing it, but it never said it was done. The exit
    // code stays 1 (only "finished" is a clean finish) — the colour is what
    // tells a human it is worth looking at rather than worth rerunning.
    const mark =
      result.status === "finished" ? green(result.status) : result.status === "settled" ? yellow(result.status) : red(result.status);
    process.stderr.write(`\n${mark} — ${result.summary}\n${dim(usageLine(modelId, result.usage))}\n`);
  }
  process.exit(result.status === "finished" ? 0 : 1);
}

interface SandboxSettings {
  url: string;
  token: string;
  image: string;
  network: "none" | "egress";
  /** Container TTL requested from the daemon, seconds. */
  ttlSec: number;
}

/**
 * How long a run's sandbox may live before the daemon's reaper takes it,
 * SHIP_SANDBOX_TTL_SEC, default 2 h. Ship never asked for a TTL before, so
 * every run got the daemon's 30-minute default — and on 2026-08-25 four runs
 * on large repositories were reaped before their first exec (their index step
 * was still embedding), surfacing as `turn-0-exec: run not found`. Two hours
 * covers a 40-turn run with the suite; the run's own caps still end it, the
 * TTL is only the backstop for a worker that died mid-run. Floor 600 s.
 */
export function resolveSandboxTtlSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHIP_SANDBOX_TTL_SEC;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 7200;
  return Math.max(600, Math.trunc(n));
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
  return { url, token, image, network, ttlSec: resolveSandboxTtlSec() };
}

/**
 * Warn — loudly — that this worker cannot run externally-sourced tasks.
 *
 * Deliberately a warning and not a refusal to start. The approval policy is a
 * set of command regexes: useful as a prompt, not a boundary (the same effects
 * are one `node -e`, `nc`, or `find -delete` away, and the agent writes the
 * commands), so untrusted work genuinely does need isolation. But a worker that
 * refuses to BOOT teaches its operator to reach for the override, after which
 * everything runs unsandboxed forever — the enforcement has to sit on the
 * dangerous run, not on the process. It does: see durable.ts. This exists so
 * nobody discovers the situation from a failed run alone.
 */
function warnIfUnsandboxed(sandboxConfigured: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (sandboxConfigured) return;
  const override = (env.SHIP_ALLOW_UNSANDBOXED_INTAKE ?? "").toLowerCase();
  if (override === "1" || override === "true" || override === "yes") {
    process.stderr.write(
      `${yellow("warning:")} no sandbox configured and SHIP_ALLOW_UNSANDBOXED_INTAKE is set — agent commands from ` +
        `webhooks and chat will run directly on this host.\n`,
    );
    return;
  }
  process.stderr.write(
    `${yellow("warning:")} no sandbox configured. Runs you launch yourself work normally; tasks that arrive from a ` +
      `webhook, Slack, or an issue will be REFUSED, because their commands would run on this host.\n` +
      `  fix: set SHIP_SANDBOX_URL + SHIP_SANDBOX_TOKEN (see docs/DEPLOY.md)\n`,
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
  const modelId = resolveModelId(args.flags.model, process.env, config.model);
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
    finishWhenSettled: args.flags.settle === true,
  });

  // Run the suite BEFORE the push, for the same reason the worker does: a
  // reviewer reading "tests passed" wants it to mean the code in the pull
  // request, not the code as it was two steps earlier.
  const evidence: Evidence = {};
  const testTarget = args.flags.tests === true || envAsked("SHIP_TESTS") ? testTargetFromEnv() : undefined;
  if (testTarget !== undefined) {
    process.stderr.write(dim(`running ${testTarget.command}…\n`));
    evidence.tests = await runTests(executor, testTarget);
  }

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
  await attachEvidence({ ref, token, pr: pr.number, branch: checkout.branch, runId, evidence, args, repoUrl });
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
      ttlSec: sandbox.ttlSec,
    });
  }
  // Local durable runs: a persistent per-run workspace under the state
  // dir. It survives parks trivially (no TTL), so snapshot support is
  // unnecessary here — that's the sandbox path's concern.
  //
  // isolated is FALSE and that is not a formality: it is what stops an
  // externally-sourced task from executing on this host.
  return {
    isolated: false,
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
  opts?: { plan?: boolean; critic?: boolean; settle?: boolean },
): Promise<RunOutcome | null> {
  const modelId = resolveModelId(args.flags.model, process.env, config.model);
  const usingSandbox = resolveSandbox(args, config) !== undefined;
  const wf = durableAgent({
    model: resolveModel(modelId),
    executor: durableProvider(args, config),
    projects: runtime.projects,
    approveAction: defaultApprovalPolicy,
    // Local workspaces root every path at the run's own dir, so "." is
    // the honest working directory to show the agent.
    workdir: usingSandbox ? "/work" : ".",
    steer: runtime.steer,
    harnesses: externalAdapters(),
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
    ...durableRecoveryInput(opts),
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
    ...(args.flags.settle === true ? { settle: true } : {}),
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
      // Who unblocked it. Approving is remote code execution and spend.
      by: cliActor().id,
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

/**
 * Explain one run in operator terms.
 *
 * `runs` answers "what is there"; the run detail page answers "what happened,
 * in 300 events". Neither answers "what do I do about it", which is the only
 * question anyone actually has about a run that did not finish. Derived from
 * the log alone, so it works when nothing else does.
 */
async function explainCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const runId = args.positional[0];
  if (runId === undefined || runId === "") fail("a run id is required: teploy-ship explain <run-id>");
  const runtime = await makeRuntime(args, loadConfig());
  try {
    const events = await runtime.store.load(runId);
    const explanation = explainRun(events);
    if (args.flags.json === true) {
      process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
      return;
    }
    const colour = explanation.needsAttention ? yellow : green;
    process.stdout.write(`${colour(explanation.headline)}\n\n`);
    process.stdout.write(`${dim("Asked to:  ")} ${explanation.tried}\n`);
    process.stdout.write(`${dim("Stopped at:")} ${explanation.stoppedAt}\n`);
    process.stdout.write(`${dim("Next:      ")} ${explanation.nextStep}\n`);
    if (explanation.evidence.length > 0) process.stdout.write(`\n${dim(explanation.evidence.join("  ·  "))}\n`);
  } finally {
    await runtime.close();
  }
}

/**
 * Hand a task to a worker instead of running it here.
 *
 * The product's headline flow is issue -> worker -> pull request, and until now
 * the only ways to start one were the dashboard's form and an intake webhook:
 * `run --durable` executes in-process and takes no repo, and `fix` uses the
 * live loop with its own inline publish. So the flow the documentation leads
 * with could not be started from the CLI at all, which is a poor first ten
 * minutes for anyone self-hosting.
 *
 * The repo is checked against the same allowlist `fix` uses. An operator typed
 * this URL, so it is trusted as `operator` — but `assertRepoAllowed` still
 * binds when an allowlist is configured, and `credentialFor` will not hand a
 * token to an origin outside it either way.
 */
async function enqueueCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(rest);
  const task = args.positional[0];
  if (task === undefined || task === "") fail('a task is required: teploy-ship enqueue "fix the failing test" --repo <url>');

  const repoUrl = args.flags.repo as string | undefined;
  if (repoUrl !== undefined) {
    const policy: RepoPolicyConfig = {
      ...policyFromEnv(),
      ...(config.gitToken !== undefined ? { gitToken: config.gitToken } : {}),
      ...(config.githubToken !== undefined ? { githubToken: config.githubToken } : {}),
    };
    try {
      assertRepoAllowed(repoUrl, { trust: "operator", config: policy });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const runtime = await makeRuntime(args, config);
  const runId = `run-${randomUUID().slice(0, 8)}`;
  try {
    await enqueueRun(runtime, {
      runId,
      task,
      model: resolveModelId(args.flags.model, process.env, config.model),
      source: "manual",
      // Whoever holds this shell. Attested by the OS, not by Ship — see actor.ts.
      actor: cliActor(),
      ...(repoUrl !== undefined ? { repo: repoUrl, trust: "operator" as const } : {}),
      ...(args.flags.plan === true ? { plan: true } : {}),
      ...(args.flags.critic === true ? { critic: true } : {}),
      ...(args.flags.settle === true ? { settle: true } : {}),
    });
  } finally {
    await runtime.close();
  }

  if (args.flags.json === true) {
    process.stdout.write(`${JSON.stringify({ runId, task, repo: repoUrl ?? null })}\n`);
    return;
  }
  process.stderr.write(`${green("queued")} ${bold(runId)}\n`);
  process.stderr.write(`${dim("A worker picks it up on its next tick. Watch it with:")}\n`);
  process.stderr.write(`  teploy-ship runs\n  teploy-ship explain ${runId}\n`);
}

/**
 * Per-repo evidence configuration (D1): the test command and Observe service
 * that belong to ONE repository.
 *
 * SHIP_TEST_COMMAND and OBSERVE_SERVICE are one value per WORKER, which was
 * fine while a worker served one repository and failed the moment it served
 * two — a worker watching fylun-web attached its RED metrics to a one-line Go
 * change in an unrelated repo. This command writes the repo-keyed config that
 * `enqueueRun` resolves and materialises into each run's input, so one worker
 * serves many repos with the right evidence for each.
 *
 * `set` is a full upsert: the entry becomes exactly the flags you pass, and a
 * flag you omit clears its field. Omit everything and nothing is stored.
 */
async function evidenceCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const [sub, target] = rest;
  const args = parseArgs(rest);
  if (sub === "list") {
    const runtime = await makeRuntime(args, config);
    try {
      const entries = await runtime.evidence.list();
      if (args.flags.json === true) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        process.stderr.write(dim("no per-repo evidence configured; workers fall back to SHIP_TEST_COMMAND / OBSERVE_*\n"));
        return;
      }
      for (const e of entries) {
        process.stdout.write(`${bold(e.repo)}\n`);
        if (e.testCommand !== undefined) process.stdout.write(`  tests:    ${e.testCommand}\n`);
        if (e.testTimeoutMs !== undefined) process.stdout.write(`  timeout:  ${e.testTimeoutMs}ms\n`);
        if (e.observeService !== undefined) process.stdout.write(`  observe:  ${e.observeService}\n`);
      }
    } finally {
      await runtime.close();
    }
    return;
  }
  if (sub === "remove") {
    if (target === undefined) fail("a repo is required: teploy-ship evidence remove owner/name");
    const runtime = await makeRuntime(args, config);
    try {
      await runtime.evidence.remove(target);
    } finally {
      await runtime.close();
    }
    process.stderr.write(`${green("removed")} ${target}\n`);
    return;
  }
  if (sub === "set") {
    if (target === undefined || target === "") fail("a repo is required: teploy-ship evidence set owner/name --test-command \"pnpm test\"");
    const command = args.flags["test-command"] as string | undefined;
    const timeout = args.flags["test-timeout-ms"] !== undefined ? Number(args.flags["test-timeout-ms"]) : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) fail(`--test-timeout-ms must be a positive number, got: ${args.flags["test-timeout-ms"]}`);
    const service = args.flags["observe-service"] as string | undefined;
    if (command === undefined && service === undefined && timeout === undefined) {
      fail('nothing to set: pass --test-command and/or --observe-service (a flag you omit clears its field)');
    }
    const runtime = await makeRuntime(args, config);
    try {
      await runtime.evidence.set({
        repo: target,
        ...(command !== undefined ? { testCommand: command } : {}),
        ...(timeout !== undefined ? { testTimeoutMs: timeout } : {}),
        ...(service !== undefined ? { observeService: service } : {}),
      });
    } finally {
      await runtime.close();
    }
    process.stderr.write(`${green("set")} ${target}\n`);
    return;
  }
  fail('usage: teploy-ship evidence set <repo> [--test-command <cmd>] [--test-timeout-ms N] [--observe-service <svc>]\n       teploy-ship evidence list [--json]\n       teploy-ship evidence remove <repo>');
}

const PROJECT_USAGE =
  "usage: teploy-ship project set <repo> [--url <clone-url>] [--image <img>] [--network none|egress] [--memory-mb N] [--cpus N]\n" +
  "           [--policy inherit|ignore|propose|auto] [--budget <usd>] [--test-command <cmd>] [--test-timeout-ms N]\n" +
  "           [--observe-service <svc>] [--label <text>]\n" +
  "       teploy-ship project list [--json]\n       teploy-ship project remove <repo>";

/**
 * One record per repository (C1, projects.ts). `set` MERGES: a flag you pass
 * is set, a flag you omit keeps its stored value — unlike `evidence set`, a
 * project has too many fields for a full upsert to be the safe shape.
 */
async function projectCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const [sub, target] = rest;
  const args = parseArgs(rest);
  if (sub === "list") {
    const runtime = await makeRuntime(args, config);
    try {
      const entries = await runtime.projects.list();
      if (args.flags.json === true) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        process.stderr.write(dim("no projects; repos are allowed by SHIP_REPO_ALLOWLIST alone and run in SHIP_SANDBOX_IMAGE\n"));
        return;
      }
      for (const p of entries) {
        process.stdout.write(`${bold(p.repo)}${p.label !== undefined ? `  ${dim(p.label)}` : ""}\n`);
        if (p.url !== undefined) process.stdout.write(`  url:      ${p.url}\n`);
        if (p.sandboxImage !== undefined) process.stdout.write(`  image:    ${p.sandboxImage}${p.sandboxNetwork !== undefined ? ` (${p.sandboxNetwork})` : ""}\n`);
        if (p.sandboxLimits !== undefined) process.stdout.write(`  limits:   ${JSON.stringify(p.sandboxLimits)}\n`);
        if (p.sourcePolicy !== undefined) process.stdout.write(`  policy:   ${p.sourcePolicy}\n`);
        if (p.dailyBudgetUSD !== undefined) process.stdout.write(`  budget:   $${p.dailyBudgetUSD}/day\n`);
        if (p.testCommand !== undefined) process.stdout.write(`  tests:    ${p.testCommand}\n`);
        if (p.testTimeoutMs !== undefined) process.stdout.write(`  timeout:  ${p.testTimeoutMs}ms\n`);
        if (p.observeService !== undefined) process.stdout.write(`  observe:  ${p.observeService}\n`);
      }
    } finally {
      await runtime.close();
    }
    return;
  }
  if (sub === "remove") {
    if (target === undefined) fail("a repo is required: teploy-ship project remove owner/name");
    const runtime = await makeRuntime(args, config);
    try {
      await runtime.projects.remove(target);
    } finally {
      await runtime.close();
    }
    process.stderr.write(`${green("removed")} ${target}\n`);
    return;
  }
  if (sub === "set") {
    if (target === undefined || target === "") fail("a repo is required: teploy-ship project set <clone-url|owner/name> …");
    const str = (name: string): string | undefined => (args.flags[name] !== undefined ? String(args.flags[name]) : undefined);
    const num = (name: string): number | undefined => {
      if (args.flags[name] === undefined) return undefined;
      const n = Number(args.flags[name]);
      if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got: ${String(args.flags[name])}`);
      return n;
    };
    const network = str("network");
    if (network !== undefined && network !== "none" && network !== "egress") fail(`--network must be none or egress, got: ${network}`);
    const policy = str("policy");
    if (policy !== undefined && !["inherit", "ignore", "propose", "auto"].includes(policy)) fail(`--policy must be inherit, ignore, propose or auto, got: ${policy}`);
    const runtime = await makeRuntime(args, config);
    try {
      // A clone URL as the target sets --url too; a bare slug needs --url to join the allowlist.
      const url = str("url") ?? (/^[a-z]+:\/\//i.test(target) || target.startsWith("git@") ? target : undefined);
      const existing = (await runtime.projects.forRepo(target)) ?? { repo: target, autoMerge: false, autoDeploy: false };
      const { sourcePolicy: _p, ...keep } = existing;
      const next: Project = {
        ...keep,
        ...(url !== undefined ? { url } : {}),
        ...(str("label") !== undefined ? { label: str("label") } : {}),
        ...(str("image") !== undefined ? { sandboxImage: str("image") } : {}),
        ...(network !== undefined ? { sandboxNetwork: network as "none" | "egress" } : {}),
        ...(num("memory-mb") !== undefined || num("cpus") !== undefined
          ? { sandboxLimits: { ...existing.sandboxLimits, ...(num("memory-mb") !== undefined ? { memoryMb: num("memory-mb") } : {}), ...(num("cpus") !== undefined ? { cpus: num("cpus") } : {}) } }
          : {}),
        ...(policy === undefined ? (existing.sourcePolicy !== undefined ? { sourcePolicy: existing.sourcePolicy } : {}) : policy === "inherit" ? {} : { sourcePolicy: policy as IntakePolicy }),
        ...(num("budget") !== undefined ? { dailyBudgetUSD: num("budget") } : {}),
        ...(str("test-command") !== undefined ? { testCommand: str("test-command") } : {}),
        ...(num("test-timeout-ms") !== undefined ? { testTimeoutMs: num("test-timeout-ms") } : {}),
        ...(str("observe-service") !== undefined ? { observeService: str("observe-service") } : {}),
      };
      await runtime.projects.set(next);
    } finally {
      await runtime.close();
    }
    process.stderr.write(`${green("set")} ${target}\n`);
    return;
  }
  fail(PROJECT_USAGE);
}

/**
 * The buyer half of P2-3 (governance.ts): per-user authority, auto windows,
 * required reviewers. The dashboard's Policies page edits the same store.
 */
async function policyCommand(rest: string[]): Promise<void> {
  const config = loadConfig();
  const [sub, second, third] = rest;
  const args = parseArgs(rest);
  const list = (flag: string): string[] | undefined => {
    const v = args.flags[flag];
    if (v === undefined) return undefined;
    return String(v).split(",").map((x) => x.trim()).filter((x) => x !== "");
  };
  const usage =
    "usage: teploy-ship policy show [--json]\n" +
    "       teploy-ship policy authority <approve|auto|steer|policies> --roles admin,editor [--users a,b]\n" +
    "       teploy-ship policy window set [--source <s>] --days mon-fri --start 09:00 --end 18:00 --tz <zone>\n" +
    "       teploy-ship policy window remove|check [--source <s>]\n" +
    "       teploy-ship policy reviewers set <repo> [--users a,b] [--teams t]";

  if (sub === "show") {
    const runtime = await makeRuntime(args, config);
    try {
      const g = await runtime.governance.get();
      if (args.flags.json === true) {
        process.stdout.write(`${JSON.stringify(g, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${bold("authority")}\n`);
      for (const action of AUTHORITY_ACTIONS) {
        const grant = g.authority[action];
        process.stdout.write(`  ${action.padEnd(9)} roles: ${grant.roles.join(",") || "-"}   users: ${grant.users.join(",") || "-"}\n`);
      }
      process.stdout.write(`${bold("auto windows")}\n`);
      const windows = Object.entries(g.windows);
      if (windows.length === 0) process.stdout.write(dim("  none — auto sources may launch at any time\n"));
      for (const [source, w] of windows) {
        const inside = autoAllowedNow(g.windows, source === GLOBAL_WINDOW ? "" : source, new Date());
        process.stdout.write(`  ${(source === GLOBAL_WINDOW ? "(global)" : source).padEnd(12)} ${formatWindow(w)}   ${inside ? green("open now") : yellow("closed now")}\n`);
      }
      process.stdout.write(`${bold("required reviewers")}\n`);
      if (g.reviewers.length === 0) process.stdout.write(dim("  none\n"));
      for (const r of g.reviewers) {
        process.stdout.write(`  ${r.repo.padEnd(28)} users: ${r.users.join(",") || "-"}   teams: ${r.teams.join(",") || "-"}\n`);
      }
    } finally {
      await runtime.close();
    }
    return;
  }

  if (sub === "authority") {
    if (second === undefined || !(AUTHORITY_ACTIONS as readonly string[]).includes(second)) {
      fail(`an action is required: one of ${AUTHORITY_ACTIONS.join(", ")}`);
    }
    const roles = list("roles");
    const users = list("users");
    if (roles === undefined && users === undefined) fail("pass --roles and/or --users (omitting one clears it)");
    for (const r of roles ?? []) if (!["admin", "editor", "viewer"].includes(r)) fail(`unknown role: ${r}`);
    const runtime = await makeRuntime(args, config);
    try {
      await runtime.governance.setAuthority(second as AuthorityAction, {
        roles: (roles ?? []) as Array<"admin" | "editor" | "viewer">,
        users: users ?? [],
      });
    } finally {
      await runtime.close();
    }
    process.stderr.write(`${green("set")} ${second}: roles ${(roles ?? []).join(",") || "-"}, users ${(users ?? []).join(",") || "-"}\n`);
    return;
  }

  if (sub === "window") {
    const source = ((args.flags.source as string | undefined) ?? "").trim();
    const label = source === "" ? "(global)" : source;
    if (second === "set") {
      const days = args.flags.days as string | undefined;
      const start = args.flags.start as string | undefined;
      const end = args.flags.end as string | undefined;
      const tz = args.flags.tz as string | undefined;
      if (days === undefined || start === undefined || end === undefined || tz === undefined) {
        fail("window set needs --days, --start, --end and --tz");
      }
      const runtime = await makeRuntime(args, config);
      try {
        await runtime.governance.setWindow(source, { days: parseDays(days), start, end, tz });
        const w = windowFor((await runtime.governance.get()).windows, source === "" ? GLOBAL_WINDOW : source)!;
        process.stderr.write(`${green("set")} ${label}: ${formatWindow(w)}\n`);
      } finally {
        await runtime.close();
      }
      return;
    }
    if (second === "remove") {
      const runtime = await makeRuntime(args, config);
      try {
        await runtime.governance.setWindow(source, null);
      } finally {
        await runtime.close();
      }
      process.stderr.write(`${green("removed")} window for ${label}\n`);
      return;
    }
    if (second === "check") {
      const runtime = await makeRuntime(args, config);
      try {
        const g = await runtime.governance.get();
        const key = source === "" ? GLOBAL_WINDOW : source;
        const w = windowFor(g.windows, key);
        const open = autoAllowedNow(g.windows, key, new Date());
        if (args.flags.json === true) {
          process.stdout.write(`${JSON.stringify({ source: key, window: w ?? null, autoAllowedNow: open })}\n`);
        } else if (w === undefined) {
          process.stdout.write(`${label}: no window — auto may launch at any time\n`);
        } else {
          process.stdout.write(`${label}: ${formatWindow(w)} — ${open ? green("open: auto launches now") : yellow("closed: auto sources park as propose")}\n`);
        }
      } finally {
        await runtime.close();
      }
      return;
    }
    fail(usage);
  }

  if (sub === "reviewers") {
    if (second !== "set" || third === undefined || third === "") fail("usage: teploy-ship policy reviewers set <repo> [--users a,b] [--teams t]");
    const runtime = await makeRuntime(args, config);
    try {
      await runtime.governance.setReviewers({ repo: third, users: list("users") ?? [], teams: list("teams") ?? [] });
      const key = repoSlug(third) ?? third.trim().toLowerCase();
      const rule = (await runtime.governance.get()).reviewers.find((r) => r.repo === key);
      process.stderr.write(rule === undefined ? `${green("removed")} reviewer rule for ${third}\n` : `${green("set")} ${rule.repo}: users ${rule.users.join(",") || "-"}, teams ${rule.teams.join(",") || "-"}\n`);
    } finally {
      await runtime.close();
    }
    return;
  }

  fail(usage);
}

/**
 * Export the run history as something outside this machine can read.
 *
 * The durable event log has always recorded everything, which is why Ship gets
 * described as having an audit trail. It did not have one: a record you cannot
 * show anyone is not an audit trail, and the only way to answer "what has this
 * agent done to our repositories" was to read hundreds of events per run out of
 * the store.
 *
 * Read `src/audit.ts` before relying on the output. Ship records **no actor**
 * — not for enqueue, not for approval — so this answers what ran, when, at what
 * cost and what it published, and cannot answer who authorised it. Every row
 * carries `attributable: false` so that is impossible to miss.
 */
async function auditCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const format = enumFlag(args.flags.format, "format", ["csv", "json"] as const, "csv");
  const since = args.flags.since as string | undefined;
  const until = args.flags.until as string | undefined;
  for (const [name, value] of [["since", since], ["until", until]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) fail(`--${name} must be an ISO-8601 timestamp, got: ${value}`);
  }

  const runtime = await makeRuntime(args, loadConfig());
  try {
    const metas = await runtime.listMeta();
    const rows = [];
    for (const meta of metas) {
      rows.push(auditRow(meta, await runtime.store.load(meta.runId)));
    }
    const windowed = withinWindow(rows, since, until);
    process.stdout.write(format === "json" ? `${JSON.stringify(windowed, null, 2)}\n` : toCsv(windowed));
    if (windowed.length === 0) process.stderr.write(dim("no runs in that window\n"));
    else {
      // Report the gap by counting it, not with a blanket caveat. The old line
      // said "no actor attribution" unconditionally; once runs started carrying
      // an actor that footer contradicted the rows directly above it, which is
      // the kind of stale claim that makes a reader distrust the whole export.
      const n = windowed.length;
      const unattributed = windowed.filter((r) => !r.attributable).length;
      const caveat =
        unattributed === 0
          ? "every run names who asked"
          : unattributed === n
            ? "no run names who asked (all predate attribution, or came from a machine)"
            : `${unattributed} of ${n} name nobody`;
      process.stderr.write(dim(`${n} run${n === 1 ? "" : "s"} — ${caveat}\n`));
    }
  } finally {
    await runtime.close();
  }
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
    // Who asked, when anyone did. Runs from before attribution existed print
    // nothing here rather than a placeholder — a blank is honest, "unknown" in
    // every row is noise that trains you to stop reading the column.
    const actor = actorFromMeta(meta);
    const who = actor.kind === "unknown" ? "" : `  ${dim(formatActor(actor))}`;
    process.stdout.write(`${meta.runId}  ${status}  ${dim(meta.updatedAt)}${who}  ${meta.task.slice(0, 60)}\n`);
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
  warnIfUnsandboxed(usingSandbox);

  const runtime = await makeRuntime(args, config);
  if (runtime.kind !== "nucleus") fail("worker needs --store nucleus");
  const modelId = resolveModelId(args.flags.model, process.env, config.model);
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
  const modelId = resolveModelId(args.flags.model, process.env, config.model);
  const model = resolveModel(modelId);
  const repeats = numFlag(args.flags.repeats, "repeats", 1, { min: 1, max: 100, integer: true });
  const suiteName = (args.flags.suite as string) ?? "builtin";
  const tasks: EvalTask[] =
    suiteName === "hard" ? hardSuite : suiteName === "extreme" ? extremeSuite : suiteName === "all" ? [...builtinSuite, ...hardSuite, ...extremeSuite] : builtinSuite;

  if (args.flags.settle === true) {
    // Same footgun as --settle on a durable run, and worth the same warning:
    // eval workspaces are bare mkdtemp directories (eval.ts) and no suite task
    // runs `git init`, so the working-tree fingerprint always comes back
    // undefined, `dirty` is never true, and the settle path cannot fire. Accept
    // the flag but say plainly that it does nothing here.
    process.stderr.write(`${yellow("--settle is ignored on eval runs")} — eval workspaces are not git repos, so there is no working tree to detect as settled.\n`);
  }
  process.stderr.write(`Running ${tasks.length} tasks (${suiteName}) against ${modelId} (${repeats}x)...\n\n`);
  const report = await runEval({
    tasks,
    model,
    repeats,
    ...(args.flags.critic === true || args.flags.settle === true
      ? {
          agentOptions: {
            ...(args.flags.critic === true ? { critic: true } : {}),
            ...(args.flags.settle === true ? { finishWhenSettled: true } : {}),
          },
        }
      : {}),
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
    case "explain":
      return explainCommand(rest);
    case "enqueue":
      return enqueueCommand(rest);
    case "evidence":
      return evidenceCommand(rest);
    case "project":
      return projectCommand(rest);
    case "policy":
      return policyCommand(rest);
    case "audit":
      return auditCommand(rest);
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
