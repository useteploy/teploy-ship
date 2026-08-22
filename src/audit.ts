import type { WorkflowEvent } from "@neutron-build/workflow";

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
 * ## What this cannot tell you, and why it is stated rather than hidden
 *
 * **There is no actor attribution anywhere in Ship.** A run does not record who
 * enqueued it and an approval does not record who granted it — `RunMeta` has
 * `source` (which intake channel) and `ranOn` (which host), and no user field
 * at all. So this export answers *what ran, when, at what cost, and what it
 * published*. It cannot answer *who authorised it*.
 *
 * For an internal operator record that is enough and useful. For a compliance
 * artefact it is not, and adding actor attribution is the prerequisite — not a
 * refinement of this. It is deliberately surfaced by `attributable: false` on
 * every row rather than left for someone to discover after they have relied on
 * it.
 */
export interface AuditRow {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  /** Which intake channel the run arrived through — NOT which person. */
  source: string;
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
   * Always false today. Ship records no actor for enqueue or approval, so no
   * row here can name a person. See the note on this module.
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

  for (const e of events) {
    const data = asRecord(e.data);
    if (e.type === "run-started") {
      const input = asRecord(data?.input);
      if (typeof input?.repo === "string") repo = input.repo;
    } else if (e.type === "event-waiting") {
      approvals += 1;
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
    model: meta.model,
    ranOn: meta.ranOn ?? "",
    repo,
    task: meta.task,
    pr,
    turns,
    costUSD: Number(cost.toFixed(4)),
    approvals,
    attributable: false,
  };
}

const COLUMNS: (keyof AuditRow)[] = [
  "runId",
  "createdAt",
  "updatedAt",
  "status",
  "source",
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
