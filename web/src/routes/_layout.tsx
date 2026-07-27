import type { ComponentChildren } from "preact";
import type { MiddlewareFn } from "@neutron-build/core";

import { currentUser, requiredRole, roleAllows, sameOrigin, isMutating } from "../lib/session.server.js";
import { teployNav } from "../lib/nav.server.js";
import type { NavData } from "../lib/nav.server.js";

/** Cross-product dashboard switcher config (top-left). Server-side loader so it
 * renders with SSR and never causes a hydration mismatch. */
export function loader(): { nav: NavData } {
  return { nav: teployNav("ship") };
}

/**
 * Identity + RBAC for the whole surface (Teploy RBAC contract:
 * admin/editor/viewer), exported from the root layout because that is where
 * the framework actually collects middleware (route and layout modules — the
 * documented global src/middleware.ts is not loaded by either server; recorded
 * as a framework-excellence finding).
 *
 * A web approve button is remote code + spend approval, so nothing is served
 * unauthenticated, and the role gate fails closed. Authentication is a Bearer
 * SHIP_WEB_TOKEN (API/bootstrap → admin), a signed ship_session cookie (a
 * logged-in user carrying their role), or a legacy ship_token cookie
 * (back-compat → admin). Roles: reads need viewer, mutations need editor,
 * settings/sources/users need admin.
 */
export const middleware: MiddlewareFn = async (request, _context, next) => {
  const url = new URL(request.url);
  const path = url.pathname;
  // /hooks/* authenticates via webhook HMAC inside the route, not bearer;
  // /health is the family-convention liveness probe (teploy's deploy gate
  // polls it before any login could exist).
  // /oidc/* is the SSO handshake — it carries no session yet and must be reachable.
  if (path === "/login" || path === "/health" || path.startsWith("/hooks/") || path.startsWith("/oidc/") || path.startsWith("/assets/") || path === "/favicon.ico") return next();

  // /api/* is a machine surface: answer it with a status, never a redirect to a
  // login page a program cannot fill in. Its routes document 401/403 and a
  // caller that followed a 302 would parse the login HTML as its result.
  const isData = request.headers.get("x-neutron-data") === "true" || path.startsWith("/api/");
  const principal = await currentUser(request);
  if (principal === null) {
    if (isData) {
      return new Response(JSON.stringify({ title: "Unauthorized", status: 401 }), {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      });
    }
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }

  // CSRF — reject cross-origin state-changing requests. SameSite=Lax on the
  // session cookie already blocks the ordinary case; this covers a browser or
  // intermediary that does not enforce it. Bearer callers send neither Origin
  // nor Sec-Fetch-Site and so pass, which is correct: a bearer token is never
  // attached ambiently, so it cannot be ridden by a third-party page.
  if (isMutating(request.method) && !sameOrigin(request)) {
    if (isData) {
      return new Response(JSON.stringify({ title: "Cross-origin request blocked", status: 403 }), {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      });
    }
    return new Response("Cross-origin request blocked.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // RBAC — authenticated but possibly under-privileged for this route.
  const need = requiredRole(request.method, path);
  if (!roleAllows(principal.role, need)) {
    if (isData) {
      return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: `requires the ${need} role` }), {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      });
    }
    return new Response(`Forbidden — this action requires the ${need} role.`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return next();
};

/**
 * App shell. Styles are inline and minimal on purpose — this is an
 * operations surface, not a marketing page: monochrome, dense, readable.
 */
const CSS = `
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #e6edf3; --dim: #8b949e;
  --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top { display: flex; align-items: center; gap: 22px;
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 10; }
header.top .brand { font-weight: 700; color: var(--text); letter-spacing: .04em; font-size: 13px; }
details.switcher { position: relative; }
details.switcher > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--dim); font-size: 13px; }
details.switcher > summary::-webkit-details-marker { display: none; }
details.switcher > summary:hover { color: var(--text); border-color: var(--dim); }
details.switcher .caret { font-size: 10px; opacity: .7; }
details.switcher .switcher-menu { position: absolute; left: 0; top: 100%; margin-top: 4px; z-index: 30;
  min-width: 150px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden; }
details.switcher .switcher-item { display: block; padding: 8px 12px; font-size: 13px; color: var(--text); text-decoration: none; }
details.switcher a.switcher-item:hover { background: var(--bg); text-decoration: none; }
details.switcher .switcher-item.current { color: var(--dim); font-weight: 600; }
header.top nav.nav { display: flex; gap: 4px; }
header.top nav.nav a { color: var(--dim); padding: 5px 11px; border-radius: 6px; font-size: 13px; }
header.top nav.nav a:hover { color: var(--text); background: var(--panel); text-decoration: none; }
header.top nav.nav a.active { color: var(--text); background: var(--panel); }
header.top .spacer { flex: 1; }
header.top .env { color: var(--dim); font-size: 12px; }
header.top .env b { color: var(--text); font-weight: 500; }
main { max-width: 1080px; margin: 0 auto; padding: 22px 20px 60px; }
h1.page { font-size: 18px; margin: 4px 0 2px; }
h2.section { font-size: 14px; color: var(--dim); font-weight: 500; text-transform: uppercase;
  letter-spacing: .05em; margin: 28px 0 10px; }
.count { color: var(--dim); font-weight: 400; }
.card { border: 1px solid var(--border); background: var(--panel); border-radius: 8px;
  padding: 12px 14px; margin: 8px 0; }
.card.attn { border-left: 3px solid var(--yellow); }
.row-actions { display: flex; gap: 8px; align-items: center; }
.chip { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 12px;
  border: 1px solid var(--border); color: var(--dim); }
.chips { display: flex; gap: 6px; margin: 10px 0 4px; flex-wrap: wrap; }
.chips a { padding: 3px 11px; border-radius: 12px; border: 1px solid var(--border);
  color: var(--dim); font-size: 12px; }
.chips a:hover, .chips a.on { color: var(--text); border-color: var(--dim); text-decoration: none; }
button.sm { padding: 4px 10px; font-size: 12px; }
table.runs { width: 100%; border-collapse: collapse; }
table.runs th { text-align: left; color: var(--dim); font-weight: 500;
  padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
table.runs td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.status { display: inline-block; padding: 1px 8px; border-radius: 10px;
  font-size: 12px; border: 1px solid var(--border); }
.status.completed { color: var(--green); border-color: var(--green); }
.status.waiting { color: var(--yellow); border-color: var(--yellow); }
.status.failed { color: var(--red); border-color: var(--red); }
.status.cancelled { color: var(--dim); border-color: var(--dim); }
.status.queued, .status.wake, .status.sleeping, .status.retrying { color: var(--blue); border-color: var(--blue); }
form.newrun { display: flex; gap: 8px; margin: 18px 0; }
form.newrun input[type=text] { flex: 1; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font: inherit; }
button { background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
button:hover { border-color: var(--dim); }
button.approve { color: var(--green); border-color: var(--green); }
button.deny { color: var(--red); border-color: var(--red); }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel); margin: 10px 0; padding: 10px 14px; }
.timeline .kind { font-size: 12px; color: var(--dim); margin-bottom: 4px; }
.timeline pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word;
  font: 13px/1.45 inherit; color: var(--text); max-height: 340px; overflow-y: auto; }
.timeline li.thought { border-left: 3px solid var(--dim); }
.timeline li.action { border-left: 3px solid var(--blue); }
.timeline li.observation { border-left: 3px solid #6e7681; }
.timeline li.approval { border-left: 3px solid var(--yellow); }
.timeline li.done { border-left: 3px solid var(--green); }
.timeline li.error { border-left: 3px solid var(--red); }
.meta { color: var(--dim); font-size: 12px; margin: 4px 0 14px; }
.decide { display: flex; gap: 10px; margin: 14px 0; }
.login { max-width: 380px; margin: 12vh auto; }
.login input { width: 100%; margin: 10px 0; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 10px; font: inherit; }
.empty { color: var(--dim); padding: 30px 0; }
`;

// The layout renders a FRAGMENT, not a document: the framework owns the
// <html>/<head>/<body> shell (index.html in app mode). Rendering a full
// document here nests <html> inside the shell's #app div — the browser
// flattens it and hydration, unable to match, appends a second copy of
// the entire UI (found live on the first teploy-deployed instance).
// charset/viewport/title live in index.html; the style block rides in
// the fragment, which browsers apply from body just fine.
// Highlight the current section (the layout renders as a fragment and has
// no request path, so mark the active nav link client-side).
const NAV_ACTIVE = `(function(){var p=location.pathname;document.querySelectorAll('nav.nav a').forEach(function(a){var h=a.getAttribute('href');if(h==='/'?p==='/':p.indexOf(h)===0)a.classList.add('active');});})();`;

// Live updates. A page calls __shipLive("route:<file>") to get pushed refreshes:
// one EventSource to /events (server pushes on any state change) drives a
// loader-data re-fetch that reloads only when THIS page's data changed. A slow
// interval is the fallback when SSE is unavailable. Scroll position survives
// the reload so watching a live run doesn't jump to the top.
const SHIP_LIVE = `
window.__shipLive = function (routeId) {
  var SK = "ship-scroll:" + location.pathname;
  var saved = sessionStorage.getItem(SK);
  if (saved !== null) { sessionStorage.removeItem(SK); window.scrollTo(0, parseInt(saved, 10) || 0); }
  var last = null;
  function reload() { try { sessionStorage.setItem(SK, String(window.scrollY)); } catch (e) {} location.reload(); }
  function check() {
    fetch(location.pathname + location.search, { headers: { "X-Neutron-Data": "true", "X-Neutron-Routes": routeId } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) { if (t === null) return; if (last === null) { last = t; return; } if (t !== last) reload(); })
      .catch(function () {});
  }
  var es = null;
  try { es = new EventSource("/events"); es.addEventListener("change", check); } catch (e) {}
  var slow = setInterval(check, es ? 15000 : 4000);
  if (slow.unref) slow.unref();
  check();
};
`;

export default function Layout({ children, data }: { children: ComponentChildren; data?: { nav: NavData } }) {
  const nav = data?.nav;
  const showSwitcher = nav !== undefined && nav.apps.some((a) => a.url !== "");
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header class="top">
        {showSwitcher && nav !== undefined && (
          <details class="switcher">
            <summary>{nav.apps.find((a) => a.key === nav.current)?.label ?? "Teploy"}<span class="caret">▾</span></summary>
            <div class="switcher-menu">
              {nav.apps.map((a) =>
                a.key === nav.current ? (
                  <span class="switcher-item current">{a.label}</span>
                ) : (
                  <a class="switcher-item" href={a.url}>{a.label}</a>
                ),
              )}
            </div>
          </details>
        )}
        <a href="/" class="brand">TEPLOY SHIP</a>
        <nav class="nav">
          <a href="/">Inbox</a>
          <a href="/runs">Runs</a>
          <a href="/reviews">Reviews</a>
          <a href="/fleet">Fleet</a>
          <a href="/knowledge">Knowledge</a>
          <a href="/sources">Sources</a>
          <a href="/spend">Spend</a>
          <a href="/settings">Settings</a>
          <a href="/account">Account</a>
        </nav>
        <span class="spacer" />
      </header>
      <main>{children}</main>
      <script dangerouslySetInnerHTML={{ __html: NAV_ACTIVE }} />
      <script dangerouslySetInnerHTML={{ __html: SHIP_LIVE }} />
    </>
  );
}
