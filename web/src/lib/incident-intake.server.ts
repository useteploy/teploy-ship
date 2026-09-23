import { BodyTooLarge, firstHeader, json, parseJson, readCappedBody, verifyObserveSignature } from "./webhook.server.js";
// dist/incidents.js directly, the same as the incidents route: the module is
// self-contained by construction (no value imports), so the client bundler
// never reaches node:fs through it. Everything node-only here stays behind
// the .server strip.
import { intakeObserveAlert } from "../../../dist/incidents.js";
import type { IncidentConfig, IncidentObserveWire, IncidentProjectView } from "../../../dist/incidents.js";
// redact.js is equally self-contained and only ever loaded server-side from
// here; safeForDisplay is the bounded-output helper every run surface uses.
import { safeForDisplay } from "../../../dist/redact.js";
import { shipRuntime } from "./store.server.js";

/**
 * S17 — the Observe webhook receiver for the incident store (the push twin
 * of the P1-5 task receiver in routes/hooks/observe.tsx; that one proposes a
 * RUN, this one opens an INCIDENT with attribution, dedupe and recovery).
 *
 * Auth is the webhook HMAC against SHIP_INCIDENT_INTAKE_SECRET, verified by
 * the same constant-time compare the hooks/* receivers use
 * (verifyObserveSignature — timingSafeEqual under a length guard, plus the
 * freshness window, because the timestamp is bound INTO the signed message).
 * A separate secret from SHIP_OBSERVE_SIGNING_SECRET on purpose: the two
 * receivers do different things with the same alert, and rotating one must
 * not rotate the other. In Observe, the secret is the webhook row's own
 * secret — generated at creation, revealed exactly once
 * (teploy-observe internal/platform/webhooks.go:92).
 *
 * Delivery dedupe: Observe stamps a stable X-Observe-Delivery per firing
 * (webhooks.go:261, reused across retries), so a resent delivery collapses
 * here; the signature is the fallback key for the same reason the P1-5
 * receiver uses it. Below that, intakeObserveAlert dedupes by (service,
 * fingerprint) — rule_id in practice — so a re-FIRE (fresh alert_id, same
 * rule) updates the open incident instead of stacking.
 *
 * Unset secret = the receiver answers 503 and nothing is written: the leg is
 * off by default, exactly like the P1-5 receiver.
 */
export interface IncidentIntakeDeps {
  secret?: string;
  runtime?: {
    config: IncidentConfig;
    projects: { list(): Promise<readonly IncidentProjectView[]> };
    deliveries: { claim(source: string, deliveryId: string): Promise<boolean> };
  };
}

export async function handleIncidentIntake(request: Request, deps: IncidentIntakeDeps = {}): Promise<Response> {
  const secret = deps.secret ?? process.env.SHIP_INCIDENT_INTAKE_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "incident intake disabled: SHIP_INCIDENT_INTAKE_SECRET is not set" });
  }
  // Capped BEFORE the HMAC: this route is unauthenticated until the signature
  // verifies (the layout exemption is what routes it here past the bearer
  // gate), so an unbounded read would let any caller pick how much memory
  // and hashing Ship spends on a request it is about to reject.
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const refused = await verifyObserveSignature(request, body, secret);
  if (refused !== null) return refused;

  const runtime = deps.runtime ?? (await shipRuntime());
  const deliveryId = firstHeader(request, "x-observe-delivery", "x-observe-signature");
  if (deliveryId !== null && !(await runtime.deliveries.claim("incident-intake", deliveryId))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  const payload = parseJson<IncidentObserveWire>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  const result = await intakeObserveAlert(
    { config: runtime.config, projects: runtime.projects },
    payload,
    // The raw alert rides onto the record bounded and redacted — the same
    // bounded-output treatment every run surface gives tool output.
    { rawAlert: safeForDisplay(body, 8_192) },
  );
  if (result.kind === "skipped") return json(200, { ok: true, skipped: result.reason });
  return json(result.kind === "created" ? 201 : 200, {
    ok: true,
    outcome: result.kind,
    incidentId: result.record.id,
    status: result.record.status,
  });
}
