import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { HARNESS_VERSIONS } from "./harness.js";
import type { HarnessAdapter, HarnessResult, HarnessStatus, HarnessUsage } from "./harness.js";

/**
 * External harness adapters (P5-2): Ship drives a vendor coding agent that is
 * installed in the sandbox image, in its headless mode, over the same executor
 * the native loop uses. Contracts and the documentation they come from are in
 * docs/adapters.md.
 *
 * Each attempt is TWO recorded steps: `harness-preflight` (is the binary
 * there, which version) and `harness-run` (the one exec, its parsed result).
 * The run step is a single exec because the sandbox API is request/response —
 * output arrives when the process ends — so the "coarse progress" an external
 * harness reports is started / completed plus the turn count parsed from its
 * event stream, not a live feed. Both steps always record a value; a missing
 * binary or a crashed process is a recorded `error` result, never a thrown
 * step, so replay takes the same branch.
 *
 * What stays outside, deliberately: the publish gate, the evidence legs and
 * spend settle run after this returns, on whatever tree the harness left.
 * Ship records what the harness says about itself and treats none of it as
 * evidence.
 */

/** Env var names forwarded from the worker into the harness process, per adapter. */
export const DEFAULT_FORWARDED_ENV: Record<string, string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENCODE_CONFIG_CONTENT"],
};

const PROMPT_PATH = ".teploy-agent/harness-prompt.md";
const ENV_PATH = ".teploy-agent/harness.env";

export interface ExternalHarnessOptions {
  /** The worker's environment — read for credentials to forward and for tuning. */
  env?: NodeJS.ProcessEnv;
}

export interface ExternalHarnessConfig {
  /** Whole-attempt deadline in ms (SHIP_HARNESS_TIMEOUT_MS, default 30 min). */
  timeoutMs: number;
  /** Model passed to the harness, if any (SHIP_HARNESS_MODEL; the harness's own default otherwise). */
  model?: string;
  /** Names of worker env vars written into the harness's environment (SHIP_HARNESS_ENV overrides the default list). */
  forward: string[];
  /** Pass `--bare` to claude (SHIP_CLAUDE_BARE=1): API-key auth only, no host context. */
  claudeBare: boolean;
}

export function externalHarnessConfig(id: string, env: NodeJS.ProcessEnv = process.env): ExternalHarnessConfig {
  const timeout = Number(env.SHIP_HARNESS_TIMEOUT_MS);
  const model = (env.SHIP_HARNESS_MODEL ?? "").trim();
  const forwardRaw = (env.SHIP_HARNESS_ENV ?? "").trim();
  const forward =
    forwardRaw === ""
      ? (DEFAULT_FORWARDED_ENV[id] ?? [])
      : forwardRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  return {
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30 * 60_000,
    ...(model !== "" ? { model } : {}),
    forward,
    claudeBare: /^(1|true|yes)$/i.test((env.SHIP_CLAUDE_BARE ?? "").trim()),
  };
}

/** Shell-quote one argument for POSIX sh. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The env file the harness sources: NAME='value' lines, sh-quoted. */
export function envFile(forward: string[], env: NodeJS.ProcessEnv): { text: string; names: string[] } {
  const names: string[] = [];
  const lines: string[] = [];
  for (const name of forward) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    const value = env[name];
    if (value === undefined || value === "") continue;
    names.push(name);
    lines.push(`${name}=${shq(value)}`);
  }
  return { text: lines.join("\n") + (lines.length > 0 ? "\n" : ""), names };
}

/** Preflight: the binary exists in the sandbox, and which version it is. */
export interface Preflight {
  found: boolean;
  version: string;
  detail?: string;
}

async function preflight(executor: AgentExecutor, binary: string): Promise<Preflight> {
  try {
    const probe = await executor.exec(`command -v ${binary} >/dev/null 2>&1 && ${binary} --version 2>&1 | head -n 1`, { timeoutMs: 60_000 });
    if (probe.exitCode !== 0) {
      return { found: false, version: "", detail: `${binary} is not on PATH in the sandbox image` };
    }
    return { found: true, version: probe.stdout.trim().slice(0, 120) };
  } catch (error) {
    return { found: false, version: "", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The recorded shape of the run step. */
export interface HarnessRunRecord {
  exitCode: number;
  timedOut: boolean;
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  /** Which forwarded env NAMES were present (never values). */
  forwarded: string[];
  stderrTail: string;
}

function tail(text: string, max = 1500): string {
  return text.length <= max ? text : text.slice(-max);
}

function errorResult(summary: string): HarnessResult {
  return {
    status: "error",
    summary,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
    incomplete: true,
  };
}

/**
 * The prompt an external harness works from. The native loop's system prompt
 * describes Ship's own action protocol, which means nothing to a vendor
 * agent; this states the contract those agents need: the tree is the
 * deliverable, git is not theirs.
 */
export function externalPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    "You are running unattended inside a sandbox with no one to answer questions. " +
    "Work in the current directory. Your deliverable is the EDITED WORKING TREE: do not commit, push, stash, " +
    "create branches or change git configuration — the change is published after you stop. " +
    "Do not ask for confirmation; if something is ambiguous, pick the smallest reasonable interpretation and say so in your final message. " +
    "Finish with a short plain-text summary of what you changed and how you verified it."
  );
}

/**
 * Parse claude's `--output-format stream-json` (one JSON object per line; the
 * last is `{"type":"result",...}`). Documented fields: docs/adapters.md.
 */
export function parseClaudeStream(
  stdout: string,
  priced: boolean,
): { status: HarnessStatus; summary: string; turns: number; usage: HarnessUsage; sawResult: boolean } {
  let result: Record<string, unknown> | undefined;
  let assistantTurns = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "assistant") assistantTurns += 1;
    if (event.type === "result") result = event;
  }
  if (result === undefined) {
    return {
      status: "error",
      summary: "claude produced no result event",
      turns: assistantTurns,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
      sawResult: false,
    };
  }
  const u = (result.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadTokens = num(u.cache_read_input_tokens);
  const cacheWriteTokens = num(u.cache_creation_input_tokens);
  const usage: HarnessUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    priced,
    // total_cost_usd is a client-side estimate. It is the honest number under an
    // API key (the same list-price arithmetic pricing.ts does); under a
    // subscription it is an estimate of a bill that does not exist, so it is
    // not recorded as spend at all — the run is counted, not priced.
    ...(priced && typeof result.total_cost_usd === "number" ? { costUSD: result.total_cost_usd } : {}),
  };
  const subtype = typeof result.subtype === "string" ? result.subtype : "";
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const turns = num(result.num_turns) > 0 ? num(result.num_turns) : assistantTurns;
  if (subtype === "success" && result.is_error !== true) {
    return { status: "finished", summary: text === "" ? "claude finished without a summary" : text.slice(0, 4000), turns, usage, sawResult: true };
  }
  if (subtype === "error_max_turns") {
    return { status: "max-steps", summary: `claude reached its ${turns}-turn limit.`, turns, usage, sawResult: true };
  }
  if (subtype === "error_max_budget_usd") {
    return { status: "budget-exhausted", summary: "claude stopped at its per-run budget.", turns, usage, sawResult: true };
  }
  const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).map(String).join("; ") : "";
  return {
    status: "error",
    summary: `claude ended with ${subtype || "an error"}${errors !== "" ? `: ${errors}` : text !== "" ? `: ${text.slice(0, 800)}` : ""}`,
    turns,
    usage,
    sawResult: true,
  };
}

/**
 * Parse opencode's `--format json` event stream: `step_finish` parts carry
 * `tokens` and `cost`; the last `text` part is the agent's final message;
 * there is no terminal result object (docs/adapters.md).
 */
export function parseOpencodeStream(stdout: string): { summary: string; turns: number; usage: HarnessUsage; error?: string } {
  let turns = 0;
  let lastText = "";
  let cost = 0;
  let error: string | undefined;
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") lastText = part.text.trim();
    if (event.type === "step_finish") {
      turns += 1;
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      usage.inputTokens += num(tokens.input);
      usage.outputTokens += num(tokens.output) + num(tokens.reasoning);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + num(cache.read);
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + num(cache.write);
      cost += num(part.cost);
    }
    if (event.type === "error") {
      const e = event.error as Record<string, unknown> | string | undefined;
      error = typeof e === "string" ? e : typeof e?.message === "string" ? (e.message as string) : JSON.stringify(e ?? "unknown error");
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  // opencode reports cost 0 for models it cannot price and for subscription
  // providers alike. Tokens with no dollars is exactly the unpriced shape.
  if (cost > 0) {
    usage.priced = true;
    usage.costUSD = cost;
  } else {
    usage.priced = false;
  }
  return { summary: lastText, turns, usage, ...(error !== undefined ? { error } : {}) };
}

interface CommandSpec {
  binary: string;
  /** Build the shell command; `prompt` is the sh-quoted prompt path. */
  command: (opts: { config: ExternalHarnessConfig; maxSteps: number; maxRunCostUSD: number; priced: boolean }) => string;
  parse: (exec: ExecResult, priced: boolean) => { status: HarnessStatus; summary: string; turns: number; usage: HarnessUsage };
  /** Is the usage this harness reports billed per token under the forwarded credentials? */
  priced: (forwarded: string[]) => boolean;
}

const SPECS: Record<string, CommandSpec> = {
  "claude-code": {
    binary: "claude",
    // claude refuses bypassPermissions as root unless it is told it is in a
    // sandbox; the sandbox image runs as root and IS a sandbox.
    command: ({ config, maxSteps, maxRunCostUSD, priced }) =>
      `IS_SANDBOX=1 claude -p "$(cat ${shq(PROMPT_PATH)})" --output-format stream-json --verbose ` +
      `--permission-mode bypassPermissions --max-turns ${maxSteps}` +
      (config.claudeBare ? " --bare" : "") +
      (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
      (priced && maxRunCostUSD > 0 ? ` --max-budget-usd ${maxRunCostUSD.toFixed(2)}` : ""),
    parse: (exec, priced) => {
      const parsed = parseClaudeStream(exec.stdout, priced);
      if (!parsed.sawResult && exec.exitCode !== 0) {
        return { ...parsed, summary: `claude exited ${exec.exitCode} before producing a result: ${tail(exec.stderr, 600).trim() || "(no stderr)"}` };
      }
      return parsed;
    },
    // An API key bills per token; an OAuth token draws on a subscription. A
    // custom auth token / base URL is a proxy whose billing Ship cannot see.
    priced: (forwarded) => forwarded.includes("ANTHROPIC_API_KEY") && !forwarded.includes("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  opencode: {
    binary: "opencode",
    command: ({ config }) =>
      `opencode run --format json --auto --pure --dir . ` +
      (config.model !== undefined ? `--model ${shq(config.model)} ` : "") +
      `"$(cat ${shq(PROMPT_PATH)})"`,
    parse: (exec) => {
      const parsed = parseOpencodeStream(exec.stdout);
      if (parsed.error !== undefined || exec.exitCode !== 0) {
        return {
          status: "error",
          summary: `opencode ${parsed.error !== undefined ? `reported: ${parsed.error}` : `exited ${exec.exitCode}: ${tail(exec.stderr, 600).trim() || "(no stderr)"}`}`,
          turns: parsed.turns,
          usage: parsed.usage,
        };
      }
      return {
        status: "finished",
        summary: parsed.summary === "" ? "opencode finished without a summary" : parsed.summary.slice(0, 4000),
        turns: parsed.turns,
        usage: parsed.usage,
      };
    },
    // Decided per run from the cost opencode reports (parseOpencodeStream).
    priced: () => true,
  },
};

export function externalAdapter(id: "claude-code" | "opencode", options: ExternalHarnessOptions = {}): HarnessAdapter {
  const spec = SPECS[id]!;
  const env = options.env ?? process.env;
  return {
    id,
    version: HARNESS_VERSIONS[id]!,
    isolated: true,
    async run(task, ws, budget, onEvent): Promise<HarnessResult> {
      const p = ws.stepPrefix;
      onEvent({ kind: "started", harness: id });
      const pre = await ws.ctx.step(`${p}harness-preflight`, () => preflight(ws.executor, spec.binary));
      if (!pre.found) {
        const result = errorResult(`${spec.binary} is not available in the sandbox image (${pre.detail ?? "not found"}); nothing ran`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      const record = await ws.ctx.step(`${p}harness-run`, async (): Promise<HarnessRunRecord> => {
        const config = externalHarnessConfig(id, env);
        const forwardedEnv = envFile(config.forward, env);
        const priced = spec.priced(forwardedEnv.names);
        try {
          await ws.executor.putFile(PROMPT_PATH, externalPrompt(task.prompt));
          await ws.executor.putFile(ENV_PATH, forwardedEnv.text);
          const command =
            `set -a; . ${shq(ENV_PATH)}; set +a; rm -f ${shq(ENV_PATH)}; ` +
            spec.command({ config, maxSteps: budget.maxSteps, maxRunCostUSD: budget.maxRunCostUSD, priced });
          const exec = await ws.executor.exec(command, { timeoutMs: config.timeoutMs, maxOutputBytes: 16 * 1_048_576 });
          const parsed = spec.parse(exec, priced);
          const timedOut = exec.timedOut === true;
          return {
            exitCode: exec.exitCode,
            timedOut,
            status: timedOut ? "error" : parsed.status,
            summary: timedOut ? `${spec.binary} did not finish within ${Math.round(config.timeoutMs / 60_000)} minutes` : parsed.summary,
            turns: parsed.turns,
            usage: parsed.usage,
            forwarded: forwardedEnv.names,
            stderrTail: tail(exec.stderr),
          };
        } catch (error) {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: `${spec.binary} could not be run: ${error instanceof Error ? error.message : String(error)}`,
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
            forwarded: forwardedEnv.names,
            stderrTail: "",
          };
        } finally {
          await ws.executor.exec(`rm -f ${shq(ENV_PATH)} ${shq(PROMPT_PATH)}`, { timeoutMs: 30_000 }).catch(() => {});
        }
      });
      for (let turn = 0; turn < record.turns; turn++) onEvent({ kind: "turn", turn });
      onEvent({ kind: "completed", status: record.status });
      return {
        status: record.status,
        summary: record.summary,
        turns: record.turns,
        usage: record.usage,
        incomplete: record.status !== "finished",
      };
    },
  };
}

/** Every external adapter this worker can carry. Presence of the binary is checked per run, as a recorded step. */
export function externalAdapters(options: ExternalHarnessOptions = {}): HarnessAdapter[] {
  return [externalAdapter("claude-code", options), externalAdapter("opencode", options)];
}
