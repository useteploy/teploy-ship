import { EVENT_DETAIL_MAX, EVENT_TITLE_MAX, oneLine, type ShipEvent } from "../event-rules.js";
import { safeForDisplay } from "../redact.js";
import type { AdapterOptions, HeaderBag, MapOutcome, VendorAdapter, VerifyOutcome } from "./adapter.js";
import { parseJsonBody } from "./adapter.js";
import { verifyWebhookSignature } from "./verify.js";

/**
 * E7 EV4 — Jira Cloud admin webhooks (developer.atlassian.com/cloud/jira/
 * platform/webhooks, checked 2026-10-17).
 *
 * Verification: webhooks registered with a secret are signed WebSub-style —
 * `X-Hub-Signature: <method>=<hex HMAC(method, secret, raw body)>`. The
 * method prefix MUST be parsed rather than assumed: Atlassian's own examples
 * warn the algorithm may change, so an unknown method is a 401 "cannot
 * verify", never a silent fallback to sha256. Atlassian documents this test
 * vector, which the tests pin so a regression in the parse or the compare
 * is caught without a live Jira:
 *
 *   secret   "It's a Secret to Everybody"
 *   payload  "Hello World!"
 *   header   sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9
 *
 * The signature covers no timestamp, so freshness is soft (maxAge on the
 * body's `timestamp`), backed by the delivery claim on the
 * `X-Atlassian-Webhook-Identifier` header — unique per tenant, identical
 * across the up-to-five retries.
 *
 * Ordering matters more here than anywhere else: `Secondary` flow deliveries
 * (bulk/cascade fallout) may lag 15 minutes behind their `Primary`, so the
 * engine's subject watermark is what keeps an old update from re-opening an
 * episode a newer event already closed.
 */

const SIGNATURE_HEADER = "x-hub-signature";
const IDENTIFIER_HEADER = "x-atlassian-webhook-identifier";
const FLOW_HEADER = "x-atlassian-webhook-flow";

function verifyJira(headers: HeaderBag, rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const header = (headers.get(SIGNATURE_HEADER) ?? "").trim();
  // WebSub method=signature; anything else cannot be verified as-is.
  const parsed = /^([A-Za-z0-9]+)=([0-9A-Fa-f]+)$/.exec(header);
  if (parsed === null) return { ok: false, status: 401, reason: "malformed-signature" };
  const method = parsed[1]!.toLowerCase();
  if (method !== "sha256") return { ok: false, status: 401, reason: `unsupported-signature-method: ${method}` };
  const ok = verifyWebhookSignature(rawBody, header, { header: SIGNATURE_HEADER, prefix: "sha256=", encoding: "hex" }, opts.secret);
  return ok ? { ok: true } : { ok: false, status: 401, reason: "bad-signature" };
}

/** A labels changelog item's toString is the comma-separated new label set. */
function changelogAddsLabel(changelog: Record<string, unknown> | undefined, label: string): boolean {
  const items = changelog?.items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (item === null || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    // ["toString"] not .toString: the field is a payload key that shadows
    // Object.prototype.toString for plain property access.
    const updated = entry["toString"];
    return entry.field === "labels" && typeof updated === "string"
      && updated.split(",").map((part) => part.trim()).includes(label);
  });
}

function fieldsOf(issue: Record<string, unknown>): Record<string, unknown> {
  const fields = issue.fields;
  return fields !== null && typeof fields === "object" && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
}

export const jiraAdapter: VendorAdapter = {
  verify: verifyJira,
  map(sourceId, headers, rawBody, opts): MapOutcome {
    const payload = parseJsonBody(rawBody);
    if (payload === null) return { ok: false, status: 400, problem: "malformed jira webhook body" };
    const deliveryId = oneLine(headers.get(IDENTIFIER_HEADER) ?? "", 200);
    if (deliveryId === "") {
      return { ok: false, status: 400, problem: "jira webhook carries no X-Atlassian-Webhook-Identifier; refusing rather than deduping on nothing" };
    }
    const timestamp = Number(payload.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return { ok: false, status: 400, problem: "jira webhook carries no parsable timestamp" };
    }
    const occurredAt = new Date(timestamp < 1e11 ? timestamp * 1000 : timestamp).toISOString();
    const flow = oneLine(headers.get(FLOW_HEADER) ?? "", 20);
    const event = payload.webhookEvent;

    if (event === "comment_created") {
      // Recorded only: no default rule matches ticket.comment.
      const issue = (payload.issue ?? {}) as Record<string, unknown>;
      const comment = (payload.comment ?? {}) as Record<string, unknown>;
      if (typeof issue.key !== "string" || issue.key === "") {
        return { ok: false, status: 400, problem: "comment webhook carries no issue.key" };
      }
      const fields = fieldsOf(issue);
      const summary = oneLine(typeof fields.summary === "string" ? fields.summary : "", EVENT_TITLE_MAX);
      const body = safeForDisplay(oneLine(typeof comment.body === "string" ? comment.body : "", 2_000), 2_000);
      const commentEvent: ShipEvent = {
        source: sourceId,
        type: "ticket.comment",
        eventId: deliveryId,
        subject: `jira:${oneLine(issue.key, 60)}`,
        occurredAt,
        title: safeForDisplay(`[${oneLine(issue.key, 40)}] ${summary}`, EVENT_TITLE_MAX),
        detail: body,
        attrs: { ...(flow !== "" ? { flow } : {}) },
      };
      return { ok: true, events: [commentEvent], deliveryId };
    }

    if (event === "jira:issue_created" || event === "jira:issue_updated") {
      const issue = (payload.issue ?? {}) as Record<string, unknown>;
      if (typeof issue.key !== "string" || issue.key === "") {
        return { ok: false, status: 400, problem: "issue webhook carries no issue.key" };
      }
      const fields = fieldsOf(issue);
      const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === "string") : [];
      const label = opts.label ?? "";
      // On create the label being present is the trigger; on update ONLY a
      // changelog add counts, or every later edit of a labelled issue would
      // re-fire the task.
      const labelled =
        event === "jira:issue_created" ? label !== "" && labels.includes(label)
        : label !== "" && changelogAddsLabel(payload.changelog as Record<string, unknown> | undefined, label);
      if (!labelled) return { ok: true, events: [], deliveryId };
      const summary = oneLine(typeof fields.summary === "string" ? fields.summary : "", EVENT_TITLE_MAX + 60);
      const project = fields.project as Record<string, unknown> | undefined;
      const issuetype = fields.issuetype as Record<string, unknown> | undefined;
      const priority = fields.priority as Record<string, unknown> | undefined;
      const status = fields.status as Record<string, unknown> | undefined;
      const user = payload.user as Record<string, unknown> | undefined;
      const description = safeForDisplay(oneLine(typeof fields.description === "string" ? fields.description : "", 2_000), 2_000);
      const labelledEvent: ShipEvent = {
        source: sourceId,
        type: "ticket.labelled",
        eventId: deliveryId,
        subject: `jira:${oneLine(issue.key, 60)}`,
        occurredAt,
        title: safeForDisplay(`[${oneLine(issue.key, 40)}] ${summary}`, EVENT_TITLE_MAX),
        detail: safeForDisplay(
          [description, `Labels: ${labels.map((l) => oneLine(l, 60)).join(", ")}`].filter((line) => line !== "").join("\n"),
          EVENT_DETAIL_MAX,
        ),
        attrs: {
          label,
          labels: oneLine(labels.join(","), 300),
          ...(project !== null && typeof project === "object" && typeof project.key === "string" ? { project: oneLine(project.key, 20) } : {}),
          ...(issuetype !== null && typeof issuetype === "object" && typeof issuetype.name === "string" ? { type: oneLine(issuetype.name, 60) } : {}),
          ...(priority !== null && typeof priority === "object" && typeof priority.name === "string" ? { priority: oneLine(priority.name, 60) } : {}),
          ...(status !== null && typeof status === "object" && typeof status.name === "string" ? { status: oneLine(status.name, 60) } : {}),
          ...(user !== null && typeof user === "object" && typeof user.displayName === "string" ? { user: oneLine(user.displayName, 100) } : {}),
          ...(flow !== "" ? { flow } : {}),
        },
      };
      return { ok: true, events: [labelledEvent], deliveryId };
    }

    // Every other webhookEvent (worklog, attachment, sprint, …) maps to
    // nothing: claimed, logged, never a task.
    return { ok: true, events: [], deliveryId };
  },
};
