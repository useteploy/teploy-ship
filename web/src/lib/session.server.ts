import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { normalizeRole, roleAllows } from "teploy-ship/runtime";
import type { Role } from "teploy-ship/runtime";

import { publicOrigin } from "./oidc.server.js";
import { shipRuntime, webToken } from "./store.server.js";

/**
 * Web-side identity + authorization for Ship, conforming to the Teploy RBAC
 * contract (admin/editor/viewer). Sessions are stateless signed cookies so the
 * web surface stays horizontally scalable (no shared session store) and the
 * principal maps 1:1 to a future OIDC claim.
 *
 * Three ways to authenticate, in order:
 *   1. `Authorization: Bearer <SHIP_WEB_TOKEN>` — API + bootstrap, admin.
 *   2. `ship_session` signed cookie — a logged-in user carrying their role.
 *   3. Legacy `ship_token` cookie == SHIP_WEB_TOKEN — back-compat, admin.
 * The env SHIP_WEB_TOKEN is always an admin master credential, so an operator
 * is never locked out and existing API callers keep working.
 */

export interface Principal {
  /**
   * Stable identity. For SSO this is `issuer#sub`, not the username: usernames
   * change, get reused, and collide across providers, so anything keyed on one
   * (audit trails, ownership, per-user settings) silently follows the name
   * rather than the person.
   */
  user: string;
  /** Friendly name for display. Falls back to `user`. */
  display?: string;
  role: Role;
}

/** How a session was established. "pw" = local account (role is re-read from the
 * store on every request, so demotion/removal is immediate). "sso" = OIDC (the
 * IdP is authoritative per-login; the signed cookie carries the mapped role and
 * there is no local store row to look up). */
export type SessionKind = "pw" | "sso";

export interface Session extends Principal {
  kind: SessionKind;
}

export const SESSION_COOKIE = "ship_session";
const SESSION_TTL_S = 60 * 60 * 24 * 30;
/**
 * How long an SSO session may act on the role the IdP asserted at login.
 *
 * The role rides in the signed cookie, so a group removal, a disabled account,
 * or a demotion at the IdP had no effect until the cookie expired — up to 30
 * days of authority the IdP had already revoked. Bounding re-authentication
 * separately from cookie lifetime keeps the IdP roughly authoritative without
 * a server-side session store.
 */
const SSO_REAUTH_S = 60 * 60 * 12;

export { roleAllows };

function sessionSecret(): Buffer {
  // Stable HMAC key derived from the server's web token (always set).
  // SHIP_SESSION_SECRET overrides so sessions can survive a token rotation.
  const base = process.env.SHIP_SESSION_SECRET ?? webToken();
  return createHash("sha256").update(`ship-session:${base}`).digest();
}

/**
 * Fingerprint of the CURRENT master credential, stamped into every session.
 *
 * With SHIP_SESSION_SECRET set, session signatures stopped depending on
 * SHIP_WEB_TOKEN — which is the documented point (sessions survive a token
 * rotation) but had a consequence nobody wanted: a session minted with a
 * LEAKED token stayed valid, as unconditional admin, for the full 30-day
 * cookie lifetime. Rotation was not revocation. Sessions established via the
 * master credential now carry its fingerprint and die the moment it changes;
 * ordinary account sessions are unaffected, so rotation still does not log
 * everyone out.
 */
function credentialVersion(): string {
  return createHash("sha256").update(webToken()).digest("base64url").slice(0, 16);
}

/** Constant-time comparison against the server web token. */
export function tokenMatches(presented: string | null): boolean {
  if (presented === null || presented === "") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(webToken()).digest();
  return timingSafeEqual(a, b);
}

// ── Stateless signed sessions ────────────────────────────────────────────

export function signSession(p: Principal, kind: SessionKind = "pw", now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_TTL_S;
  const payload = Buffer.from(
    JSON.stringify({
      u: p.user,
      ...(p.display !== undefined && p.display !== p.user ? { d: p.display } : {}),
      r: p.role,
      k: kind,
      exp,
      // Only the master-credential identity is pinned to the token; pinning
      // account sessions would make rotation log every user out for nothing.
      ...(p.user === "token" ? { cv: credentialVersion() } : {}),
      // When the IdP's assertion must be refreshed (SSO only).
      ...(kind === "sso" ? { rv: Math.floor(now / 1000) + SSO_REAUTH_S } : {}),
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string | null, now = Date.now()): Session | null {
  if (token === null || token === "") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: string;
      r?: string;
      k?: string;
      exp?: number;
      cv?: string;
      rv?: number;
      d?: string;
    };
    const seconds = Math.floor(now / 1000);
    if (typeof claims.exp !== "number" || claims.exp < seconds) return null;
    if (typeof claims.u !== "string") return null;
    // A master-credential session dies with the credential it was minted from.
    if (claims.u === "token" && claims.cv !== credentialVersion()) return null;
    const kind: SessionKind = claims.k === "sso" ? "sso" : "pw";
    // An SSO session past its re-auth window has to go back to the IdP, which
    // is where role and account status actually live.
    if (kind === "sso" && (typeof claims.rv !== "number" || claims.rv < seconds)) return null;
    return {
      user: claims.u,
      ...(typeof claims.d === "string" ? { display: claims.d } : {}),
      role: normalizeRole(claims.r),
      kind,
    };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const raw = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1] ?? null;
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Resolve the authenticated principal for a request, or null.
 *
 * For cookie sessions the role is re-derived from the user store on every
 * request, so a demotion or removal takes effect immediately rather than
 * lingering in a stateless cookie until it expires. The store is the source of
 * truth; the signed cookie only proves *who* you are, not *what* you may do. */
export async function currentUser(request: Request): Promise<Principal | null> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
  if (bearer !== null && tokenMatches(bearer)) return { user: "token", role: "admin" };

  const session = verifySession(readCookie(request, SESSION_COOKIE));
  if (session !== null) {
    // The bootstrap/master-credential session (token login) has no stored
    // account — it is always admin, like the bearer path.
    if (session.user === "token") return { user: "token", role: "admin" };
    // SSO sessions have no local account: the IdP is authoritative per-login and
    // the role rides in the tamper-proof signed cookie. Trust it (bounded by the
    // cookie TTL); re-authentication re-reads the role from the IdP.
    if (session.kind === "sso") {
      return { user: session.user, ...(session.display !== undefined ? { display: session.display } : {}), role: session.role };
    }
    const runtime = await shipRuntime();
    const stored = await runtime.users.get(session.user);
    if (stored !== null) return { user: stored.username, role: stored.role };
    // The account was removed — the session is dead even if the cookie is valid.
    return null;
  }

  // Back-compat: a legacy single-token cookie is an admin.
  if (tokenMatches(readCookie(request, "ship_token"))) return { user: "token", role: "admin" };

  return null;
}

// ── Route authorization ──────────────────────────────────────────────────

// Admin-only areas: they read/write secrets and accounts.
const ADMIN_PREFIXES = ["/settings", "/users"];
// Governed by the authority grants (governance.ts) INSIDE the route, not by
// role here: a named user may hold `approve` or `policies` without being an
// editor or admin, and a viewer may read what the rules are. Every mutation on
// these paths calls `may()` itself — see authority.server.ts. The Inbox ("/")
// is exact-match: its approve / launch / new-run posts are all `approve`-gated.
const AUTHORITY_PATHS = ["/runs", "/api/runs", "/sources", "/projects", "/policies", "/api/policies"];

/** Minimum role for a request. Reads → viewer, mutations → editor, admin areas
 * → admin. Fails closed: an unclassified mutation requires editor, never
 * viewer. Self-service password change (/account) is allowed for any user. */
export function requiredRole(method: string, path: string): Role {
  if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "admin";
  if (path === "/" || AUTHORITY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return "viewer";
  if (path === "/account" || path.startsWith("/account/") || path === "/logout") return "viewer";
  return method === "GET" || method === "HEAD" ? "viewer" : "editor";
}

// ── Login ──────────────────────────────────────────────────────────────

/** Verify credentials against the user store, falling back to the web token
 * as an admin master credential (so the operator is never locked out). Always
 * spends hashing time on a miss to hide which usernames exist. */
export async function authenticate(username: string, password: string): Promise<Principal | null> {
  const runtime = await shipRuntime();
  const user = await runtime.users.verify(username, password);
  if (user !== null) return { user: user.username, role: user.role };
  // Master credential: the server web token authenticates as the reserved
  // "token" admin principal (same identity as the API bearer path).
  if (tokenMatches(password)) return { user: "token", role: "admin" };
  return null;
}

/**
 * SameSite is Lax, not Strict, because the SSO callback cannot work under
 * Strict: `handleCallback` sets this cookie and redirects to "/", and that last
 * hop is the tail of a cross-site redirect chain that began at the IdP.
 * Browsers withhold Strict cookies on a cross-site-initiated top-level
 * navigation, so the user would land on "/" with no cookie, bounce back to
 * /login, and only appear signed in after a manual reload. Password login never
 * leaves the site, which is why Strict looked fine.
 *
 * Lax is not a CSRF regression: it is still withheld on cross-site POST, which
 * is every mutation Ship has. `sameOrigin` below covers what SameSite alone
 * does not, matching what dash already does.
 */
/**
 * Whether the browser reached us over HTTPS.
 *
 * Shared with the OIDC flow deliberately. Password login used to read
 * `X-Forwarded-Proto` unconditionally to decide the cookie's Secure attribute,
 * which is the exact header-downgrade the OIDC code documents defending
 * against: a proxy that forwards rather than overwrites the client's header,
 * or a directly reachable backend, could mint a privileged session cookie
 * WITHOUT Secure on an HTTPS deployment.
 */
export function requestIsSecure(request: Request): boolean {
  return publicOrigin(request).startsWith("https://");
}

export function sessionSetCookie(p: Principal, secure: boolean, kind: SessionKind = "pw"): string {
  const parts = [
    `${SESSION_COOKIE}=${signSession(p, kind)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_S}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Whether a state-changing request came from our own origin.
 *
 * Belt-and-braces alongside SameSite=Lax, for a browser or intermediary that
 * does not enforce it. Fetch Metadata is preferred when present; "none" is a
 * user-initiated navigation (address bar, bookmark), which is not CSRF. A
 * request carrying neither header is not a browser form post, so it is not the
 * CSRF case — API callers authenticate with a bearer token, which is never
 * attached ambiently.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "") return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "") {
    try {
      return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
    } catch {
      return false;
    }
  }
  return true;
}

/** Methods that can change state, and so need the cross-origin check. */
export function isMutating(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}
