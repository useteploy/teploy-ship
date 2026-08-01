import type { ComponentChildren } from "preact";
import faviconUrl from "../favicon.svg?url";
import type { MiddlewareFn } from "@neutron-build/core";

import { currentUser, requiredRole, roleAllows, sameOrigin, isMutating } from "../lib/session.server.js";
import { publicOrigin } from "../lib/oidc.server.js";
import { teployNav } from "../lib/nav.server.js";
import type { NavData } from "../lib/nav.server.js";
import { installProcessErrorHooks, reportError } from "../lib/observe.server.js";

/** Cross-product dashboard switcher config (top-left). Server-side loader so it
 * renders with SSR and never causes a hydration mismatch. */
export async function loader({ request }: { request: Request }): Promise<{ nav: NavData; signedIn: boolean; path: string }> {
  return {
    nav: teployNav("ship"),
    signedIn: (await currentUser(request)) !== null,
    path: new URL(request.url).pathname,
  };
}

/** Nav links, with the one owning `path` marked. Longest href wins so "/runs"
 *  is not shadowed by "/". */
const NAV_LINKS = [
  { href: "/", label: "Inbox" },
  { href: "/runs", label: "Runs" },
  { href: "/reviews", label: "Reviews" },
  { href: "/fleet", label: "Fleet" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/sources", label: "Sources" },
  { href: "/spend", label: "Spend" },
  { href: "/settings", label: "Settings" },
  { href: "/account", label: "Account" },
];

function activeHref(path: string): string | null {
  let best: string | null = null;
  for (const l of NAV_LINKS) {
    const hit = l.href === "/" ? path === "/" : path === l.href || path.startsWith(l.href + "/");
    if (hit && (best === null || l.href.length > best.length)) best = l.href;
  }
  return best;
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
  // Runs only on the server (middleware is a routing concept, never
  // hydrated), so this is a safe, guaranteed-once-per-process place to
  // install the catch-alls for anything that escapes a request entirely.
  // No-op unless OBSERVE_URL and OBSERVE_API_KEY are set.
  installProcessErrorHooks();
  const url = new URL(request.url);
  const path = url.pathname;
  // /hooks/* authenticates via webhook HMAC inside the route, not bearer;
  // /health is the family-convention liveness probe (teploy's deploy gate
  // polls it before any login could exist).
  // /oidc/* is the SSO handshake — it carries no session yet and must be reachable.
  if (path === "/login" || path === "/health" || path.startsWith("/hooks/") || path.startsWith("/oidc/") || path.startsWith("/assets/") || path === "/favicon.ico") {
    return withSecurityHeaders(await next(), request);
  }

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
  return withSecurityHeaders(await next(), request);
};

/**
 * Response boundary for an operations console.
 *
 * The dashboard approves remote code execution and spend, and it set no
 * response security headers at all. SameSite=Lax covers the common CSRF case,
 * but framing, MIME sniffing, referrer leakage and injected script are separate
 * problems with separate answers — and `frame-ancestors 'none'` is the explicit
 * decision this surface should be making rather than inheriting.
 *
 * The CSP allows inline styles and scripts because the app ships both (the live
 * updater and the inline stylesheet); it still forbids loading anything from
 * another origin, which is the part that matters for a self-hosted console.
 */
function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
    ].join("; "),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // Only on an HTTPS deployment: sending HSTS from a plain-HTTP tailnet box
  // would strand it behind a browser-pinned upgrade it cannot satisfy.
  if (publicOrigin(request).startsWith("https://")) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * App shell. Styles are inline and minimal on purpose — this is an
 * operations surface, not a marketing page: monochrome, dense, readable.
 */
const CSS = `
:root {
  /* Neutron paints <html> from --neutron-bg (default #0A0A0A). Left unset it
     shows below a short page as a black band, as if the document ended. */
  --neutron-bg: #0d1117;
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #e6edf3; --dim: #8b949e;
  --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top { display: flex; align-items: center; gap: 22px; min-height: 55px;
  padding: 10px 20px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 10; }
/* Loading bar: a light sweeping left to right along the header's bottom rule,
   matching teploy-dash. Ship navigates with real page loads, so it starts on a
   link click and rides until the next document replaces it. */
header.top .load-bar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; width: 0;
  opacity: 0; z-index: 2; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--accent, #58a6ff) 45%, #dceaff);
  transition: width .4s cubic-bezier(.1,.75,.25,1), opacity .25s ease; }
header.top .brand-group { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; }
header.top .brand { font-weight: 700; color: var(--text); letter-spacing: -.01em; font-size: 14px; }
header.top .switcher-static { display: inline-flex; align-items: center; padding: 5px 10px; border: 1px solid var(--border, #30363d);
  border-radius: 6px; font-size: 13px; font-weight: 600; line-height: 1.35; color: var(--text); }
details.switcher { position: relative; }
/* Same metrics as dash and observe (and as .switcher-static right above): 13px
   at 600 with line-height 1.35 lands the chip at 30px tall. Without the weight
   and line-height this one rendered 32px and lighter than the other two. */
details.switcher > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--text);
  font-size: 13px; font-weight: 600; line-height: 1.35; }
details.switcher > summary::-webkit-details-marker { display: none; }
details.switcher > summary:hover { color: var(--text); border-color: var(--dim); }
details.switcher .caret { font-size: 9px; opacity: .55; }
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
.timeline li.turn { border-left: 3px solid var(--blue); padding: 0; }
.timeline li.observation { border-left: 3px solid #6e7681; }
.timeline li.approval { border-left: 3px solid var(--yellow); }
.timeline li.done { border-left: 3px solid var(--green); }
.timeline li.error { border-left: 3px solid var(--red); }
/* A collapsed turn is one scannable line: what ran, how it exited, how long. */
.timeline summary { display: flex; align-items: baseline; gap: 10px; cursor: pointer;
  padding: 9px 14px; list-style: none; }
.timeline summary::-webkit-details-marker { display: none; }
.timeline summary:hover { background: var(--panel-hover, rgba(255,255,255,0.03)); }
.timeline details[open] summary { border-bottom: 1px solid var(--border); }
.timeline details > pre { margin: 0; padding: 10px 14px; border-radius: 0; }
.turn-name { color: var(--dim); font-size: 12px; flex: 0 0 auto; }
.turn-action { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 13px; color: var(--text); }
.turn-meta { flex: 0 0 auto; font-size: 12px; color: var(--dim); }
.turn-meta .ok { color: var(--green); }
.turn-meta .bad { color: var(--red); }
.turn-thought { color: var(--dim); border-bottom: 1px solid var(--border); }
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
// Live updates. A page calls __shipLive("route:<file>") to get pushed refreshes:
// one EventSource to /events (server pushes on any state change) drives a
// loader-data re-fetch that reloads only when THIS page's data changed. A slow
// interval is the fallback when SSE is unavailable. Scroll position survives
// the reload so watching a live run doesn't jump to the top.
/* Ship navigates by real page loads, so there is no request to wrap the way
   dash wraps its fetches. Start the sweep on the intent to navigate — an
   internal link click or a form submit — and let the next document replace it.
   A cancelled navigation (same page, or the user coming back) fades it out so
   the bar never sticks at 90%. */
const NAV_PROGRESS = `(function(){
  var el=document.getElementById('load-bar'); if(!el) return;
  var t1,t2;
  function start(){
    clearTimeout(t1); clearTimeout(t2);
    el.style.transition='none'; el.style.width='0%'; el.style.opacity='1';
    void el.offsetWidth; el.style.transition=''; el.style.width='90%';
  }
  function stop(){
    el.style.width='100%';
    t1=setTimeout(function(){ el.style.opacity='0'; t2=setTimeout(function(){ el.style.width='0%'; },300); },220);
  }
  // The layout is server-rendered once and survives client-side route changes,
  // so the active link has to be re-marked here — the server's value goes stale
  // the moment the router swaps a page without re-rendering the header.
  function syncActive(){
    var links=document.querySelectorAll('header.top nav.nav a');
    var path=location.pathname, best=null, i;
    for(i=0;i<links.length;i++){
      var h=links[i].getAttribute('href')||'';
      var hit = h==='/' ? path==='/' : (path===h || path.indexOf(h+'/')===0);
      if(hit && (best===null || h.length>best.length)) best=h;
    }
    for(i=0;i<links.length;i++){
      links[i].classList.toggle('active',(links[i].getAttribute('href')||'')===best);
    }
  }
  ['pushState','replaceState'].forEach(function(m){
    var orig=history[m];
    history[m]=function(){ var r=orig.apply(this,arguments); syncActive(); return r; };
  });
  window.addEventListener('popstate',syncActive);
  syncActive();

  var KEY='ship-nav-progress';
  var watch;
  // Two navigation styles have to finish the sweep. Client-side routing keeps
  // this document alive, so watch for the URL to change and complete here. A
  // real page load destroys it instead, so leave a flag the next document
  // picks up. Whichever happens first clears the other's bookkeeping.
  function begin(){
    try{ sessionStorage.setItem(KEY,'1'); }catch(e){}
    start();
    var from=location.href, ticks=0;
    clearInterval(watch);
    watch=setInterval(function(){
      ticks++;
      if(location.href!==from){
        clearInterval(watch);
        try{ sessionStorage.removeItem(KEY); }catch(e){}
        syncActive();
        setTimeout(stop, 32);
      } else if(ticks>160){        // 8s ceiling: never strand the bar on screen
        clearInterval(watch);
        try{ sessionStorage.removeItem(KEY); }catch(e){}
        stop();
      }
    },50);
  }
  document.addEventListener('click',function(e){
    var a=e.target && e.target.closest ? e.target.closest('a') : null;
    if(!a) return;
    var href=a.getAttribute('href')||'';
    if(a.target==='_blank'||a.hasAttribute('download')) return;
    if(href===''||href.charAt(0)==='#') return;
    if(/^[a-z]+:/i.test(href) && a.origin!==location.origin) return;   // external
    if(a.href===location.href) return;                                  // same page
    begin();
  },true);
  document.addEventListener('submit',function(){ begin(); },true);
  // Full page load: the document that started the sweep is gone, so finish it
  // here. Runs inline as this script parses — the header is already above it.
  var pending=null;
  try{ pending=sessionStorage.getItem(KEY); if(pending) sessionStorage.removeItem(KEY); }catch(e){}
  if(pending){
    el.style.transition='none'; el.style.width='90%'; el.style.opacity='1';
    void el.offsetWidth; el.style.transition='';
    setTimeout(stop, 32);
  }
  window.addEventListener('pageshow',function(e){ if(e.persisted) stop(); });
})();`;

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

/** Tab icon. Emitted as a raw head fragment — the node adapter serves /assets/
 *  but not publicDir files at the dist root, so the icon rides the bundle. */
export function head() {
  return `<link rel="icon" type="image/svg+xml" href="${faviconUrl}" />`;
}

export default function Layout({ children, data }: { children: ComponentChildren; data?: { nav: NavData; signedIn?: boolean; path?: string } }) {
  const nav = data?.nav;
  // /login renders inside this layout, so without this the sign-in page shows
  // the full app nav — every link bounces straight back to /login.
  const signedIn = data?.signedIn === true;
  const current = activeHref(data?.path ?? "/");
  const showSwitcher = nav !== undefined && nav.apps.some((a) => a.url !== "");
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header class="top">
        <div class="brand-group">
        <a href="/" class="brand">Teploy</a>
        {/* Always name the current product; only offer the dropdown when a
            sibling dashboard is actually reachable. */}
        {showSwitcher && nav !== undefined ? (
          <details class="switcher">
            <summary>{nav.apps.find((a) => a.key === nav.current)?.label ?? "Ship"}<span class="caret">▾</span></summary>
            <div class="switcher-menu">
              {/* Only the other dashboards — the chip already names this one. */}
              {nav.apps.filter((a) => a.url !== "").map((a) => (
                <a class="switcher-item" href={a.url}>{a.label}</a>
              ))}
            </div>
          </details>
        ) : (
          <span class="switcher-static">Ship</span>
        )}
        </div>
        {signedIn && (
          <nav class="nav">
            {NAV_LINKS.map((l) => (
              <a href={l.href} class={l.href === current ? "active" : undefined}>{l.label}</a>
            ))}
          </nav>
        )}
        <span class="spacer" />
        <span class="load-bar" id="load-bar" />
      </header>
      <script dangerouslySetInnerHTML={{ __html: NAV_PROGRESS }} />
      <script dangerouslySetInnerHTML={{ __html: SHIP_LIVE }} />
      <main>{children}</main>
    </>
  );
}

/**
 * Every route falls back to this when a loader or a component throws — the
 * framework walks up to the nearest layout boundary, so one export covers the
 * whole surface. Without it a failure rendered a bare "Application Error" page
 * with the message suppressed in production AND nothing written to the
 * container log, which left a 500 with no way to tell what broke.
 *
 * The message is shown deliberately: this is a self-hosted operator tool behind
 * auth, and a nameless error is worse than a candid one. The stack is not.
 */
export function ErrorBoundary({ error }: { error: Error }) {
  // Server-side render, so this reaches the container log — the one place an
  // operator can actually go looking after the fact. Also reported to Observe
  // (no-op unless configured) so it shows up structured instead of only here.
  console.error(`[ship] render failed: ${error?.message ?? String(error)}`, error?.stack ?? "");
  reportError(error);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header class="top">
        <div class="brand-group">
          <a href="/" class="brand">Teploy</a>
          <span class="switcher-static">Ship</span>
        </div>
      </header>
      <main>
        <h1 class="page">Something broke on this page</h1>
        <p class="meta">
          The rest of Ship is unaffected — runs keep executing on the worker, which is a separate process.
        </p>
        <div class="card attn" style="margin:12px 0">
          <pre style="margin:0;white-space:pre-wrap;word-break:break-word">{error?.message ?? String(error)}</pre>
        </div>
        <p class="meta">
          <a href="/">Back to the inbox</a> · <a href="/runs">All runs</a>
        </p>
      </main>
    </>
  );
}
