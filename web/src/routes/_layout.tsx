import type { ComponentChildren } from "preact";
import type { MiddlewareFn } from "@neutron-build/core";

import { webToken } from "../lib/store.js";

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
  if (path === "/login" || path.startsWith("/assets/") || path === "/favicon.ico") return next();

  const expected = webToken();
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  const cookie = request.headers.get("cookie") ?? "";
  const cookieToken = /(?:^|;\s*)ship_token=([^;]+)/.exec(cookie)?.[1] ?? null;

  if (bearer === expected || (cookieToken !== null && decodeURIComponent(cookieToken) === expected)) {
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
header.top { display: flex; align-items: baseline; gap: 16px;
  padding: 14px 20px; border-bottom: 1px solid var(--border); }
header.top .brand { font-weight: 700; color: var(--text); letter-spacing: .02em; }
header.top .store { color: var(--dim); font-size: 12px; }
main { max-width: 1080px; margin: 0 auto; padding: 20px; }
table.runs { width: 100%; border-collapse: collapse; }
table.runs th { text-align: left; color: var(--dim); font-weight: 500;
  padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
table.runs td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.status { display: inline-block; padding: 1px 8px; border-radius: 10px;
  font-size: 12px; border: 1px solid var(--border); }
.status.completed { color: var(--green); border-color: var(--green); }
.status.waiting { color: var(--yellow); border-color: var(--yellow); }
.status.failed { color: var(--red); border-color: var(--red); }
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

export default function Layout({ children }: { children: ComponentChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Teploy Ship</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="top">
          <a href="/" class="brand">TEPLOY SHIP</a>
          <span class="store">runs</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
