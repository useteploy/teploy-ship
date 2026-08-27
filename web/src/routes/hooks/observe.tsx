import {
  BodyTooLarge,
  claimDelivery,
  firstHeader,
  incidentTaskFromObserveAlert,
  json,
  observeRepoFor,
  parseJson,
  proposeFromWebhook,
  readCappedBody,
  verifyObserveSignature,
} from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * P1-5 — Observe alert receiver: a firing alert becomes an `incident`
 * proposal in Ship's inbox.
 *
 * Auth is the webhook HMAC (this path is exempt from the bearer middleware).
 * Observe signs Stripe-style —
 * `X-Observe-Signature: sha256=<hex HMAC-SHA256(secret, "<ts>.<body>")>` with
 * `X-Observe-Timestamp` carrying the same unix seconds
 * (teploy-observe/internal/platform/webhooks.go:134-161) — against
 * SHIP_OBSERVE_SIGNING_SECRET. That secret is NOT an env var on the Observe
 * side: Observe generates it when the webhook row is created and reveals it
 * exactly once in the create response (webhooks.go:35-49). Copy it then; there
 * is no rotate or reveal endpoint.
 *
 * REGISTRATION GOTCHA, and it will bite before anything else does: Observe
 * dials webhook targets through `netsafe.Client`
 * (teploy-observe/internal/netsafe/netsafe.go:41-56), which blocks loopback,
 * RFC1918 **and 100.64.0.0/10** at connect time. A Ship reachable only on the
 * tailnet can never receive a delivery — register the PUBLIC Ship URL.
 *
 * Policy: `observe` is deliberately left off the auto list. An incident is not
 * something to run unattended, and the worker only auto-launches a source
 * whose stored policy says `auto` (src/worker.ts:253), so an unconfigured
 * `observe` proposes and waits — the default this path wants.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_OBSERVE_SIGNING_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "observe intake disabled: SHIP_OBSERVE_SIGNING_SECRET is not set" });
  }
  // Capped BEFORE the HMAC — see the note in the Forgejo receiver. This route
  // is unauthenticated until the signature verifies, so an unbounded read lets
  // any caller pick how much memory and hashing work Ship spends on a request
  // it is going to reject.
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const refused = await verifyObserveSignature(request, body, secret);
  if (refused !== null) return refused;

  // Observe stamps NO delivery id (webhooks.go:134-161 sets only the signature
  // and the timestamp), so the signature itself is the fallback claim key: it
  // is a function of the body AND the per-fire timestamp, so it is unique per
  // delivery and identical across a replay of the same bytes. The
  // `x-observe-delivery` header is preferred for when Observe grows one.
  // Belt and braces regardless — `observe:<alert_id>` dedupes at intake, so a
  // replay that gets past this collapses onto the existing task rather than
  // opening a second incident.
  if (!(await claimDelivery("observe", firstHeader(request, "x-observe-delivery", "x-observe-signature")))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  const payload = parseJson<Parameters<typeof incidentTaskFromObserveAlert>[0]>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  // The repo binding is the one I/O step and it happens here, not in the pure
  // builder: service -> repo is a reverse lookup over the evidence store.
  const repo = await observeRepoFor(payload);
  const input = incidentTaskFromObserveAlert(payload, repo !== undefined ? { repo } : {});
  if (input === null) return json(200, { ok: true, skipped: "alert carries no alert_id" });
  return proposeFromWebhook(input);
}

export default function Never() {
  return null;
}
