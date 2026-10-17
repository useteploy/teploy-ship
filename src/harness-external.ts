import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { HARNESS_PACKAGES, HARNESS_VERSIONS } from "./harness.js";
import { PLAN_REVIEW_REFUSAL, refusalFor } from "./harness-capabilities.js";
import { clipDetail } from "./live.js";
import type { LiveUpdate } from "./live.js";
import type { HarnessAdapter, HarnessResult, HarnessStatus, HarnessUsage } from "./harness.js";

/**
 * External harness adapters (P5-2): Ship drives a vendor coding agent that is
 * installed in the sandbox image, in its headless mode, over the same executor
 * the native loop uses. Contracts and the documentation they come from are in
 * docs/adapters.md.
 *
 * Each attempt is TWO recorded steps: `harness-preflight` (is the binary
 * there, which version, and is that a version this adapter can drive) and
 * `harness-run` (the one exec, its parsed result).
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
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZHIPU_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENCODE_CONFIG_CONTENT"],
  // CODEX_API_KEY is what OpenAI documents for non-interactive exec; OPENAI_API_KEY
  // is the older spelling some deployments still carry. CODEX_ACCESS_TOKEN is the
  // subscription (ChatGPT) path — unpriced under P5-3, like claude's OAuth token.
  // AI_GATEWAY_URL/AI_GATEWAY_KEY route codex through teploy-gateway when both are
  // present: the adapter then declares a `teploy-gateway` model provider
  // (codexGatewayConfigFlags) instead of calling OpenAI directly.
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "AI_GATEWAY_URL", "AI_GATEWAY_KEY"],
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
  /** The version images/versions.json bakes for this harness, when it names one. */
  expected?: string;
  /** Does the installed binary report `expected`? Absent when nothing to compare. */
  pinned?: boolean;
  /**
   * Set when the found binary's version is one this adapter refuses to drive
   * (opencode >= 2). Same shape as a missing binary: recorded here, the run
   * stops before `harness-run`, nothing executes.
   */
  refused?: string;
}

/**
 * What to do about a harness the sandbox image does not carry.
 *
 * The old message ("not on PATH in the sandbox image") was true and useless:
 * it left an operator to work out on their own that harnesses are BAKED, which
 * image to bake them into, and how to point a repo at it. Ship owns all three
 * answers, so it says them.
 */
export function missingHarnessHelp(id: string, binary: string): string {
  const pkg = HARNESS_PACKAGES[id];
  return (
    `${binary} is not on PATH in the sandbox image. Harnesses are baked into the image, never installed per run ` +
    `(a run-time install needs sandbox egress and drifts under a running worker, which breaks replay). ` +
    `Build one that carries it — \`images/build.sh --harness ${id} go\`${pkg !== undefined ? ` (installs ${pkg.npm}@${pkg.version})` : ""} — ` +
    `then point this repo at it on the dashboard's Projects page, or the whole worker with SHIP_SANDBOX_IMAGE.`
  );
}

/**
 * The major version in a `--version` first line, when the line carries an
 * x.y.z. Undefined when it carries no such token — an unparseable version is
 * recorded, never guessed at (the same rule `pinned` follows below).
 */
export function versionMajor(version: string): number | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Why an opencode >= 2.0.0 is refused rather than run (S13). The 2.x line
 * removed `--pure` and `--dir`, so the invocation this adapter builds fails
 * flag-parse and prints usage — nothing would run — and its event stream
 * renamed `tool` to `tool_use` and dropped the terminal `step_finish`, which
 * the live feed and the turn/usage counts silently misread. The v2 contract,
 * measured against real 2.0.26 streams, and what adopting it needs are in
 * evals/receipts/2026-10-14-opencode-v2-events.txt; until that tracked work
 * lands, the refusal is the honest outcome.
 */
export function opencodeV2Refusal(version: string, expected?: string): string {
  return (
    `opencode reports ${version}, which is the 2.x line, and ship's opencode adapter drives the 1.x contract: v2 removed --pure and --dir (this invocation fails flag-parse; nothing would run) and renamed the tool event the live feed reads. ` +
    (expected !== undefined
      ? `images/versions.json pins opencode-ai@${expected} — an unpinned binary (local, dev, brew) is how a 2.x arrives; run an image that bakes the pin (images/build.sh --harness opencode). `
      : "") +
    `Adopting v2 is tracked work; the measured contract and the adoption list are in evals/receipts/2026-10-14-opencode-v2-events.txt.`
  );
}

async function preflight(
  executor: AgentExecutor,
  id: string,
  binary: string,
  refuseVersion?: (version: string, expected?: string) => string | undefined,
): Promise<Preflight> {
  const expected = HARNESS_PACKAGES[id]?.version;
  try {
    const probe = await executor.exec(`command -v ${binary} >/dev/null 2>&1 && ${binary} --version 2>&1 | head -n 1`, { timeoutMs: 60_000 });
    if (probe.exitCode !== 0) {
      return { found: false, version: "", detail: missingHarnessHelp(id, binary), ...(expected !== undefined ? { expected } : {}) };
    }
    const version = probe.stdout.trim().slice(0, 120);
    const refusal = refuseVersion?.(version, expected);
    return {
      found: true,
      version,
      ...(expected !== undefined ? { expected } : {}),
      // Recorded, NOT enforced. Refusing here would take a working deployment
      // offline the moment images/versions.json moved ahead of the image on
      // the box; what an operator actually needs is the log to say which binary
      // wrote the tree, which this gives them. The one exception is a major
      // the adapter cannot drive at all (refuseVersion): that binary cannot
      // run the invocation, so refusing beats a run that dies in flag-parse.
      ...(expected !== undefined ? { pinned: version.includes(expected) } : {}),
      ...(refusal !== undefined ? { refused: refusal } : {}),
    };
  } catch (error) {
    return { found: false, version: "", detail: error instanceof Error ? error.message : String(error), ...(expected !== undefined ? { expected } : {}) };
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
  /**
   * The vendor session codex reports (`thread.started` → `thread_id`), recorded
   * so a log can name the program's own continuation handle
   * (`codex exec resume <id>`) without re-running it. codex only.
   */
  threadId?: string;
  /**
   * The paths codex says it changed (`file_change` items, `kind path` per
   * entry, capped). A claim by the harness, not evidence: the publish gate
   * diffs the tree itself. codex only.
   */
  fileChanges?: string[];
  /** How many commands codex reported executing (`command_execution` items). codex only. */
  commands?: number;
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
export function externalPrompt(prompt: string, mode?: "fix" | "scan"): string {
  return (
    `${prompt}\n\n` +
    "You are running unattended inside a sandbox with no one to answer questions. " +
    (mode === "scan"
      ? "This is a read-only investigation. Your deliverable is findings and verification results; do not edit tracked files, commit, push, stash, create branches or change git configuration. Nothing will be published. "
      : "Work in the current directory. Your deliverable is the EDITED WORKING TREE: do not commit, push, stash, create branches or change git configuration — the change is published after you stop. ") +
    "Do not ask for confirmation; if something is ambiguous, pick the smallest reasonable interpretation and say so in your final message. " +
    (mode === "scan" ? "Finish with findings in the requested format and the commands and results you verified." : "Finish with a short plain-text summary of what you changed and how you verified it.")
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

/**
 * Parse codex's `exec --json` JSONL stream (one event per line; the contract
 * is `codex-rs/exec/src/exec_events.rs` at the pinned tag, see
 * docs/adapters.md "codex"): `thread.started` names the session, each
 * `turn.started` is a turn, `item.completed` carries the agent's messages,
 * commands and file changes, and `turn.completed` carries the turn's usage.
 * `turn.failed` / `error` are terminal errors.
 *
 * Usage nesting follows the vendor's own accounting (and T3's reader,
 * apps/server/src/provider/CodexTurnTokenUsage.ts:164): cached input and
 * reasoning output are counted INSIDE input_tokens / output_tokens, so
 * totalTokens is their sum, not a sum of every field.
 */
export function parseCodexExecStream(stdout: string): {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  threadId?: string;
  fileChanges: string[];
  commands: number;
  sawCompletion: boolean;
  error?: string;
} {
  let threadId: string | undefined;
  let turns = 0;
  let commands = 0;
  let lastText = "";
  let sawCompletion = false;
  let error: string | undefined;
  const fileChanges: string[] = [];
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, priced: false };
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
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string" && event.thread_id !== "") threadId = event.thread_id;
        break;
      case "turn.started":
        turns += 1;
        break;
      case "item.completed":
      case "item.updated": {
        const item = (event.item ?? {}) as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") lastText = item.text.trim();
        if (event.type === "item.completed" && item.type === "command_execution") commands += 1;
        if (event.type === "item.completed" && item.type === "file_change") {
          const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
          for (const change of changes.slice(0, 200)) {
            if (typeof change.path !== "string") continue;
            fileChanges.push(`${typeof change.kind === "string" && change.kind !== "" ? change.kind : "update"} ${change.path}`);
          }
        }
        break;
      }
      case "turn.completed": {
        sawCompletion = true;
        const u = (event.usage ?? {}) as Record<string, unknown>;
        usage.inputTokens = num(u.input_tokens);
        usage.outputTokens = num(u.output_tokens);
        usage.cacheReadTokens = num(u.cached_input_tokens);
        usage.cacheWriteTokens = num(u.cache_write_input_tokens);
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
        break;
      }
      case "turn.failed": {
        const e = (event.error ?? {}) as Record<string, unknown>;
        error = typeof e.message === "string" && e.message !== "" ? e.message : JSON.stringify(event.error ?? "turn failed");
        break;
      }
      case "error":
        error = typeof event.message === "string" ? event.message : JSON.stringify(event);
        break;
      default:
        break;
    }
  }
  const base = {
    summary: lastText === "" ? "codex finished without a summary" : lastText.slice(0, 4000),
    turns,
    usage,
    ...(threadId !== undefined ? { threadId } : {}),
    fileChanges: fileChanges.slice(0, 200),
    commands,
    sawCompletion,
  };
  if (error !== undefined) return { ...base, status: "error", summary: `codex reported: ${error.slice(0, 800)}`, error };
  if (!sawCompletion) {
    return { ...base, status: "error", summary: "codex produced no turn.completed event", error: "no turn.completed" };
  }
  return { ...base, status: "finished" };
}

/**
 * What a harness is doing right now, read off its event stream as it
 * arrives (live.ts). Line-buffered: a chunk may end mid-object. Returns the
 * update to publish when the picture changed, null otherwise, so a busy
 * stream does not write the store per byte.
 */
export interface LiveTracker {
  feed(chunk: string): LiveUpdate | null;
}

function lineBuffered(onLine: (event: Record<string, unknown>) => LiveUpdate | null): LiveTracker {
  let buffer = "";
  return {
    feed(chunk) {
      buffer += chunk;
      let update: LiveUpdate | null = null;
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line.startsWith("{")) continue;
        try {
          const next = onLine(JSON.parse(line) as Record<string, unknown>);
          if (next !== null) update = next;
        } catch {
          // torn or non-JSON line
        }
      }
      return update;
    },
  };
}

/** claude's stream-json: assistant messages carry tool_use / text blocks. */
export function claudeLiveTracker(): LiveTracker {
  let turns = 0;
  return lineBuffered((event) => {
    if (event.type !== "assistant") return null;
    turns += 1;
    const message = (event.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
    let detail = "";
    for (const block of content) {
      if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target = [input.file_path, input.command, input.pattern, input.query, input.description].find((v) => typeof v === "string" && v !== "");
        detail = `${String(block.name ?? "tool")}${typeof target === "string" ? ` ${clipDetail(target, 100)}` : ""}`;
      } else if (block.type === "text" && detail === "" && typeof block.text === "string") {
        detail = clipDetail(block.text, 120);
      }
    }
    return { phase: "harness", turn: turns, ...(detail !== "" ? { detail } : {}) };
  });
}

/** opencode's --format json: `tool` parts name the tool, `step_finish` counts a turn. */
export function opencodeLiveTracker(): LiveTracker {
  let turns = 0;
  return lineBuffered((event) => {
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_finish") {
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    if (event.type === "tool") {
      const state = (part.state ?? {}) as Record<string, unknown>;
      const input = (state.input ?? part.input ?? {}) as Record<string, unknown>;
      const target = [input.filePath, input.command, input.pattern, input.query].find((v) => typeof v === "string" && v !== "");
      return { phase: "harness", turn: turns, detail: `${String(part.tool ?? "tool")}${typeof target === "string" ? ` ${clipDetail(target, 100)}` : ""}` };
    }
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      return { phase: "harness", turn: turns, detail: clipDetail(part.text, 120) };
    }
    return null;
  });
}

/**
 * codex's exec --json: `turn.started` counts a turn; item events name the
 * command being run, the files being changed, or the agent's message
 * (exec_events.rs — file_change items only ever arrive as `item.completed`).
 */
export function codexLiveTracker(): LiveTracker {
  let turns = 0;
  return lineBuffered((event) => {
    if (event.type === "turn.started") {
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    const item = (event.item ?? {}) as Record<string, unknown>;
    if ((event.type === "item.started" || event.type === "item.completed") && item.type === "command_execution") {
      return typeof item.command === "string"
        ? { phase: "harness", turn: turns, detail: `exec ${clipDetail(item.command, 100)}` }
        : { phase: "harness", turn: turns, detail: "exec" };
    }
    if (event.type === "item.completed" && item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
      const paths = changes.map((c) => (typeof c.path === "string" ? c.path : "")).filter((p) => p !== "");
      return paths.length > 0 ? { phase: "harness", turn: turns, detail: `edit ${clipDetail(paths.join(", "), 100)}` } : null;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
      return { phase: "harness", turn: turns, detail: clipDetail(item.text, 120) };
    }
    return null;
  });
}

/**
 * The `--config` flags that point codex at teploy-gateway: a `teploy-gateway`
 * model provider whose base_url comes from the (already sourced) AI_GATEWAY_URL
 * and whose key codex reads itself from AI_GATEWAY_KEY (`env_key`), then
 * `model_provider` selecting it. Values are TOML on the far side of `-c
 * key=value` (codex parses the value as TOML with a raw-string fallback —
 * codex-rs/utils/cli/src/config_override.rs), so literals are quoted and the
 * URL rides in single quotes inside a shell double-quoted arg so `$AI_GATEWAY_URL`
 * still expands after harness.env is sourced.
 *
 * codex speaks the Responses wire API only (`wire_api = "chat"` was removed
 * upstream), so the gateway endpoint must be Responses-compatible — see
 * docs/adapters.md "codex".
 */
export function codexGatewayConfigFlags(forwarded: readonly string[]): string {
  if (!forwarded.includes("AI_GATEWAY_URL")) return "";
  return (
    ` --config ${shq('model_providers.teploy-gateway.name="teploy-gateway"')}` +
    ` --config "model_providers.teploy-gateway.base_url='$AI_GATEWAY_URL'"` +
    ` --config ${shq('model_providers.teploy-gateway.env_key="AI_GATEWAY_KEY"')}` +
    ` --config ${shq('model_provider="teploy-gateway"')}`
  );
}

interface CommandSpec {
  binary: string;
  /** The live tracker for this harness's event stream. */
  live: () => LiveTracker;
  /** Build the shell command; `prompt` is the sh-quoted prompt path. */
  command: (opts: { config: ExternalHarnessConfig; maxSteps: number; maxRunCostUSD: number; priced: boolean; forwarded: string[] }) => string;
  parse: (exec: ExecResult, priced: boolean) => { status: HarnessStatus; summary: string; turns: number; usage: HarnessUsage; threadId?: string; fileChanges?: string[]; commands?: number };
  /** Is the usage this harness reports billed per token under the forwarded credentials? */
  priced: (forwarded: string[]) => boolean;
  /**
   * Refuse a found binary whose resolved version this adapter cannot drive,
   * returning the reason (undefined = run it). The recorded preflight value
   * carries the refusal, so replay takes the same branch.
   */
  refuseVersion?: (version: string, expected?: string) => string | undefined;
}

const SPECS: Record<string, CommandSpec> = {
  "claude-code": {
    binary: "claude",
    live: claudeLiveTracker,
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
    live: opencodeLiveTracker,
    // S13 major-version guard: 2.0.0 removed --pure and --dir (this command
    // fails flag-parse) and renamed tool -> tool_use in the stream the live
    // tracker reads. An unparseable version stays a recorded `pinned: false`,
    // never a refusal — same behaviour as before the guard.
    refuseVersion: (version, expected) => {
      const major = versionMajor(version);
      return major !== undefined && major >= 2 ? opencodeV2Refusal(version, expected) : undefined;
    },
  },
  codex: {
    binary: "codex",
    live: codexLiveTracker,
    // `codex exec --json` is the one-shot headless mode: JSONL on stdout, one
    // exec, parse at exit — the same shape as claude's `-p --output-format
    // stream-json`. NOT `codex app-server`: that is a long-lived JSON-RPC
    // stdio server (initialize → thread/start → turn/start → notifications),
    // which needs interactive stdin the sandbox exec API does not have —
    // output is request/response and execStream is read-only. docs/adapters.md
    // "codex" carries the full argument.
    //
    // --dangerously-bypass-approvals-and-sandbox = approval_policy never +
    // sandbox_mode danger-full-access in one flag, and its own help text says
    // it is "intended solely for running in environments that are externally
    // sandboxed" — which a Ship run is: the sandbox container IS the isolation
    // boundary (default-deny egress, disposable FS), and codex's nested
    // Landlock sandbox would be a second sandbox inside it, one that also
    // denies network egress under workspace-write.
    command: ({ config, forwarded }) =>
      `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` +
      (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
      codexGatewayConfigFlags(forwarded) +
      ` - < ${shq(PROMPT_PATH)}`,
    parse: (exec) => {
      const parsed = parseCodexExecStream(exec.stdout);
      if (!parsed.sawCompletion && exec.exitCode !== 0) {
        return { ...parsed, status: "error", summary: `codex exited ${exec.exitCode} before completing a turn: ${tail(exec.stderr, 600).trim() || "(no stderr)"}` };
      }
      return parsed;
    },
    // codex exec reports tokens and never dollars — there is no total_cost_usd
    // equivalent in the exec event stream — so every codex run is counted in
    // the unpriced ledger with its tokens recorded (P5-3). Under
    // CODEX_ACCESS_TOKEN that is exactly right (a subscription quota); under
    // an API key the bill exists but Ship has no figure for it, and $0 would
    // be the dishonest answer.
    priced: () => false,
  },
};

export function externalAdapter(id: "claude-code" | "opencode" | "codex", options: ExternalHarnessOptions = {}): HarnessAdapter {
  const spec = SPECS[id]!;
  const env = options.env ?? process.env;
  return {
    id,
    version: HARNESS_VERSIONS[id]!,
    isolated: true,
    async run(task, ws, budget, onEvent): Promise<HarnessResult> {
      const p = ws.stepPrefix;
      onEvent({ kind: "started", harness: id });
      const pre = await ws.ctx.step(`${p}harness-preflight`, () => preflight(ws.executor, id, spec.binary, spec.refuseVersion));
      if (!pre.found) {
        const result = errorResult(`${pre.detail ?? `${spec.binary} was not found`} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      // A version this adapter refuses (opencode >= 2) is the same shape as a
      // missing binary: the reason is on the recorded preflight step, the run
      // stops here, and the binary never executes.
      if (pre.refused !== undefined) {
        const result = errorResult(`${pre.refused} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      const record = await ws.ctx.step(`${p}harness-run`, async (): Promise<HarnessRunRecord> => {
        const config = externalHarnessConfig(id, env);
        const forwardedEnv = envFile(config.forward, env);
        const priced = spec.priced(forwardedEnv.names);
        try {
          // Admission covers the UI/queue; direct CLI workflow execution also
          // must not silently skip an operator's requested plan gate. Keep
          // this inside the recorded step so prior completed runs replay.
          if (task.input.plan === true && task.input.mode !== "scan") throw new Error(`${refusalFor(id, "plan-review") ?? PLAN_REVIEW_REFUSAL} No external agent was started.`);
          await ws.executor.putFile(PROMPT_PATH, externalPrompt(task.prompt, task.input.mode));
          await ws.executor.putFile(ENV_PATH, forwardedEnv.text);
          const command =
            `set -a; . ${shq(ENV_PATH)}; set +a; rm -f ${shq(ENV_PATH)}; ` +
            spec.command({ config, maxSteps: budget.maxSteps, maxRunCostUSD: budget.maxRunCostUSD, priced, forwarded: forwardedEnv.names });
          const execOptions = { timeoutMs: config.timeoutMs, maxOutputBytes: 16 * 1_048_576 };
          // Streamed when the executor can (the sandbox daemon), so the run
          // page shows the harness's turns and tool calls as they happen
          // instead of a thirty-minute blank. Same result either way; the
          // recorded step is the exit, never the chunks.
          ws.live?.({ phase: "harness", turn: 0, detail: `${spec.binary} starting` });
          const tracker = spec.live();
          const exec =
            ws.execStream !== undefined
              ? await ws.execStream(command, execOptions, (stream, chunk) => {
                  if (stream !== "stdout") return;
                  const update = tracker.feed(chunk);
                  if (update !== null) ws.live?.(update);
                })
              : await ws.executor.exec(command, execOptions);
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
            ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
            ...(parsed.fileChanges !== undefined ? { fileChanges: parsed.fileChanges } : {}),
            ...(parsed.commands !== undefined ? { commands: parsed.commands } : {}),
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
  return [externalAdapter("claude-code", options), externalAdapter("opencode", options), externalAdapter("codex", options)];
}
