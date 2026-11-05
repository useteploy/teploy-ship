/**
 * The Teploy family's standard Observe env contract (plan DASH_AUTOCONFIG
 * 10.3), resolved once for every place Ship talks to Observe:
 *
 *   OBSERVE_ENDPOINT                      base URL (standard name)
 *   OBSERVE_API_KEY                       ingest key            (secret)
 *   OTEL_EXPORTER_OTLP_ENDPOINT           base URL (OTLP spelling)
 *   OTEL_EXPORTER_OTLP_HEADERS            x-api-key=<key>       (secret)
 *   OTEL_EXPORTER_OTLP_PROTOCOL           http/protobuf
 *   OTEL_SERVICE_NAME                     service name for self-observations
 *   OTEL_RESOURCE_ATTRIBUTES              service.version=…,…
 *   OBSERVE_URL                           LEGACY base URL — still works,
 *                                         warns once, replaced by
 *                                         OBSERVE_ENDPOINT
 *
 * Ship's own scheme (OBSERVE_URL) predates the contract and is deprecated in
 * favour of it; the four legacy schemes across the fleet (Ship's, realcost's,
 * Akiroo's OBSERVE_SITE_ID, Fylun's custom OTEL) retire onto these names.
 * Nothing here removes a working name: an existing deployment configured with
 * OBSERVE_URL behaves exactly as before, plus one deprecation line naming the
 * replacement.
 *
 * The OTLP spelling is honoured only under Observe's own rule for it: an
 * OTLP endpoint with no Observe credential is ANOTHER VENDOR'S collector
 * (teploy-observe docs/service-tokens.md, environment contract), so it must
 * not wire Ship's dogfood egress. And Ship speaks HTTP only — protobuf and
 * JSON over HTTP both reach Observe's ingest — so a protocol of grpc (or
 * anything unknown) leaves the OTLP endpoint unused, with a warning saying
 * why, rather than a silently wrong transport.
 *
 * Pure module on purpose: no env read at module level, no node imports, no
 * timers — the web error reporter is client-bundled and imports this from
 * dist/, exactly like dist/incidents.js.
 */

/** How the base URL was spelled. "OBSERVE_URL" is the deprecated name. */
export type ObserveEndpointSource = "OBSERVE_ENDPOINT" | "OBSERVE_URL" | "OTEL_EXPORTER_OTLP_ENDPOINT";

export interface ObserveWiring {
  /** Base URL, trimmed, no trailing slash. */
  base: string;
  /** The ingest key (x-api-key). Empty wiring is never returned, so never "". */
  ingestKey: string;
  /** X-Observe-Site override, "" when unset (legacy OBSERVE_SITE). */
  site: string;
  /** Which env name supplied the base URL. */
  source: ObserveEndpointSource;
  /** OTEL_SERVICE_NAME when set — overrides the product defaults for self-observations. */
  serviceName?: string;
  /** Parsed OTEL_RESOURCE_ATTRIBUTES (k=v,k=v), empty when unset. */
  resourceAttributes: Record<string, string>;
}

export type ObserveWarn = (line: string) => void;

let warnedLegacyURL = false;
let warnedProtocol = false;

/** Test seam: forget the once-per-process warning latches. */
export function resetObserveWiringWarnings(): void {
  warnedLegacyURL = false;
  warnedProtocol = false;
}

/** Just the resolved base URL, for callers whose credential is not the ingest key. */
export interface ObserveBase {
  base: string;
  source: ObserveEndpointSource;
}

/**
 * The Observe base URL under the family env contract, or null when no spelling
 * is set. Unlike observeWiringFromEnv this demands no ingest key: the share
 * token and service token read paths carry their own credentials, and a
 * deployment configured for reads only (URL + OBSERVE_READ_TOKEN, no
 * OBSERVE_API_KEY) has always been valid and stays valid.
 */
export function observeBaseFromEnv(env: NodeJS.ProcessEnv, warn?: ObserveWarn): ObserveBase | null {
  const say = warn ?? ((line: string) => console.warn(line));

  const standard = trimBase(env.OBSERVE_ENDPOINT);
  if (standard !== "") return { base: standard, source: "OBSERVE_ENDPOINT" };

  const legacy = trimBase(env.OBSERVE_URL);
  if (legacy !== "") {
    if (!warnedLegacyURL) {
      warnedLegacyURL = true;
      say("[observe] OBSERVE_URL is deprecated; set OBSERVE_ENDPOINT instead (Teploy family env contract). The old name still works.");
    }
    return { base: legacy, source: "OBSERVE_URL" };
  }

  const otlp = trimBase(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (otlp !== "") {
    // The Observe credential rule applies to this spelling regardless of which
    // credential the caller holds: an OTLP endpoint with no Observe key
    // anywhere is another vendor's collector, and pointing Ship's reads at a
    // stranger would be worse than reading nothing.
    const key = (env.OBSERVE_API_KEY ?? "").trim() !== "" || otlpHeaderXAPIKey(env.OTEL_EXPORTER_OTLP_HEADERS ?? "") !== "";
    if (!key) return null;
    if (!otlpProtocolUsable(env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "")) {
      if (!warnedProtocol) {
        warnedProtocol = true;
        say(`[observe] OTEL_EXPORTER_OTLP_PROTOCOL=${env.OTEL_EXPORTER_OTLP_PROTOCOL} is not an HTTP transport; Ship's Observe egress speaks HTTP, so OTEL_EXPORTER_OTLP_ENDPOINT is left to the real OTel SDKs.`);
      }
      return null;
    }
    return { base: otlp, source: "OTEL_EXPORTER_OTLP_ENDPOINT" };
  }

  return null;
}

/**
 * Resolve Ship's Observe ingest wiring from the environment, or null when
 * Observe ingest is not configured. Standard names win; the legacy name keeps
 * working; the OTLP spelling fills in only when the Observe credential rule is
 * satisfied.
 */
export function observeWiringFromEnv(env: NodeJS.ProcessEnv, warn?: ObserveWarn): ObserveWiring | null {
  const base = observeBaseFromEnv(env, warn);
  if (base === null) return null;
  const apiKey = (env.OBSERVE_API_KEY ?? "").trim();
  const headerKey = otlpHeaderXAPIKey(env.OTEL_EXPORTER_OTLP_HEADERS ?? "");
  // A keyless standard/legacy endpoint is not an Observe configuration:
  // Observe issues no anonymous ingest, and treating it as configured would
  // post telemetry at a stranger.
  const key = base.source === "OTEL_EXPORTER_OTLP_ENDPOINT" && apiKey === "" ? headerKey : apiKey;
  if (key === "") return null;
  const site = (env.OBSERVE_SITE ?? "").trim();
  const serviceName = (env.OTEL_SERVICE_NAME ?? "").trim();
  const resourceAttributes = parseOTELAttributes(env.OTEL_RESOURCE_ATTRIBUTES ?? "");
  return {
    base: base.base,
    ingestKey: key,
    site,
    source: base.source,
    ...(serviceName !== "" ? { serviceName } : {}),
    resourceAttributes,
  };
}

function trimBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** http/protobuf and http/json both reach Observe over the transport Ship actually uses. */
function otlpProtocolUsable(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "" || v === "http/protobuf" || v === "http/json";
}

/**
 * OTLP header list (k=v,k=v per the OTel spec) → the x-api-key value, if any.
 * Keys compare case-insensitively; a repeated key lets the last entry win.
 */
export function otlpHeaderXAPIKey(raw: string): string {
  let key = "";
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim().toLowerCase();
    if (name !== "x-api-key") continue;
    key = pair.slice(eq + 1).trim();
  }
  return key;
}

/** OTLP resource-attribute list (k=v,k=v) → a map. Malformed entries are skipped, not fatal. */
export function parseOTELAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key === "") continue;
    out[key] = pair.slice(eq + 1).trim();
  }
  return out;
}
