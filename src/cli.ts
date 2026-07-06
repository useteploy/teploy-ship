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
import { deliverEvent } from "@neutron-build/workflow";
import type { RunOutcome } from "@neutron-build/workflow";

import { parseArgs } from "./args.js";
import { commitAndPush, fixPrompt, openPullRequest, parseRepoUrl, setupRepo } from "./git.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import { runAgent } from "./agent.js";
import { defaultApprovalPolicy } from "./approval.js";
import { durableAgent, sandboxProvider } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { formatReport, runEval } from "./eval.js";
import type { EvalTask } from "./eval.js";
import { stateDir } from "./run-store.js";
import { fileRuntime, nucleusRuntime } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { startWorker } from "./worker.js";
import { builtinSuite } from "./tasks.js";
import { hardSuite } from "./hard-tasks.js";
import { extremeSuite } from "./extreme-tasks.js";
import { bold, dim, green, promptApproval, red, renderEvent, renderUsage, yellow } from "./ui.js";

const USAGE = `teploy-ship — coding agent on your own stack

Usage:
  teploy-ship run "<task>"            live run in the terminal (streamed, interactive approvals)
      [--model provider/model]        default anthropic/claude-sonnet-5
      [--sandbox <url> --sandbox-token <t> [--sandbox-image <img>]]
      [--max-steps N] [--yes] [--json]
  teploy-ship run --durable "<task>"  durable run: parks on approvals, survives exits
  teploy-ship runs                    list durable runs
  teploy-ship resume <run-id>         continue a durable run (after a crash or park)
  teploy-ship approve <run-id>        approve a parked action and continue
      [--handoff]                     deliver the decision, let a worker finish the run
  teploy-ship deny <run-id> [reason]  deny a parked action and continue
  teploy-ship fix --repo <url> "<task>"  clone, fix on a branch, push, open a PR
      [--git-token <t>]               also SHIP_GIT_TOKEN or gitToken in config
      [--base <branch>]               PR target (default: repo default branch)
      (accepts run flags: --model, --sandbox…, --max-steps, --yes, --json)
  teploy-ship worker                  resident worker: picks up due nucleus-store runs
      [--interval seconds]            poll interval (default 5)
  teploy-ship web                     serve the runs dashboard (browser approve/deny)
      [--port N] [--token <t>]        token also via SHIP_WEB_TOKEN (required)
      [--dev]                         vite dev server instead of the built app
  teploy-ship eval [--suite builtin|hard|extreme|all] [--repeats N] [--json]

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
  store?: string;
  nucleusUrl?: string;
  gitToken?: string;
  /** Per-source intake policies for the worker: { forgejo: "auto", … } */
  intake?: Record<string, "ignore" | "propose" | "auto">;
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".config", "teploy-ship", "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

/**
 * Gateway-aware model resolution: with AI_GATEWAY_URL (+_KEY) set, all
 * calls route through teploy-gateway using the project key — provider
 * keys never reach the app; caching stays on either way.
 */
function resolveModel(modelId: string): ModelAdapter {
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

  const model = resolveModel((args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5");
  const { executor, workdir } = await makeExecutor(args, config);

  const abort = new AbortController();
  process.on("SIGINT", () => {
    process.stderr.write(`\n${yellow("interrupting after the current action…")}\n`);
    abort.abort();
  });

  const interactive = process.stdin.isTTY === true && args.flags.yes !== true && args.flags.headless !== true;
  const result = await runAgent({
    model,
    executor,
    task,
    workdir,
    maxSteps: args.flags["max-steps"] !== undefined ? Number(args.flags["max-steps"]) : 20,
    approveAction: defaultApprovalPolicy,
    onApprovalRequest: interactive ? (action) => promptApproval(action) : () => args.flags.yes === true,
    onEvent: args.flags.json === true ? undefined : renderEvent,
    abortSignal: abort.signal,
  });

  await executor.destroy();
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify({ status: result.status, summary: result.summary, steps: result.steps.length, usage: result.usage }, null, 2) + "\n");
  } else {
    const mark = result.status === "finished" ? green(result.status) : red(result.status);
    process.stderr.write(`\n${mark} — ${result.summary}\n${dim(renderUsage(result.usage))}\n`);
  }
  process.exit(result.status === "finished" ? 0 : 1);
}

async function makeExecutor(
  args: ReturnType<typeof parseArgs>,
  config: Config,
): Promise<{ executor: AgentExecutor; workdir: string }> {
  const sandboxUrl = (args.flags.sandbox as string) ?? config.sandboxUrl;
  if (sandboxUrl !== undefined) {
    const token = (args.flags["sandbox-token"] as string) ?? config.sandboxToken;
    if (token === undefined) fail("--sandbox requires --sandbox-token (or sandboxToken in config)");
    const executor = await SandboxExecutor.start({
      baseURL: sandboxUrl,
      token,
      create: { image: (args.flags["sandbox-image"] as string) ?? config.sandboxImage ?? "python:3.12-slim" },
    });
    return { executor, workdir: "/work" };
  }
  const workdir = join(stateDir(), "workspaces", `live-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });
  process.stderr.write(dim(`workspace: ${workdir}\n`));
  return { executor: new LocalExecutor({ root: workdir }), workdir };
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
  const token = (args.flags["git-token"] as string) ?? process.env.SHIP_GIT_TOKEN ?? config.gitToken;
  if (token === undefined || token === "") fail("a git token is required: --git-token, SHIP_GIT_TOKEN, or gitToken in config");

  const ref = parseRepoUrl(repoUrl);
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const model = resolveModel((args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5");
  const { executor } = await makeExecutor(args, config);

  process.stderr.write(dim(`cloning ${ref.owner}/${ref.repo}…\n`));
  const checkout = await setupRepo(executor, { ref, token, runId });
  process.stderr.write(dim(`on ${checkout.branch} (from ${checkout.base})\n`));

  const runtime = await makeRuntime(args, config);
  const repoKey = `${ref.owner}/${ref.repo}`;
  const context = await loadRepoContext(executor, { repo: repoKey, memory: runtime.memory });
  if (context !== "") process.stderr.write(dim("injecting repo playbook/history\n"));

  const interactive = process.stdin.isTTY === true && args.flags.yes !== true && args.flags.headless !== true;
  const result = await runAgent({
    model,
    executor,
    task: fixPrompt({ task, branch: checkout.branch, base: (args.flags.base as string) ?? checkout.base, context }),
    workdir: ".",
    maxSteps: args.flags["max-steps"] !== undefined ? Number(args.flags["max-steps"]) : 30,
    approveAction: defaultApprovalPolicy,
    onApprovalRequest: interactive ? (action) => promptApproval(action) : () => args.flags.yes === true,
    onEvent: args.flags.json === true ? undefined : renderEvent,
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
  if (pushed === null) {
    await runtime.memory.record({ repo: repoKey, note: runNote({ task, summary: result.summary }), runId }).catch(() => {});
    await runtime.close();
    await executor.destroy();
    process.stderr.write(`${red("no changes")} — the run produced an empty diff (status: ${result.status}).\n`);
    process.exit(1);
  }

  const pr = await openPullRequest({
    ref,
    token,
    head: checkout.branch,
    base: (args.flags.base as string) ?? checkout.base,
    title: task.length > 72 ? `${task.slice(0, 72)}…` : task,
    body: `${result.summary}\n\n---\nTask: ${task}\nRun: ${runId} · ${result.steps.length} steps · agent status: ${result.status}\nGenerated by Teploy Ship.`,
  });
  await runtime.memory.record({ repo: repoKey, note: runNote({ task, summary: result.summary, pr: pr.url }), runId }).catch(() => {});
  await runtime.close();
  await executor.destroy();
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify({ status: result.status, pr: pr.url, number: pr.number, sha: pushed.sha, runId }, null, 2) + "\n");
  } else {
    process.stderr.write(`\n${green("PR opened")} — ${bold(pr.url)}\n${dim(renderUsage(result.usage))}\n`);
  }
  process.exit(0);
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
  const sandboxUrl = (args.flags.sandbox as string) ?? config.sandboxUrl;
  if (sandboxUrl !== undefined) {
    const token = (args.flags["sandbox-token"] as string) ?? config.sandboxToken;
    if (token === undefined) fail("--sandbox requires --sandbox-token (or sandboxToken in config)");
    return sandboxProvider({
      baseURL: sandboxUrl,
      token,
      image: (args.flags["sandbox-image"] as string) ?? config.sandboxImage ?? "python:3.12-slim",
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
      return new LocalExecutor({ root: handle });
    },
  };
}

async function executePass(
  runtime: ShipRuntime,
  runId: string,
  task: string,
  args: ReturnType<typeof parseArgs>,
  config: Config,
): Promise<RunOutcome | null> {
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const usingSandbox = ((args.flags.sandbox as string) ?? config.sandboxUrl) !== undefined;
  const wf = durableAgent({
    model: resolveModel(modelId),
    executor: durableProvider(args, config),
    approveAction: defaultApprovalPolicy,
    // Local workspaces root every path at the run's own dir, so "." is
    // the honest working directory to show the agent.
    workdir: usingSandbox ? "/work" : ".",
  });
  const outcome = await runtime.execute(wf, runId, { task });
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
  const outcome = await executePass(runtime, runId, task, args, config);
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
  await deliverEvent(runtime.store, runId, meta.eventName, {
    approved,
    ...(reason !== undefined ? { reason } : {}),
  });
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

async function workerCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  if (((args.flags.store as string) ?? config.store) !== "nucleus") {
    fail("worker needs the shared store: --store nucleus (+ --nucleus-url or NUCLEUS_URL)");
  }
  const runtime = await makeRuntime(args, config);
  if (runtime.kind !== "nucleus") fail("worker needs --store nucleus");
  const modelId = (args.flags.model as string) ?? config.model ?? "anthropic/claude-sonnet-5";
  const usingSandbox = ((args.flags.sandbox as string) ?? config.sandboxUrl) !== undefined;
  const gitToken = (args.flags["git-token"] as string) ?? process.env.SHIP_GIT_TOKEN ?? config.gitToken;
  const worker = startWorker({
    runtime: runtime as import("./runtime.js").NucleusShipRuntime,
    model: resolveModel(modelId),
    modelId,
    executor: durableProvider(args, config),
    workdir: usingSandbox ? "/work" : ".",
    intervalMs: args.flags.interval !== undefined ? Number(args.flags.interval) * 1000 : 5000,
    ...(gitToken !== undefined ? { gitToken } : {}),
    ...(config.intake !== undefined ? { intakePolicies: config.intake } : {}),
  });
  // The scheduler's own timer is unref'd; this ref'd no-op holds the
  // process resident until a signal stops it.
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = (): void => {
    process.stderr.write(`\n${dim("worker stopping…")}\n`);
    clearInterval(keepAlive);
    worker.stop();
    void runtime.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function webCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = loadConfig();
  const token = (args.flags.token as string) ?? process.env.SHIP_WEB_TOKEN;
  if (token === undefined || token === "") {
    fail("web needs an access token: --token <t> or SHIP_WEB_TOKEN (the browser login uses it)");
  }
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
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
  const repeats = args.flags.repeats !== undefined ? Number(args.flags.repeats) : 1;
  const suiteName = (args.flags.suite as string) ?? "builtin";
  const tasks: EvalTask[] =
    suiteName === "hard" ? hardSuite : suiteName === "extreme" ? extremeSuite : suiteName === "all" ? [...builtinSuite, ...hardSuite, ...extremeSuite] : builtinSuite;

  process.stderr.write(`Running ${tasks.length} tasks (${suiteName}) against ${modelId} (${repeats}x)...\n\n`);
  const report = await runEval({
    tasks,
    model,
    repeats,
    onResult: (r) => process.stderr.write(`  [${r.passed ? "PASS" : "FAIL"}] ${r.task} (attempt ${r.attempt + 1}, ${r.steps} steps)\n`),
  });
  process.stdout.write(`\n${formatReport(report)}\n`);
  if (args.flags.json === true) process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.passRate === 1 ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
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
