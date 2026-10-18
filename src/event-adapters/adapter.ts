import type { ShipEvent } from "../event-rules.js";

/**
 * E7 EV4 — the shared contract every vendor adapter implements. An adapter is
 * two pure functions over one webhook delivery:
 *
 *   verify(headers, rawBody, options)  -> ok | { status, reason }
 *   map(sourceId, headers, rawBody, options) -> ShipEvent[] | { status, problem }
 *
 * `verify` authenticates the delivery with the source's secret (deployment
 * config, never a parameter the payload controls); `map` turns the verified
 * raw body into typed ShipEvents with every free-text field clamped and
 * redacted HERE, exactly like shipEventFromEnvelope does for the generic
 * envelope. Neither reads the clock, the store or the network: `nowMs` is
 * passed in, so the modules stay deterministic and testable.
 *
 * Every adapter MUST refuse a payload without the vendor's own event or
 * delivery id (400) rather than fall back to a body hash: deduping an
 * id-less vendor delivery on its bytes would treat every retry of a mutable
 * payload as a new event (the EV4 slice contract).
 */

/** Case-insensitive header lookup; Request.headers satisfies this directly. */
export interface HeaderBag {
  get(name: string): string | null;
}

export interface AdapterOptions {
  secret: string;
  nowMs: number;
  /** The source's auth class; for GitLab it selects signature vs token verification. */
  auth: "hmac" | "shared-secret";
  /** Hard freshness window (seconds) for schemes whose signature covers a timestamp. */
  replayWindowSeconds?: number;
  /** Shared-secret vendors: the header the sender puts the token in. */
  tokenHeader?: string;
  /** Jira/GitLab issues: the label that maps an issue to ticket.labelled. */
  label?: string;
}

export type VerifyOutcome = { ok: true } | { ok: false; status: 400 | 401; reason: string };

export type MapOutcome =
  | { ok: true; events: ShipEvent[]; deliveryId: string | null }
  | { ok: false; status: 400; problem: string };

export interface VendorAdapter {
  verify(headers: HeaderBag, rawBody: string, opts: AdapterOptions): VerifyOutcome;
  map(sourceId: string, headers: HeaderBag, rawBody: string, opts: AdapterOptions): MapOutcome;
}

/** JSON.parse guarded so a malformed body maps to a 400, never a throw. */
export function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
