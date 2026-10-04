/**
 * Wires src/safe-fetch.ts to the forge fetches (programme S01/S04): the
 * production pinned fetch, the operator allow-list, and the flag.
 *
 * Why this exists. A repository URL typed into the setup form (or carried by a
 * project, a delivery or an imported issue) becomes `${ref.base}/api/v1/...`
 * and is fetched with the forge token attached. Nothing checked where `base`
 * points: `http://169.254.169.254/x/y`, a loopback admin port or the tailnet
 * all received a request with the token. safe-fetch.ts decides; this module
 * makes the decision bite and keeps it from breaking the legitimate case.
 *
 * SELF-HOSTED FORGES ARE LEGITIMATE. Ship's primary forge is a Forgejo on a
 * private network, usually `http://forgejo:3000` or `https://git.lan`: exactly
 * what the default policy refuses. So enforcement has an operator allow-list
 * (`SHIP_SAFE_FETCH_ALLOW=host1,host2:3000`), and a listed host is trusted by
 * NAME: private addresses, http, any port and single-label names pass. Cloud
 * metadata and link-local addresses stay refused even for a listed host.
 *
 * MODES (`SHIP_SAFE_FETCH`):
 *   unset / "shadow"  default. The request is untouched; what enforcement WOULD
 *                     have refused is logged (once per host and reason). The
 *                     check runs beside the request, never in front of it.
 *   "on"              enforce: refuse, validate every redirect hop, connect to
 *                     the validated address only.
 *   "off"             no check at all, not even the shadow lookup.
 *
 * The injected-fetch path (`fetchImpl` arguments, tests) is not touched: only
 * the DEFAULT forge fetch goes through here.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { classifyAddress, validateRetrievalTarget, type Pin, type TargetDecision } from "./safe-fetch.js";

export type EgressMode = "off" | "shadow" | "enforce";

export interface AllowEntry {
  host: string;
  /** Undefined: any port. */
  port?: number;
}

export interface EgressConfig {
  mode: EgressMode;
  allow: AllowEntry[];
}

export function parseAllowList(text: string | undefined): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const raw of (text ?? "").split(",")) {
    const item = raw.trim().toLowerCase();
    if (item === "") continue;
    const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(item);
    if (m === null) continue;
    const host = m[1]!.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    out.push(m[2] === undefined ? { host } : { host, port: Number(m[2]) });
  }
  return out;
}

export function egressConfig(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  const flag = (env.SHIP_SAFE_FETCH ?? "").trim().toLowerCase();
  const mode: EgressMode = flag === "on" ? "enforce" : flag === "off" ? "off" : "shadow";
  return { mode, allow: parseAllowList(env.SHIP_SAFE_FETCH_ALLOW) };
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolve: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export type EgressDecision =
  | { allowed: true; url: URL; pin: Pin; via: "policy" | "allowlist" }
  | { allowed: false; reason: string; detail: string };

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function allowListed(url: URL, allow: readonly AllowEntry[]): boolean {
  const host = bareHost(url);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return allow.some((e) => e.host === host && (e.port === undefined || e.port === port));
}

/** The decision for one hop: operator allow-list first, then the default policy. */
export async function decideEgress(input: string | URL, config: EgressConfig, resolve: Resolver = systemResolve): Promise<EgressDecision> {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input.trim() : input.href);
  } catch {
    return { allowed: false, reason: "invalid_url", detail: "does not parse" };
  }
  if (allowListed(url, config.allow)) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { allowed: false, reason: "scheme", detail: `scheme ${url.protocol} not allowed` };
    if (url.username !== "" || url.password !== "") return { allowed: false, reason: "userinfo", detail: "credentials in URL" };
    const host = bareHost(url);
    let addresses: string[];
    if (classifyAddress(host) !== null) addresses = [host];
    else {
      try {
        addresses = await resolve(host);
      } catch (error) {
        return { allowed: false, reason: "resolve_failed", detail: error instanceof Error ? error.message : String(error) };
      }
    }
    if (addresses.length === 0) return { allowed: false, reason: "no_addresses", detail: "name resolved to nothing" };
    for (const address of addresses) {
      const c = classifyAddress(address);
      if (c === null) return { allowed: false, reason: "bad_address", detail: `unparseable resolved address ${address}` };
      // Trusting a name does not extend to metadata or link-local answers.
      if (c.cls === "linklocal" || address === "100.100.100.200") return { allowed: false, reason: "private_address", detail: `${host} resolves to ${address} (${c.cls})` };
    }
    const first = classifyAddress(addresses[0]!)!;
    return { allowed: true, url, pin: { address: addresses[0]!, family: first.family, hostname: host }, via: "allowlist" };
  }
  const decision: TargetDecision = await validateRetrievalTarget(url, { resolve });
  if (!decision.allowed) return { allowed: false, reason: decision.reason, detail: decision.detail };
  return { allowed: true, url: decision.url, pin: decision.pin, via: "policy" };
}

/**
 * A fetch that connects to `pin.address` whatever the name resolves to at
 * connect time, keeping the URL's hostname for SNI and Host. One short-lived
 * Agent per request: the pin is per request, so it cannot be a shared one.
 * Matches `RetrieveDeps.fetch`, so retrieveUntrusted can use it directly.
 */
export async function pinnedFetch(url: string, init: RequestInit, pin: Pin): Promise<Response> {
  const agent = new Agent({
    connect: {
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all === true) callback(null, [{ address: pin.address, family: pin.family }]);
        else callback(null, pin.address, pin.family);
      }) as never,
    },
  });
  try {
    return (await undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: agent })) as unknown as Response;
  } finally {
    // close() is graceful: the in-flight body finishes, then the sockets go.
    void agent.close().catch(() => undefined);
  }
}

export interface EgressDeps {
  config?: () => EgressConfig;
  resolve?: Resolver;
  /** The network call for an allowed hop. Default: pinnedFetch. */
  fetch?: (url: string, init: RequestInit, pin: Pin) => Promise<Response>;
  /** The untouched path (off and shadow). Read at call time: tests replace globalThis.fetch. */
  passthrough?: typeof fetch;
  log?: (line: string) => void;
  maxRedirects?: number;
}

export class EgressDenied extends TypeError {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`forge request refused by SHIP_SAFE_FETCH: ${reason}: ${detail}`);
  }
}

const shadowSeen = new Set<string>();

/** Test hook: shadow logging dedupes per process. */
export function resetShadowLog(): void {
  shadowSeen.clear();
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The forge fetch. Same signature as `fetch`; git.ts and forge-state.ts use it
 * where they used the global.
 */
export function createForgeFetch(deps: EgressDeps = {}): typeof fetch {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const resolve = deps.resolve ?? systemResolve;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const config = (deps.config ?? egressConfig)();
    const passthrough = deps.passthrough ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    if (config.mode === "off") return passthrough(input as never, init);
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (config.mode === "shadow") {
      void (async () => {
        const d = await decideEgress(href, config, resolve);
        if (d.allowed) return;
        let host = "?";
        try {
          host = new URL(href).host;
        } catch {
          // keep "?"
        }
        const key = `${host} ${d.reason}`;
        if (shadowSeen.has(key)) return;
        shadowSeen.add(key);
        log(`[safe-fetch:shadow] would refuse forge request to ${host}: ${d.reason} (${d.detail}). Set SHIP_SAFE_FETCH_ALLOW=${host} if this is a legitimate forge, then SHIP_SAFE_FETCH=on.`);
      })().catch(() => undefined);
      return passthrough(input as never, init);
    }

    if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("forge egress needs a URL string");
    const doFetch = deps.fetch ?? pinnedFetch;
    const wanted = init?.redirect ?? "follow";
    const maxRedirects = deps.maxRedirects ?? 3;
    let current = href;
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    const origin0 = new URL(href).origin;
    for (let hop = 0; ; hop++) {
      const d = await decideEgress(current, config, resolve);
      if (!d.allowed) throw new EgressDenied(d.reason, `hop ${hop}: ${d.detail}`);
      const response = await doFetch(d.url.href, currentInit, d.pin);
      if (!REDIRECTS.has(response.status) || wanted === "manual") return response;
      void response.body?.cancel().catch(() => undefined);
      if (wanted === "error") throw new TypeError("unexpected redirect");
      const location = response.headers.get("location");
      if (location === null || location === "" || hop + 1 > maxRedirects) throw new EgressDenied("redirect", `hop ${hop}: missing Location or more than ${maxRedirects} redirects`);
      current = new URL(location, d.url).href;
      if (new URL(current).origin !== origin0) {
        // Credentials never follow a redirect off the original origin.
        const headers = new Headers(currentInit.headers);
        headers.delete("authorization");
        currentInit = { ...currentInit, headers };
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentInit.method === "POST")) {
        const { body: _body, ...rest } = currentInit;
        currentInit = { ...rest, method: "GET" };
      }
    }
  }) as typeof fetch;
}

/** The instance the forge code uses. */
export const forgeFetch: typeof fetch = createForgeFetch();
