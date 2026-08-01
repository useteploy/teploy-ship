import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import * as client from "openid-client";

import { normalizeRole } from "teploy-ship/runtime";
import type { Role } from "teploy-ship/runtime";

import { webToken } from "./store.server.js";
import { sessionSetCookie } from "./session.server.js";
import { resolveRole, resolveUsername, parseScopes } from "./oidc-map.js";

/**
 * OIDC single sign-on for Ship (Phase 2 of the Teploy RBAC contract). Ship acts
 * as an OpenID Connect relying party: login is delegated to an external identity
 * provider (the customer's own Okta/Azure AD/Google/Keycloak — "generic OIDC" —
 * or Teploy Platform acting as the IdP for Cloud). The IdP authenticates the
 * user; Ship verifies the signed ID token (authorization-code flow with PKCE +
 * state + nonce via openid-client), maps a claim to admin/editor/viewer, and
 * mints the SAME signed-cookie session password login issues.
 *
 * Ship is stateless by design (no server-side session store), so the in-flight
 * state/nonce/PKCE verifier ride in a short-lived signed, HttpOnly cookie rather
 * than a server map. The SSO session's role is carried in the (tamper-proof,
 * HMAC-signed) cookie and re-read from the IdP on each login, keeping the IdP
 * authoritative. Password login stays available as the break-glass path.
 *
 * Enabled only when SHIP_OIDC_ISSUER + SHIP_OIDC_CLIENT_ID are set.
 */

const FLOW_COOKIE = "ship_oidc_flow";
const FLOW_TTL_S = 600;

interface OIDCConfig {
  issuer: string;
  clientID: string;
  clientSecret: string;
  redirectURL: string;
  scopes: string[];
  label: string;
  usernameClaim: string;
  roleClaim: string;
  groupsClaim: string;
  adminGroup: string;
  editorGroup: string;
  viewerGroup: string;
  defaultRole: Role;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

let cachedConfig: OIDCConfig | null | undefined;

/** Parsed SSO config, or null when SSO is not configured. Cached. */
function config(): OIDCConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const issuer = env("SHIP_OIDC_ISSUER");
  const clientID = env("SHIP_OIDC_CLIENT_ID");
  if (issuer === "" || clientID === "") {
    cachedConfig = null;
    return null;
  }
  cachedConfig = {
    issuer,
    clientID,
    clientSecret: env("SHIP_OIDC_CLIENT_SECRET"),
    redirectURL: env("SHIP_OIDC_REDIRECT_URL"),
    scopes: parseScopes(env("SHIP_OIDC_SCOPES")),
    label: env("SHIP_OIDC_LABEL") || "Single sign-on",
    usernameClaim: env("SHIP_OIDC_USERNAME_CLAIM") || "preferred_username",
    roleClaim: env("SHIP_OIDC_ROLE_CLAIM") || "teploy_role",
    groupsClaim: env("SHIP_OIDC_GROUPS_CLAIM") || "groups",
    adminGroup: env("SHIP_OIDC_ADMIN_GROUP"),
    editorGroup: env("SHIP_OIDC_EDITOR_GROUP"),
    viewerGroup: env("SHIP_OIDC_VIEWER_GROUP"),
    defaultRole: normalizeRole(env("SHIP_OIDC_DEFAULT_ROLE")),
  };
  return cachedConfig;
}

export function oidcEnabled(): boolean {
  return config() !== null;
}

export function oidcLabel(): string {
  return config()?.label ?? "Single sign-on";
}

// ── Provider discovery (lazy, cached on success) ───────────────────────────

let discovered: Promise<client.Configuration> | null = null;

async function provider(cfg: OIDCConfig): Promise<client.Configuration> {
  if (discovered === null) {
    discovered = cfg.clientSecret !== ""
      ? client.discovery(new URL(cfg.issuer), cfg.clientID, cfg.clientSecret)
      : client.discovery(new URL(cfg.issuer), cfg.clientID, undefined, client.None());
  }
  try {
    return await discovered;
  } catch (err) {
    discovered = null; // don't cache a failed discovery — retry next login
    throw err;
  }
}

// ── Request helpers ────────────────────────────────────────────────────────

/**
 * The origin a browser actually reached us on.
 *
 * `X-Forwarded-*` is client input unless something in front of us overwrites
 * it, and Ship's shipped teploy.yml uses `ingress: host` — the web process is
 * published straight at <server-ip>:7460 with no proxy at all. Believing those
 * headers unconditionally therefore let any caller pick the scheme, and
 * `isSecure` feeds the cookie's `Secure` attribute: `X-Forwarded-Proto: http`
 * was enough to have session cookies minted without it.
 *
 * So, in order: an explicitly configured public URL wins (SHIP_PUBLIC_URL, the
 * same var the notifier and /sources already use); then the forwarded headers,
 * but only when the operator has said a proxy is in front (SHIP_TRUST_PROXY);
 * otherwise what the request itself claims.
 *
 * Dash gates the identical logic on the peer IP against a trusted-proxy CIDR
 * list. That is the better check and this should match it, but the web layer
 * here only ever sees a `Request` — Neutron's middleware context carries no
 * peer address — so the operator states it instead of us inferring it.
 */
export function publicOrigin(request: Request): string {
  const configured = env("SHIP_PUBLIC_URL");
  if (configured !== "") {
    try {
      const u = new URL(configured);
      return `${u.protocol.replace(":", "")}://${u.host}`;
    } catch {
      // Malformed value: fall through rather than fail the login outright.
    }
  }

  const url = new URL(request.url);
  if (trustProxy()) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
    if (proto !== undefined && proto !== "" && host !== undefined && host !== "") {
      return `${proto}://${host}`;
    }
  }
  return `${url.protocol.replace(":", "")}://${request.headers.get("host") || url.host}`;
}

/** Whether a reverse proxy in front of Ship is authoritative for scheme/host. */
export function trustProxy(): boolean {
  const raw = env("SHIP_TRUST_PROXY").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function redirectUri(request: Request, cfg: OIDCConfig): string {
  return cfg.redirectURL !== "" ? cfg.redirectURL : `${publicOrigin(request)}/oidc/callback`;
}

function isSecure(request: Request): boolean {
  return publicOrigin(request).startsWith("https://");
}

// ── Flow cookie (stateless state/nonce/verifier) ───────────────────────────

interface Flow {
  v: string; // PKCE code verifier
  s: string; // state
  n: string; // nonce
  exp: number;
}

function flowSecret(): Buffer {
  const base = process.env.SHIP_SESSION_SECRET ?? webToken();
  return createHash("sha256").update(`ship-oidc-flow:${base}`).digest();
}

function signFlow(flow: Flow): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  const sig = createHmac("sha256", flowSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyFlow(token: string | null, now = Date.now()): Flow | null {
  if (token === null || token === "") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = createHmac("sha256", flowSecret()).update(payload).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Flow;
    if (typeof flow.exp !== "number" || flow.exp < Math.floor(now / 1000)) return null;
    if (typeof flow.v !== "string" || typeof flow.s !== "string" || typeof flow.n !== "string") return null;
    return flow;
  } catch {
    return null;
  }
}

function flowSetCookie(value: string, secure: boolean): string {
  const parts = [`${FLOW_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${FLOW_TTL_S}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function flowClearCookie(secure: boolean): string {
  const parts = [`${FLOW_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
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

function fail(request: Request, message: string): Response {
  const headers = new Headers({ location: `/login?error=${encodeURIComponent(message)}` });
  headers.append("set-cookie", flowClearCookie(isSecure(request)));
  return new Response(null, { status: 302, headers });
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** Start the authorization-code flow: mint state/nonce/PKCE, stash them in a
 * signed flow cookie, and redirect to the IdP. */
export async function startLogin(request: Request): Promise<Response> {
  const cfg = config();
  if (cfg === null) return new Response("SSO is not configured", { status: 404 });

  let prov: client.Configuration;
  try {
    prov = await provider(cfg);
  } catch {
    return fail(request, "SSO provider is unavailable — try again shortly");
  }

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const authUrl = client.buildAuthorizationUrl(prov, {
    redirect_uri: redirectUri(request, cfg),
    scope: cfg.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  const flow: Flow = { v: codeVerifier, s: state, n: nonce, exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S };
  const headers = new Headers({ location: authUrl.href });
  headers.append("set-cookie", flowSetCookie(signFlow(flow), isSecure(request)));
  return new Response(null, { status: 302, headers });
}

/** Complete the flow: verify the flow cookie, exchange the code, verify the ID
 * token (signature/audience/expiry/state/nonce), map claims to a role, and mint
 * the SSO session cookie. */
export async function handleCallback(request: Request): Promise<Response> {
  const cfg = config();
  if (cfg === null) return new Response("SSO is not configured", { status: 404 });

  const flow = verifyFlow(readCookie(request, FLOW_COOKIE));
  if (flow === null) return fail(request, "SSO session expired — please sign in again");

  let prov: client.Configuration;
  try {
    prov = await provider(cfg);
  } catch {
    return fail(request, "SSO provider is unavailable — try again shortly");
  }

  // Reconstruct the callback URL against the PUBLIC origin so redirect_uri
  // matches the authorize request even behind a proxy that rewrites Host.
  const currentUrl = new URL(redirectUri(request, cfg));
  currentUrl.search = new URL(request.url).search;

  let claims: Record<string, unknown> | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(prov, currentUrl, {
      pkceCodeVerifier: flow.v,
      expectedState: flow.s,
      expectedNonce: flow.n,
    });
    claims = tokens.claims() as Record<string, unknown> | undefined;
  } catch {
    return fail(request, "SSO sign-in failed — please try again");
  }
  if (claims === undefined) return fail(request, "SSO response was missing an ID token");

  const username = resolveUsername(claims, cfg.usernameClaim);
  if (username === "") return fail(request, "SSO identity has no usable username claim");
  // "token" is the reserved bootstrap/bearer identity — never let SSO mint it.
  if (username.toLowerCase() === "token") return fail(request, "SSO username is reserved");

  // The principal is issuer + subject, which is the only identity an OIDC
  // provider promises is stable and unique. preferred_username can be changed
  // by its owner, reused after an account is deleted, and collides across two
  // IdPs — so audit history keyed on it is ambiguous, and any future per-user
  // record could be inherited by whoever holds the name next. The display name
  // stays the friendly one; the KEY does not.
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const issuer = typeof claims.iss === "string" ? claims.iss : cfg.issuer;
  if (subject === "") return fail(request, "SSO identity has no subject claim");
  const principal = `${issuer}#${subject}`;

  const role = resolveRole(claims, cfg);
  const secure = isSecure(request);
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", sessionSetCookie({ user: principal, display: username, role }, secure, "sso"));
  headers.append("set-cookie", flowClearCookie(secure));
  return new Response(null, { status: 302, headers });
}
