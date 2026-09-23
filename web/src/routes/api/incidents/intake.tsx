import { handleIncidentIntake } from "../../../lib/incident-intake.server.js";

export const config = { mode: "app" };

/**
 * S17 — Observe alert intake for the incident store: an Observe webhook POST
 * becomes an attributed incident (or updates/reopens the one its fingerprint
 * already owns). The logic and the auth contract live in
 * lib/incident-intake.server.ts; see its header for the Observe-side wire
 * facts (payload shape, signature, delivery id).
 *
 * INTEGRATION (orchestrator-owned file): this path authenticates by HMAC
 * inside the route, exactly like /hooks/*, but the layout middleware's
 * exemption list does not know it yet — until _layout.tsx's check gains
 * `|| path.startsWith("/api/incidents/intake")`, Observe's POST is answered
 * by the bearer gate with a 401 and nothing is created.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  return handleIncidentIntake(request);
}

// POST-only route: the default export exists so the router registers the
// path (the decide route's lesson — a missing default 404s silently).
export default function Never() {
  return null;
}
