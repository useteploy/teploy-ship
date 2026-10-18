import { currentUser } from "../../../lib/session.server.js";
import { handleEventSourceSave } from "../../../lib/event-rules.server.js";

export const config = { mode: "app" };

/**
 * E7 EV2 — register an event source for /hooks/events/<id>: {id, auth:
 * "hmac" | "shared-secret", enabled, replayWindowSeconds?, maxAgeSeconds?}.
 * The secret itself never rides this API — it is deployment config
 * (SHIP_EVENT_SECRET_<ID>), and a shared-secret source cannot be registered
 * until that env var holds at least 32 bytes.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const principal = await currentUser(request);
  if (principal === null) return new Response(JSON.stringify({ title: "Unauthorized", status: 401 }), { status: 401, headers: { "content-type": "application/problem+json" } });
  return handleEventSourceSave(request, principal.user);
}

export default function Never() {
  return null;
}
