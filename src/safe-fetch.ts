/**
 * The boundary for fetching a URL that came from imported context (an issue
 * body, a task description, a tool response, a retrieved page). Programme
 * packages S01 and S04: imported text can name any address it likes, and the
 * only thing standing between that text and a privileged request from this
 * host (cloud metadata, the tailnet, a loopback admin port, the Nucleus store)
 * is the decision made here.
 *
 * PURE AND DEPENDENCY-INJECTED. Nothing in this module touches the network or
 * DNS itself: the caller hands in `resolve` (name -> addresses) and `fetch`.
 * Nothing is wired into a route yet; this is the contract the routes will call.
 * It imports nothing, so it is safe to bundle anywhere.
 *
 * WHY A HOSTNAME CHECK IS NOT ENOUGH. `https://innocent.example/` passes any
 * string test and may resolve to 169.254.169.254. So the decision is made on
 * the RESOLVED addresses, and when ANY answer is private the whole name is
 * refused (a rebinding record that mixes one public and one private address
 * must not be allowed to pick the private one at connect time).
 *
 * WHY THE ADDRESS IS PINNED. Checking a name and then letting the HTTP client
 * resolve it again is a race the attacker controls (DNS rebinding with a zero
 * TTL). `retrieveUntrusted` therefore resolves each hop exactly once and hands
 * the validated address to the injected `fetch` as its third argument. The
 * injected fetch MUST connect to that address (for undici: an Agent whose
 * `connect.lookup` returns it) and keep the original hostname for SNI and the
 * Host header. A fetch that ignores the pin re-opens the rebinding window; the
 * wiring change that supplies the production fetch owns that, and must have a
 * test against a real socket.
 *
 * WHAT IT DECIDES, in order, for every hop (the first URL and every redirect
 * target alike, because a public first hop that redirects to 10.0.0.5 is the
 * canonical bypass): scheme allowlist, no userinfo, port allowlist, hostname
 * shape and name denylist, allowHosts, then the address class of every
 * resolved address. WHATWG URL parsing is the single parser: decimal, hex,
 * octal and short IPv4 spellings, full-width digits, ideographic dots and
 * IDN are normalised by it before any rule runs, and the normalised `href` is
 * what is fetched, so the checker and the client cannot disagree about the host.
 *
 * Credentials: no cookies, no Authorization, no referrer, `credentials:
 * "omit"`; caller headers are filtered to a small safe set and are never
 * carried across a redirect to a different origin.
 */

export type DenyReason =
  | "invalid_url"
  | "scheme"
  | "userinfo"
  | "port"
  | "host_denied"
  | "host_not_allowed"
  | "ambiguous_ip"
  | "resolve_failed"
  | "no_addresses"
  | "bad_address"
  | "private_address"
  | "redirect_missing_location"
  | "redirect_loop"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "fetch_failed";

export interface Pin {
  /** The validated address the connection must be made to. */
  address: string;
  family: 4 | 6;
  /** The hostname to keep for SNI / Host (the URL's, lowercased, no trailing dot). */
  hostname: string;
}

export type TargetDecision =
  | { allowed: true; url: URL; pin: Pin; addresses: string[] }
  | { allowed: false; reason: DenyReason; detail: string };

export interface TargetOptions {
  /** name -> every A/AAAA answer. Called once per hop for a non-literal host. */
  resolve: (hostname: string) => Promise<string[]>;
  /** Exact hosts ("docs.example.com") or suffix wildcards ("*.example.com"). When set, nothing else passes. */
  allowHosts?: readonly string[];
  /** Permit RFC1918, CGNAT, loopback and ULA. Link-local and metadata stay denied regardless. */
  allowPrivate?: boolean;
  /** Permit plain http. Off by default. */
  allowHttp?: boolean;
  /** Ports other than the scheme default. Empty by default. */
  allowPorts?: readonly number[];
}

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
  "metadata.tencentyun.com",
  "100.100.100.200",
]);
const DENIED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".ts.net", ".onion"];

/** Strip one trailing dot and lowercase; `LOCALHOST.` and `localhost` are the same name. */
function canonicalHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Strict dotted-quad: four decimal parts, no leading zeros (010 is octal to some stacks, decimal to others). */
export function parseIPv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  const parts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const s = m[i]!;
    if (s.length > 1 && s.startsWith("0")) return null;
    const n = Number(s);
    if (n > 255) return null;
    parts.push(n);
  }
  return parts;
}

/** RFC 4291 text -> 16 bytes. No zone ids (a zone is a local-interface selector; refuse). */
export function parseIPv6(text: string): number[] | null {
  let s = text;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%") || !s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const lastPart = s.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const v4 = parseIPv4(lastPart);
    if (v4 === null) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (head === null || rest === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 4) {
    groups[6] = (tail[0]! << 8) | tail[1]!;
    groups[7] = (tail[2]! << 8) | tail[3]!;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  return bytes;
}

type Class = "public" | "private" | "linklocal";

function classifyV4(b: readonly number[]): Class {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 169 && c === 254) return "linklocal";
  if (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && b[2] === 0) ||
    (a === 192 && c === 0 && b[2] === 2) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113) ||
    a >= 224
  ) return "private";
  return "public";
}

function classifyV6(b: readonly number[]): Class {
  const allZeroTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  // :: and ::1 and the deprecated IPv4-compatible ::/96
  if (allZeroTo(12)) return "private";
  // IPv4-mapped ::ffff:0:0/96 -- refused outright, whatever the embedded v4 is.
  if (allZeroTo(10) && b[10] === 0xff && b[11] === 0xff) return "private";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "linklocal"; // fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return "private"; // fec0::/10 site-local
  if ((b[0]! & 0xfe) === 0xfc) return "private"; // fc00::/7 ULA (includes fd00:ec2::254)
  if (b[0] === 0xff) return "private"; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "private"; // documentation
  // NAT64 64:ff9b::/96 and 6to4 2002::/16 embed an IPv4 address the NAT/relay will reach.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return "private";
  if (b[0] === 0x20 && b[1] === 0x02) return "private";
  return "public";
}

/** Classify a resolved address. Null when it is not a clean IP literal (refuse, never guess). */
export function classifyAddress(address: string): { family: 4 | 6; cls: Class } | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) return { family: 4, cls: classifyV4(v4) };
  const v6 = parseIPv6(address);
  if (v6 !== null) return { family: 6, cls: classifyV6(v6) };
  return null;
}

function hostMatches(host: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const p = canonicalHost(raw);
    if (p.startsWith("*.")) {
      if (host.endsWith(p.slice(1)) && host.length > p.length - 1) return true;
    } else if (host === p) return true;
  }
  return false;
}

const deny = (reason: DenyReason, detail: string): TargetDecision => ({ allowed: false, reason, detail });

/**
 * Decide whether `input` may be retrieved. Resolves a non-literal hostname
 * once; the returned `pin` is the address to connect to.
 */
export async function validateRetrievalTarget(input: string | URL, options: TargetOptions): Promise<TargetDecision> {
  const raw = typeof input === "string" ? input.trim() : input.href;
  // Userinfo is judged on the raw text as well: the parser may drop an empty `@`.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw.replace(/\\/g, "/"))) return deny("userinfo", "credentials in URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny("invalid_url", "does not parse");
  }
  const allowedSchemes = options.allowHttp === true ? ["https:", "http:"] : ["https:"];
  if (!allowedSchemes.includes(url.protocol)) return deny("scheme", `scheme ${url.protocol} not allowed`);
  if (url.username !== "" || url.password !== "") return deny("userinfo", "credentials in URL");

  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (port !== defaultPort && !(options.allowPorts ?? []).includes(port)) return deny("port", `port ${port} not allowed`);

  const host = canonicalHost(url.hostname);
  if (host === "") return deny("invalid_url", "empty host");
  if (/[^\x21-\x7e]/.test(host) || host.includes("%")) return deny("invalid_url", "non-ascii or escaped host");

  const v4Literal = parseIPv4(host);
  const v6Literal = host.includes(":") ? parseIPv6(host) : null;
  const isLiteral = v4Literal !== null || v6Literal !== null;
  if (host.includes(":") && v6Literal === null) return deny("invalid_url", "bad IPv6 literal");

  if (!isLiteral) {
    // URL has already folded every IPv4 spelling it understands. A last label
    // that is still numeric or 0x-hex means some stack could read it as an
    // address; refuse rather than reason about it.
    const last = host.slice(host.lastIndexOf(".") + 1);
    if (/^(\d+|0x[0-9a-f]*)$/i.test(last)) return deny("ambiguous_ip", "numeric host that is not a clean dotted quad");
    if (!host.includes(".")) return deny("host_denied", "single-label host");
    if (METADATA_HOSTS.has(host)) return deny("host_denied", "cloud metadata hostname");
    if (host === "localhost" || DENIED_SUFFIXES.some((s) => host.endsWith(s))) return deny("host_denied", "local or internal name");
  } else if (METADATA_HOSTS.has(host)) {
    return deny("host_denied", "cloud metadata address");
  }

  if (options.allowHosts !== undefined && !hostMatches(host, options.allowHosts)) {
    return deny("host_not_allowed", `${host} is not in the allowlist`);
  }

  let addresses: string[];
  if (isLiteral) {
    addresses = [host];
  } else {
    try {
      addresses = await options.resolve(host);
    } catch (error) {
      return deny("resolve_failed", error instanceof Error ? error.message : String(error));
    }
    if (!Array.isArray(addresses) || addresses.length === 0) return deny("no_addresses", "name resolved to nothing");
  }

  let first: { address: string; family: 4 | 6 } | undefined;
  for (const address of addresses) {
    const c = typeof address === "string" ? classifyAddress(address) : null;
    if (c === null) return deny("bad_address", `unparseable resolved address ${String(address)}`);
    // ANY private answer refuses the name (rebinding records mix public and private).
    if (c.cls === "linklocal" || (c.cls === "private" && options.allowPrivate !== true)) {
      return deny("private_address", `${host} resolves to ${address} (${c.cls})`);
    }
    first ??= { address, family: c.family };
  }
  return { allowed: true, url, pin: { address: first!.address, family: first!.family, hostname: host }, addresses };
}

// ---------------------------------------------------------------------------

export interface RetrieveDeps extends TargetOptions {
  /**
   * The network call. Must honour `init.redirect === "manual"` and connect to
   * `pin.address`. The third argument is what makes rebinding impossible.
   */
  fetch: (url: string, init: RequestInit, pin: Pin) => Promise<Response>;
  maxHops?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Extra request headers. Credential-bearing ones are dropped. */
  headers?: Record<string, string>;
}

export type RetrieveResult =
  | { ok: true; status: number; finalUrl: string; contentType: string; body: Uint8Array; hops: string[] }
  | { ok: false; reason: DenyReason; detail: string; hops: string[] };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { accept: "text/*, application/json;q=0.9, */*;q=0.1" };
  for (const [k, v] of Object.entries(headers ?? {})) if (SAFE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

class Deadline extends Error {}

function race<T>(work: Promise<T>, deadline: Promise<never>): Promise<T> {
  return Promise.race([work, deadline]);
}

export async function retrieveUntrusted(input: string, deps: RetrieveDeps): Promise<RetrieveResult> {
  const maxHops = deps.maxHops ?? 5;
  const maxBytes = deps.maxBytes ?? 1_048_576;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const hops: string[] = [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Deadline("deadline exceeded"));
    }, timeoutMs);
  });
  deadline.catch(() => undefined); // never an unhandled rejection when the work wins
  const fail = (reason: DenyReason, detail: string): RetrieveResult => ({ ok: false, reason, detail, hops });

  try {
    let current: string = input;
    const seen = new Set<string>();
    let previousOrigin: string | undefined;
    for (let hop = 0; ; hop++) {
      const decision = await race(validateRetrievalTarget(current, deps), deadline);
      if (!decision.allowed) return fail(decision.reason, `hop ${hop}: ${decision.detail}`);
      const href = decision.url.href;
      if (seen.has(href)) return fail("redirect_loop", `hop ${hop}: ${href} already visited`);
      seen.add(href);
      hops.push(href);

      // Credentials never cross an origin; here none exist at all, but keep the rule explicit.
      const headers = safeHeaders(previousOrigin === undefined || previousOrigin === decision.url.origin ? deps.headers : undefined);
      previousOrigin = decision.url.origin;
      const response = await race(
        deps.fetch(
          href,
          { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", headers, signal: controller.signal },
          decision.pin,
        ),
        deadline,
      );

      if (REDIRECTS.has(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (location === null || location === "") return fail("redirect_missing_location", `hop ${hop}: ${response.status} without Location`);
        if (hop + 1 > maxHops) return fail("too_many_redirects", `more than ${maxHops} redirects`);
        try {
          current = new URL(location, href).href;
        } catch {
          return fail("invalid_url", `hop ${hop}: unparseable Location`);
        }
        continue;
      }

      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        return fail("too_large", `declared ${declared} bytes, limit ${maxBytes}`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await race(reader.read(), deadline);
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            void reader.cancel().catch(() => undefined);
            return fail("too_large", `body exceeded ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        body.set(c, offset);
        offset += c.byteLength;
      }
      return {
        ok: true,
        status: response.status,
        finalUrl: href,
        contentType: response.headers.get("content-type") ?? "",
        body,
        hops,
      };
    }
  } catch (error) {
    if (error instanceof Deadline) return fail("timeout", `no complete response within ${timeoutMs}ms`);
    return fail("fetch_failed", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
