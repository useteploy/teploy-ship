import { slackTaskFromMention } from "teploy-ship/runtime";

import { BodyTooLarge, claimDelivery, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * Slack Events API receiver: @mention the app with a task ("<@ship> fix
 * the flaky auth test repo:https://…") and it lands in the intake queue
 * under source "slack" — per-source policies gate it like every other
 * source. Signature: Slack's v0 scheme (HMAC-SHA256 over
 * "v0:<timestamp>:<body>" with SHIP_SLACK_SIGNING_SECRET), with a 5-minute
 * timestamp window against replays. The url_verification handshake is
 * answered so the subscription can be enabled.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_SLACK_SIGNING_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "slack intake disabled: SHIP_SLACK_SIGNING_SECRET is not set" });
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }

  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) {
    return json(401, { title: "stale or missing slack timestamp" });
  }
  const signature = request.headers.get("x-slack-signature") ?? "";
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad slack signature" });
  }

  const payload = parseJson<{
    type?: string;
    challenge?: string;
    event?: { type?: string; text?: string; channel?: string; ts?: string; bot_id?: string };
  }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  if (payload.type === "url_verification") {
    return json(200, { challenge: payload.challenge ?? "" });
  }
  if (payload.type !== "event_callback" || payload.event?.type !== "app_mention") {
    return json(200, { ok: true, skipped: "not an app_mention" });
  }
  if (payload.event.bot_id !== undefined) {
    return json(200, { ok: true, skipped: "bot message" });
  }

  const input = slackTaskFromMention(payload.event);
  if (input === null) return json(200, { ok: true, skipped: "empty mention" });
  // Slack's five-minute window bounds replay but does not prevent it; the
  // message's channel+ts is a stable per-delivery identity.
  if (!(await claimDelivery("slack", `${payload.event.channel ?? ""}:${payload.event.ts ?? ""}`))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }
  return proposeFromWebhook(input);
}
