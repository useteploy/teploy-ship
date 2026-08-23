import type { WorkflowEvent } from "@neutron-build/workflow";

import { actorFromMeta, isAttributable } from "./actor.js";
import { costUSD } from "./pricing.js";
import type { RunMeta } from "./run-store.js";

/**
 * The run history, as an artefact somebody outside this machine can read.
 *
 * Ship's durable event log already records everything that happened, which is
 * why it is described as an audit trail. It is not one yet: an auditable record
 * you cannot show an auditor is not an audit trail, and until this existed the
 * only way to answer "what has this agent done to our repositories" was to read
 * several hundred events per run out of a database.
 *
 * ## Attribution, and what it is still not
 *
 * Runs now carry an actor and approvals carry a granter (see actor.ts), so a
 * row can answer *who asked* and *who unblocked it* as well as what ran, when,
 * at what cost and what it published.
 *
 * Two honest limits remain, both visible in the row rather than buried:
 *
 * - **`attributable` is per-row, not decorative.** Runs enqueued before
 *   attribution existed, CI-triggered runs (a machine asked, not a person), and
 *   any surface that could not name someone report `false`. A reader filtering
 *   for accountable actions filters on this column.
 * - **An `intake` actor is asserted, not verified.** The webhook signature
 *   proves the payload came from the forge; it does not prove the forge is
 *   honest about who wrote the issue. `actorKind` is exported next to `actor`
 *   precisely so nobody has to guess how much the name is worth.
 */
export interface AuditRow {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  /** Which intake channel the run arrived through — NOT which person. */
  source: string;
  /** Stable id of whoever asked for the run; "" when nobody could be named. */
  actor: string;
  /** How that identity was established: user | cli | intake | unknown. */
  actorKind: string;
  /**
   * Stable ids of everyone who granted an approval on this run, in order,
   * separated by "; ". Empty when the run needed no approval — which is not the
   * same as an approval nobody signed, and `approvals` is the column that
   * distinguishes them.
   */
  approvedBy: string;
  model: string;
  /** Worker host that last executed it. */
  ranOn: string;
  repo: string;
  task: string;
  /** Pull request opened by the run, if any. */
  pr: string;
  turns: number;
  costUSD: number;
  /** Did a person have to unblock this run at some point? */
  approvals: number;
  /**
   * True when this run names who asked for it. False for runs enqueued before
   * attribution existed and for machine-triggered runs. See the note above:
   * true means a name is present, NOT that Ship verified it.
   */
  attributable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Pull the facts an auditor asks about out of one run's event log. */
export function auditRow(meta: RunMeta, events: WorkflowEvent[]): AuditRow {
  let repo = "";
  let pr = "";
  let turns = 0;
  let approvals = 0;
  let cost = 0;
  const approvedBy: string[] = [];

  for (const e of events) {
    const data = asRecord(e.data);
    if (e.type === "run-started") {
      const input = asRecord(data?.input);
      if (typeof input?.repo === "string") repo = input.repo;
    } else if (e.type === "event-waiting") {
      approvals += 1;
    } else if (e.type === "event-received") {
      // The granter rides on the delivered payload — deliverEvent records it as
      // `data.payload` — which is the only place a decision's author appears.
      // An unsigned decision (a CLI too old to send `by`, or a session that
      // could not be resolved) contributes nothing rather than a blank entry.
      const by = asRecord(data?.payload)?.by;
      if (typeof by === "string" && by !== "") approvedBy.push(by);
    } else if (e.type === "step-completed") {
      const m = /^turn-(\d+)-exec$/.exec(e.name ?? "");
      if (m !== null) turns = Math.max(turns, Number(m[1]) + 1);
    } else if (e.type === "run-completed") {
      const out = asRecord(data?.output);
      if (typeof out?.pr === "string") pr = out.pr;
      if (typeof out?.turns === "number") turns = Math.max(turns, out.turns);
      // Priced from the recorded usage rather than from a running total, so an
      // export of an old run reports what that run actually cost even if the
      // price table has moved since.
      if (out?.usage !== undefined) cost = costUSD(meta.model, out.usage as never);
    }
  }

  return {
    runId: meta.runId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    source: meta.source ?? "unknown",
    actor: meta.actor ?? "",
    actorKind: meta.actorKind ?? "unknown",
    approvedBy: approvedBy.join("; "),
    model: meta.model,
    ranOn: meta.ranOn ?? "",
    repo,
    task: meta.task,
    pr,
    turns,
    costUSD: Number(cost.toFixed(4)),
    approvals,
    attributable: isAttributable(actorFromMeta(meta)),
  };
}

const COLUMNS: (keyof AuditRow)[] = [
  "runId",
  "createdAt",
  "updatedAt",
  "status",
  "source",
  "actor",
  "actorKind",
  "approvedBy",
  "model",
  "ranOn",
  "repo",
  "task",
  "pr",
  "turns",
  "costUSD",
  "approvals",
  "attributable",
];

/**
 * RFC 4180 quoting. Tasks are free text written by whoever filed the issue and
 * routinely contain commas, quotes and newlines; a naive join produces a file
 * that opens in a spreadsheet and is silently wrong, which is worse than one
 * that fails to open.
 */
function csvCell(value: string | number | boolean): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: AuditRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}

/** Filter to a window. Both bounds optional; `since` is inclusive, `until` exclusive. */
export function withinWindow(rows: AuditRow[], since?: string, until?: string): AuditRow[] {
  return rows.filter((r) => {
    if (since !== undefined && r.createdAt < since) return false;
    if (until !== undefined && r.createdAt >= until) return false;
    return true;
  });
}
