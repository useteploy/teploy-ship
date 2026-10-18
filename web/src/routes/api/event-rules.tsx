import { handleEventRuleSave, handleEventRulesList } from "../../lib/event-rules.server.js";
import { currentUser } from "../../lib/session.server.js";

export const config = { mode: "app" };

/**
 * E7 EV2 — rule management for the generic event sources: GET lists rules
 * and registered sources (with secret presence, never values), POST saves
 * one rule. The save refuses `policy: "auto"` on a shared-secret source —
 * that is Decision 12's floor, not a setting. The acting user is recorded
 * as the rule's `by`.
 */
export async function loader(): Promise<Response> {
  return handleEventRulesList();
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const principal = await currentUser(request);
  if (principal === null) return new Response(JSON.stringify({ title: "Unauthorized", status: 401 }), { status: 401, headers: { "content-type": "application/problem+json" } });
  return handleEventRuleSave(request, principal.user);
}

export default function Never() {
  return null;
}
