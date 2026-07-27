import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { normalizeRole, roleAllows } from "teploy-ship/runtime";
import type { Role } from "teploy-ship/runtime";

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
  user: string;
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

export { roleAllows };

function sessionSecret(): Buffer {
  // Stable HMAC key derived from the server's web token (always set).
  // SHIP_SESSION_SECRET overrides so sessions can survive a token rotation.
  const base = process.env.SHIP_SESSION_SECRET ?? webToken();
  return createHash("sha256").update(`ship-session:${base}`).digest();
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
  const payload = Buffer.from(JSON.stringify({ u: p.user, r: p.role, k: kind, exp })).toString("base64url");
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
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; r?: string; k?: string; exp?: number };
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(now / 1000)) return null;
    if (typeof claims.u !== "string") return null;
    const kind: SessionKind = claims.k === "sso" ? "sso" : "pw";
    return { user: claims.u, role: normalizeRole(claims.r), kind };
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
    if (session.kind === "sso") return { user: session.user, role: session.role };
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

// Admin-only areas: they read/write secrets, sources, and accounts.
const ADMIN_PREFIXES = ["/settings", "/sources", "/users"];

/** Minimum role for a request. Reads → viewer, mutations → editor, admin areas
 * → admin. Fails closed: an unclassified mutation requires editor, never
 * viewer. Self-service password change (/account) is allowed for any user. */
export function requiredRole(method: string, path: string): Role {
  if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "admin";
  if (path === "/account" || path.startsWith("/account/")) return "viewer";
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

export function sessionSetCookie(p: Principal, secure: boolean, kind: SessionKind = "pw"): string {
  const parts = [
    `${SESSION_COOKIE}=${signSession(p, kind)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_S}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
