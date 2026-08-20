import { costUSD } from "./pricing.js";
import type { RunUsage } from "./durable.js";

/**
 * Ship dogfooding into Observe: each completed run is emitted as an LLM event
 * so its model, tokens, cost, and outcome show up in Observe's dashboards
 * alongside everything else you run. Opt-in — a no-op unless OBSERVE_URL and
 * OBSERVE_API_KEY are set — and always fire-and-forget so telemetry never
 * blocks or fails a run.
 *
 *   OBSERVE_URL      https://observe.example.com
 *   OBSERVE_API_KEY  ingest key (maps to a site)
 *   OBSERVE_SITE     optional explicit site id (X-Observe-Site)
 */
export interface ObserveRunEvent {
  runId: string;
  model: string;
  /** Terminal run status: completed | failed | cancelled. */
  status: string;
  usage?: RunUsage;
  repo?: string;
  pr?: number;
  latencyMs?: number;
}

export interface ObserveEmitter {
  emitRun(event: ObserveRunEvent): void;
  readonly enabled: boolean;
}

const NOOP: ObserveEmitter = { emitRun: () => {}, enabled: false };

export function makeObserveEmitter(log: (line: string) => void = () => {}): ObserveEmitter {
  const base = (process.env.OBSERVE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.OBSERVE_API_KEY ?? "";
  if (base === "" || key === "") return NOOP;
  const site = process.env.OBSERVE_SITE ?? "";

  return {
    enabled: true,
    emitRun(event) {
      const provider = event.model.includes("/") ? event.model.split("/")[0]! : "unknown";
      const body = {
        session_id: event.runId,
        span_id: event.runId,
        model: event.model,
        provider,
        operation: "ship.run",
        prompt_tokens: event.usage?.inputTokens ?? 0,
        completion_tokens: event.usage?.outputTokens ?? 0,
        cost_usd: costUSD(event.model, event.usage),
        latency_ms: event.latencyMs ?? 0,
        status: event.status === "completed" ? "ok" : "error",
        error_message: event.status === "completed" ? "" : event.status,
        metadata: {
          source: "teploy-ship",
          ...(event.repo !== undefined ? { repo: event.repo } : {}),
          ...(event.pr !== undefined ? { pr: event.pr } : {}),
        },
      };
      const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key };
      if (site !== "") headers["x-observe-site"] = site;
      void fetch(`${base}/api/v1/llm/ingest`, { method: "POST", headers, body: JSON.stringify(body) }).catch((err) =>
        log(`[observe] emit ${event.runId} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
  };
}

/**
 * The read path: what does the service this run touched actually look like?
 *
 * Everything above emits. This half asks. It exists so a pull request can
 * carry evidence rather than a claim — Vorflux says "a PR with proof" and
 * means a passing test run; with this, ours can mean production telemetry.
 *
 * Credential: an Observe SHARE TOKEN (`OBSERVE_READ_TOKEN`), not the ingest
 * key above and not a user session. A share token is GET-only, pinned by the
 * server to its own site, long-lived and revocable — the only credential in
 * Observe a worker can hold. The ingest key is write-scoped and a user JWT
 * expires in 24 hours and belongs to a person.
 *
 * Scope: it reads ONE endpoint, `/api/v1/traces/services`, which returns per
 * service request count, error count, latency percentiles and Apdex. Aggregates
 * only — no trace payloads, no span attributes, nothing user-supplied.
 */
export interface ServiceHealth {
  service: string;
  requests: number;
  errors: number;
  /** errors/requests, or 0 when nothing was served. */
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  apdex: number;
}

export interface TelemetryTarget {
  /** Observe base URL. */
  url: string;
  /** Share token (X-Share-Token). */
  token: string;
  /** The service name as it appears in traces. */
  service: string;
  /**
   * Below this many requests a window says nothing, and a "verdict" off it
   * would be noise dressed as evidence. Both windows must clear it.
   */
  minRequests?: number;
  timeoutMs?: number;
  /** Length of each comparison window, in minutes. */
  windowMinutes?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

/** Read this worker's telemetry target. All three parts or nothing. */
export function telemetryTargetFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryTarget | undefined {
  const url = (env.OBSERVE_URL ?? "").replace(/\/+$/, "");
  const token = (env.OBSERVE_READ_TOKEN ?? "").trim();
  const service = (env.OBSERVE_SERVICE ?? "").trim();
  if (url === "" || token === "" || service === "") return undefined;
  const min = Number(env.OBSERVE_MIN_REQUESTS);
  const win = Number(env.OBSERVE_WINDOW_MINUTES);
  return {
    url,
    token,
    service,
    ...(Number.isFinite(min) && min > 0 ? { minRequests: min } : {}),
    ...(Number.isFinite(win) && win > 0 ? { windowMinutes: win } : {}),
  };
}

interface ServiceSummaryWire {
  service_name?: string;
  request_count?: number;
  error_count?: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  apdex_score?: number;
}

/**
 * Read one service's RED metrics over a window.
 *
 * Returns null when the service has no rows in the window — which is a real
 * answer ("nothing was served") and must not be confused with a zero-error
 * service. Throws nothing: a telemetry read cannot be allowed to fail a run.
 */
export async function readServiceHealth(
  target: TelemetryTarget,
  from: Date,
  to: Date,
): Promise<ServiceHealth | null> {
  const doFetch = target.fetch ?? globalThis.fetch;
  // RFC3339, always. Observe parses these with time.Parse and SILENTLY falls
  // back to "the last 24 hours" on a malformed value, so a formatting slip
  // here would not error — it would answer a different question.
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(`${target.url}/api/v1/traces/services?${qs.toString()}`, {
      method: "GET",
      headers: { "X-Share-Token": target.token },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as ServiceSummaryWire[];
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r.service_name === target.service);
    if (row === undefined) return null;
    const requests = row.request_count ?? 0;
    const errors = row.error_count ?? 0;
    return {
      service: target.service,
      requests,
      errors,
      errorRate: requests > 0 ? errors / requests : 0,
      p50: row.p50_ms ?? 0,
      p95: row.p95_ms ?? 0,
      p99: row.p99_ms ?? 0,
      apdex: row.apdex_score ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What the comparison is allowed to say. */
export type TelemetryVerdict =
  // Worker wiring, not a measurement: this host has no telemetry target. It is
  // a RECORDED outcome rather than a skipped step, so the step sequence stays a
  // function of the run input and a replay on a differently-wired host does not
  // diverge.
  | { kind: "disabled"; reason: string }
  | { kind: "compared"; before: ServiceHealth; after: ServiceHealth; errorRateDelta: number; p95Delta: number }
  | { kind: "insufficient"; reason: string; before: ServiceHealth | null; after: ServiceHealth | null }
  | { kind: "unavailable"; reason: string };

/** Default floor: below this a window is noise, not a measurement. */
export const MIN_REQUESTS_FOR_A_VERDICT = 20;

/**
 * Compare two windows — and refuse to compare when the data cannot carry it.
 *
 * The refusal is the important half. Two changes this week improved a
 * mechanism and moved the graded score by exactly zero, and a preview
 * environment serves almost no traffic, so the default outcome of a naive
 * before/after is a confident number computed from a handful of requests. That
 * is worse than silence: it looks like proof.
 */
export function compareHealth(
  before: ServiceHealth | null,
  after: ServiceHealth | null,
  minRequests = MIN_REQUESTS_FOR_A_VERDICT,
): TelemetryVerdict {
  if (before === null && after === null) {
    return { kind: "unavailable", reason: "no telemetry for this service in either window" };
  }
  if (before === null || after === null) {
    return {
      kind: "insufficient",
      reason: before === null ? "no telemetry before the change" : "no telemetry after the change yet",
      before,
      after,
    };
  }
  if (before.requests < minRequests || after.requests < minRequests) {
    return {
      kind: "insufficient",
      reason:
        `too little traffic to compare (${before.requests} requests before, ${after.requests} after; ` +
        `${minRequests} needed in each)`,
      before,
      after,
    };
  }
  return {
    kind: "compared",
    before,
    after,
    errorRateDelta: after.errorRate - before.errorRate,
    p95Delta: after.p95 - before.p95,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;

/**
 * The telemetry section of a pull request.
 *
 * States what was measured and never claims the change CAUSED it. Traffic mix
 * shifts, other deploys land, and a preview environment is not production —
 * a correlation reported as causation is the kind of claim a reader checks
 * once and then stops trusting the rest.
 */
export function telemetryComment(verdict: TelemetryVerdict, runId: string): string {
  const head = `Telemetry (run ${runId})`;
  switch (verdict.kind) {
    case "disabled":
      return `${head}\n\nNot measured: ${verdict.reason}.`;
    case "unavailable":
      return `${head}\n\nNo measurement: ${verdict.reason}.`;
    case "insufficient": {
      const lines = [`${head}\n\nNot enough data to compare — ${verdict.reason}.`];
      const shown = verdict.after ?? verdict.before;
      if (shown !== null) {
        lines.push(
          `\nFor context, ${shown.service} over the window measured: ${shown.requests} requests, ` +
            `${shown.errors} errors (${pct(shown.errorRate)}), p95 ${shown.p95}ms.`,
        );
      }
      lines.push(`\nThis is a measurement, not a verdict on the change.`);
      return lines.join("");
    }
    case "compared": {
      const { before, after } = verdict;
      const arrow = (d: number): string => (d > 0 ? "up" : d < 0 ? "down" : "flat");
      return (
        `${head}\n\n` +
        `| ${before.service} | before | after |\n|---|---|---|\n` +
        `| requests | ${before.requests} | ${after.requests} |\n` +
        `| errors | ${before.errors} (${pct(before.errorRate)}) | ${after.errors} (${pct(after.errorRate)}) |\n` +
        `| p95 | ${before.p95}ms | ${after.p95}ms |\n` +
        `| p99 | ${before.p99}ms | ${after.p99}ms |\n` +
        `| apdex | ${before.apdex.toFixed(2)} | ${after.apdex.toFixed(2)} |\n\n` +
        `Error rate ${arrow(verdict.errorRateDelta)} ${pct(Math.abs(verdict.errorRateDelta))}, ` +
        `p95 ${arrow(verdict.p95Delta)} ${Math.abs(verdict.p95Delta)}ms.\n\n` +
        `Measured over two windows around this change. Correlation only — other deploys and traffic mix are not controlled for.`
      );
    }
  }
}

/** Default comparison window, each side. */
export const DEFAULT_WINDOW_MINUTES = 30;

/**
 * Compare the window before this moment with the one before that.
 *
 * Two adjacent windows anchored at "now", rather than at the run's start: the
 * run's own duration varies from minutes to an hour, so anchoring there would
 * silently change the window length per run and make two runs incomparable.
 * What this buys is modest and the comment says so — it is a correlation
 * around a change, not proof of one.
 */
export async function compareAroundNow(target: TelemetryTarget, now: Date): Promise<TelemetryVerdict> {
  const minutes = target.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const ms = minutes * 60_000;
  const mid = new Date(now.getTime() - ms);
  const start = new Date(now.getTime() - 2 * ms);
  const before = await readServiceHealth(target, start, mid);
  const after = await readServiceHealth(target, mid, now);
  return compareHealth(before, after, target.minRequests);
}
