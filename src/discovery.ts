/**
 * Programme B — Ship's sibling discovery document (plan DASH_AUTOCONFIG
 * 10.1, owner-approved 2026-11-03).
 *
 * GET /.well-known/teploy.json is what another Teploy product (Dash first)
 * reads to recognise this instance BEFORE an admin connects it. It mirrors
 * Observe's document (teploy-observe cmd/observe/discovery.go) in shape and
 * in security posture:
 *
 *   - it carries NO secrets and grants nothing — an unauthenticated reader
 *     learns the product, the running version, a stable instance id, where
 *     the dashboard is (when the operator has said so), and what a client
 *     can actually do next;
 *   - URLs are never guessed. dashboard_url comes only from an explicit
 *     operator-set env value, never from the request's Host header (a client
 *     can spoof that) and never from anything Ship derives. Empty means
 *     "unknown — ask", exactly like Observe;
 *   - it is default-DENY on Ship's single web listener. Observe can pin its
 *     document to the private dashboard listener because Observe has two
 *     listeners; Ship's one port serves both the dashboard and the
 *     HMAC-authenticated webhook receivers (/hooks/*, /api/incidents/intake*),
 *     and that port is the one an operator may publish to the internet. So
 *     the route answers 404 until SHIP_DISCOVERY is turned on — the
 *     operator's act of enabling it is the declaration "this port is not
 *     internet-facing", the same declaration Observe's operator makes by
 *     separating the listeners. Pinned by the default-off test next to the
 *     route (web/src/lib/discovery.server.test.ts).
 *
 * This module is pure on purpose — no env read at module level, no node
 * imports — so the web route can import it from dist/ the way the incident
 * routes import dist/incidents.js, and the same tests run in both suites'
 * reach. Everything that touches process state (the store, the flag) is
 * injected.
 */

/** The one path the document is served on. Part of the family contract. */
export const DISCOVERY_PATH = "/.well-known/teploy.json";

/** The document. Five fields, deliberately: adding one is a contract change. */
export interface DiscoveryDoc {
  product: "ship";
  version: string;
  instance_id: string;
  /**
   * Explicit operator configuration only: SHIP_DASHBOARD_URL, falling back
   * to SHIP_PUBLIC_URL (Ship serves the dashboard and its webhook receivers
   * on ONE port, so the public URL IS the dashboard URL — the same
   * one-listener rule Observe applies). Empty when neither is set: the
   * client must ask, not guess.
   */
  dashboard_url: string;
  /**
   * Only what the endpoint's consumer can actually do NEXT, conditioned on
   * the wiring that makes it true. `dash_intake` (signed Dash incidents are
   * accepted at /api/incidents/intake/dash) is advertised only while
   * SHIP_DASH_INTAKE_SECRET is set — without it the receiver answers 503 and
   * advertising it would be a promise the deployment cannot keep.
   */
  capabilities: string[];
}

/** Base-URL normalisation shared with the emitters: trim, strip trailing "/". */
export function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * dashboard_url, never guessed. Precedence:
 *   SHIP_DASHBOARD_URL  — dedicated, nothing else reads it (Observe has the
 *                         same variable for the same reason: when the public
 *                         URL might name something else, only an explicit
 *                         dashboard value can answer);
 *   SHIP_PUBLIC_URL     — Ship's one listener makes the public URL the
 *                         dashboard URL, so it is a real answer, not a guess;
 *   ""                  — unknown. Never the request Host, never derived.
 */
export function discoveryDashboardURL(env: NodeJS.ProcessEnv): string {
  const dedicated = normalizeBaseURL(env.SHIP_DASHBOARD_URL ?? "");
  if (dedicated !== "") return dedicated;
  return normalizeBaseURL(env.SHIP_PUBLIC_URL ?? "");
}

/**
 * Capabilities, each conditioned on the env that actually arms it.
 */
export function discoveryCapabilities(env: NodeJS.ProcessEnv): string[] {
  const caps: string[] = [];
  if ((env.SHIP_DASH_INTAKE_SECRET ?? "").trim() !== "") caps.push("dash_intake");
  return caps;
}

/** The document for this process. `instanceId` comes from the store (below). */
export function discoveryDoc(env: NodeJS.ProcessEnv, instanceId: string): DiscoveryDoc {
  return {
    product: "ship",
    version: (env.SHIP_VERSION ?? "").trim() !== "" ? env.SHIP_VERSION!.trim() : "dev",
    instance_id: instanceId,
    dashboard_url: discoveryDashboardURL(env),
    capabilities: discoveryCapabilities(env),
  };
}

// ------------------------------------------------------------- instance id

/** The config-store key holding this deployment's instance id. */
export const INSTANCE_ID_KEY = "SHIP_INSTANCE_ID";

/**
 * The least store Ship's instance id needs — the runtime config store's own
 * shape (src/runtime-config.ts), so the real store plugs in with no adapter.
 */
export interface InstanceIdStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, updatedBy?: string): Promise<void>;
}

/**
 * This deployment's stable instance id, generated once and persisted in
 * Ship's runtime config store — the same place the Akiroo connector and the
 * incident store keep operator-live state, durable in file AND postgres/nucleus
 * mode. It survives a container replacement (the store is on a volume or a
 * separate database), so Dash can pin a confirmed identity to it, and a
 * restored copy claims to be the original: same store, same id. A copy that
 * will run alongside the original has to be re-identified by hand (remove the
 * SHIP_INSTANCE_ID config key before starting it) — Observe automates this
 * with `reidentify` because it also revokes tokens; Ship mints nothing yet,
 * so there is nothing to revoke and the manual step is documented in DEPLOY.md.
 *
 * Convergence: after writing, the value is read BACK and the stored value
 * wins. Only the web process serves discovery, so in practice there is one
 * writer; if two processes ever race on an empty store, both read back the
 * last write and agree from then on (the keyed store keeps one row — there is
 * no "smallest of many rows" to lean on the way Observe's meta table can).
 *
 * Never throws blindly at the caller: store errors propagate — the route
 * turns them into a 503 rather than a document with a half-made identity.
 */
export async function ensureInstanceId(
  store: InstanceIdStore,
  generate: () => string = defaultGenerateInstanceId,
): Promise<string> {
  const stored = (await store.get(INSTANCE_ID_KEY)) ?? "";
  if (stored.trim() !== "") return stored.trim();
  const id = generate();
  if (id.trim() === "") throw new Error("discovery: generated instance id is empty");
  await store.set(INSTANCE_ID_KEY, id, "discovery");
  const confirmed = (await store.get(INSTANCE_ID_KEY)) ?? "";
  // A blank read-back means the store accepted the write and lost it — that
  // is a store fault, and pretending the id is durable would be worse than
  // refusing.
  if (confirmed.trim() === "") throw new Error("discovery: stored instance id is not readable");
  return confirmed.trim();
}

/** 16 random bytes as hex (32 chars) — Observe's instance id shape. */
function defaultGenerateInstanceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
