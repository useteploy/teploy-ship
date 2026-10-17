import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { HARNESS_ALIAS_VERSIONS, HARNESS_PACKAGES, HARNESS_VERSIONS } from "./harness.js";
import { PLAN_REVIEW_REFUSAL, refusalFor } from "./harness-capabilities.js";
import type { SteerStore } from "./steer.js";
import { clipDetail } from "./live.js";
import type { LiveUpdate } from "./live.js";
import type { HarnessAdapter, HarnessResult, HarnessStatus, HarnessUsage } from "./harness.js";

/**
 * External harness adapters (P5-2): Ship drives a vendor coding agent that is
 * installed in the sandbox image, in its headless mode, over the same executor
 * the native loop uses. Contracts and the documentation they come from are in
 * docs/adapters.md.
 *
 * Each attempt is TWO recorded steps — `harness-preflight` (is the binary
 * there, which version, and is that a version this adapter can drive) and
 * `harness-run` (the one exec, its parsed result) — plus, when the run asked
 * for steering and the binary's line supports it, a `harness-steer-N` /
 * `harness-resume-N` pair per delivered batch of operator notes (D6/D7): the
 * note is delivered by resuming the vendor session the run recorded, so the
 * operator's redirect lands in the agent's context rather than in a store
 * nobody reads. Those steps are input-gated on `steer` (step-fingerprint.ts),
 * so a run enqueued without it keeps the exact two-step sequence every earlier
 * log carries.
 *
 * The run step is a single exec because the sandbox API is request/response —
 * output arrives when the process ends — so the "coarse progress" an external
 * harness reports is started / completed plus the turn count parsed from its
 * event stream, not a live feed. A "turn boundary" for steering is therefore
 * a process exit: notes queued while a vendor process ran are delivered by
 * the next process, resuming the recorded session (opencode `--session`,
 * claude `--resume`). This is the T3 Code pattern (session-id discipline,
 * resume-as-steering) cut to Ship's one-shot exec model — the reference keeps
 * a live server/client pair per provider (packages/provider-opencode/src/server/v2),
 * which needs a bidirectional channel into the sandbox that Ship's executor
 * deliberately does not offer; the session store on the container's disk is
 * what makes one-shot resume equivalent for this purpose.
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
const STEER_PATH = ".teploy-agent/harness-steer.md";

/**
 * How many batches of steer notes one attempt will deliver: a steered attempt
 * runs at most `1 + STEER_ROUNDS_MAX` vendor processes (the main run plus this
 * many resumes). Each batch is one vendor process (up to SHIP_HARNESS_TIMEOUT_MS), so the bound is spend, not
 * correctness: the loop also stops on its own when no notes are pending or a
 * resume timed out. Recorded steps make the count replay-stable.
 */
export const STEER_ROUNDS_MAX = 3;

/**
 * The opencode v2 session id for one attempt: caller-chosen and deterministic,
 * because the server validates only the `ses` prefix but the id must be the
 * same string in the first exec and every resume — and a replay must rebuild
 * the identical command (evals/receipts/2026-10-14-opencode-v2-events.txt §3:
 * arbitrary ids are rejected despite the help text, `ses_`-prefixed ids
 * persist context across processes). T3's adapter mints ids the same way,
 * scoped per thread (packages/provider-opencode/src/server/v2/adapter.ts).
 */
export function opencodeSessionId(runId: string, prefix: string): string {
  const scope = `${runId}${prefix === "" ? "" : `:${prefix}`}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `ses_ship_${scope}`;
}

export interface ExternalHarnessOptions {
  /** The worker's environment — read for credentials to forward and for tuning. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where steer notes are drained from between vendor processes. Absent store
   * + steer-enabled input drains empty — the same degrade-not-break rule the
   * native loop follows (durable.ts), so the step sequence stays a function
   * of the input alone.
   */
  steer?: Pick<SteerStore, "drain">;
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
 * Why an opencode PAST the 2.x line is refused rather than run. The adapter
 * drives two measured contracts: 1.x (`--pure -- --dir`, `tool` events) and
 * 2.x (no `--pure`/`--dir`, `tool_use`, `--session`, terminal `step_finish`
 * absent) — both in evals/receipts/2026-10-14-opencode-v2-events.txt. A 3.x
 * is none of those: driving it would be guesswork about flags and events, and
 * the same receipt's history (v2 silently under-counted turns and hid tool
 * activity from the live feed under the v1 parser) says the failure mode of
 * guessing is silence, not noise.
 */
export function opencodeFutureLineRefusal(version: string, expected?: string): string {
  return (
    `opencode reports ${version}, past the 2.x line ship's opencode adapter has measured, so it refuses to run it: a future line may have removed flags or renamed events again the way 2.0 did. ` +
    (expected !== undefined
      ? `images/versions.json pins ${HARNESS_PACKAGES.opencode!.npm}@${expected} — run an image that bakes the pin (images/build.sh --harness opencode). `
      : "") +
    `The measured 1.x and 2.x contracts are in evals/receipts/2026-10-14-opencode-v2-events.txt; extending the adapter to a new line is tracked work, not a flag-patch.`
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
  /**
   * The vendor session this exec ran (D6/D7): opencode's `ses_…` id, claude's
   * `session_id`. Recorded on the step, so it is durable in the log and a
   * replay reads it back rather than re-deriving it — and steering resumes
   * exactly the session the binary reported, not the one Ship asked for.
   */
  sessionId?: string;
}

/**
 * Sum usage across the execs of one steered attempt. `priced` is conjunctive:
 * a run is priced only if every exec's usage could be priced, and a mixed run
 * keeps its token counts but never reports dollars it cannot account for.
 */
export function addUsage(a: HarnessUsage, b: HarnessUsage): HarnessUsage {
  const priced = a.priced !== false && b.priced !== false;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    priced,
    ...(priced ? { costUSD: (a.costUSD ?? 0) + (b.costUSD ?? 0) } : {}),
  };
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
): { status: HarnessStatus; summary: string; turns: number; usage: HarnessUsage; sawResult: boolean; sessionId?: string } {
  let result: Record<string, unknown> | undefined;
  let assistantTurns = 0;
  // The session every event names; `--resume` steering (D7) needs it. Taken
  // preferentially from the terminal result, which is the one claude vends as
  // authoritative, with the first event that carries one as the fallback (a
  // crashed run prints no result but has printed its init by then).
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (sessionId === undefined && typeof event.session_id === "string" && event.session_id !== "") sessionId = event.session_id;
    if (event.type === "assistant") assistantTurns += 1;
    if (event.type === "result") result = event;
  }
  if (result !== undefined && typeof result.session_id === "string" && result.session_id !== "") sessionId = result.session_id;
  if (result === undefined) {
    return {
      status: "error",
      summary: "claude produced no result event",
      turns: assistantTurns,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
      sawResult: false,
      ...(sessionId !== undefined ? { sessionId } : {}),
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
  const withSession = <T extends object>(value: T): T => ({ ...value, ...(sessionId !== undefined ? { sessionId } : {}) });
  if (subtype === "success" && result.is_error !== true) {
    return withSession({ status: "finished", summary: text === "" ? "claude finished without a summary" : text.slice(0, 4000), turns, usage, sawResult: true });
  }
  if (subtype === "error_max_turns") {
    return withSession({ status: "max-steps", summary: `claude reached its ${turns}-turn limit.`, turns, usage, sawResult: true });
  }
  if (subtype === "error_max_budget_usd") {
    return withSession({ status: "budget-exhausted", summary: "claude stopped at its per-run budget.", turns, usage, sawResult: true });
  }
  const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).map(String).join("; ") : "";
  return withSession({
    status: "error",
    summary: `claude ended with ${subtype || "an error"}${errors !== "" ? `: ${errors}` : text !== "" ? `: ${text.slice(0, 800)}` : ""}`,
    turns,
    usage,
    sawResult: true,
  });
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
 * Parse opencode **v2**'s `--format json` event stream (D6). The contract,
 * measured against real 2.0.26 streams on 2026-10-14
 * (evals/receipts/2026-10-14-opencode-v2-events.txt §2/§4):
 *
 *   step_start — carries `part.messageID`; a NEW messageID is a new model
 *                step, and this is where turns are counted, because…
 *   step_finish — …is emitted only after tool-calling steps. The terminal
 *                text step emits none, so a pure reply reports no usage and
 *                counting here (as the 1.x parser does) under-counts. The
 *                payload shape on tool steps is 1.x-compatible
 *                (tokens.{input,output,reasoning}, tokens.cache.{read,write},
 *                cost), so usage is summed wherever it does appear.
 *   text — the final text lands in the LAST `text` part, as on 1.x.
 *   tool_use — 1.x's `tool` event renamed (part shape otherwise compatible).
 *   error — same role as 1.x, richer fields.
 *
 * Every event names the session (`sessionID`, `ses`-prefixed) — recorded so
 * steering can resume exactly the session the binary actually ran, not the
 * one Ship asked for.
 */
export function parseOpencode2Stream(stdout: string): { summary: string; turns: number; usage: HarnessUsage; error?: string; sessionId?: string } {
  let turns = 0;
  let stepFinishes = 0;
  let lastText = "";
  let cost = 0;
  let error: string | undefined;
  let sessionId: string | undefined;
  const messages = new Set<string>();
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
    if (sessionId === undefined && typeof event.sessionID === "string" && event.sessionID.startsWith("ses")) sessionId = event.sessionID;
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_start" && typeof part.messageID === "string" && !messages.has(part.messageID)) messages.add(part.messageID);
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") lastText = part.text.trim();
    if (event.type === "step_finish") {
      stepFinishes += 1;
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
  // Turn counting: messageIDs when the stream carries them (measured v2), the
  // 1.x step_finish count as the fallback for a 2.x patch level that stops
  // naming messageIDs — zero turns on a pure reply was one of the measured
  // degradations this parser exists to fix.
  turns = messages.size > 0 ? messages.size : stepFinishes;
  usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  // Same cost-honesty rule as the 1.x parser: opencode reports cost 0 for
  // models it cannot price and for subscription providers alike, and tokens
  // with no dollars is exactly the unpriced shape (P5-3).
  //
  // v2 adds a second way to be unpriced: step_finish is emitted only after
  // tool-calling steps, so the terminal text step carries no usage at all
  // (receipt §4). When the stream names more model steps than it finished,
  // the tokens AND the dollars are a lower bound, and summing them as if
  // complete would report a confident, wrong figure — so the run is
  // unpriced (tokens kept, no dollars), never priced-but-short.
  const incomplete = messages.size > 0 && stepFinishes < messages.size;
  if (cost > 0 && !incomplete) {
    usage.priced = true;
    usage.costUSD = cost;
  } else {
    usage.priced = false;
  }
  return { summary: lastText, turns, usage, ...(error !== undefined ? { error } : {}), ...(sessionId !== undefined ? { sessionId } : {}) };
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

/**
 * opencode's `--format json` live feed. 1.x: `tool` parts name the tool,
 * `step_finish` counts a turn. 2.x (D6, measured in
 * evals/receipts/2026-10-14-opencode-v2-events.txt §4/§5): the tool event is
 * renamed `tool_use` — the one rename that made the v1 tracker blind to all
 * tool activity — and the terminal text step emits no `step_finish`, so the
 * turn ticks at each NEW `step_start` messageID instead. Streams that carry
 * no messageIDs (1.x, and any 2.x that drops them) keep the step_finish
 * tick, which preserves 1.x behaviour exactly.
 */
export function opencodeLiveTracker(): LiveTracker {
  let turns = 0;
  let message: string | null = null;
  return lineBuffered((event) => {
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_start" && typeof part.messageID === "string") {
      if (message === part.messageID) return null;
      message = part.messageID;
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    if (event.type === "step_finish") {
      if (message !== null) return null; // v2: this step already ticked at its step_start
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    if (event.type === "tool" || event.type === "tool_use") {
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

/** What parsing one vendor exec produced. `sessionId` is the durable handle steering resumes. */
interface ParsedRun {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  sessionId?: string;
  threadId?: string;
  fileChanges?: string[];
  commands?: number;
}

interface ExecOpts {
  config: ExternalHarnessConfig;
  maxSteps: number;
  maxRunCostUSD: number;
  priced: boolean;
  forwarded: string[];
}

/**
 * One invocation contract for a vendor line. opencode has two (1.x and 2.x
 * differ in flags AND events); claude has one. A line that can be resumed
 * with a steering note carries `steerResume` (D6/D7).
 */
interface LineSpec {
  /** Build the shell command; the prompt is read from a file the adapter wrote. */
  command: (opts: ExecOpts & { session?: string }) => string;
  parse: (exec: ExecResult, priced: boolean) => ParsedRun;
  /**
   * The session id Ship passes UP FRONT, when the line takes a caller-chosen
   * one (opencode `--session`). Absent means the session is whatever the
   * binary assigns and `parse` must fish out of the stream (claude
   * `session_id`).
   */
  sessionFor?: (ids: { runId: string; prefix: string }) => string;
  /** Deliver one batch of steer notes by resuming the recorded session. */
  steerResume?: (opts: ExecOpts & { session: string; notePath: string }) => string;
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
  /** Pick the invocation for the binary's resolved major line (an unparseable version = the 1 line, as before D6). */
  line: (major: number | undefined) => LineSpec;
  /** Is the usage this harness reports billed per token under the forwarded credentials? */
  priced: (forwarded: string[]) => boolean;
  /**
   * Refuse a found binary whose resolved version this adapter cannot drive,
   * returning the reason (undefined = run it). The recorded preflight value
   * carries the refusal, so replay takes the same branch.
   */
  refuseVersion?: (version: string, expected?: string) => string | undefined;
}

const claudeLine: LineSpec = {
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
  // D7: `--resume <id>` makes the next `-p` process a continuation of the
  // recorded session — the same session-resume steering T3's Claude adapter
  // does through the Agent SDK (apps/server/src/orchestration-v2/Adapters/
  // ClaudeAdapterV2.ts: resume + a user message), on the CLI Ship drives.
  steerResume: ({ config, maxSteps, maxRunCostUSD, priced, session, notePath }) =>
    `IS_SANDBOX=1 claude -p "$(cat ${shq(notePath)})" --output-format stream-json --verbose ` +
    `--permission-mode bypassPermissions --max-turns ${maxSteps} --resume ${shq(session)}` +
    (config.claudeBare ? " --bare" : "") +
    (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
    (priced && maxRunCostUSD > 0 ? ` --max-budget-usd ${maxRunCostUSD.toFixed(2)}` : ""),
};

function opencodeParse(using: (stdout: string) => ReturnType<typeof parseOpencodeStream> | ReturnType<typeof parseOpencode2Stream>) {
  return (exec: ExecResult): ParsedRun => {
    const parsed = using(exec.stdout);
    const sessionId = "sessionId" in parsed && typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    if (parsed.error !== undefined || exec.exitCode !== 0) {
      return {
        status: "error",
        summary: `opencode ${parsed.error !== undefined ? `reported: ${parsed.error}` : `exited ${exec.exitCode}: ${tail(exec.stderr, 600).trim() || "(no stderr)"}`}`,
        turns: parsed.turns,
        usage: parsed.usage,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    }
    return {
      status: "finished",
      summary: parsed.summary === "" ? "opencode finished without a summary" : parsed.summary.slice(0, 4000),
      turns: parsed.turns,
      usage: parsed.usage,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  };
}

/** opencode 1.x: `--pure`/`--dir` invocation, `tool` events, `step_finish` turns. Kept for the images that still bake the 1.x pin and for the runs they recorded (D6). */
const opencodeV1Line: LineSpec = {
  command: ({ config }) =>
    `opencode run --format json --auto --pure --dir . ` +
    (config.model !== undefined ? `--model ${shq(config.model)} ` : "") +
    `"$(cat ${shq(PROMPT_PATH)})"`,
  parse: opencodeParse(parseOpencodeStream),
};

/** opencode 2.x (D6): flags and events per the measured 2.0.26 contract. */
const opencodeV2Line: LineSpec = {
  // --pure and --dir are GONE (the v1 invocation fails flag-parse here).
  // There is no --pure replacement: plugin policy moved to config. The
  // sandbox remains the isolation boundary — default-deny egress, ephemeral
  // container — and the 2.x background service `run` talks to lives inside
  // that container and dies with it. --session is caller-chosen so the id is
  // a function of the run, not of stream parsing (receipt §3).
  command: ({ config, session }) =>
    `opencode run --format json --auto` +
    (session !== undefined ? ` --session ${shq(session)}` : "") +
    (config.model !== undefined ? ` --model ${shq(config.model)} ` : " ") +
    `"$(cat ${shq(PROMPT_PATH)})"`,
  parse: opencodeParse(parseOpencode2Stream),
  sessionFor: ({ runId, prefix }) => opencodeSessionId(runId, prefix),
  steerResume: ({ config, session, notePath }) =>
    `opencode run --format json --auto --session ${shq(session)} ` +
    (config.model !== undefined ? `--model ${shq(config.model)} ` : "") +
    `"$(cat ${shq(notePath)})"`,
};

const codexLine: LineSpec = {
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
};

const SPECS: Record<string, CommandSpec> = {
  "claude-code": {
    binary: "claude",
    live: claudeLiveTracker,
    line: () => claudeLine,
    // An API key bills per token; an OAuth token draws on a subscription. A
    // custom auth token / base URL is a proxy whose billing Ship cannot see.
    priced: (forwarded) => forwarded.includes("ANTHROPIC_API_KEY") && !forwarded.includes("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  opencode: {
    binary: "opencode",
    live: opencodeLiveTracker,
    // Version-aware since D6: 1.x drives the 1.x contract, 2.x the measured
    // v2 one. An unparseable version takes the 1.x line, exactly as before.
    line: (major) => (major !== undefined && major >= 2 ? opencodeV2Line : opencodeV1Line),
    // Decided per run from the cost opencode reports (parseOpencodeStream / parseOpencode2Stream).
    priced: () => true,
    // S13 major-version guard, continued: 1.x and 2.x are measured; anything
    // PAST 2.x is refused rather than guessed at. An unparseable version
    // stays a recorded `pinned: false`, never a refusal.
    refuseVersion: (version, expected) => {
      const major = versionMajor(version);
      return major !== undefined && major >= 3 ? opencodeFutureLineRefusal(version, expected) : undefined;
    },
  },
  codex: {
    binary: "codex",
    live: codexLiveTracker,
    line: () => codexLine,
    // codex exec reports tokens and never dollars — there is no total_cost_usd
    // equivalent in the exec event stream — so every codex run is counted in
    // the unpriced ledger with its tokens recorded (P5-3). Under
    // CODEX_ACCESS_TOKEN that is exactly right (a subscription quota); under
    // an API key the bill exists but Ship has no figure for it, and $0 would
    // be the dishonest answer.
    priced: () => false,
  },
};

export function externalAdapter(
  id: "claude-code" | "opencode" | "codex",
  options: ExternalHarnessOptions = {},
  version: string = HARNESS_VERSIONS[id]!,
): HarnessAdapter {
  const spec = SPECS[id]!;
  const env = options.env ?? process.env;
  // Contract 1 never recorded the steer steps. An alias registered under "1"
  // (HARNESS_ALIAS_VERSIONS) is this same adapter with the loop off, so a
  // log recorded before the steer contract replays step-for-step.
  const steerLoop = version !== "1";
  return {
    id,
    version,
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
      // A version this adapter refuses (an opencode past the measured 2.x
      // line) is the same shape as a missing binary: the reason is on the
      // recorded preflight step, the run stops here, and the binary never
      // executes.
      if (pre.refused !== undefined) {
        const result = errorResult(`${pre.refused} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      // Version-aware since D6: the line the resolved major selects decides
      // the invocation, the parser, and whether the session can be resumed.
      const line = spec.line(versionMajor(pre.version));
      const sessionFor = line.sessionFor?.({ runId: ws.ctx.runId, prefix: p });
      /**
       * One vendor exec: the env-file dance, the command, the parsed record.
       * `startDetail` is the live hint before the stream opens; the resume
       * execs pass none because the steer round already announced itself.
       */
      const execRecord = async (
        commandFor: (opts: ExecOpts & { session?: string }) => string,
        writeFiles: () => Promise<void>,
        startDetail?: string,
      ): Promise<HarnessRunRecord> => {
        const config = externalHarnessConfig(id, env);
        const forwardedEnv = envFile(config.forward, env);
        const priced = spec.priced(forwardedEnv.names);
        try {
          await writeFiles();
          await ws.executor.putFile(ENV_PATH, forwardedEnv.text);
          const command =
            `set -a; . ${shq(ENV_PATH)}; set +a; rm -f ${shq(ENV_PATH)}; ` +
            commandFor({ config, maxSteps: budget.maxSteps, maxRunCostUSD: budget.maxRunCostUSD, priced, forwarded: forwardedEnv.names, ...(sessionFor !== undefined ? { session: sessionFor } : {}) });
          const execOptions = { timeoutMs: config.timeoutMs, maxOutputBytes: 16 * 1_048_576 };
          // Streamed when the executor can (the sandbox daemon), so the run
          // page shows the harness's turns and tool calls as they happen
          // instead of a thirty-minute blank. Same result either way; the
          // recorded step is the exit, never the chunks.
          if (startDetail !== undefined) ws.live?.({ phase: "harness", turn: 0, detail: startDetail });
          const tracker = spec.live();
          const exec =
            ws.execStream !== undefined
              ? await ws.execStream(command, execOptions, (stream, chunk) => {
                  if (stream !== "stdout") return;
                  const update = tracker.feed(chunk);
                  if (update !== null) ws.live?.(update);
                })
              : await ws.executor.exec(command, execOptions);
          const parsed = line.parse(exec, priced);
          const timedOut = exec.timedOut === true;
          const sessionId = parsed.sessionId ?? sessionFor;
          return {
            exitCode: exec.exitCode,
            timedOut,
            status: timedOut ? "error" : parsed.status,
            summary: timedOut ? `${spec.binary} did not finish within ${Math.round(config.timeoutMs / 60_000)} minutes` : parsed.summary,
            turns: parsed.turns,
            usage: parsed.usage,
            forwarded: forwardedEnv.names,
            stderrTail: tail(exec.stderr),
            // The session the binary actually ran (parsed) — or, on a line
            // with a caller-chosen id, the one we told it to. Recorded so
            // steering resumes exactly what the log says ran.
            ...(sessionId !== undefined ? { sessionId } : {}),
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
          await ws.executor.exec(`rm -f ${shq(ENV_PATH)} ${shq(PROMPT_PATH)} ${shq(STEER_PATH)}`, { timeoutMs: 30_000 }).catch(() => {});
        }
      };
      const record = await ws.ctx.step(`${p}harness-run`, async (): Promise<HarnessRunRecord> => {
        const config = externalHarnessConfig(id, env);
        // Admission covers the UI/queue; direct CLI workflow execution also
        // must not silently skip an operator's requested plan gate. Kept as a
        // recorded `error` RESULT, not a thrown step — the contract every
        // earlier log carries, so prior completed runs replay the same value.
        if (task.input.plan === true && task.input.mode !== "scan") {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: `${refusalFor(id, "plan-review") ?? PLAN_REVIEW_REFUSAL} No external agent was started.`,
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
            forwarded: envFile(config.forward, env).names,
            stderrTail: "",
          };
        }
        return await execRecord(
          (opts) => line.command(opts),
          async () => {
            await ws.executor.putFile(PROMPT_PATH, externalPrompt(task.prompt, task.input.mode));
          },
          `${spec.binary} starting`,
        );
      });
      // D6/D7 — steering by session resume, at process boundaries. Gated on
      // the input flag set at enqueue (the same gate the step fingerprint
      // admits these steps by) and on the contract (version "1" never records
      // them), and bounded by STEER_ROUNDS_MAX. The loop's control flow reads
      // recorded facts alone — the drain's turn-claimed notes, the recorded
      // session id, the line the recorded preflight resolved, the recorded
      // timeout flag, recorded spend — so a replay walks exactly the rounds
      // the log carries and never starts a vendor process. A note that cannot
      // be delivered is consumed into a recorded refusal rather than left
      // pending forever, and the final step records whatever the loop never
      // read.
      let status = record.status;
      let summary = record.summary;
      let turns = record.turns;
      let usage = record.usage;
      if (steerLoop && task.input.steer === true) {
        const undelivered: string[] = [];
        let session = record.sessionId;
        // A plan-review refusal / could-not-run record (exitCode -1) started
        // nothing, and a timed-out main run has no session worth resuming:
        // neither steers. The final drain below still runs.
        let steerable = record.exitCode !== -1 && !record.timedOut;
        for (let round = 0; steerable && round < STEER_ROUNDS_MAX; round++) {
          const notes = await ws.ctx.step(`${p}harness-steer-${round}`, async () => {
            // Keyed by attempt prefix + round so the drain is idempotent and
            // no two attempts of one run claim each other's notes (the same
            // stamp-then-read discipline the native loop's turn key gives it).
            if (options.steer === undefined) return [];
            return await options.steer.drain(ws.ctx.runId, `${p}ext-${round}`).catch(() => []);
          });
          if (notes.length === 0) break;
          // What is left of the run's caps. Each resume is a fresh vendor
          // process that would otherwise get the FULL --max-turns and
          // --max-budget-usd again, so a steered run could spend several
          // times its ceiling.
          const remainingTurns = budget.maxSteps - turns;
          // A cost cap bounds a resume only if spend so far is KNOWN. Unknown
          // (unpriced) spend on a harness that is billed per token (opencode
          // on a model it cannot price) would otherwise count as $0 and let
          // every resume run uncapped, so the resume is refused with a reason.
          // A harness that is unpriced by design (a subscription: claude with
          // an OAuth token, codex) has no dollar cap to honour and stays
          // bounded by its turn limit.
          const spendUnknown = budget.maxRunCostUSD > 0 && usage.priced === false && spec.priced(envFile(externalHarnessConfig(id, env).forward, env).names);
          const spent = usage.priced === false ? 0 : (usage.costUSD ?? 0);
          const remainingCost = budget.maxRunCostUSD - spent;
          const resumed = await ws.ctx.step(`${p}harness-resume-${round}`, async (): Promise<HarnessRunRecord | { delivered: false; reason: string }> => {
            if (line.steerResume === undefined || session === undefined) {
              // A note the gate accepted but this run cannot deliver — a 2.x
              // contract on a 1.x binary (no --session, no recorded id).
              // Consumed with the reason on the record, never silently
              // dropped and never left pending after the run ends.
              return {
                delivered: false,
                reason:
                  `steering was accepted for this run, but its ${spec.binary} cannot take it: ` +
                  (line.steerResume === undefined
                    ? `the 1.x line records no session to resume`
                    : `the run recorded no session id to resume`) +
                    `. The note was not delivered; send a follow-up instead.`,
              };
            }
            if (budget.maxSteps > 0 && remainingTurns <= 0) {
              return { delivered: false, reason: `the run has used its ${budget.maxSteps}-turn limit, so there is no budget left to act on the note. The note was not delivered; send a follow-up instead.` };
            }
            if (spendUnknown) {
              return { delivered: false, reason: `the run's spend is unpriced, so its $${budget.maxRunCostUSD.toFixed(2)} cost limit cannot be enforced across a resume. The note was not delivered; send a follow-up instead.` };
            }
            if (budget.maxRunCostUSD > 0 && remainingCost < 0.01) {
              return { delivered: false, reason: `the run has spent its $${budget.maxRunCostUSD.toFixed(2)} cost limit, so there is no budget left to act on the note. The note was not delivered; send a follow-up instead.` };
            }
            const resumeSession = session;
            return await execRecord(
              (opts) =>
                line.steerResume!({
                  ...opts,
                  maxSteps: budget.maxSteps > 0 ? remainingTurns : opts.maxSteps,
                  maxRunCostUSD: budget.maxRunCostUSD > 0 ? remainingCost : opts.maxRunCostUSD,
                  session: resumeSession,
                  notePath: STEER_PATH,
                }),
              async () => {
                await ws.executor.putFile(STEER_PATH, notes.map((note) => `Operator steering — adjust course accordingly: ${note}`).join("\n\n"));
              },
              `steering note → ${spec.binary}`,
            );
          });
          if ("delivered" in resumed) {
            undelivered.push(...notes);
            summary += `\n\nSteering not delivered: ${resumed.reason}`;
            break;
          }
          // exitCode -1 is the "could not be run" record: its zero-usage
          // `priced: false` means "no data", not "unpriced", and must not
          // flip the run's accounting.
          if (resumed.exitCode >= 0) {
            turns += resumed.turns;
            usage = addUsage(usage, resumed.usage);
          }
          if (resumed.status === "finished" && !resumed.timedOut) {
            // The resume completed: its work stands. Its account is appended,
            // never substituted — the main run's summary is part of the result.
            status = "finished";
            summary += `\n\nAfter steering: ${resumed.summary}`;
            if (resumed.sessionId !== undefined) session = resumed.sessionId;
          } else {
            // A failed delivery is a refusal on the record, not a verdict on
            // the work the main run already did: the attempt keeps its
            // status, and the notes it consumed are accounted as undelivered.
            undelivered.push(...notes);
            summary += `\n\nSteering not delivered: the resume ${resumed.timedOut ? "timed out" : `ended with ${resumed.status}`} (${resumed.summary.slice(0, 300)})`;
            break;
          }
        }
        // Notes accepted after the last drain (during the final resume, or
        // while the publish gate ran) would otherwise be accepted, answered
        // "sent" and never read. Drain them into an explicit record.
        const leftovers = await ws.ctx.step(`${p}harness-steer-undelivered`, async () => {
          const late = options.steer === undefined ? [] : await options.steer.drain(ws.ctx.runId, `${p}ext-final`).catch(() => []);
          return [...undelivered, ...late];
        });
        if (leftovers.length > 0) summary += `\n\nSteering notes that were NOT delivered to the agent (${leftovers.length}): ${leftovers.join(" | ").slice(0, 1500)}`;
      }
      for (let turn = 0; turn < turns; turn++) onEvent({ kind: "turn", turn });
      onEvent({ kind: "completed", status });
      return {
        status,
        summary,
        turns,
        usage,
        incomplete: status !== "finished",
      };
    },
  };
}

/** Every external adapter this worker can carry. Presence of the binary is checked per run, as a recorded step. */
export function externalAdapters(options: ExternalHarnessOptions = {}): HarnessAdapter[] {
  const adapters = [externalAdapter("claude-code", options), externalAdapter("opencode", options), externalAdapter("codex", options)];
  for (const [id, versions] of Object.entries(HARNESS_ALIAS_VERSIONS)) {
    for (const version of versions) adapters.push(externalAdapter(id as "claude-code" | "opencode", options, version));
  }
  return adapters;
}
