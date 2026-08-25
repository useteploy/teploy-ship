import type { WorkflowEvent } from "@neutron-build/workflow";

export interface TimelineItem {
  kind: "task" | "turn" | "approval" | "decision" | "done" | "error" | "note";
  title: string;
  body: string;
  at: string;
  /** Turn items: what the agent actually ran, for the collapsed one-line row. */
  summary?: string;
  /** Turn items: the model's reasoning, revealed on expand. */
  thought?: string;
  /** Turn items: exit code of the executed action, when one ran. */
  exitCode?: number;
  /** Turn items: think -> result wall time. */
  durationMs?: number;
}

/** A turn under construction, before its think/exec halves are joined. */
interface TurnAcc {
  index: number;
  at: string;
  thought: string;
  summary: string;
  output: string;
  exitCode?: number;
  endedAt?: string;
}

/**
 * The first fenced block in a think step is the action the agent chose to run.
 * The collapsed row shows its first line, which is the single most useful
 * thing to see when scanning a run — "what did it do next".
 */
function actionOf(text: string): string {
  // The info string is not always a bare language: `create CHANGELOG.md` names
  // its target. Match it loosely — anchoring to [a-z]* meant those fences did
  // not match at all, and the regex then treated a CLOSING fence as an opening
  // one and surfaced the prose after it as the action.
  const fence = /```([^\n]*)\n([\s\S]*?)```/.exec(text);
  if (fence === null) return "";
  const info = (fence[1] ?? "").trim();
  const first = (fence[2] ?? "").trim().split("\n")[0] ?? "";
  // An info string carrying an argument already says what the turn did.
  if (info.includes(" ")) return info;
  if (first === "") return info;
  return info === "" ? first : `${info}: ${first}`;
}

/** Step names that are per-turn bookkeeping rather than something to read. */
function turnMatch(name: string): { index: number; part: string } | null {
  const m = /^turn-(\d+)-(think|exec|steer|search)$/.exec(name);
  if (m === null) return null;
  return { index: Number(m[1]), part: m[2] ?? "" };
}

function execBody(result: unknown): { body: string; exitCode?: number } {
  const r = result as { exitCode?: number; stdout?: string; stderr?: string } | string | undefined;
  if (typeof r === "object" && r !== null && "exitCode" in r) {
    const parts: string[] = [];
    if (typeof r.stdout === "string" && r.stdout !== "") parts.push(r.stdout);
    if (typeof r.stderr === "string" && r.stderr !== "") parts.push(`stderr:\n${r.stderr}`);
    return { body: parts.join("\n"), ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}) };
  }
  return { body: String(r ?? "") };
}

/**
 * Render any recorded result as a string. JSON.stringify returns undefined for
 * undefined and throws on a BigInt or a cycle, and the renderer measures
 * body.length — so one malformed event must not be able to 500 a whole run
 * page. Never throws, always a string.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** True for a step whose recorded result carries no information worth a row. */
function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "string") return result.trim() === "";
  return false;
}

function flushTurn(items: TimelineItem[], turn: TurnAcc | null): void {
  if (turn === null) return;
  const started = new Date(turn.at).getTime();
  const ended = turn.endedAt !== undefined ? new Date(turn.endedAt).getTime() : NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : undefined;
  items.push({
    kind: "turn",
    title: `turn ${turn.index}`,
    body: turn.output,
    at: turn.at,
    summary: turn.summary,
    thought: turn.thought,
    ...(turn.exitCode !== undefined ? { exitCode: turn.exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

/**
 * Project the workflow event log into what an operator wants to read.
 *
 * A turn is one row, not three-plus. The log records each turn as separate
 * think / exec / steer / search steps, and rendering them one-per-block turned
 * a short run into thousands of pixels of scrolling — with every empty steer
 * poll drawn as its own "[]" block. Here they collapse into a single item
 * carrying the chosen action as its heading, the reasoning and the output
 * behind it, so a run reads as a list of what the agent did.
 */
export function toTimeline(events: WorkflowEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let turn: TurnAcc | null = null;

  for (const event of events) {
    const at = event.at;
    // Anything that is not part of the open turn closes it first, so ordering
    // is preserved even when a run parks mid-turn.
    const name = event.type === "step-completed" ? (event.name ?? "") : "";
    const part = name === "" ? null : turnMatch(name);
    if (part === null && turn !== null) {
      flushTurn(items, turn);
      turn = null;
    }

    switch (event.type) {
      case "run-started": {
        const input = (event.data as { input?: { task?: string } } | undefined)?.input;
        items.push({ kind: "task", title: "task", body: input?.task ?? "", at });
        break;
      }
      case "step-completed": {
        const result = (event.data as { result?: unknown } | undefined)?.result;
        if (part !== null) {
          if (turn !== null && turn.index !== part.index) {
            flushTurn(items, turn);
            turn = null;
          }
          turn ??= { index: part.index, at, thought: "", summary: "", output: "" };
          if (part.part === "think") {
            const text =
              typeof result === "object" && result !== null && "text" in result
                ? String((result as { text: unknown }).text)
                : String(result ?? "");
            turn.thought = text;
            turn.summary = actionOf(text);
          } else if (part.part === "exec") {
            const { body, exitCode } = execBody(result);
            turn.output = body;
            if (exitCode !== undefined) turn.exitCode = exitCode;
            turn.endedAt = at;
          } else if (!isEmptyResult(result)) {
            // A steer note that actually landed, or search hits — worth showing.
            const extra = asText(result);
            turn.output = turn.output === "" ? extra : `${turn.output}\n\n${part.part}:\n${extra}`;
            turn.endedAt = at;
          }
          break;
        }
        if (name === "sandbox" || /-snapshot$/.test(name) || /-restore$/.test(name)) {
          items.push({ kind: "note", title: name, body: asText(result ?? ""), at });
        } else if (!isEmptyResult(result)) {
          items.push({ kind: "note", title: name, body: asText(result), at });
        }
        break;
      }
      case "step-failed": {
        const data = event.data as { error?: { message?: string }; attempt?: number } | undefined;
        items.push({
          kind: "error",
          title: `${event.name ?? "step"} failed (attempt ${data?.attempt ?? "?"})`,
          body: data?.error?.message ?? "",
          at,
        });
        break;
      }
      case "event-waiting":
        items.push({ kind: "approval", title: "waiting for approval", body: event.name ?? "", at });
        break;
      case "event-received": {
        const payload = (event.data as { payload?: { approved?: boolean; reason?: string } } | undefined)?.payload;
        items.push({
          kind: "decision",
          title: payload?.approved === true ? "approved" : "denied",
          body: payload?.reason ?? "",
          at,
        });
        break;
      }
      case "run-completed": {
        const output = (event.data as
          | { output?: { summary?: string; pr?: string; usage?: Usage } }
          | undefined)?.output;
        const extras: string[] = [];
        if (output?.pr !== undefined && output.pr !== null) extras.push(`PR: ${output.pr}`);
        const usage = output?.usage;
        if (usage !== undefined) {
          const cache = usage.cacheReadTokens !== undefined ? `, cache-read ${usage.cacheReadTokens}` : "";
          extras.push(`tokens: ${usage.inputTokens} in / ${usage.outputTokens} out${cache}`);
        }
        const body = [output?.summary ?? "", extras.join(" · ")].filter((s) => s !== "").join("\n\n");
        items.push({ kind: "done", title: "completed", body, at });
        break;
      }
      case "run-cancelled": {
        const reason = (event.data as { reason?: string | null } | undefined)?.reason;
        items.push({ kind: "error", title: "cancelled", body: reason ?? "", at });
        break;
      }
      case "run-failed": {
        const error = (event.data as { error?: { detail?: string; title?: string } } | undefined)?.error;
        items.push({ kind: "error", title: "run failed", body: error?.detail ?? error?.title ?? "", at });
        break;
      }
      default:
        break;
    }
  }
  flushTurn(items, turn);
  return items;
}

/** One row in the run page's "Recorded steps" section. */
export interface RecordedStep {
  /** Step name exactly as recorded ("turn-3-exec", "repo-push", "tests"). */
  name: string;
  at: string;
  /** Minimum honest one-line summary derived from the recorded result. */
  summary: string;
  /** True when the result itself says the step did not succeed. */
  failed: boolean;
  /** Present on per-turn steps: which turn the step belongs to. */
  turn?: number;
}

/**
 * Any turn-scoped step, broader than toTimeline's turnMatch on purpose: the
 * timeline collapses think/exec/steer/search into one narrative row, but the
 * recorded-steps list is an INDEX of the log — turn-2-critic and
 * turn-2-fingerprint belong to turn 2 even though the timeline never groups
 * them.
 */
const TURN_STEP = /^turn-(\d+)-[a-z-]+$/;

/** One line, bounded: a summary that wraps or scrolls stops summarising. */
function oneLine(text: string, max = 120): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The minimum honest one-line summary of a recorded step result.
 *
 * NEVER the raw payload: a step's result can be kilobytes of stdout, and this
 * feeds a compact index whose job is "what happened here" at a glance. The
 * shapes recognised are the ones durable.ts actually records — exitCode for
 * exec-shaped results, the outcome kind for evidence steps (tests,
 * preview-deploy, telemetry-check, repo-push), a PR number for repo-pr — and
 * anything unrecognised degrades to a bounded first line or a capped
 * compact-JSON rendering, never a dump.
 */
function stepSummary(result: unknown): { summary: string; failed: boolean } {
  if (result === null || result === undefined) return { summary: "", failed: false };
  if (typeof result === "string") return { summary: oneLine(result), failed: false };
  if (typeof result === "number" || typeof result === "boolean") return { summary: String(result), failed: false };
  if (Array.isArray(result)) return { summary: `${result.length}`, failed: false };
  if (typeof result !== "object") return { summary: oneLine(String(result)), failed: false };
  const r = result as {
    exitCode?: unknown;
    kind?: unknown;
    number?: unknown;
    text?: unknown;
  };
  // Evidence steps: the outcome kind. "failed" carries the suite's exit code
  // when there is one; disabled/skipped/unavailable/insufficient are honest
  // outcomes, not failures. Checked BEFORE exitCode because the failed suite
  // result carries both, and "failed (exit 2)" says more than "exit 2".
  if (typeof r.kind === "string") {
    const failed = r.kind === "failed" || r.kind === "errored" || r.kind === "refused";
    const exit = failed && typeof r.exitCode === "number" ? ` (exit ${r.exitCode})` : "";
    return { summary: `${r.kind}${exit}`, failed };
  }
  // Exec-shaped results (turn-N-exec): the exit code IS the summary.
  if (typeof r.exitCode === "number") return { summary: `exit ${r.exitCode}`, failed: r.exitCode !== 0 };
  // repo-pr: {url, number} — the PR number is the summary, not the URL.
  if (typeof r.number === "number") return { summary: `PR #${r.number}`, failed: false };
  // Think-shaped results ({text, usage}): the first line of the reasoning.
  if (typeof r.text === "string") return { summary: oneLine(r.text), failed: false };
  // Unknown object: compact JSON, capped — a bounded rendering, not a dump.
  try {
    return { summary: oneLine(JSON.stringify(result)), failed: false };
  } catch {
    return { summary: "", failed: false };
  }
}

/**
 * Every step-completed event as an ordered row — the inspection view the
 * narrative timeline deliberately is not. toTimeline tells you WHAT THE AGENT
 * DID; this tells you WHAT THE LOG RECORDS, one row per step, which is the
 * honest basis for any future replay: you cannot replay what you cannot see.
 */
export function recordedSteps(events: WorkflowEvent[]): RecordedStep[] {
  const steps: RecordedStep[] = [];
  for (const event of events) {
    if (event.type !== "step-completed") continue;
    const name = event.name ?? "";
    if (name === "") continue;
    const result = (event.data as { result?: unknown } | undefined)?.result;
    const { summary, failed } = stepSummary(result);
    const turn = TURN_STEP.exec(name);
    steps.push({
      name,
      at: event.at,
      summary,
      failed,
      ...(turn !== null ? { turn: Number(turn[1]) } : {}),
    });
  }
  return steps;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** False = consumed a quota Ship cannot price (P5-3); counted, never a dollar figure. */
  priced?: boolean;
  /** The harness's own dollar figure, when it priced its usage itself. */
  costUSD?: number;
}

export interface RunOutcome {
  repo?: string;
  pr?: string;
  summary?: string;
  usage?: Usage;
}

/** Pull the at-a-glance outcome (repo, PR, cost inputs, summary) out of the log. */
export function runOutcome(events: WorkflowEvent[]): RunOutcome {
  const out: RunOutcome = {};
  for (const event of events) {
    if (event.type === "run-started") {
      const input = (event.data as { input?: { repo?: string } } | undefined)?.input;
      if (input?.repo !== undefined) out.repo = input.repo;
    } else if (event.type === "run-completed") {
      const o = (event.data as { output?: { summary?: string; pr?: string; usage?: Usage } } | undefined)?.output;
      if (o?.pr !== undefined && o.pr !== null) out.pr = o.pr;
      if (o?.summary !== undefined) out.summary = o.summary;
      if (o?.usage !== undefined) out.usage = o.usage;
    }
  }
  return out;
}

export function itemClass(kind: TimelineItem["kind"]): string {
  switch (kind) {
    case "turn":
      return "turn";
    case "approval":
    case "decision":
      return "approval";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "observation";
  }
}

/** "3m" / "1h 04m" — a run's timeline reads better in elapsed time than in ISO. */
export function since(from: string, at: string): string {
  const a = new Date(from).getTime();
  const b = new Date(at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Compact duration for a single turn. */
export function took(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
