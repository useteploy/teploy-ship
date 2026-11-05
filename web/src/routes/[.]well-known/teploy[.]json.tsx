import { handleDiscovery } from "../../lib/discovery.server.js";

export const config = { mode: "app" };

/**
 * GET /.well-known/teploy.json — the sibling discovery document (Programme B,
 * plan DASH_AUTOCONFIG 10.1). The file name uses neutron's `[.]` escape for a
 * literal dot in a route segment; a plain `.well-known` directory would be
 * skipped by the route walker (entries starting with "." are ignored), and a
 * plain `teploy.json.tsx` would map to /teploy/json.
 *
 * Unauthenticated (the layout exempts this exact path) and default-off: the
 * handler refuses with 404 until SHIP_DISCOVERY is on, because this port is
 * also the webhook-receiver port. See lib/discovery.server.ts for the
 * default-deny reasoning; src/discovery.ts for the document contract.
 */
export async function loader(): Promise<Response> {
  return handleDiscovery();
}

// The router registers a path only when the module has a default export (the
// decide route's lesson — a missing default 404s silently).
export default function Never() {
  return null;
}
