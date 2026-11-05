/**
 * Ship reading Observe with a scoped SERVICE TOKEN (Programme B, plan
 * DASH_AUTOCONFIG 10.2/10.6): an `obs_svc_...` token carrying `alerts:read`
 * authenticates with `Authorization: Bearer` to
 * `/api/v1/service/sites/{site_id}/alerts/*` — and to nothing else, which is
 * Observe's structural boundary (docs/service-tokens.md: a service token is
 * not a JWT, a telemetry key or a share token, so it cannot reach users, SQL
 * or stored telemetry even by accident).
 *
 * This is deliberately NOT the existing share-token read path: RED-metric
 * reads (`/api/v1/traces/services`, observe.ts) stay on OBSERVE_READ_TOKEN,
 * because Observe answers a service token there with exactly the same 401 it
 * gives anyone else. Two credentials, two surfaces, no crossover.
 *
 * What uses this today: the Settings connection check (a service-token
 * alerts:read call is the one probe that proves the whole wiring — endpoint,
 * token, scope and site ownership — rather than just "the server is up") and
 * the incidents page's alert-state panel. Both are reads; nothing here
 * writes, and there is nothing to write: alerts:read is a read scope.
 *
 * Pure module with an injectable fetch, browser-safe by construction like
 * observe-endpoint.ts (the web side imports it from dist/).
 */

import { observeBaseFromEnv } from "./observe-endpoint.js";
import type { ObserveWarn } from "./observe-endpoint.js";

/** The token prefix Observe mints (internal/svctoken Prefix). */
export const SERVICE_TOKEN_PREFIX = "obs_svc_";

export interface ObserveServiceAuth {
  /** Observe base URL (any family spelling — observe-endpoint.ts resolves it). */
  base: string;
  /** The obs_svc_... token. */
  token: string;
  /** The site whose alerts this deployment may read — the token's manager must own it. */
  siteId: string;
}

/**
 * Resolve the service-token wiring: base URL (family env contract) +
 * OBSERVE_SERVICE_TOKEN + OBSERVE_SITE. All three or nothing.
 *
 * A token without the obs_svc_ prefix is refused locally with a warning
 * naming the expectation: everything else would be a guaranteed 401 against
 * a credential the operator probably pasted from the wrong field.
 */
export function observeServiceAuthFromEnv(env: NodeJS.ProcessEnv, warn?: ObserveWarn): ObserveServiceAuth | undefined {
  const say = warn ?? ((line: string) => console.warn(line));
  const base = observeBaseFromEnv(env, warn);
  const token = (env.OBSERVE_SERVICE_TOKEN ?? "").trim();
  const siteId = (env.OBSERVE_SITE ?? "").trim();
  if (base === null || token === "" || siteId === "") return undefined;
  if (!token.startsWith(SERVICE_TOKEN_PREFIX)) {
    say(`[observe] OBSERVE_SERVICE_TOKEN does not start with ${SERVICE_TOKEN_PREFIX} — that is a service token's shape; an ingest key or share token will be refused by /api/v1/service/*.`);
    return undefined;
  }
  return { base: base.base, token, siteId };
}

/** The alert-rule fields Ship surfaces (Observe platform.AlertRule). */
export interface ObserveAlertRule {
  rule_id: string;
  name: string;
  metric: string;
  severity: string;
  enabled: boolean;
}

/** One triggered alert (Observe platform.AlertHistoryEntry). */
export interface ObserveAlertHistoryEntry {
  alert_id: string;
  rule_id: string;
  triggered_at: string;
  metric_value: number;
  threshold: number;
  status: string;
}

/**
 * What one read established. Same distinction as observe.ts's ServiceRead:
 * `rejected` is a fact about the WIRING (credential, scope, ownership,
 * reachability), never about the alerts, and collapsing it into "no alerts"
 * would print a lie at the exact moment an operator is looking.
 */
export type AlertsRead<T> = { kind: "ok"; value: T } | { kind: "rejected"; reason: string };

export interface ServiceReadOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** GET /api/v1/service/sites/{site}/alerts/rules — proves the token, scope and site ownership. */
export async function readAlertRules(auth: ObserveServiceAuth, options: ServiceReadOptions = {}): Promise<AlertsRead<ObserveAlertRule[]>> {
  return serviceGet(auth, `/api/v1/service/sites/${encodeURIComponent(auth.siteId)}/alerts/rules`, options, parseRules);
}

/** GET /api/v1/service/sites/{site}/alerts/history?limit=N — what fired, most recent first. */
export async function readAlertHistory(
  auth: ObserveServiceAuth,
  limit: number,
  options: ServiceReadOptions = {},
): Promise<AlertsRead<ObserveAlertHistoryEntry[]>> {
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
  return serviceGet(
    auth,
    `/api/v1/service/sites/${encodeURIComponent(auth.siteId)}/alerts/history?limit=${capped}`,
    options,
    parseHistory,
  );
}

async function serviceGet<T>(
  auth: ObserveServiceAuth,
  path: string,
  options: ServiceReadOptions,
  parse: (body: unknown) => T[] | null,
): Promise<AlertsRead<T[]>> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const res = await doFetch(`${auth.base}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${auth.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return { kind: "rejected", reason: refusedReason(res.status) };
    const body = await res.json().catch(() => null);
    const rows = parse(body);
    if (rows === null) return { kind: "rejected", reason: "Observe returned an unexpected body" };
    return { kind: "ok", value: rows };
  } catch (error) {
    return { kind: "rejected", reason: `Observe could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Observe's service API error contract (docs/service-tokens.md), in words an operator can act on. */
function refusedReason(status: number): string {
  switch (status) {
    case 401:
      return "Observe refused the service token (401): invalid or revoked";
    case 403:
      return "the token lacks the alerts:read scope (403)";
    case 404:
      return "the site is not managed by this token (404) — Observe answers a foreign site exactly like a missing one";
    case 429:
      return "Observe is rate-limiting this client (429); retry after Retry-After";
    case 503:
      return "Observe's store is unavailable (503); retry — not a verdict on the token";
    default:
      return `Observe answered ${status}`;
  }
}

function parseRules(body: unknown): ObserveAlertRule[] | null {
  if (!Array.isArray(body)) return null;
  const rows: ObserveAlertRule[] = [];
  for (const r of body) {
    if (typeof r !== "object" || r === null) return null;
    const rule = r as Record<string, unknown>;
    if (typeof rule.rule_id !== "string") return null;
    rows.push({
      rule_id: rule.rule_id,
      name: typeof rule.name === "string" ? rule.name : "",
      metric: typeof rule.metric === "string" ? rule.metric : "",
      severity: typeof rule.severity === "string" ? rule.severity : "",
      enabled: rule.enabled === true,
    });
  }
  return rows;
}

function parseHistory(body: unknown): ObserveAlertHistoryEntry[] | null {
  if (!Array.isArray(body)) return null;
  const rows: ObserveAlertHistoryEntry[] = [];
  for (const r of body) {
    if (typeof r !== "object" || r === null) return null;
    const entry = r as Record<string, unknown>;
    if (typeof entry.alert_id !== "string" || typeof entry.rule_id !== "string") return null;
    rows.push({
      alert_id: entry.alert_id,
      rule_id: entry.rule_id,
      triggered_at: typeof entry.triggered_at === "string" ? entry.triggered_at : "",
      metric_value: typeof entry.metric_value === "number" ? entry.metric_value : Number(entry.metric_value) || 0,
      threshold: typeof entry.threshold === "number" ? entry.threshold : Number(entry.threshold) || 0,
      status: typeof entry.status === "string" ? entry.status : "",
    });
  }
  return rows;
}
