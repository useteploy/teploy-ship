import { linearTaskFromIssue } from "../../lib/ship.server.js";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * Linear webhook receiver: issues labeled `ship` become intake tasks —
 * the same opt-in-by-label contract as the git forges. Signature:
 * `linear-signature` is hex HMAC-SHA256 of the raw body with
 * SHIP_LINEAR_SIGNING_SECRET; the body must carry a numeric
 * `webhookTimestamp` within five minutes (replay bound), and deliveries are
 * deduped on the signed body's sha256 as well as the Linear-Delivery header.
 * Bind a repository by putting `repo:<clone-url>` in the issue description.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_LINEAR_SIGNING_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "linear intake disabled: SHIP_LINEAR_SIGNING_SECRET is not set" });
  }
  const { createHash, createHmac, timingSafeEqual } = await import("node:crypto");
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const signature = request.headers.get("linear-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  // Equal string lengths do not imply equal byte lengths (the header is
  // attacker-chosen and may carry multi-byte characters), and timingSafeEqual
  // throws on a length mismatch — an unsigned request must never become a 500.
  if (signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) {
    return json(401, { title: "bad linear signature" });
  }

  const payload = parseJson<Parameters<typeof linearTaskFromIssue>[0] & { webhookTimestamp?: unknown }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  // Linear puts webhookTimestamp (ms) INSIDE the signed body, and it is
  // REQUIRED: freshness is checked on a signed value because the
  // Linear-Delivery header is not covered by the signature, so a captured
  // body re-sent under a fresh delivery id has nothing but this timestamp to
  // refuse it — and a body without one has no freshness bound at all.
  if (typeof payload.webhookTimestamp !== "number" || !Number.isFinite(payload.webhookTimestamp)) {
    return json(401, { title: "missing or invalid linear webhookTimestamp" });
  }
  const age = (Date.now() - payload.webhookTimestamp) / 1000;
  if (Math.abs(age) > 300) return json(401, { title: "stale linear webhookTimestamp" });
  const input = linearTaskFromIssue(payload);
  if (input === null) return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  // Dedupe on the hash of the signed bytes IN ADDITION to the delivery
  // header: the header is unsigned, so a captured body under a fresh delivery
  // id passed the header claim above — identical bytes are the same delivery
  // whatever id they travel under.
  const bodyHash = createHash("sha256").update(body).digest("hex");
  if (!(await claimDelivery("linear-body", `sha256:${bodyHash}`)) || !(await claimDelivery("linear", firstHeader(request, "linear-delivery", "linear-event-id")))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }
  return proposeFromWebhook(input);
}
