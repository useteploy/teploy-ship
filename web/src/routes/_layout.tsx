import type { ComponentChildren } from "preact";
import type { MiddlewareFn } from "@neutron-build/core";

import { webToken } from "../lib/store.server.js";

/**
 * Single-token auth for the whole surface, exported from the root layout
 * because that is where the framework actually collects middleware (route
 * and layout modules — the documented global src/middleware.ts is not
 * loaded by either server; recorded as a framework-excellence finding).
 * A web approve button is remote code approval, so nothing is served
 * unauthenticated: requests need `Authorization: Bearer <token>` (API
 * callers) or the `ship_token` cookie set by /login.
 */
export const middleware: MiddlewareFn = async (request, _context, next) => {
  const url = new URL(request.url);
  const path = url.pathname;
  // /hooks/* authenticates via webhook HMAC inside the route, not bearer;
  // /health is the family-convention liveness probe (teploy's deploy gate
  // polls it before any login could exist).
  if (path === "/login" || path === "/health" || path.startsWith("/hooks/") || path.startsWith("/assets/") || path === "/favicon.ico") return next();

  const expected = webToken();
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  const cookie = request.headers.get("cookie") ?? "";
  const rawCookieToken = /(?:^|;\s*)ship_token=([^;]+)/.exec(cookie)?.[1] ?? null;
  // A malformed %-sequence must read as a bad token (401), never a 500.
  let cookieToken: string | null = null;
  if (rawCookieToken !== null) {
    try {
      cookieToken = decodeURIComponent(rawCookieToken);
    } catch {
      cookieToken = null;
    }
  }

  // Constant-time comparison: token equality must not leak prefix length
  // through response timing.
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const matches = (presented: string | null): boolean => {
    if (presented === null) return false;
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  };
  if (matches(bearer) || matches(cookieToken)) {
    return next();
  }
  if (request.headers.get("x-neutron-data") === "true") {
    return new Response(JSON.stringify({ title: "Unauthorized", status: 401 }), {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    });
  }
  return new Response(null, { status: 302, headers: { location: "/login" } });
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

export default function Layout({ children }: { children: ComponentChildren }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header class="top">
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
        </nav>
        <span class="spacer" />
      </header>
      <main>{children}</main>
      <script dangerouslySetInnerHTML={{ __html: NAV_ACTIVE }} />
      <script dangerouslySetInnerHTML={{ __html: SHIP_LIVE }} />
    </>
  );
}
