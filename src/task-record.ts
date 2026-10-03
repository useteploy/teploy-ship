/**
 * S03 — one task, read from the records Ship already keeps.
 *
 * A "task" today is a chain of runs anchored by `taskRootRunId`
 * (task-session.ts): the root run plus every follow-up/revision. The
 * programme's contract wants intent, requirements, plan versions, attempts and
 * three SEPARATE outcomes — execution, acceptance, delivery. Only some of that
 * is stored as a first-class record. This module projects what exists and says
 * "not-recorded" for what does not, so a UI or API can adopt the contract
 * without a migration and without inventing facts.
 *
 * What maps to what (existing record -> contract field):
 *   run-started input.userMessage ?? input.task -> requirement statement (per attempt)
 *   run-started input.parentRunId               -> attempt lineage
 *   event-received "plan-approval"              -> plan decision (approved / edited / by)
 *   event-received "change-approval"/"approve-merge" -> change decision (the only
 *                                                  recorded acceptance act)
 *   run-completed output.status                 -> execution outcome of that attempt
 *   run-cancelled reason REVISION_CANCEL_PREFIX -> acceptance superseded by a revision
 *   delivery record state (passed in by caller) -> delivery outcome
 *
 * Not recorded anywhere today, so reported as such rather than guessed:
 * structured acceptance criteria, per-requirement evidence mapping, waivers,
 * participants other than the decision granter, and plan text versions beyond
 * an operator edit flag.
 *
 * Invariants (pinned in task-record.test.ts):
 *  - execution "finished" never implies acceptance. A finished run with no
 *    authorised decision is acceptance "not-recorded".
 *  - A later attempt supersedes an earlier acceptance; it is not carried over.
 *  - A denied decision is "rejected", not silently absent.
 *  - Delivery is its own field and never inferred from the other two.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";
import { CHANGE_EVENT, MERGE_EVENT, PLAN_EVENT, REVISION_CANCEL_PREFIX } from "./plan.js";
import type { RunMeta } from "./run-store.js";

export interface TaskAttemptSource {
  meta: RunMeta;
  events: readonly WorkflowEvent[];
}

export type ExecutionState =
  | "not-started"
  | "running"
  | "waiting-on-people"
  | "finished"
  | "incomplete"
  | "failed"
  | "cancelled";

export type AcceptanceState = "not-recorded" | "pending" | "accepted" | "rejected" | "superseded";

export type DeliveryOutcome = "not-recorded" | "proposed" | "approved" | "executing" | "confirmed" | "unknown" | "failed" | "held";

export interface Decision {
  event: string;
  approved: boolean;
  by: string | null;
  at: string;
  /** Plan decisions only: the operator replaced the agent's plan text. */
  edited?: boolean;
  reason?: string;
}

export interface TaskAttempt {
  runId: string;
  parentRunId: string | null;
  statement: string | null;
  startedAt: string | null;
  execution: ExecutionState;
  /** output.status as recorded by the run, when it ended with one. */
  endStatus: string | null;
  waitingOn: string | null;
  decisions: Decision[];
  /** Run id of the follow-up that replaced this attempt's pending review, if any. */
  supersededBy: string | null;
}

export interface TaskRecord {
  rootRunId: string;
  attempts: TaskAttempt[];
  /** Statements in attempt order. They are what was asked, not accepted criteria. */
  requirements: { runId: string; statement: string }[];
  execution: ExecutionState;
  acceptance: AcceptanceState;
  /** Who recorded the acceptance decision, when one exists. */
  acceptedBy: string | null;
  delivery: DeliveryOutcome;
  /** Contract fields this projection cannot fill from stored records. */
  notRecorded: string[];
  /** Anything surprising in the source records (never thrown, never hidden). */
  anomalies: string[];
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

const NOT_RECORDED = [
  "structured acceptance criteria",
  "per-requirement evidence mapping",
  "requirement waivers",
  "participants other than decision granters",
  "plan text versions (only an operator-edit flag exists)",
];

function attemptOf(source: TaskAttemptSource, anomalies: string[]): TaskAttempt {
  const events = [...source.events].sort((a, b) => a.seq - b.seq);
  const started = events.find((e) => e.type === "run-started");
  const input = rec(rec(started?.data)?.input);
  const statementRaw = input?.userMessage ?? input?.task;
  const parent = input?.parentRunId;

  const decisions: Decision[] = [];
  const waiting = new Map<string, number>();
  for (const e of events) {
    const name = e.name ?? "";
    if (e.type === "event-waiting") waiting.set(name, (waiting.get(name) ?? 0) + 1);
    if (e.type !== "event-received") continue;
    waiting.set(name, Math.max(0, (waiting.get(name) ?? 0) - 1));
    if (name !== PLAN_EVENT && name !== CHANGE_EVENT && name !== MERGE_EVENT) continue;
    const payload = rec(rec(e.data)?.payload);
    if (typeof payload?.approved !== "boolean") {
      anomalies.push(`${source.meta.runId}: ${name} delivered without a boolean "approved"; not counted as a decision`);
      continue;
    }
    decisions.push({
      event: name,
      approved: payload.approved,
      by: typeof payload.by === "string" && payload.by !== "" ? payload.by : null,
      at: e.at,
      ...(name === PLAN_EVENT && typeof payload.plan === "string" && payload.plan.trim() !== "" ? { edited: true } : {}),
      ...(typeof payload.reason === "string" && payload.reason !== "" ? { reason: payload.reason } : {}),
    });
  }
  const openWait = [...waiting.entries()].find(([, n]) => n > 0)?.[0] ?? null;

  const terminal = events.find((e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled");
  const output = terminal?.type === "run-completed" ? rec(rec(terminal.data)?.output) : undefined;
  const endStatus = typeof output?.status === "string" ? output.status : null;
  const incomplete = output?.incomplete === true;

  let execution: ExecutionState;
  if (started === undefined) execution = "not-started";
  else if (terminal?.type === "run-failed") execution = "failed";
  else if (terminal?.type === "run-cancelled") execution = "cancelled";
  else if (terminal?.type === "run-completed") execution = endStatus === "finished" && !incomplete ? "finished" : "incomplete";
  else if (openWait !== null) execution = "waiting-on-people";
  else execution = "running";

  const reason = terminal?.type === "run-cancelled" ? rec(terminal.data)?.reason : undefined;
  const supersededBy =
    typeof reason === "string" && reason.startsWith(REVISION_CANCEL_PREFIX) ? reason.slice(REVISION_CANCEL_PREFIX.length) : null;

  return {
    runId: source.meta.runId,
    parentRunId: typeof parent === "string" ? parent : null,
    statement: typeof statementRaw === "string" ? statementRaw : null,
    startedAt: started?.at ?? null,
    execution,
    endStatus,
    waitingOn: execution === "waiting-on-people" ? openWait : null,
    decisions,
    supersededBy,
  };
}

/**
 * Project one task. `sources` are the runs of the task (root first or in any
 * order; they are ordered by lineage then start time). `delivery` is the
 * caller's delivery record state for the task's published change, if any.
 */
export function taskRecord(
  rootRunId: string,
  sources: readonly TaskAttemptSource[],
  delivery?: { state: Exclude<DeliveryOutcome, "not-recorded"> },
): TaskRecord {
  const anomalies: string[] = [];
  const attempts = sources
    .map((s) => attemptOf(s, anomalies))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.runId.localeCompare(b.runId));

  if (!attempts.some((a) => a.runId === rootRunId)) anomalies.push(`root run ${rootRunId} is not among the supplied attempts`);
  for (const a of attempts) {
    if (a.parentRunId !== null && !attempts.some((o) => o.runId === a.parentRunId)) {
      anomalies.push(`${a.runId}: parent ${a.parentRunId} is not among the supplied attempts`);
    }
  }

  const requirements = attempts.flatMap((a) => (a.statement === null ? [] : [{ runId: a.runId, statement: a.statement }]));
  const latest = attempts[attempts.length - 1];

  // Acceptance is only ever read from a recorded change decision on the LATEST
  // attempt. An earlier attempt's approval was for earlier bytes.
  let acceptance: AcceptanceState = "not-recorded";
  let acceptedBy: string | null = null;
  if (latest !== undefined) {
    const change = [...latest.decisions].reverse().find((d) => d.event === CHANGE_EVENT || d.event === MERGE_EVENT);
    if (change !== undefined) {
      acceptance = change.approved ? "accepted" : "rejected";
      acceptedBy = change.approved ? change.by : null;
    } else if (latest.waitingOn === CHANGE_EVENT || latest.waitingOn === MERGE_EVENT) {
      acceptance = "pending";
    } else if (latest.supersededBy !== null) {
      acceptance = "superseded";
    }
  }
  // A revision exists but the latest attempt has no decision of its own: the
  // earlier acceptance (if any) does not carry over.
  if (acceptance === "not-recorded" && attempts.slice(0, -1).some((a) => a.decisions.some((d) => (d.event === CHANGE_EVENT || d.event === MERGE_EVENT) && d.approved))) {
    acceptance = "superseded";
  }

  return {
    rootRunId,
    attempts,
    requirements,
    execution: latest?.execution ?? "not-started",
    acceptance,
    acceptedBy,
    delivery: delivery?.state ?? "not-recorded",
    notRecorded: [...NOT_RECORDED],
    anomalies,
  };
}
