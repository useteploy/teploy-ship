#!/usr/bin/env node
// ship-browser — act on the run's ```look browser session (S12).
//
// ```look is deliberately the ONE browser verb (the tool-vocab addendum §3):
// the loop owns observation because the snapshot is what the model sees;
// acting stays in agent code, which already has a shell and Playwright. What
// that code lacked was the SESSION: look.ts starts a headless chromium on
// --remote-debugging-port=9222 inside the run's sandbox and every look
// attaches to it, but nothing told the agent so — its own Playwright launch
// a second browser, and a later look observed none of it. This module is the
// missing half: import it from a ```bash block and drive the SAME session
// the next ```look will observe.
//
//   import { page, byRef } from "/usr/local/lib/ship-browser.mjs";
//   await (await byRef("e12")).click();       // a [ref=eN] from your last look
//   await (await byRef("e13")).fill("Ada");   // any Playwright locator method
//   await page().keyboard.press("Enter");
//   process.exit(0);                          // the CDP socket holds node open
//
// byRef resolves refs EXACTLY the way look's driver does (src/look.ts): it
// renders an ai snapshot on the connection first — the aria-ref engine
// resolves against the last snapshot rendered HERE, and an unchanged page
// re-mints identical refs, so the refs your look printed resolve unchanged —
// then goes through playwright's `aria-ref=` selector engine, `f2e3` iframe
// refs included. A stale ref throws look's own error shape; no fuzzy matching.
//
// AUTHORITY: none is granted. This module is ordinary agent code running in
// the same container ```bash runs in, under the same egress tier the sandbox
// enforces for every process — a sealed (network=none) run gets no further
// with it than with curl, and on the open tier agent code could already have
// launched its own chromium (one is baked in the image). LOOK_SEALED and
// LOOK_OPEN_PLAN gate the OBSERVATION verb; the network boundary for acting
// is the sandbox's own egress layer, unchanged by this file.
//
// Baked verbatim into the sandbox images (images/sandbox-{node,go}/Dockerfile)
// from images/browser-helper/ship-browser.mjs, exactly like
// images/acp-driver/ship-acp.mjs. It lives in /usr/local/lib so its own bare
// `import("playwright")` resolves against the image's global
// /usr/local/lib/node_modules install with no node_modules symlink — and is
// imported by absolute path for the same reason (an ESM import ignores
// NODE_PATH, so "ship-browser" would not resolve from the workspace).
//
// The session it joins is owned by look.ts, which writes
// .teploy-agent/look-session.mjs before every driver turn. page() spawns
// THAT script (detached, logged to /tmp/ship-look-session.log) when the CDP
// endpoint is down — the same launch the look driver performs — so the one
// copy of the session's launch lives in look.ts and this file never invents
// a second one. Before the run's first look there is no script and no
// session; byRef needs a snapshot's refs anyway, so the error says what to
// do: run ```look first.

/** The session's CDP endpoint — loopback in the container, look.ts's LOOK_CDP_PORT. */
export const CDP = "http://127.0.0.1:9222";
/** The session script look.ts owns and writes (src/look.ts LOOK_DIR). */
export const SESSION_SCRIPT = ".teploy-agent/look-session.mjs";
/** The element-ref grammar of ai snapshots (the addendum §4; actions.ts LOOK_REF). */
export const REF = /^(f\d+)?e\d+$/;

/**
 * The stale-ref error, look's own shape (look.ts lookStaleRef) phrased for
 * the code that just hit it. Loud on purpose: refs are minted per snapshot
 * render and die with the page they came from.
 */
export function staleRef(ref) {
  return `Ref ${ref} not found in the current page snapshot. Run \`\`\`look again and use refs from that snapshot.`;
}

/** Is the session's CDP endpoint answering? Loopback, so no proxy applies. */
async function up() {
  try {
    return (await fetch(CDP + "/json/version")).ok;
  } catch {
    return false;
  }
}

/** Start the session exactly as look's driver does: spawn look.ts's script detached. */
async function startSession() {
  const fs = await import("node:fs");
  if (!fs.existsSync(SESSION_SCRIPT)) {
    throw new Error(
      `ship-browser: no look session script at ${SESSION_SCRIPT} — run \`\`\`look (with url=) first: ` +
        "it starts the session and writes the script that owns it, and a byRef ref only exists after a snapshot anyway.",
    );
  }
  const log = fs.openSync("/tmp/ship-look-session.log", "a");
  const child = (await import("node:child_process")).spawn(process.execPath, [SESSION_SCRIPT], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

/**
 * The look session's current page: connectOverCDP to the shared endpoint,
 * taking the default context's current page (the one ```look observes), a
 * fresh tab only when none exists. Cached per process, with a liveness probe
 * so a session that died underneath a long-running script reconnects (and
 * restarts the session) instead of handing back a closed page.
 *
 * Never browser.close(): this connection must not tear down the run's
 * session. End YOUR script with process.exit(0) — the CDP socket holds the
 * event loop open otherwise (same reason look's drivers exit explicitly).
 */
let current = null;

export async function page() {
  if (current !== null) {
    try {
      await current.url();
      return current;
    } catch {
      current = null; // the session died under this process; reconnect below
    }
  }
  if (!(await up())) {
    await startSession();
    const deadline = Date.now() + 20000;
    while (!(await up())) {
      if (Date.now() > deadline) {
        throw new Error("ship-browser: the browser session did not come up within 20s — /tmp/ship-look-session.log has its output.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  current = context.pages()[0] ?? (await context.newPage());
  return current;
}

/**
 * A Playwright Locator for one [ref=eN] / f2e3 id from the latest look
 * snapshot. Resolution is look's, verbatim: mint refs on this connection
 * with an ai snapshot, then resolve through the aria-ref engine — and force
 * that resolution NOW (the same locator-snapshot call look's ref= path
 * makes) so a stale ref fails here, with look's error, rather than deep
 * inside a click two lines later.
 */
export async function byRef(ref) {
  if (typeof ref !== "string" || !REF.test(ref)) {
    throw new Error(`ship-browser: byRef wants a snapshot ref (e12, or f2e3 inside an iframe), got: ${JSON.stringify(ref)}`);
  }
  const p = await page();
  await p.ariaSnapshot({ mode: "ai" }); // mint this connection's refs first
  const locator = p.locator("aria-ref=" + ref);
  try {
    await locator.ariaSnapshot({ mode: "ai" });
  } catch {
    throw new Error(staleRef(ref));
  }
  return locator;
}
