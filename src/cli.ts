#!/usr/bin/env node
// teploy-ship — the Ship CLI: run coding-agent tasks live in your
// terminal (streamed, interactive approvals) or as durable runs that
// park on approval, survive exits/crashes, and resume later.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { anthropic, createAnthropic } from "@neutron-build/ai/anthropic";
import { openai, createOpenAI } from "@neutron-build/ai/openai";
import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor, SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { deliverEvent, executeRun } from "@neutron-build/workflow";
import type { RunOutcome } from "@neutron-build/workflow";

import { parseArgs } from "./args.js";
import { runAgent } from "./agent.js";
import { defaultApprovalPolicy } from "./approval.js";
import { approvalEvent, durableAgent, sandboxProvider } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { formatReport, runEval } from "./eval.js";
import type { EvalTask } from "./eval.js";
import { FileEventStore, RunMetaStore, stateDir } from "./run-store.js";
import { builtinSuite } from "./tasks.js";
import { hardSuite } from "./hard-tasks.js";
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
  teploy-ship deny <run-id> [reason]  deny a parked action and continue
  teploy-ship eval [--suite builtin|hard|all] [--repeats N] [--json]

Config: flags > env > ~/.config/teploy-ship/config.json
  (model, sandboxUrl, sandboxToken, sandboxImage)
Gateway: set AI_GATEWAY_URL + AI_GATEWAY_KEY to route through teploy-gateway.
Durable state: ${stateDir()} (override: TEPLOY_SHIP_STATE)`;

interface Config {
  model?: string;
  sandboxUrl?: string;
  sandboxToken?: string;
  sandboxImage?: string;
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
// durable runs
// ---------------------------------------------------------------------------

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

async function executePass(runId: string, task: string, args: ReturnType<typeof parseArgs>, config: Config): Promise<RunOutcome> {
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
  const store = new FileEventStore();
  const meta = new RunMetaStore();
  const outcome = await executeRun({ workflow: wf, runId, store, input: { task } });
  const previous = await meta.load(runId);
  await meta.save({
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

function reportOutcome(runId: string, outcome: RunOutcome): void {
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
  const runId = `run-${randomUUID().slice(0, 8)}`;
  process.stderr.write(`${dim(`durable run ${runId}`)}\n`);
  const outcome = await executePass(runId, task, args, config);
  reportOutcome(runId, outcome);
  process.exit(outcome.status === "failed" ? 1 : 0);
}

async function resumeCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const runId = args.positional[0];
  if (runId === undefined) fail("usage: teploy-ship resume <run-id>");
  const meta = await new RunMetaStore().load(runId);
  if (meta === null) fail(`unknown run: ${runId}`);
  const outcome = await executePass(runId, meta.task, args, loadConfig());
  reportOutcome(runId, outcome);
  process.exit(outcome.status === "failed" ? 1 : 0);
}

async function decideCommand(rest: string[], approved: boolean): Promise<void> {
  const args = parseArgs(rest);
  const runId = args.positional[0];
  if (runId === undefined) fail(`usage: teploy-ship ${approved ? "approve" : "deny"} <run-id>`);
  const metaStore = new RunMetaStore();
  const meta = await metaStore.load(runId);
  if (meta === null) fail(`unknown run: ${runId}`);
  if (meta.eventName === undefined) fail(`run ${runId} is not waiting for approval (status: ${meta.status})`);

  const reason = args.positional[1];
  await deliverEvent(new FileEventStore(), runId, meta.eventName, {
    approved,
    ...(reason !== undefined ? { reason } : {}),
  });
  process.stderr.write(`${approved ? green("approved") : red("denied")} — continuing run…\n`);
  const outcome = await executePass(runId, meta.task, args, loadConfig());
  reportOutcome(runId, outcome);
  process.exit(outcome.status === "failed" ? 1 : 0);
}

async function runsCommand(): Promise<void> {
  const metas = await new RunMetaStore().list();
  if (metas.length === 0) {
    process.stderr.write(dim("no durable runs\n"));
    return;
  }
  for (const meta of metas) {
    const status =
      meta.status === "completed" ? green(meta.status) : meta.status === "waiting" ? yellow(meta.status) : meta.status === "failed" ? red(meta.status) : meta.status;
    process.stdout.write(`${meta.runId}  ${status}  ${dim(meta.updatedAt)}  ${meta.task.slice(0, 60)}\n`);
  }
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
    suiteName === "hard" ? hardSuite : suiteName === "all" ? [...builtinSuite, ...hardSuite] : builtinSuite;

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
      return runsCommand();
    case "resume":
      return resumeCommand(rest);
    case "approve":
      return decideCommand(rest, true);
    case "deny":
      return decideCommand(rest, false);
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
