import { EVENT_DETAIL_MAX, EVENT_TITLE_MAX, oneLine, type ShipEvent } from "../event-rules.js";
import { safeForDisplay } from "../redact.js";
import type { AdapterOptions, HeaderBag, MapOutcome, VendorAdapter, VerifyOutcome } from "./adapter.js";
import { parseJsonBody } from "./adapter.js";
import { verifyWebhookSignature } from "./verify.js";

/**
 * E7 EV4 — Sentry integration-platform webhooks.
 *
 * Verification (docs.sentry.io, "Webhooks" / "Issues" / "Issue Alerts",
 * checked 2026-10-17): the `Sentry-Hook-Signature` header is the hex
 * HMAC-SHA256 of the body keyed with the integration's client secret. The
 * docs' sample code re-serializes the parsed body before signing it
 * (`JSON.stringify(request.body)`), which no receiver can reproduce
 * byte-for-byte; the only thing a receiver CAN check is the raw body it was
 * handed, so that is what we sign, exactly like every other HMAC webhook.
 * Sentry sends a `Sentry-Hook-Timestamp` too, but its role is not
 * documented and it is not part of the signed message, so freshness stays
 * soft: the route's maxAge check on the mapped event's occurredAt (the
 * issue's lastSeen) is what bounds replay, backed by the delivery claim on
 * `Request-ID`.
 *
 * The legacy plugin webhooks (pre-integration-platform) carry no signature
 * at all and have no official schema; they are deliberately NOT supported
 * here. A source that cannot present a Sentry signature cannot be
 * registered as vendor "sentry" (VENDOR_AUTH), which is the point.
 */

const SIGNATURE_HEADER = "sentry-hook-signature";
const RESOURCE_HEADER = "sentry-hook-resource";
const REQUEST_ID_HEADER = "request-id";

function verifySentry(headers: HeaderBag, rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const ok = verifyWebhookSignature(rawBody, headers.get(SIGNATURE_HEADER), { header: SIGNATURE_HEADER, encoding: "hex" }, opts.secret);
  return ok ? { ok: true } : { ok: false, status: 401, reason: "bad-signature" };
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isoOr(problem: string, value: unknown): { ok: true; iso: string } | { ok: false; problem: string } {
  if (typeof value !== "string" && typeof value !== "number") return { ok: false, problem };
  const ms = typeof value === "number" ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, problem };
  return { ok: true, iso: new Date(ms).toISOString() };
}

/** issue resource: `created` | `unresolved` | `resolved` map; other actions are recorded as no event. */
function issueEvent(sourceId: string, action: unknown, issue: Record<string, unknown> | undefined): { ok: true; event: ShipEvent } | { ok: false; problem: string } | { ok: true; event: null } {
  if (issue === undefined || typeof issue.id !== "string" || issue.id === "") {
    return { ok: false, problem: "issue webhook carries no data.issue.id" };
  }
  let type: string | null = null;
  if (action === "created") type = "issue.new";
  else if (action === "unresolved") type = "issue.regression";
  else if (action === "resolved") type = "issue.resolved";
  // assigned/archived change nothing the rule engine orders on; the delivery
  // is claimed and logged without an event.
  if (type === null) return { ok: true, event: null };
  const when = isoOr("issue webhook carries no usable lastSeen/firstSeen timestamp", issue.lastSeen ?? issue.firstSeen);
  if (!when.ok) return { ok: false, problem: when.problem };
  const project = issue.project as Record<string, unknown> | undefined;
  const slug = project !== null && typeof project === "object" && typeof project.slug === "string" ? project.slug : "unknown-project";
  const count = num(issue.count);
  const userCount = num(issue.userCount);
  const title = safeForDisplay(oneLine(typeof issue.title === "string" ? issue.title : `Sentry issue ${issue.id}`, EVENT_TITLE_MAX + 60), EVENT_TITLE_MAX);
  const detail = safeForDisplay(
    [
      `Culprit: ${oneLine(typeof issue.culprit === "string" ? issue.culprit : "", 300)}`,
      `Level: ${oneLine(typeof issue.level === "string" ? issue.level : "", 40)} Status: ${oneLine(typeof issue.status === "string" ? issue.status : "", 40)}`,
      typeof issue.web_url === "string" ? `Issue: ${oneLine(issue.web_url, 300)}` : "",
    ].filter((line) => line !== "").join("\n"),
    EVENT_DETAIL_MAX,
  );
  return {
    ok: true,
    event: {
      source: sourceId,
      type,
      eventId: "", // filled by the caller: Sentry's stable id is the Request-ID header
      // One integration serves one Sentry org, and issue ids are unique
      // there, so the bare id scopes the episode without splitting it
      // between the issue and event_alert resources (a slug would: the
      // event_alert payload carries only a numeric project).
      subject: `sentry:issue/${oneLine(issue.id, 100)}`,
      occurredAt: when.iso,
      title,
      detail,
      attrs: {
        ...(typeof issue.level === "string" && issue.level !== "" ? { level: oneLine(issue.level, 40) } : {}),
        ...(typeof issue.status === "string" && issue.status !== "" ? { status: oneLine(issue.status, 40) } : {}),
        ...(typeof issue.substatus === "string" && issue.substatus !== "" ? { substatus: oneLine(issue.substatus, 40) } : {}),
        project_slug: oneLine(slug, 100),
        ...(count !== undefined ? { count } : {}),
        ...(userCount !== undefined ? { user_count: userCount } : {}),
        ...(typeof issue.shortId === "string" && issue.shortId !== "" ? { short_id: oneLine(issue.shortId, 60) } : {}),
        ...(typeof issue.culprit === "string" && issue.culprit !== "" ? { culprit: oneLine(issue.culprit, 200) } : {}),
      },
    },
  };
}

/** event_alert resource: `action` is always `triggered`. */
function alertEvent(sourceId: string, event: Record<string, unknown> | undefined, triggeredRule: unknown): { ok: true; event: ShipEvent } | { ok: false; problem: string } | { ok: true; event: null } {
  if (event === undefined || typeof event.issue_id !== "string" || event.issue_id === "") {
    return { ok: false, problem: "event_alert webhook carries no data.event.issue_id" };
  }
  const when = isoOr("event_alert webhook carries no usable datetime/timestamp", event.datetime ?? event.timestamp);
  if (!when.ok) return { ok: false, problem: when.problem };
  const tags = new Map<string, string>();
  if (Array.isArray(event.tags)) {
    for (const pair of event.tags.slice(0, 40)) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
        tags.set(oneLine(pair[0], 60), oneLine(pair[1], 120));
      }
    }
  }
  const environment = tags.get("environment");
  const title = safeForDisplay(oneLine(typeof event.title === "string" ? event.title : `Sentry alert on issue ${event.issue_id}`, EVENT_TITLE_MAX + 60), EVENT_TITLE_MAX);
  const detail = safeForDisplay(
    [
      `Culprit: ${oneLine(typeof event.culprit === "string" ? event.culprit : "", 300)}`,
      typeof event.release === "string" && event.release !== "" ? `Release: ${oneLine(event.release, 120)}` : "",
      environment !== undefined ? `Environment: ${oneLine(environment, 120)}` : "",
      typeof triggeredRule === "string" && triggeredRule !== "" ? `Rule: ${oneLine(triggeredRule, 200)}` : "",
      typeof event.web_url === "string" ? `Event: ${oneLine(event.web_url, 300)}` : "",
    ].filter((line) => line !== "").join("\n"),
    EVENT_DETAIL_MAX,
  );
  return {
    ok: true,
    event: {
      source: sourceId,
      type: "alert.triggered",
      eventId: "",
      subject: `sentry:issue/${oneLine(event.issue_id, 100)}`,
      occurredAt: when.iso,
      title,
      detail,
      attrs: {
        ...(typeof event.level === "string" && event.level !== "" ? { level: oneLine(event.level, 40) } : {}),
        ...(typeof event.release === "string" && event.release !== "" ? { release: oneLine(event.release, 120) } : {}),
        // "environment" is only present when the SDK tags it; conditions
        // must tolerate its absence (attr missing = not equal).
        ...(environment !== undefined ? { environment: oneLine(environment, 120) } : {}),
        ...(typeof triggeredRule === "string" && triggeredRule !== "" ? { triggered_rule: oneLine(triggeredRule, 200) } : {}),
        ...(typeof event.culprit === "string" && event.culprit !== "" ? { culprit: oneLine(event.culprit, 200) } : {}),
      },
    },
  };
}

export const sentryAdapter: VendorAdapter = {
  verify: verifySentry,
  map(sourceId, headers, rawBody, _opts): MapOutcome {
    const payload = parseJsonBody(rawBody);
    if (payload === null) {
      return { ok: false, status: 400, problem: "malformed sentry webhook body" };
    }
    // Sentry's own retry-stable id is the Request-ID header; the payloads
    // carry none. Refusing an id-less delivery beats deduping on body bytes.
    const requestId = oneLine(headers.get(REQUEST_ID_HEADER) ?? "", 200);
    if (requestId === "") {
      return { ok: false, status: 400, problem: "sentry webhook carries no Request-ID header; refusing rather than deduping on nothing" };
    }
    const resource = headers.get(RESOURCE_HEADER) ?? "";
    const body = payload as { action?: unknown; data?: unknown };
    const data = body.data as Record<string, unknown> | undefined;
    const mapped =
      resource === "issue" ? issueEvent(sourceId, body.action, data?.issue as Record<string, unknown> | undefined)
      : resource === "event_alert" ? alertEvent(sourceId, data?.event as Record<string, unknown> | undefined, data?.triggered_rule)
      : { ok: true as const, event: null }; // installation/comment/... resources map to nothing
    if (!mapped.ok) return { ok: false, status: 400, problem: mapped.problem };
    const event = mapped.event === null ? null : { ...mapped.event, eventId: requestId };
    return { ok: true, events: event === null ? [] : [event], deliveryId: requestId };
  },
};
