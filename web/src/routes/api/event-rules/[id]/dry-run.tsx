import { handleEventRuleDryRun } from "../../../../lib/event-rules.server.js";

export const config = { mode: "app" };

/**
 * E7 EV2 — dry-run one rule: POST {"payload": "<raw envelope JSON>"} or
 * {"recorded": "<eventId>"} to see exactly what a delivery would propose —
 * the parsed event, the ordering verdict, the would-be ProposeInput with
 * its exact dedupe key, and whether it would collapse onto an existing
 * task. Writes nothing: no propose, no subject write, no rate slot, no
 * ring append.
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  return handleEventRuleDryRun(params.id, request);
}

export default function Never() {
  return null;
}
