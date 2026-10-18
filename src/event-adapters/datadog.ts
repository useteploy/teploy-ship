import { EVENT_DETAIL_MAX, EVENT_TITLE_MAX, oneLine, type ShipEvent } from "../event-rules.js";
import { safeForDisplay } from "../redact.js";
import type { AdapterOptions, HeaderBag, MapOutcome, VendorAdapter, VerifyOutcome } from "./adapter.js";
import { parseJsonBody } from "./adapter.js";
import { constantTimeEqualStrings } from "./verify.js";

/**
 * E7 EV4 — Datadog monitor webhooks.
 *
 * Datadog has NO payload signature (docs.datadoghq.com/integrations/webhooks,
 * checked 2026-10-17): the only authenticator is a custom header whose name
 * and value the operator defines in the webhook tile. That makes this a
 * shared-secret source in EV2's terms: the token is compared in constant
 * time against SHIP_EVENT_SECRET_<ID>, a rule with policy "auto" on it is
 * refused at save (Decision 12, 2026-10-17), and freshness is soft — the
 * template's `at` field, backed by the delivery claim on the template id.
 *
 * The default Datadog payload is not documented as stable JSON fields, so
 * Ship publishes one required payload template (below) and refuses anything
 * that is missing its keys: a template-less body would have no event id,
 * and deduping it on body bytes would treat every monitor-grouped
 * re-notification as a new event.
 */

/** The payload template a Ship operator pastes into the Datadog webhook tile. */
export const DATADOG_PAYLOAD_TEMPLATE =
  '{"id":"$ID","transition":"$ALERT_TRANSITION","monitor":"$ALERT_ID","cycle":"$ALERT_CYCLE_KEY","aggreg":"$AGGREG_KEY","title":"$EVENT_TITLE","priority":"$ALERT_PRIORITY","scope":"$ALERT_SCOPE","tags":"$TAGS","service":"$TAGS[service]","at":"$LAST_UPDATED_POSIX","link":"$LINK"}';

const DEFAULT_TOKEN_HEADER = "x-teploy-token";

const TEMPLATE_KEYS = ["id", "transition", "monitor", "cycle", "title", "at"] as const;

function verifyDatadog(headers: HeaderBag, _rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const name = opts.tokenHeader ?? DEFAULT_TOKEN_HEADER;
  const token = headers.get(name) ?? "";
  if (token === "" || !constantTimeEqualStrings(token, opts.secret)) {
    return { ok: false, status: 401, reason: "bad event token" };
  }
  return { ok: true };
}

function transitionType(transition: string): string {
  const t = transition.toLowerCase();
  if (t === "triggered" || t === "re-triggered" || t.startsWith("retriggered")) return "alert.triggered";
  if (t === "recovered") return "alert.recovered";
  // Warn / No Data (and their re- forms) and Renotify are recorded but match
  // no default rule: an operator who wants them writes a rule for alert.warn.
  return "alert.warn";
}

export const datadogAdapter: VendorAdapter = {
  verify: verifyDatadog,
  map(sourceId, _headers, rawBody, _opts): MapOutcome {
    const payload = parseJsonBody(rawBody);
    if (payload === null) {
      return { ok: false, status: 400, problem: "malformed datadog webhook body" };
    }
    for (const key of TEMPLATE_KEYS) {
      const value = payload[key];
      if (typeof value !== "string" || value.trim() === "") {
        return {
          ok: false,
          status: 400,
          problem: `datadog webhook body is missing "${key}"; configure the webhook payload with Ship's template: ${DATADOG_PAYLOAD_TEMPLATE}`,
        };
      }
    }
    const id = oneLine(payload.id as string, 200);
    // $LAST_UPDATED_POSIX is seconds; tolerate a pasted $LAST_UPDATED (ms).
    const at = Number(payload.at);
    if (!Number.isFinite(at) || at <= 0) return { ok: false, status: 400, problem: "datadog webhook \"at\" is not a timestamp" };
    const occurredAt = new Date(at < 1e11 ? at * 1000 : at).toISOString();
    const transition = oneLine(payload.transition as string, 60);
    const title = safeForDisplay(oneLine(payload.title as string, EVENT_TITLE_MAX + 60), EVENT_TITLE_MAX);
    const service = oneLine((payload.service as string | undefined) ?? "", 200);
    const detail = safeForDisplay(
      [
        `Transition: ${transition} Priority: ${oneLine((payload.priority as string | undefined) ?? "", 20)}`,
        `Monitor: ${oneLine(payload.monitor as string, 100)}`,
        `Scope: ${oneLine((payload.scope as string | undefined) ?? "", 400)}`,
        oneLine((payload.link as string | undefined) ?? "", 400),
      ].filter((line) => line !== "").join("\n"),
      EVENT_DETAIL_MAX,
    );
    const event: ShipEvent = {
      source: sourceId,
      type: transitionType(transition),
      eventId: id,
      // One episode per monitor alert cycle, so a Recovered closes the
      // episode the Triggered on the same cycle opened.
      subject: `datadog:${oneLine(payload.monitor as string, 100)}/${oneLine(payload.cycle as string, 100)}`,
      occurredAt,
      ...(service !== "" ? { repoHint: service } : {}),
      title,
      detail,
      attrs: {
        transition,
        monitor: oneLine(payload.monitor as string, 100),
        ...(service !== "" ? { service } : {}),
        ...typeof payload.priority === "string" && payload.priority !== "" ? { priority: oneLine(payload.priority, 20) } : {},
        ...typeof payload.scope === "string" && payload.scope !== "" ? { scope: oneLine(payload.scope, 300) } : {},
        ...typeof payload.tags === "string" && payload.tags !== "" ? { tags: oneLine(payload.tags, 300) } : {},
        ...typeof payload.link === "string" && payload.link !== "" ? { link: oneLine(payload.link, 300) } : {},
      },
    };
    return { ok: true, events: [event], deliveryId: null };
  },
};
