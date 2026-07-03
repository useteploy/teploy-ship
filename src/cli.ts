#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { anthropic } from "@neutron-build/ai/anthropic";
import { openai } from "@neutron-build/ai/openai";
import { LocalExecutor, SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";

import { runAgent } from "./agent.js";
import { formatReport, runEval } from "./eval.js";
import { builtinSuite } from "./tasks.js";

// teploy-agent run "<task>" [--model provider/model] [--sandbox <url>] ...
// teploy-agent eval [--model provider/model] [--repeats N]
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "eval") {
    await evalCommand(rest);
    return;
  }
  if (command !== "run") {
    console.error('Usage:\n  teploy-agent run "<task>" [--model provider/model] [--sandbox <url> --sandbox-token <t>]\n  teploy-agent eval [--model provider/model] [--repeats N]');
    process.exit(2);
  }

  const args = parseArgs(rest);
  const task = args.positional[0];
  if (task === undefined || task === "") {
    console.error("A task is required: teploy-agent run \"fix the failing test\"");
    process.exit(2);
  }

  const modelId = args.flags.model ?? "anthropic/claude-sonnet-5";
  const model = modelId.startsWith("anthropic/")
    ? anthropic(modelId.slice("anthropic/".length))
    : openai(modelId.replace(/^openai\//, ""));

  let executor: AgentExecutor;
  let workdir: string;
  if (args.flags.sandbox !== undefined) {
    if (args.flags["sandbox-token"] === undefined) {
      console.error("--sandbox requires --sandbox-token");
      process.exit(2);
    }
    executor = await SandboxExecutor.start({
      baseURL: args.flags.sandbox,
      token: args.flags["sandbox-token"],
      create: { image: args.flags["sandbox-image"] ?? "python:3.12-slim" },
    });
    workdir = "/work";
  } else {
    workdir = mkdtempSync(join(tmpdir(), "teploy-agent-"));
    executor = new LocalExecutor({ root: workdir });
    console.error(`[local executor] workspace: ${workdir}`);
  }

  const result = await runAgent({
    model,
    executor,
    task,
    workdir,
    maxSteps: args.flags["max-steps"] !== undefined ? Number(args.flags["max-steps"]) : 20,
    onEvent: (event) => {
      const prefix = { thought: "\n[think]", action: "[act]  ", observation: "[obs]  ", finish: "\n[done]", error: "[err]  " }[event.type];
      console.error(`${prefix} ${event.text}`);
    },
  });

  await executor.destroy();
  console.log(`\n=== ${result.status} ===\n${result.summary}`);
  process.exit(result.status === "finished" ? 0 : 1);
}

async function evalCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const modelId = args.flags.model ?? "anthropic/claude-sonnet-5";
  const model = modelId.startsWith("anthropic/")
    ? anthropic(modelId.slice("anthropic/".length))
    : openai(modelId.replace(/^openai\//, ""));
  const repeats = args.flags.repeats !== undefined ? Number(args.flags.repeats) : 1;

  console.error(`Running ${builtinSuite.length} tasks against ${modelId} (${repeats}x)...\n`);
  const report = await runEval({
    tasks: builtinSuite,
    model,
    repeats,
    onResult: (r) => console.error(`  [${r.passed ? "PASS" : "FAIL"}] ${r.task} (attempt ${r.attempt + 1}, ${r.steps} steps)`),
  });
  console.log(`\n${formatReport(report)}`);
  if (args.flags.json !== undefined) console.log(`\n${JSON.stringify(report, null, 2)}`);
  process.exit(report.passRate === 1 ? 0 : 1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      flags[token.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
