import { createHmac, timingSafeEqual } from "node:crypto";

import { EVENT_DETAIL_MAX, EVENT_TITLE_MAX, oneLine, type ShipEvent } from "../event-rules.js";
import { safeForDisplay } from "../redact.js";
import type { AdapterOptions, HeaderBag, MapOutcome, VendorAdapter, VerifyOutcome } from "./adapter.js";
import { parseJsonBody } from "./adapter.js";

/**
 * E7 EV4 — PagerDuty Webhooks v3.
 *
 * Verification (docs.pagerduty.com "Verifying Signatures", checked
 * 2026-10-17): the `X-PagerDuty-Signature` header carries a comma-separated
 * list of `v1=<hex HMAC-SHA256(secret, raw body)>` values. Multiple values
 * exist so a subscription's signing key can rotate with zero downtime, so
 * the check accepts ANY entry that matches. Every comparison is
 * constant-time over the decoded 32 bytes. Entries with an unknown version
 * prefix are ignored, not fatal — a future v2 must not brick every
 * receiver.
 *
 * The signature covers no timestamp, so freshness is soft (the route's
 * maxAge check on the event's occurredAt) backed by the delivery claim on
 * the event id.
 */

const SIGNATURE_HEADER = "x-pagerduty-signature";
const DELIVERY_HEADER = "x-webhook-id";

function verifyPagerDuty(headers: HeaderBag, rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const header = headers.get(SIGNATURE_HEADER) ?? "";
  const entries = header.split(",").map((entry) => entry.trim()).filter((entry) => entry.startsWith("v1="));
  if (entries.length === 0) return { ok: false, status: 401, reason: "malformed-signature" };
  const digest = createHmac("sha256", opts.secret).update(rawBody, "utf8").digest();
  for (const entry of entries) {
    const given = Buffer.from(entry.slice(3), "hex");
    if (given.length === digest.length && timingSafeEqual(given, digest)) return { ok: true };
  }
  return { ok: false, status: 401, reason: "bad-signature" };
}

/**
 * Only the four incident states the rule engine orders on are mapped.
 * `incident.acknowledged` is recorded (type incident.acknowledged) but no
 * default rule matches it; every other incident.* type (priority_updated,
 * escalated, annotated, …) maps to no event at all — the delivery is still
 * claimed, it just never becomes a task.
 */
const TYPE_MAP: Record<string, string> = {
  "incident.triggered": "incident.triggered",
  // A reopen is a new episode of the same incident: the engine opens one
  // because its occurredAt is past the close watermark.
  "incident.reopened": "incident.triggered",
  "incident.resolved": "incident.resolved",
  "incident.acknowledged": "incident.acknowledged",
};

export const pagerdutyAdapter: VendorAdapter = {
  verify: verifyPagerDuty,
  map(sourceId, headers, rawBody, _opts): MapOutcome {
    const payload = parseJsonBody(rawBody);
    if (payload === null) return { ok: false, status: 400, problem: "malformed pagerduty webhook body" };
    const event = payload.event as Record<string, unknown> | undefined;
    if (event === undefined || typeof event !== "object") {
      return { ok: false, status: 400, problem: "pagerduty webhook carries no event object" };
    }
    const eventId = oneLine(typeof event.id === "string" ? event.id : "", 200);
    if (eventId === "") {
      return { ok: false, status: 400, problem: "pagerduty webhook carries no event.id; refusing rather than deduping on nothing" };
    }
    const type = typeof event.event_type === "string" ? TYPE_MAP[event.event_type] : undefined;
    if (type === undefined) return { ok: true, events: [], deliveryId: oneLine(headers.get(DELIVERY_HEADER) ?? "", 200) || null };
    const occurred = typeof event.occurred_at === "string" ? Date.parse(event.occurred_at) : NaN;
    if (!Number.isFinite(occurred)) {
      return { ok: false, status: 400, problem: "pagerduty webhook carries no parsable event.occurred_at" };
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (typeof data.id !== "string" || data.id === "") {
      return { ok: false, status: 400, problem: "pagerduty webhook carries no event.data.id" };
    }
    const service = data.service as Record<string, unknown> | undefined;
    const serviceSummary = service !== null && typeof service === "object" && typeof service.summary === "string" ? service.summary : undefined;
    const priority = data.priority as Record<string, unknown> | undefined;
    const title = safeForDisplay(oneLine(typeof data.title === "string" ? data.title : `Incident ${String(data.id)}`, EVENT_TITLE_MAX + 60), EVENT_TITLE_MAX);
    const detail = safeForDisplay(
      [
        ...(serviceSummary !== undefined ? [`Service: ${oneLine(serviceSummary, 200)}`] : []),
        `Status: ${oneLine(typeof data.status === "string" ? data.status : "", 40)} Urgency: ${oneLine(typeof data.urgency === "string" ? data.urgency : "", 40)}`,
        ...(priority !== null && typeof priority === "object" && typeof priority.summary === "string" ? [`Priority: ${oneLine(priority.summary, 40)}`] : []),
        ...(typeof data.html_url === "string" ? [oneLine(data.html_url, 300)] : []),
      ].join("\n"),
      EVENT_DETAIL_MAX,
    );
    const number = typeof data.number === "number" && Number.isFinite(data.number) ? data.number : undefined;
    const mapped: ShipEvent = {
      source: sourceId,
      type,
      eventId,
      subject: `pagerduty:${oneLine(data.id, 100)}`,
      occurredAt: new Date(occurred).toISOString(),
      // The service summary is the attribution hint: a service name resolved
      // through the project records, never a URL the payload picked.
      ...(serviceSummary !== undefined ? { repoHint: oneLine(serviceSummary, 200) } : {}),
      title,
      detail,
      attrs: {
        ...(number !== undefined ? { number } : {}),
        ...(typeof data.status === "string" ? { status: oneLine(data.status, 40) } : {}),
        ...(typeof data.urgency === "string" ? { urgency: oneLine(data.urgency, 40) } : {}),
        ...(priority !== null && typeof priority === "object" && typeof priority.summary === "string" ? { priority: oneLine(priority.summary, 40) } : {}),
        ...(serviceSummary !== undefined ? { service: oneLine(serviceSummary, 200) } : {}),
        ...(typeof data.incident_key === "string" && data.incident_key !== "" ? { incident_key: oneLine(data.incident_key, 200) } : {}),
        ...(typeof event.resource_type === "string" ? { resource: oneLine(event.resource_type, 40) } : {}),
      },
    };
    return { ok: true, events: [mapped], deliveryId: oneLine(headers.get(DELIVERY_HEADER) ?? "", 200) || null };
  },
};
