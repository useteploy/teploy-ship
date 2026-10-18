import { createHash, timingSafeEqual } from "node:crypto";

import { BodyTooLarge, firstHeader, json, readCappedBody } from "./webhook.server.js";
import { proposeExternal, RepoNotAllowedError } from "teploy-ship/runtime";
// dist imports keep this module out of the client bundle: everything here is
// node-only behind the .server strip (the same reason incident-intake.server
// imports dist/incidents.js directly).
import { verifyEvent } from "../../../dist/tool-manifest.js";
import type { EventEnvelope } from "../../../dist/tool-manifest.js";
import {
  eventRulesMode,
  eventSourceSecret,
  parseEventEnvelope,
  ruleSeesEvent,
  shipEventFromEnvelope,
  decideEvent,
  type EventRule,
  type ShipEvent,
  type EventSourceRecord,
} from "../../../dist/event-rules.js";
import { eventVendorAdapter, vendorSignatureCoversTimestamp } from "../../../dist/event-adapters/index.js";
import {
  getEventRule,
  getEventSource,
  listEventRules,
  listEventSources,
  listSeenEvents,
  processEvent,
  readSubject,
  recordSeenEvent,
  saveEventRule,
  saveEventSource,
} from "../../../dist/event-subjects.js";
import type { RuntimeConfigStore } from "../../../dist/runtime-config.js";
import type { IntakeStore, IntakeTask, ProposeInput } from "../../../dist/intake.js";
import { normalizeDedupeKey } from "../../../dist/intake.js";
import { shipRuntime } from "./store.server.js";

/**
 * E7 EV2 — the generic signed event receiver (`POST /hooks/events/:source`)
 * plus the operator surfaces for rules (list/save, dry run) and sources.
 *
 * The receiver follows the house webhook pattern exactly (webhook.server.ts):
 * body capped BEFORE any signature work, constant-time HMAC with the
 * timestamp bound into the signed message, a durable delivery-id claim, and
 * a 503 when the leg is not configured. The body is the S24 EventEnvelope
 * (X-Teploy-Timestamp / X-Teploy-Signature over "<ts>.<body>"), verified
 * with the same verifyEvent the notification envelopes use — with the
 * in-memory dedupe left out, because THIS surface dedupes durably through
 * the DeliveryLog instead.
 *
 * Flag: SHIP_EVENT_RULES=off (default; the route answers 503) | shadow
 * (evaluate and log only; writes nothing but the seen-event ring) | on.
 *
 * Sources without a real signature (shared-secret) are accepted as
 * first-class senders but can never carry an auto rule: that refusal is
 * validateEventRule's, enforced at save (Decision 12, 2026-10-17).
 *
 * EV4 adds the vendor leg: a source whose record declares a vendor (Sentry,
 * Datadog, PagerDuty v3, Jira, GitLab) is verified and mapped by that
 * vendor's adapter (src/event-adapters/) instead of the envelope parser,
 * behind the same flag, claim and processEvent.
 */

/** The minimum a shared-secret token must be, before it is a secret at all. */
export const SHARED_SECRET_MIN_BYTES = 32;

/**
 * Constant-time equality that does not leak length through timing.
 *
 * Adapted from T3 Code's scheduledTasks/webhookVerification.ts (MIT) — hash
 * both sides to a fixed width, then timingSafeEqual — because
 * timingSafeEqual alone throws on a length mismatch and a plain === b
 * compares byte-by-byte.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export interface EventRulesRuntime {
  config: Pick<RuntimeConfigStore, "get" | "set" | "list">;
  deliveries: { claim(source: string, deliveryId: string): Promise<boolean> };
  intake: IntakeStore;
  // list() is what proposeExternal's allowlist widening reads; forRepo is
  // the attribution lookup.
  projects: { list(): Promise<Array<{ url?: string }>>; forRepo(repo: string): Promise<{ url?: string } | null> };
}

export interface EventRulesDeps {
  runtime?: EventRulesRuntime;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
}

async function deps<T extends EventRulesDeps>(d: T): Promise<{ runtime: EventRulesRuntime; env: NodeJS.ProcessEnv; now: () => number; log: (line: string) => void }> {
  const runtime = d.runtime ?? (await shipRuntime());
  return {
    runtime,
    env: d.env ?? process.env,
    now: d.now ?? (() => Date.now()),
    log: d.log ?? ((line) => console.log(line)),
  };
}

function makeProcessEventDeps(runtime: EventRulesRuntime, log: (line: string) => void) {
  return {
    config: runtime.config,
    // The repo allowlist re-check at external trust is the point of routing
    // propose through proposeExternal rather than intake.propose directly.
    propose: (input: ProposeInput) => proposeExternal(runtime as unknown as Parameters<typeof proposeExternal>[0], input),
    getTask: (taskId: string) => runtime.intake.get(taskId),
    resolveRepo: async (repoHint: string) => (await runtime.projects.forRepo(repoHint))?.url,
    log,
  };
}

// ------------------------------------------------------------------ intake

export async function handleEventIntake(request: Request, sourceId: string, d: EventRulesDeps = {}): Promise<Response> {
  const { runtime, env, now, log } = await deps(d);
  const mode = eventRulesMode(env);
  if (mode === "off") {
    return json(503, { title: "event rules disabled: SHIP_EVENT_RULES is not on" });
  }
  const source = await getEventSource(runtime.config, sourceId);
  if (source === null || !source.enabled) {
    // Same answer for unknown and disabled: an unauthenticated caller learns
    // nothing about which channels exist (the T3 hook-route pattern).
    return json(404, { title: "unknown event source" });
  }
  const secret = eventSourceSecret(sourceId, env);
  if (secret === undefined || (source.auth === "shared-secret" && secret.length < SHARED_SECRET_MIN_BYTES)) {
    return json(503, { title: `event source ${sourceId} disabled: its secret is not set (SHIP_EVENT_SECRET_${sourceId.toUpperCase().replace(/-/g, "_")})` });
  }

  // Capped BEFORE any signature work — this route is unauthenticated until
  // the signature verifies, so an unbounded read would let any caller pick
  // how much memory and hashing Ship spends on a request it is about to
  // reject (see readCappedBody).
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }

  // EV4: a source that declares a vendor speaks that vendor's webhook, not
  // the S24 envelope. Same discipline, different wire format: verify with
  // the per-source secret, map to typed events, claim the vendor's delivery
  // id, then the same processEvent the envelope path feeds.
  if (source.vendor !== undefined) {
    return handleVendorEventIntake(request, source, body, { runtime, env, now, log, mode });
  }

  let envelope: EventEnvelope;
  if (source.auth === "hmac") {
    const verified = verifyEvent(
      body,
      { timestamp: firstHeader(request, "x-teploy-timestamp") ?? "", signature: firstHeader(request, "x-teploy-signature") ?? "" },
      secret,
      { nowMs: now(), replayWindowMs: (source.replayWindowSeconds ?? 300) * 1000 },
    );
    if (!verified.ok) {
      // A well-signed but unusable body is a 400; anything that failed the
      // MAC or the freshness window is a 401 with nothing stored: the
      // delivery never reached the claim or the ring.
      const refused = verified.reason === "malformed-body" || verified.reason === "malformed-envelope" || verified.reason === "unsupported-major";
      return json(refused ? 400 : 401, { title: `bad event delivery: ${verified.reason}` });
    }
    // No seen-store is passed to verifyEvent, so it never reports a
    // duplicate here; delivery dedupe is the claim below.
    if (verified.duplicate) return json(200, { ok: true, skipped: "duplicate delivery" });
    envelope = verified.event;
  } else {
    const token = firstHeader(request, "x-teploy-token") ?? "";
    if (token === "" || !constantTimeEquals(token, secret)) {
      return json(401, { title: "bad event token" });
    }
    const parsed = parseEventEnvelope(body);
    if (!parsed.ok) return json(400, { title: `malformed event body: ${parsed.reason}` });
    envelope = parsed.envelope;
  }

  const mapped = shipEventFromEnvelope(sourceId, envelope);
  if (!mapped.ok) return json(400, { title: mapped.problem });

  // Layer 1 of dedupe: the durable delivery claim. The vendor delivery
  // header first, the event id second (stable across retries), the body
  // hash last so even an id-less sender cannot be double-processed.
  const deliveryId =
    firstHeader(request, "x-teploy-delivery")
    ?? (mapped.event.eventId !== "" ? mapped.event.eventId : `sha256:${createHash("sha256").update(body).digest("hex")}`);
  if (!(await runtime.deliveries.claim(`events:${sourceId}`, deliveryId))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  // Soft freshness for sources whose auth carries no signed timestamp: the
  // body's own occurredAt, with replays stopped above by the delivery id.
  if (source.auth === "shared-secret" && now() - Date.parse(mapped.event.occurredAt) > (source.maxAgeSeconds ?? 86_400) * 1000) {
    return json(200, { ok: true, skipped: "expired" });
  }

  // A refused repository is a 403 naming the reason, not a silent drop —
  // the same contract proposeFromWebhook gives the forge receivers.
  let result;
  try {
    result = await processEvent(
      makeProcessEventDeps(runtime, log),
      { sourceId, event: mapped.event, deliveryId, mode, nowMs: now() },
    );
  } catch (error) {
    if (error instanceof RepoNotAllowedError) {
      return json(403, { title: "repository not allowed", detail: error.message });
    }
    throw error;
  }
  return json(200, { ok: true, mode, outcomes: result.outcomes });
}

// ---------------------------------------------------------------- vendors

interface VendorIntakeContext {
  runtime: EventRulesRuntime;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  mode: "shadow" | "on";
}

/**
 * The EV4 vendor leg of `/hooks/events/:source`. Layer order matches the
 * envelope leg exactly: verify (401) -> map (400; a body without the
 * vendor's own event/delivery id is refused, never deduped on body bytes)
 * -> durable delivery claim -> soft freshness for schemes whose signature
 * covers no timestamp -> processEvent through the same propose path. A
 * delivery whose payload maps to no event (an unhandled resource or type)
 * is still claimed and answered 200: the sender did nothing wrong.
 */
async function handleVendorEventIntake(request: Request, source: EventSourceRecord, body: string, ctx: VendorIntakeContext): Promise<Response> {
  const { runtime, env, now, log, mode } = ctx;
  const vendor = source.vendor;
  if (vendor === undefined) return json(500, { title: "vendor intake on a vendor-less source" });
  const secret = eventSourceSecret(source.id, env);
  if (secret === undefined) {
    return json(503, { title: `event source ${source.id} disabled: its secret is not set (SHIP_EVENT_SECRET_${source.id.toUpperCase().replace(/-/g, "_")})` });
  }
  const adapter = eventVendorAdapter(vendor);
  const opts = {
    secret,
    nowMs: now(),
    auth: source.auth,
    ...(source.replayWindowSeconds !== undefined ? { replayWindowSeconds: source.replayWindowSeconds } : {}),
    ...(source.tokenHeader !== undefined ? { tokenHeader: source.tokenHeader } : {}),
    ...(source.label !== undefined ? { label: source.label } : {}),
  };
  const verified = adapter.verify(request.headers, body, opts);
  if (!verified.ok) {
    // Authentication failures are 401 with nothing stored; a malformed
    // signature header is still a failure to authenticate the delivery.
    return json(verified.status, { title: `bad ${vendor} delivery: ${verified.reason}` });
  }
  const mapped = adapter.map(source.id, request.headers, body, opts);
  if (!mapped.ok) return json(mapped.status, { title: mapped.problem });

  // Layer 1 of dedupe: the durable claim on the vendor delivery id, falling
  // back to the mapped event's own id (stable across vendor retries).
  const deliveryId = mapped.deliveryId ?? mapped.events[0]?.eventId ?? null;
  if (deliveryId !== null && !(await runtime.deliveries.claim(`events:${source.id}`, deliveryId))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  // Soft freshness for schemes whose signature covers no timestamp; the
  // GitLab signing token is the one that binds the clock into the MAC and
  // was rejected above if outside the window.
  const soft = !vendorSignatureCoversTimestamp(vendor, source.auth);
  const outcomes: unknown[] = [];
  const skipped: Array<{ eventId: string; reason: string }> = [];
  for (const event of mapped.events) {
    if (soft && now() - Date.parse(event.occurredAt) > (source.maxAgeSeconds ?? 86_400) * 1000) {
      // Recorded, not acted on: the ring keeps it for a dry run.
      await recordSeenEvent(runtime.config, source.id, {
        receivedAt: new Date(now()).toISOString(),
        deliveryId,
        eventId: event.eventId,
        type: event.type,
        subject: event.subject,
        occurredAt: event.occurredAt,
        title: event.title,
        outcomes: [{ ruleId: "-", outcome: "expired" }],
      });
      skipped.push({ eventId: event.eventId, reason: "expired" });
      continue;
    }
    try {
      const result = await processEvent(makeProcessEventDeps(runtime, log), { sourceId: source.id, event, deliveryId, mode, nowMs: now() });
      outcomes.push(...result.outcomes);
    } catch (error) {
      if (error instanceof RepoNotAllowedError) {
        return json(403, { title: "repository not allowed", detail: error.message });
      }
      throw error;
    }
  }
  return json(200, { ok: true, mode, vendor, outcomes, ...(skipped.length > 0 ? { skipped } : {}) });
}

// ------------------------------------------------------------- operator API

/** GET /api/event-rules — rules and sources. Secret presence, never values. */
export async function handleEventRulesList(d: EventRulesDeps = {}): Promise<Response> {
  const { runtime, env } = await deps(d);
  const rules = await listEventRules(runtime.config);
  const sources = await listEventSources(runtime.config);
  return json(200, {
    ok: true,
    mode: eventRulesMode(env),
    rules,
    sources: sources.map((s) => ({ ...s, secretSet: eventSourceSecret(s.id, env) !== undefined })),
  });
}

/** POST /api/event-rules — save one rule. Refuses auto on unsigned sources. */
export async function handleEventRuleSave(request: Request, by: string, d: EventRulesDeps = {}): Promise<Response> {
  const { runtime } = await deps(d);
  let payload: { rule?: unknown };
  try {
    payload = JSON.parse(await request.text()) as { rule?: unknown };
  } catch {
    return json(400, { title: "malformed JSON body" });
  }
  if (payload.rule === null || typeof payload.rule !== "object") {
    return json(400, { title: "body must be {rule}" });
  }
  const proposed = payload.rule as Partial<EventRule>;
  const existing = proposed.id !== undefined ? await getEventRule(runtime.config, String(proposed.id)) : null;
  // createdAt/by are the record's own audit trail, not the caller's to pick.
  const rule = { ...proposed, createdAt: existing?.createdAt ?? new Date().toISOString(), by } as unknown;
  const saved = await saveEventRule(runtime.config, rule, await listEventSources(runtime.config));
  if (!saved.ok) return json(400, { title: saved.problem });
  return json(200, { ok: true, id: (rule as EventRule).id });
}

/** POST /api/event-sources — register one source. Checks the token length for shared-secret sources. */
export async function handleEventSourceSave(request: Request, by: string, d: EventRulesDeps = {}): Promise<Response> {
  const { runtime, env } = await deps(d);
  let payload: { source?: unknown };
  try {
    payload = JSON.parse(await request.text()) as { source?: unknown };
  } catch {
    return json(400, { title: "malformed JSON body" });
  }
  if (payload.source === null || typeof payload.source !== "object") {
    return json(400, { title: "body must be {source}" });
  }
  const proposed = payload.source as Partial<EventSourceRecord>;
  const existing = proposed.id !== undefined ? await getEventSource(runtime.config, String(proposed.id)) : null;
  const source = { ...proposed, createdAt: existing?.createdAt ?? new Date().toISOString(), by } as unknown;
  if (proposed.auth === "shared-secret") {
    const secret = proposed.id !== undefined ? eventSourceSecret(String(proposed.id), env) : undefined;
    if (secret === undefined || secret.length < SHARED_SECRET_MIN_BYTES) {
      return json(400, {
        title: `set SHIP_EVENT_SECRET_${String(proposed.id ?? "").toUpperCase().replace(/-/g, "_")} to at least ${SHARED_SECRET_MIN_BYTES} bytes before registering a shared-secret source`,
      });
    }
  }
  const saved = await saveEventSource(runtime.config, source);
  if (!saved.ok) return json(400, { title: saved.problem });
  return json(200, { ok: true, id: (source as EventSourceRecord).id });
}

// ------------------------------------------------------------------ dry run

/**
 * POST /api/event-rules/:id/dry-run — the exact ProposeInput a delivery
 * would produce, against the live subject state, WRITING NOTHING. The body
 * is either {"payload": "<raw envelope JSON>"} or {"recorded": "<eventId>"}
 * to replay something the receiver already saw.
 */
export async function handleEventRuleDryRun(ruleId: string, request: Request, d: EventRulesDeps = {}): Promise<Response> {
  const { runtime, now } = await deps(d);
  const rule = await getEventRule(runtime.config, ruleId);
  if (rule === null) return json(404, { title: "unknown event rule" });

  let payload: { payload?: string; recorded?: string; headers?: Record<string, string> };
  try {
    payload = JSON.parse(await request.text()) as { payload?: string; recorded?: string; headers?: Record<string, string> };
  } catch {
    return json(400, { title: "malformed JSON body" });
  }

  // A vendor source dry-runs the vendor's own payload shape (verification is
  // skipped: nothing is stored and no rule fires, so the secret is not
  // needed; headers may be supplied for the ids that travel as headers).
  const source = await getEventSource(runtime.config, rule.match.source);

  let event: ShipEvent | null = null;
  if (typeof payload.payload === "string" && source?.vendor !== undefined) {
    const adapter = eventVendorAdapter(source.vendor);
    const mapped = adapter.map(
      source.id,
      new Headers(payload.headers ?? {}),
      payload.payload,
      { secret: "", nowMs: now(), auth: source.auth, ...(source.tokenHeader !== undefined ? { tokenHeader: source.tokenHeader } : {}), ...(source.label !== undefined ? { label: source.label } : {}) },
    );
    if (!mapped.ok) return json(400, { title: mapped.problem });
    event = mapped.events.find((e) => ruleSeesEvent(rule, e)) ?? mapped.events[0] ?? null;
  } else if (typeof payload.payload === "string") {
    const parsed = parseEventEnvelope(payload.payload);
    if (!parsed.ok) return json(400, { title: `malformed event body: ${parsed.reason}` });
    const mapped = shipEventFromEnvelope(rule.match.source, parsed.envelope);
    if (!mapped.ok) return json(400, { title: mapped.problem });
    event = mapped.event;
  } else if (typeof payload.recorded === "string") {
    const seen = await listSeenEvents(runtime.config, rule.match.source);
    const entry = seen.find((e) => e.eventId === payload.recorded);
    if (entry === undefined) return json(404, { title: "recorded event not found for this rule's source" });
    event = {
      source: rule.match.source,
      type: entry.type,
      eventId: entry.eventId,
      subject: entry.subject,
      occurredAt: entry.occurredAt,
      title: entry.title,
      detail: "",
      attrs: entry.attrs ?? {},
    };
  } else {
    return json(400, { title: "body must be {payload} or {recorded}" });
  }

  // Everything below is read-only: the subject record is loaded, the
  // decision is computed against it, and the collapse check reads intake.
  // No propose, no subject write, no rate slot, no ring append.
  const record = await readSubject(runtime.config, rule.id, event.subject);
  const attribution = event.repoHint !== undefined ? (await runtime.projects.forRepo(event.repoHint))?.url : undefined;
  const decision = decideEvent(rule, event, record, new Date(now()).toISOString(), attribution);
  const dedupeKey = decision.action === "task" ? decision.dedupeKey : null;
  let collapsesOnto: string | null = null;
  if (dedupeKey !== null) {
    const key = normalizeDedupeKey(dedupeKey);
    collapsesOnto = (await runtime.intake.list())
      .find((t) => normalizeDedupeKey(t.dedupeKey) === key && t.state !== "dismissed")?.taskId ?? null;
  }
  return json(200, {
    ok: true,
    dryRun: true,
    rule: rule.id,
    event: { type: event.type, subject: event.subject, occurredAt: event.occurredAt, eventId: event.eventId },
    ordering: { action: decision.action, ...(decision.action === "stale" ? { watermark: decision.watermark } : {}) },
    ...(decision.action === "task" ? { input: decision.input, dedupeKey, collapsesOnto } : {}),
  });
}
