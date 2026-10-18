import { handleEventRuleSave, handleEventRulesList } from "../../lib/event-rules.server.js";
import { currentUser } from "../../lib/session.server.js";
import { deniedMessage, may } from "../../lib/authority.server.js";

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
  // A rule is intake policy: the same `policies` grant as the Projects and
  // Sources pages. A rule that launches unattended is the `auto` grant on top.
  if (!(await may("policies", principal))) return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: deniedMessage("policies") }), { status: 403, headers: { "content-type": "application/problem+json" } });
  let wantsAuto = false;
  try {
    wantsAuto = (JSON.parse(await request.clone().text()) as { rule?: { policy?: unknown } }).rule?.policy === "auto";
  } catch {
    // Malformed bodies are refused by the handler with a 400.
  }
  if (wantsAuto && !(await may("auto", principal))) return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: deniedMessage("auto") }), { status: 403, headers: { "content-type": "application/problem+json" } });
  return handleEventRuleSave(request, principal.user);
}

export default function Never() {
  return null;
}
