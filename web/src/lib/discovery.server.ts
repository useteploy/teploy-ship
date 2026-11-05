import { json } from "./webhook.server.js";
import { shipRuntime } from "./store.server.js";
// dist/discovery.js is pure by construction (see src/discovery.ts) — the same
// direct-from-dist import the incident routes use for incidents.js. This file
// is .server-stripped, so the client bundle never reaches the runtime through
// it.
import { DISCOVERY_PATH, discoveryDoc, ensureInstanceId } from "../../../dist/discovery.js";

/**
 * Programme B — GET /.well-known/teploy.json (plan DASH_AUTOCONFIG 10.1):
 * the sibling discovery document. Handler only; the shape, the never-guess
 * URL rule and the persisted instance id live in src/discovery.ts, and the
 * route is web/src/routes/[.]well-known/teploy[.]json.tsx (neutron's `[.]`
 * escape for a literal dot in a segment).
 *
 * DEFAULT OFF, and that is the security posture, not an inconvenience.
 * Observe pins its document to its private dashboard listener because
 * Observe has two listeners and its ingest port is the internet-facing one.
 * Ship has ONE web listener, and it is the port the HMAC-authenticated
 * webhook receivers live on — the port an operator may publish for GitHub
 * or Dash deliveries. Serving this document there unconditionally would
 * publish the running version and the private dashboard URL to whoever can
 * reach the port, which is exactly what Observe's ingest listener refuses
 * to do. SHIP_DISCOVERY=on is the operator's declaration that this port is
 * not internet-facing; until then the route answers 404 like Observe's
 * ingest listener does. Pinned by the default-off test below.
 *
 * Unauthenticated by design (the layout exempts this exact path): the
 * document carries no secrets and grants nothing — it exists so Dash can
 * recognise this instance BEFORE an admin connects anything.
 */
export function discoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SHIP_DISCOVERY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Per-process memo of the persisted instance id; reset on failure so a transient store outage at first request does not pin a broken state for the process lifetime. */
let instanceIdPromise: Promise<string> | null = null;

function instanceId(): Promise<string> {
  instanceIdPromise ??= shipRuntime().then((runtime) => ensureInstanceId(runtime.config));
  const pending = instanceIdPromise;
  pending.catch(() => {
    // Only clear if a newer attempt has not already replaced us.
    if (instanceIdPromise === pending) instanceIdPromise = null;
  });
  return pending;
}

export interface DiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the store-backed instance id. */
  instanceId?: () => Promise<string>;
}

export async function handleDiscovery(deps: DiscoveryDeps = {}): Promise<Response> {
  if (!discoveryEnabled(deps.env ?? process.env)) {
    // Default deny: the same answer an unknown path gets, so an off instance
    // does not even reveal that it knows about discovery.
    return json(404, { title: "not found" });
  }
  let id: string;
  try {
    id = await (deps.instanceId ?? instanceId)();
  } catch (error) {
    // Identity is load-bearing (Dash pins consents to it); a doc with a
    // half-made id would be worse than a diagnostic. Same posture as
    // /health's store-unreachable 503.
    return json(503, { title: `instance id unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
  const body = JSON.stringify(discoveryDoc(deps.env ?? process.env, id));
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Re-exported for the route and tests: the one path this handler answers. */
export { DISCOVERY_PATH };
