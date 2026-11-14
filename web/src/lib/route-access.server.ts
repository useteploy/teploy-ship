import { roleAllows } from "teploy-ship/runtime";
import type { Role } from "teploy-ship/runtime";

import { currentUser } from "./session.server.js";
import type { Principal } from "./session.server.js";

/**
 * Route authorization, in one place (SHIP-01, 2026-11-14).
 *
 * Two layers read this file:
 *
 *   1. The layout middleware (`routes/_layout.tsx`) decides on
 *      `gatePath(pathname)` — the SAME string the router dispatches on.
 *   2. Every loader and action calls `requireRouteRole` as its first
 *      statement, so the middleware is never the only thing between a
 *      signed-in user and a handler above their role.
 *
 * The defect that made both necessary: the middleware compared the raw request
 * path (`/%73ettings`) against a list of admin prefixes while the framework's
 * router decoded it and dispatched to `/settings`, whose action had no check
 * of its own. An editor became an admin with one percent-encoded letter.
 */

/**
 * The path the router will dispatch on, or null when the request must be
 * refused (400) before any authorization decision is made.
 *
 * It mirrors Neutron's `normalizePathname` (core/route-path.js: one
 * `decodeURIComponent`, no backslash / NUL / `..` segment, one trailing slash
 * stripped) and `parseUrlPath` (empty segments dropped, so `//settings` and
 * `/settings//` both reach `/settings`). `route-access.test.ts` pins this
 * against the framework's own functions so an upstream change shows up as a
 * failing test, not as a gap.
 *
 * It is deliberately STRICTER than the router in four ways. Nothing Ship
 * serves needs any of them, and each is a way for two readers of one path to
 * disagree:
 *   - an encoded slash, backslash, dot, NUL or percent sign (`%2f %5c %2e %00
 *     %25`) — the last is what a double-encoded path (`/%2573ettings`) is
 *     made of;
 *   - a decoded path that would change, or fail, under a second decode;
 *   - a `.` segment, or any control character;
 *   - a path that is not rooted.
 */
export function gatePath(rawPathname: string): string | null {
  const raw = rawPathname === "" ? "/" : rawPathname;
  if (/%(?:2f|5c|2e|00|25)/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("%")) return null;
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === ".." || s === ".")) return null;
  return `/${segments.join("/")}`;
}

/** What a handler needs: a role floor, or "public" (the route authenticates itself, or needs nothing). */
export type RouteNeed = Role | "public";

interface RouteAccess {
  loader?: RouteNeed;
  action?: RouteNeed;
  /** What decides beyond the role floor, or why the route is public. */
  note: string;
}

/**
 * Every route under `routes/`, by the pattern the router matches, with the
 * role each handler requires. `route-access.test.ts` fails when a route file
 * exists that is not listed here, when a listed handler does not exist, and
 * when the middleware's `requiredRole` disagrees with an entry.
 *
 * "viewer" means any signed-in principal. Where the note names an authority
 * grant (`approve`, `steer`, `policies`, `auto`), the handler ALSO calls
 * `may()` (authority.server.ts) — a grant can be held by a named viewer, which
 * is why those routes have a viewer floor rather than editor.
 */
export const ROUTE_ACCESS = {
  // ── Admin ───────────────────────────────────────────────────────────────
  "/settings": { loader: "admin", action: "admin", note: "accounts, roles, passwords, configuration" },
  "/connect": { loader: "admin", action: "admin", note: "Akiroo handshake; the route answers a non-admin itself (connectAccess)" },
  "/connect/return": { loader: "admin", note: "Akiroo handshake return; the route answers a non-admin itself (connectAccess)" },

  // ── Signed in; an authority grant decides every mutation inside the route ─
  "/": { loader: "viewer", action: "viewer", note: "approve grant for decisions and launches; editor for submit-request" },
  "/runs": { loader: "viewer", note: "read" },
  "/runs/:id": { loader: "viewer", action: "viewer", note: "steer / approve grants per intent" },
  "/projects": { loader: "viewer", action: "viewer", note: "policies / auto grants" },
  "/workflows": { loader: "viewer", action: "viewer", note: "policies / auto grants" },
  "/setup": { loader: "viewer", action: "viewer", note: "policies / approve grants" },
  "/policies": { loader: "viewer", action: "viewer", note: "policies grant" },
  "/sources": { loader: "viewer", note: "redirect to /projects" },
  "/api/policies": { loader: "viewer", action: "viewer", note: "policies grant" },
  "/api/runs/scan": { action: "viewer", note: "approve grant" },
  "/api/runs/:id/decide": { action: "viewer", note: "approve grant" },
  "/api/runs/:id/promote": { action: "viewer", note: "approve grant" },
  "/api/runs/:id/rollback-delivery": { action: "viewer", note: "approve grant" },
  "/api/runs/:id/findings": { loader: "viewer", note: "read, per-run visibility" },
  "/api/runs/:id/live": { loader: "viewer", note: "read, per-run visibility" },
  "/api/runs/:id/thread": { loader: "viewer", note: "read, per-run visibility" },
  "/api/runs/:id/workspace": { loader: "viewer", note: "read, per-run visibility" },
  "/account": { loader: "viewer", action: "viewer", note: "self-service password change" },
  "/logout": { loader: "viewer", action: "viewer", note: "anyone signed in can sign out" },

  // ── Viewer to read, editor to mutate (the middleware's default) ──────────
  "/incidents": { loader: "viewer", action: "editor", note: "steer / approve grants" },
  "/skills": { loader: "viewer", action: "editor", note: "policies grant" },
  "/coordination": { loader: "viewer", action: "editor", note: "approve grant" },
  "/recovery": { loader: "viewer", action: "editor", note: "approve grant, loader included" },
  "/bulletin-admin": { loader: "viewer", action: "editor", note: "policies grant" },
  "/api/event-rules": { loader: "viewer", action: "editor", note: "policies / auto grants" },
  "/api/event-rules/:id/dry-run": { action: "editor", note: "writes nothing" },
  "/api/event-sources": { action: "editor", note: "policies grant" },
  "/api/bulletin/sweep": { action: "editor", note: "machine tick, normally the bearer token" },
  "/api/artifacts/:id": { loader: "viewer", note: "read, per-run visibility" },
  "/fleet": { loader: "viewer", note: "read" },
  "/spend": { loader: "viewer", note: "redirect" },
  "/events": { loader: "viewer", note: "server-sent events, read" },
  "/knowledge": { loader: "viewer", note: "redirect" },
  "/reviews": { loader: "viewer", note: "redirect" },
  "/attention": { loader: "viewer", note: "redirect" },

  // ── Public: no session; each authenticates itself or serves nothing secret ─
  "/login": { loader: "public", action: "public", note: "rate-limited sign-in" },
  "/health": { loader: "public", note: "liveness probe" },
  "/oidc/login": { loader: "public", note: "SSO handshake" },
  "/oidc/callback": { loader: "public", note: "SSO handshake" },
  "/bulletin/:slug": { loader: "public", action: "public", note: "public board, rate-limited" },
  "/hooks/github": { action: "public", note: "HMAC-SHA256, SHIP_WEBHOOK_SECRET" },
  "/hooks/forgejo": { action: "public", note: "HMAC-SHA256, SHIP_WEBHOOK_SECRET" },
  "/hooks/slack": { action: "public", note: "Slack v0 signature + timestamp" },
  "/hooks/linear": { action: "public", note: "HMAC + signed timestamp" },
  "/hooks/observe": { action: "public", note: "X-Observe-Signature + freshness" },
  "/hooks/events/:source": { action: "public", note: "per-source HMAC or token" },
  "/api/incidents/intake": { action: "public", note: "Observe signature" },
  "/api/incidents/intake/dash": { action: "public", note: "X-Teploy-Signature" },
  "/.well-known/teploy.json": { loader: "public", note: "discovery document, 404 unless SHIP_DISCOVERY" },
} as const satisfies Record<string, RouteAccess>;

export type RoutePattern = keyof typeof ROUTE_ACCESS;
export type RouteHandler = "loader" | "action";

/** The role a handler requires, or "public". Throws on a handler the table does not list — fail closed. */
export function routeNeed(route: RoutePattern, handler: RouteHandler): RouteNeed {
  const need = (ROUTE_ACCESS[route] as RouteAccess)[handler];
  if (need === undefined) throw new Error(`route-access: ${route} lists no ${handler}`);
  return need;
}

function refusal(route: RoutePattern, status: 401 | 403, need: Role): Response {
  if (route.startsWith("/api/")) {
    const body = status === 401 ? { title: "Unauthorized", status } : { title: "Forbidden", status, detail: `requires the ${need} role` };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });
  }
  return new Response(status === 401 ? "Unauthorized — sign in first." : `Forbidden — this action requires the ${need} role.`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * The role check every non-public loader and action runs first. Returns the
 * principal; THROWS a 401 (no session) or 403 (role below the table's floor)
 * `Response`, which the framework serves as the handler's answer.
 *
 * The layout middleware normally refuses the same request earlier. This is the
 * second lock: it reads the role for the handler that is actually about to
 * run, so no disagreement about the request path can skip it.
 */
export async function requireRouteRole(request: Request, route: RoutePattern, handler: RouteHandler): Promise<Principal> {
  const need = routeNeed(route, handler);
  if (need === "public") throw new Error(`route-access: ${route} ${handler} is public and takes no role check`);
  const principal = await currentUser(request);
  if (principal === null) throw refusal(route, 401, need);
  if (!roleAllows(principal.role, need)) throw refusal(route, 403, need);
  return principal;
}
