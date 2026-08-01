import { linearTaskFromIssue } from "teploy-ship/runtime";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * Linear webhook receiver: issues labeled `ship` become intake tasks —
 * the same opt-in-by-label contract as the git forges. Signature:
 * `linear-signature` is hex HMAC-SHA256 of the raw body with
 * SHIP_LINEAR_SIGNING_SECRET. Bind a repository by putting
 * `repo:<clone-url>` in the issue description.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_LINEAR_SIGNING_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "linear intake disabled: SHIP_LINEAR_SIGNING_SECRET is not set" });
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const signature = request.headers.get("linear-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad linear signature" });
  }

  const payload = parseJson<Parameters<typeof linearTaskFromIssue>[0]>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  const input = linearTaskFromIssue(payload);
  if (input === null) return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  if (!(await claimDelivery("linear", firstHeader(request, "linear-delivery", "linear-event-id")))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }
  return proposeFromWebhook(input);
}
