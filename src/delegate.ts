import { createHash } from "node:crypto";

import { scrub } from "./redact.js";

/**
 * Bounded child work — the S20/S22 coordinator's vertical slice, wired to the
 * T3-reference data plane (docs/PERCEPTION_INPUT_S12_S13_2026-10-14.md §4):
 * a delegation's result is a first-class CONTEXT TRANSFER — an id, a status,
 * and a merge-back into the parent's next turn — not a side effect somebody
 * remembers to read.
 *
 * WHAT THIS MODULE IS. The pure half plus the control BOUNDARY: event names,
 * the ledger record, the cap, the child-task prompt, the transfer projection
 * off a child's own log, and the DelegateControl interface the loop calls.
 * The runtime half (spawn against enqueueRun, outcome against the store)
 * lives in runtime.ts, which owns enqueueRun and cannot be imported here
 * without a cycle (runtime.ts imports this for the registration below).
 *
 * WHAT THIS MODULE IS NOT. A scheduler, a second budget ledger, or a
 * coordinator. Children are ordinary runs: they ride the existing admission,
 * the existing worker, the existing parks, and their spend settles through
 * the source they inherit. The cap is the one thing delegation adds, and it
 * is counted from a durable record, never from memory.
 *
 * THE PARK (see docs/COORDINATOR_DESIGN.md). The parent snapshots, sleeps in
 * a recorded wait step until the child's log holds a terminal event, and
 * restores — the ask park's shape over the engine's sleeping-run wake, which
 * the worker already drives (completeSleep in driveOne). No new sweep, no
 * wake source, no delivered event the parent must consume.
 */

/** Children per task root when SHIP_DELEGATE_MAX is unset or unreadable. */
export const DELEGATE_MAX_DEFAULT = 2;
/** The ceiling for SHIP_DELEGATE_MAX — a knob this wide is a footgun, not a bound. */
export const DELEGATE_MAX_CEILING = 16;

/**
 * The hard per-task-root child count, from SHIP_DELEGATE_MAX. Unset or
 * garbage is the default 2 (never wider than the default by accident);
 * anything above the ceiling is clamped to it rather than refused, because
 * the number is read inside a recorded step at spawn time and a refusal here
 * would fail a run that has not misbehaved.
 */
export function delegateMaxChildren(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SHIP_DELEGATE_MAX ?? "").trim();
  if (raw === "") return DELEGATE_MAX_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DELEGATE_MAX_DEFAULT;
  return Math.min(n, DELEGATE_MAX_CEILING);
}

/** How long the parent's wait step sleeps between child-state polls. */
export const DELEGATE_POLL_MS = 30_000;

/** Config key holding one task root's delegation ledger. */
export const delegationKey = (taskRootRunId: string): string => `SHIP_DELEGATION_${taskRootRunId}`;
/** Config key holding the id index (the config store lists keys, not values). */
export const DELEGATION_INDEX_KEY = "SHIP_DELEGATIONS";

/** One claimed child in a task root's ledger. Additive only; fields grow, never rename. */
export interface DelegationEntry {
  /** 1-based, in claim order — the child run id derives from it. */
  index: number;
  parentRunId: string;
  /** The turn of the parent's ```delegate action that claimed this child. */
  turn: number;
  childRunId: string;
  /** The child's task, clamped, so the ledger alone explains what was spawned. */
  task: string;
  at: string;
}

export interface DelegationRecord {
  taskRootRunId: string;
  entries: DelegationEntry[];
}

/** The run id for one claimed child: stable per (task root, index), like coordination.ts's childRunId. */
export function delegatedChildRunId(taskRootRunId: string, index: number): string {
  const digest = createHash("sha256").update(`${taskRootRunId}:delegate:${index}`).digest("hex").slice(0, 24);
  return `run-del-${digest}`;
}

/** Clamp a task for the ledger. The action already clamped the prompt; this is the belt. */
export function clampDelegateTask(task: string, max = 500): string {
  return task.length > max ? `${task.slice(0, max)}…` : task;
}

/** Parse and validate a ledger record; null when unreadable or wrong-shaped, as in coordination.ts. */
export function parseDelegationRecord(raw: string | undefined, taskRootRunId: string): DelegationRecord | null {
  if (raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Partial<DelegationRecord>;
  if (record.taskRootRunId !== taskRootRunId || !Array.isArray(record.entries)) return null;
  const entries: DelegationEntry[] = [];
  for (const entry of record.entries) {
    if (entry === null || typeof entry !== "object") return null;
    const e = entry as Partial<DelegationEntry>;
    if (
      typeof e.index !== "number" || !Number.isSafeInteger(e.index) || e.index < 1 ||
      typeof e.parentRunId !== "string" || typeof e.turn !== "number" ||
      typeof e.childRunId !== "string" || typeof e.task !== "string" || typeof e.at !== "string"
    ) {
      return null;
    }
    entries.push({ index: e.index, parentRunId: e.parentRunId, turn: e.turn, childRunId: e.childRunId, task: e.task, at: e.at });
  }
  entries.sort((a, b) => a.index - b.index);
  return { taskRootRunId, entries };
}

/**
 * The task a child run carries. The lineage is stated as FACTS (the child
 * knows where it came from and who to report to), the standalone-brief rule
 * is stated because the child genuinely cannot see the parent's conversation,
 * and the report expectation is stated because the parent's next turn reads
 * exactly that summary as its transfer.
 */
export function childTaskPrompt(input: { parentRunId: string; turn: number; task: string; repo?: string; path?: string }): string {
  const scope = [input.repo !== undefined ? `repository ${input.repo}` : "this run's repository", input.path !== undefined ? `scoped to ${input.path}/` : undefined]
    .filter((s) => s !== undefined)
    .join(", ");
  return [
    `[Delegated task, claimed by run ${input.parentRunId} at its turn ${input.turn}] This is a self-contained piece of a larger task. Work in the ${scope}. The delegating run cannot see your conversation — your finish message is the ENTIRE report it receives, so end it with a short summary of what you changed, what you verified, and anything you could not finish.`,
    "",
    input.task,
  ].join("\n");
}

/** A child's terminal result, read off its own log — the CONTEXT TRANSFER. */
export interface DelegateTransfer {
  childRunId: string;
  status: "completed" | "failed" | "cancelled";
  /** The child's own final account (run-completed output.summary / the failure line), clamped. */
  summary: string;
  /** The pull request the child opened, when it opened one. */
  pr?: string;
}

/** How much of a child's summary the transfer carries. The run page keeps the full text. */
export const TRANSFER_SUMMARY_MAX = 4000;

type EventLike = { type: string; name?: string; data?: unknown };

/**
 * Project a child's log into a transfer, or null while the child is still
 * live. PURE over the events: the same log yields the same transfer on every
 * read, which is what makes the recorded wait step's result replay-stable —
 * a terminal log is immutable, so live and replay agree by construction.
 */
export function transferFromEvents(childRunId: string, events: readonly EventLike[]): DelegateTransfer | null {
  const terminal = events.find((e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled");
  if (terminal === undefined) return null;
  const clamp = (text: string): string =>
    text.length > TRANSFER_SUMMARY_MAX ? `${text.slice(0, TRANSFER_SUMMARY_MAX)}\n…(clamped)` : text;
  if (terminal.type === "run-completed") {
    const output = (terminal.data as { output?: { summary?: unknown; pr?: unknown } } | undefined)?.output;
    const summary = typeof output?.summary === "string" && output.summary.trim() !== "" ? output.summary : "(the child finished without a summary)";
    const pr = typeof output?.pr === "string" && output.pr !== "" ? output.pr : undefined;
    return { childRunId, status: "completed", summary: clamp(summary), ...(pr !== undefined ? { pr } : {}) };
  }
  if (terminal.type === "run-cancelled") {
    const reason = (terminal.data as { reason?: unknown } | undefined)?.reason;
    return { childRunId, status: "cancelled", summary: clamp(typeof reason === "string" && reason !== "" ? reason : "the child run was cancelled") };
  }
  const error = (terminal.data as { error?: { message?: unknown } } | undefined)?.error;
  return { childRunId, status: "failed", summary: clamp(typeof error?.message === "string" && error.message !== "" ? error.message : "the child run failed") };
}

/**
 * The observation the parent's next turn consumes — the merge-back half of
 * the T3 shape. Scrubbed like any command output (the summary is model text
 * that reaches the transcript, the log and the PR body), and worded so the
 * model can tell a completed child's report from a failed one at a glance.
 */
export function transferObservation(transfer: DelegateTransfer): string {
  const head = `Delegated run ${transfer.childRunId} ${transfer.status}:`;
  const pr = transfer.pr !== undefined ? `\nPull request: ${transfer.pr}` : "";
  const advice =
    transfer.status === "completed"
      ? ""
      : transfer.status === "failed"
        ? "\nThe child FAILED — read its summary, decide whether to redo the work yourself or delegate a corrected task, and continue."
        : "\nThe child was CANCELLED before finishing; the work it was asked for was not done.";
  return `${head}\n${scrub(transfer.summary)}${pr}${advice}`;
}

/** What a ```delegate action asks the runtime half to do. */
export interface DelegateSpawnRequest {
  parentRunId: string;
  turn: number;
  task: string;
  /** Scope hint from the fence; the control verifies it names the parent's own repo. */
  repoHint?: string;
  pathHint?: string;
}

/** The spawn's answer. A refusal is a RESULT (an observation for the model), never a thrown error. */
export type DelegateSpawnOutcome =
  | { ok: true; childRunId: string }
  | { ok: false; reason: string };

/**
 * The boundary the native loop calls from inside its recorded steps. spawn is
 * idempotent per (parentRunId, turn); outcome answers null until the child's
 * log holds a terminal event, then the same transfer forever. Both are
 * store-backed in the product implementation (runtime.ts) and faked in tests.
 */
export interface DelegateControl {
  spawn(request: DelegateSpawnRequest): Promise<DelegateSpawnOutcome>;
  outcome(childRunId: string): Promise<DelegateTransfer | null>;
}

/**
 * The process's registered control, set by the runtime constructors
 * (runtime.ts) so the product path needs no worker.ts wiring — see
 * docs/COORDINATOR_DESIGN.md, "Wiring without the dirty lane". The slot is
 * read ONLY inside the delegate branch of runs whose input admits the
 * action, so nothing about it can affect a flag-off run. Last registration
 * wins, which is exact for the one-runtime-per-process product shape and
 * irrelevant to tests, which pass `config.delegate` explicitly.
 */
let registered: DelegateControl | undefined;

export function registerDelegateControl(control: DelegateControl | undefined): void {
  registered = control;
}

/** The registered control, if any. DurableAgentConfig.delegate outranks it. */
export function delegateControl(): DelegateControl | undefined {
  return registered;
}

/** The cap refusal the model sees. One message, named here so tests pin it. */
export function delegateCapMessage(max: number): string {
  return (
    `Delegation refused: this task has already spawned its limit of ${max} child run${max === 1 ? "" : "s"} ` +
    `(SHIP_DELEGATE_MAX). Do the remaining work yourself.`
  );
}

/** The child's one-level refusal, when a ```delegate block comes from a child (input.delegateChild). */
export const DELEGATE_CHILD_REFUSED =
  "Delegation refused: this run is itself a delegated child, and children cannot delegate further in this version. Do the work yourself.";

/** A ```delegate block the input never admitted, or a worker with no delegation wiring. */
export const DELEGATE_UNAVAILABLE =
  "Delegation is not available on this run. Do the work yourself in this session.";
