/**
 * Wiring for the budget reservation ledger (S11): SHIP_BUDGET_RESERVATION.
 *
 *   off     (default)  nothing here runs; no ledger file is created.
 *   shadow             the ledger is driven alongside the existing spend logic
 *                      (SpendStore.reserve/get at intake and at enqueue, the
 *                      settle in the worker's onComplete). Its verdict is
 *                      COMPARED with the existing one and any difference is
 *                      logged and counted. The existing verdict always wins.
 *   on                 a ledger refusal also denies. The existing check still
 *                      runs first and still denies on its own; the ledger can
 *                      only make admission stricter, never looser.
 *
 * What is wired: one "parent" scope per (source, UTC day), capped at the same
 * daily budget the existing check uses, one reservation per run keyed by runId
 * (the same id the SpendStore hold uses). What is NOT wired, deliberately:
 *   - child/retry scopes: the product has no per-task cap to put on them, so
 *     there is nothing honest to declare. The ledger supports them; a caller
 *     with a cap can define them.
 *   - lease fencing (FenceToken): lease loss lives in durable.ts, which this
 *     slice does not touch. A run whose worker lost its lease keeps its hold
 *     until whichever worker finishes it settles or releases it.
 *
 * ATOMICITY: the ledger is a FILE (budget-reservation.ts, ATOMICITY CEILING).
 * It serialises callers inside one process only. Two worker processes, even on
 * one host, can both read, decide and rename, and the file is not shared at all
 * between hosts. `on` therefore refuses to enable for any runtime that is not
 * the single-host file runtime (a Nucleus runtime is the multi-worker one) and
 * falls back to `shadow` with an error log. Nothing here can detect two file
 * runtime processes on one host: that is the operator's to avoid, and a second
 * process makes the ledger's verdict unsound, not merely stale.
 *
 * Known shadow-mode disagreements, by design and worth reading before trusting
 * the counters:
 *   - A scope is seeded, on first sight in a day, with the spend the existing
 *     store already shows (as a settled baseline). Runs admitted before the flag
 *     was on, or without a hold (budget <= 0, enqueued by a surface that does
 *     not hold), appear in the ledger only through that baseline.
 *   - Unpriced settlement keeps its estimate held in the ledger (unknown is not
 *     zero). The existing store releases the hold and counts the run elsewhere,
 *     so the ledger is stricter for the rest of the day. That is the point.
 *   - The existing SpendStore holds live in memory (file store) and vanish on
 *     restart; the ledger's persist. After a restart the ledger may be stricter.
 *   - A changed budget for a source mid-day is a different definition of the
 *     scope, which the ledger refuses; that admission is recorded as skipped.
 */
import { join } from "node:path";

import { fileReservationLedger, type ReservationLedger, type Settlement } from "./budget-reservation.js";
import { stateDir } from "./run-store.js";

export type BudgetReservationMode = "off" | "shadow" | "on";

export function budgetReservationMode(env: NodeJS.ProcessEnv = process.env): { mode: BudgetReservationMode; invalid?: string } {
  const raw = (env.SHIP_BUDGET_RESERVATION ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return { mode: "off" };
  if (raw === "shadow" || raw === "on") return { mode: raw };
  // An unreadable value must not turn enforcement on, nor silently look enabled.
  return { mode: "off", invalid: env.SHIP_BUDGET_RESERVATION as string };
}

export interface AdmitArgs {
  runId: string;
  source: string;
  day: string;
  budgetUSD: number;
  estimateUSD: number;
  /** What the existing SpendStore check decided (committed <= budget). */
  existingAllowed: boolean;
  /** The existing store's committed total for the source and day, this run's hold included. */
  existingCommittedUSD: number;
}

export interface AdmitVerdict {
  /** False only in `on` mode, when the ledger refused. */
  allow: boolean;
  /** The ledger's committed total when it refused, for the error message. */
  ledgerCommittedUSD?: number;
}

export type RunSettlement = { kind: "priced"; costUSD: number } | { kind: "unpriced" } | { kind: "none" };

export interface BudgetGateStats {
  admissions: number;
  agreements: number;
  /** Existing allowed, ledger would have refused. */
  ledgerStricter: number;
  /** Existing refused, ledger would have allowed. */
  ledgerLooser: number;
  /** The ledger could not give a verdict (error, cap changed, baseline over cap). */
  skipped: number;
  settledPriced: number;
  /** Settled unpriced: hold kept, counted as unknown. */
  settledUnpriced: number;
  /** A settle arrived for a run the ledger never held (no hold, or pre-flag). */
  unreserved: number;
}

export interface BudgetGate {
  readonly mode: "shadow" | "on";
  admit(args: AdmitArgs): Promise<AdmitVerdict>;
  settle(runId: string, settlement: RunSettlement): Promise<void>;
  release(runId: string): Promise<void>;
  stats(): BudgetGateStats;
}

const scopeIdOf = (source: string, day: string): string => `budget:${source}:${day}`;

export function createBudgetGate(opts: { mode: "shadow" | "on"; ledger: ReservationLedger; log?: (line: string) => void }): BudgetGate {
  const { mode, ledger } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const stats: BudgetGateStats = {
    admissions: 0,
    agreements: 0,
    ledgerStricter: 0,
    ledgerLooser: 0,
    skipped: 0,
    settledPriced: 0,
    settledUnpriced: 0,
    unreserved: 0,
  };
  // Scopes whose baseline would not fit under the cap: the ledger would admit
  // against an empty scope while the store is already over, so no verdict.
  const unseedable = new Set<string>();

  async function ensureScope(a: AdmitArgs): Promise<"ok" | string> {
    const scopeId = scopeIdOf(a.source, a.day);
    const def = await ledger.defineScope({ id: scopeId, kind: "parent", capUSD: a.budgetUSD });
    if (!def.ok) return `scope refused: ${def.reason}`;
    if (unseedable.has(scopeId)) return "baseline over cap";
    const snap = await ledger.snapshot(scopeId);
    if ("ok" in snap) return `snapshot refused: ${snap.reason}`;
    // First sight of this scope: seed what the store already shows, minus this
    // run's own hold (it is reserved separately, below).
    if (snap.committedUSD === 0 && snap.settledUSD === 0 && snap.heldUSD === 0 && snap.overrunUSD === 0) {
      const baselineId = `baseline:${scopeId}`;
      const baseline = Math.max(0, a.existingCommittedUSD - a.estimateUSD);
      if (baseline > 0) {
        const r = await ledger.reserve({ reservationId: baselineId, scopeId, amountUSD: baseline });
        if (!r.ok) {
          unseedable.add(scopeId);
          return "baseline over cap";
        }
        if (!r.replay) await ledger.settle(baselineId, { priced: true, actualUSD: baseline });
      }
    }
    return "ok";
  }

  return {
    mode,
    async admit(a) {
      stats.admissions += 1;
      let ledgerAllows: boolean | undefined;
      let ledgerCommitted: number | undefined;
      let why = "";
      try {
        const scope = await ensureScope(a);
        if (scope !== "ok") why = scope;
        else {
          const r = await ledger.reserve({ reservationId: a.runId, scopeId: scopeIdOf(a.source, a.day), amountUSD: a.estimateUSD });
          if (r.ok) ledgerAllows = true;
          else if (r.reason === "over-cap") {
            ledgerAllows = false;
            ledgerCommitted = r.committedUSD + r.requestedUSD;
          } else why = `reserve refused: ${r.reason}`;
        }
      } catch (error) {
        why = `ledger error: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (ledgerAllows === undefined) {
        stats.skipped += 1;
        log(`[budget-reservation] ${a.runId} (${a.source}): no ledger verdict (${why}); existing decision stands (${a.existingAllowed ? "allow" : "deny"})`);
        return { allow: true };
      }
      if (ledgerAllows === a.existingAllowed) stats.agreements += 1;
      else {
        if (a.existingAllowed) stats.ledgerStricter += 1;
        else stats.ledgerLooser += 1;
        log(
          `[budget-reservation] DISAGREEMENT ${a.runId} (${a.source}, ${a.day}): existing ${a.existingAllowed ? "allows" : "refuses"} ` +
            `(committed $${a.existingCommittedUSD.toFixed(4)} of $${a.budgetUSD.toFixed(2)}), ledger ${ledgerAllows ? "allows" : "refuses"}` +
            `${ledgerCommitted !== undefined ? ` (committed $${ledgerCommitted.toFixed(4)})` : ""}; mode=${mode}${mode === "shadow" ? ", outcome unchanged" : ""}`,
        );
      }
      // A hold the run will not use must not linger in the ledger.
      if (ledgerAllows && !a.existingAllowed) await ledger.release(a.runId).catch(() => {});
      const deny = mode === "on" && !ledgerAllows;
      return { allow: !deny, ...(ledgerCommitted !== undefined ? { ledgerCommittedUSD: ledgerCommitted } : {}) };
    },
    async settle(runId, s) {
      try {
        if (s.kind === "none") {
          await ledger.release(runId);
          return;
        }
        const settlement: Settlement = s.kind === "priced" ? { priced: true, actualUSD: s.costUSD } : { priced: false };
        const out = await ledger.settle(runId, settlement);
        if (!out.ok) {
          if (out.reason === "unknown-reservation") stats.unreserved += 1;
          else if (out.reason !== "already-settled") log(`[budget-reservation] ${runId}: settle refused: ${out.reason}`);
          return;
        }
        if (s.kind === "priced") stats.settledPriced += 1;
        else {
          stats.settledUnpriced += 1;
          log(`[budget-reservation] ${runId}: unpriced usage — its estimate stays held as unknown spend, not recorded as $0`);
        }
      } catch (error) {
        log(`[budget-reservation] ${runId}: settle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async release(runId) {
      try {
        await ledger.release(runId);
      } catch (error) {
        log(`[budget-reservation] ${runId}: release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    stats: () => ({ ...stats }),
  };
}

let memo: { key: string; gate: BudgetGate | undefined } | undefined;

/**
 * The process's gate, from the environment. Undefined when the flag is off —
 * callers then do exactly what they did before. `runtimeKind` is the runtime's
 * `kind`; `on` is only honoured for "file" (see ATOMICITY above).
 */
export function resolveBudgetGate(
  runtime: { kind?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): BudgetGate | undefined {
  const { mode, invalid } = budgetReservationMode(env);
  const path = join(stateDir(), "budget-ledger.json");
  const key = `${mode}|${invalid ?? ""}|${runtime?.kind ?? ""}|${path}`;
  if (memo?.key === key) return memo.gate;
  let effective: "shadow" | "on" | undefined;
  if (invalid !== undefined) log(`[budget-reservation] SHIP_BUDGET_RESERVATION=${JSON.stringify(invalid)} is not off|shadow|on; treated as off`);
  if (mode === "shadow") effective = "shadow";
  if (mode === "on") {
    if (runtime?.kind === "file") effective = "on";
    else {
      effective = "shadow";
      log(
        `[budget-reservation] REFUSING to enable \`on\`: the ledger is a single-process file and this runtime (${runtime?.kind ?? "unknown"}) ` +
          "may have several workers, which would race it. Running in shadow mode; existing budget logic is unchanged.",
      );
    }
  }
  if (effective === "on") {
    log("[budget-reservation] mode=on: ledger refusals deny admission. Single-process only; do not run a second worker or CLI enqueue process against this state dir while it is on.");
  }
  const gate = effective === undefined ? undefined : createBudgetGate({ mode: effective, ledger: fileReservationLedger(path), log });
  memo = { key, gate };
  return gate;
}
