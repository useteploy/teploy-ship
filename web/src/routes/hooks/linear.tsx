import { linearTaskFromIssue } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";

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
  const body = await request.text();
  const signature = request.headers.get("linear-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad linear signature" });
  }

  const input = linearTaskFromIssue(JSON.parse(body));
  if (input === null) return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
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
