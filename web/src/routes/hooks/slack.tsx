import { slackTaskFromMention } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";

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
  const body = await request.text();

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

  const payload = JSON.parse(body) as {
    type?: string;
    challenge?: string;
    event?: { type?: string; text?: string; channel?: string; ts?: string; bot_id?: string };
  };
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
  const runtime = await shipRuntime();
  const { created, task } = await runtime.intake.propose(input);
  return json(200, { ok: true, taskId: task.taskId, created });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
