import { handleEventIntake } from "../../../lib/event-rules.server.js";

export const config = { mode: "app" };

/**
 * E7 EV2 — the generic signed event receiver: one route for every
 * registered event source, `POST /hooks/events/<sourceId>`.
 *
 * Auth depends on the source's registered auth strength (config KV,
 * SHIP_EVENT_SOURCE_<id>; secret in SHIP_EVENT_SECRET_<ID>):
 *   hmac          X-Teploy-Timestamp + X-Teploy-Signature
 *                 (sha256=hex HMAC-SHA256(secret, "<ts>.<body>")) — the S24
 *                 envelope format, freshness-windowed (default 300 s);
 *   shared-secret X-Teploy-Token compared in constant time (32+ bytes).
 *                 Propose-only forever: a rule with policy "auto" on such a
 *                 source is refused at save (Decision 12, 2026-10-17).
 *
 * The body is the S24 EventEnvelope JSON: {eventId, schemaVersion: "1.x",
 * type, cursor, occurredAt, data: {subject, title, detail?, attrs?, seq?,
 * repoHint?}}. Everything else — matching, ordering, dedupe, the propose
 * itself — lives behind lib/event-rules.server.ts and src/event-rules.ts,
 * in front of the SAME intake.propose every other source uses.
 *
 * Off by default: SHIP_EVENT_RULES unset means this route answers 503 and
 * nothing is stored. shadow evaluates and logs; on acts.
 */
export async function action({ request, params }: { request: Request; params: { source: string } }): Promise<Response> {
  return handleEventIntake(request, params.source);
}

// POST-only route: the default export exists so the router registers the
// path (the decide route's lesson — a missing default 404s silently).
export default function Never() {
  return null;
}
