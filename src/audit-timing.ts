/**
 * S28 — derived run timing for the audit JSON export, and its aggregate.
 *
 * The CSV columns are an external contract, so timing is deliberately NOT an
 * `AuditRow` field: `toCsv` reads only `COLUMNS`, and this module adds an
 * optional `timing` object to the JSON export alone. Existing JSON consumers
 * see one additive key; CSV is byte-identical (audit-timing.test.ts pins it).
 *
 * Honesty rules, inherited from run-timing.ts and enforced again here:
 *  - A figure that cannot be established is null and is EXCLUDED from every
 *    aggregate. It is never coerced to 0: a run with no telemetry is not a fast
 *    run, and a 0 would drag the median down.
 *  - Percentiles are only computed when n >= MIN_N_FOR_PERCENTILES. Below that,
 *    the raw values are reported and no median/p90 is offered, because a median
 *    of five runs reads like a measurement and is not one.
 *  - Runs whose telemetry is partial or missing are counted explicitly.
 *  - toFirstStepMs is an upper bound on queue wait (no claim-time event exists).
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

import { runTiming } from "./run-timing.js";
import type { RunTiming } from "./run-timing.js";

/** Below this many established values per status, report raw values only. */
export const MIN_N_FOR_PERCENTILES = 20;

/** The per-run timing object attached to a JSON audit row. */
export function auditTiming(events: readonly WorkflowEvent[]): RunTiming {
  return runTiming(events);
}

export type TimingMetric = "toFirstStepMs" | "elapsedMs" | "waitingOnPeopleMs" | "activeMs";
const METRICS: TimingMetric[] = ["toFirstStepMs", "elapsedMs", "waitingOnPeopleMs", "activeMs"];

export interface MetricSummary {
  /** Runs with an established value for this metric. */
  n: number;
  /** Runs in the group whose value is null (excluded, not zero). */
  unknown: number;
  /** The raw established values, sorted; present when n is below the threshold. */
  raw?: number[];
  /** Present only when n >= minN. */
  median?: number;
  p90?: number;
}

export interface StatusTimingSummary {
  runs: number;
  /** Runs whose telemetry is "partial". */
  partial: number;
  /** Runs whose telemetry is "missing" (no usable timestamps at all). */
  missing: number;
  metrics: Record<TimingMetric, MetricSummary>;
}

export interface TimingSummary {
  minNForPercentiles: number;
  total: number;
  partial: number;
  missing: number;
  byStatus: Record<string, StatusTimingSummary>;
}

function summarise(values: (number | null)[], minN: number): MetricSummary {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const out: MetricSummary = { n: known.length, unknown: values.length - known.length };
  if (known.length >= minN && known.length > 0) {
    const mid = Math.floor(known.length / 2);
    out.median = known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
    // Nearest-rank: always an observed value, never an interpolated one.
    out.p90 = known[Math.max(1, Math.ceil(0.9 * known.length)) - 1];
  } else {
    out.raw = known;
  }
  return out;
}

export function timingSummary(
  rows: readonly { status: string; timing: RunTiming }[],
  minN: number = MIN_N_FOR_PERCENTILES,
): TimingSummary {
  const groups = new Map<string, RunTiming[]>();
  for (const r of rows) {
    const list = groups.get(r.status) ?? [];
    list.push(r.timing);
    groups.set(r.status, list);
  }
  const byStatus: Record<string, StatusTimingSummary> = {};
  for (const [status, timings] of groups) {
    byStatus[status] = {
      runs: timings.length,
      partial: timings.filter((t) => t.telemetry === "partial").length,
      missing: timings.filter((t) => t.telemetry === "missing").length,
      metrics: Object.fromEntries(METRICS.map((m) => [m, summarise(timings.map((t) => t[m]), minN)])) as Record<TimingMetric, MetricSummary>,
    };
  }
  const all = rows.map((r) => r.timing);
  return {
    minNForPercentiles: minN,
    total: all.length,
    partial: all.filter((t) => t.telemetry === "partial").length,
    missing: all.filter((t) => t.telemetry === "missing").length,
    byStatus,
  };
}
