import { handleIncidentIntake } from "../../../lib/incident-intake.server.js";

export const config = { mode: "app" };

/**
 * S17 — Observe alert intake for the incident store: an Observe webhook POST
 * becomes an attributed incident (or updates/reopens the one its fingerprint
 * already owns). The logic and the auth contract live in
 * lib/incident-intake.server.ts; see its header for the Observe-side wire
 * facts (payload shape, signature, delivery id).
 *
 * This path authenticates by HMAC inside the route, exactly like /hooks/*;
 * the layout's bearer gate exempts this exact path (_layout.tsx). Teploy Dash
 * deliveries have their own route, /api/incidents/intake/dash, with their
 * own secret and their own exact exemption.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  return handleIncidentIntake(request);
}

// POST-only route: the default export exists so the router registers the
// path (the decide route's lesson — a missing default 404s silently).
export default function Never() {
  return null;
}
