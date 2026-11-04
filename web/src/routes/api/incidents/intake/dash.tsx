import { handleDashIncidentIntake } from "../../../../lib/incident-intake.server.js";

export const config = { mode: "app" };

/**
 * Teploy Dash incident intake (Event v2, plan DASH_AUTOCONFIG 2.5): a signed
 * Dash webhook POST becomes a source-"dash" incident, updates the open one
 * its incident_id owns, or closes it on a pushed recovery. Auth (X-Teploy-*
 * HMAC against SHIP_DASH_INTAKE_SECRET), dedupe and the outcomes live in
 * lib/incident-intake.server.ts (handleDashIncidentIntake). The bearer-gate
 * exemption is an exact path match in _layout.tsx.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  return handleDashIncidentIntake(request);
}

// POST-only route: the default export exists so the router registers the
// path (a missing default 404s silently).
export default function Never() {
  return null;
}
