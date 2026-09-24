/**
 * S12's last surface: the takeover BROWSER tab. A real headless Chromium
 * running INSIDE the sandbox, driven through the same worker-mediated,
 * lease-fenced execAs path as the console and editor — the dashboard never
 * receives the sandbox credential, and every action renews the lease.
 *
 * WHAT ALREADY EXISTED (and is reused rather than duplicated): the node and
 * go sandbox images ship Debian chromium + a pinned global playwright with
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD (images/sandbox-node/Dockerfile,
 * images/sandbox-go/Dockerfile, pins in images/versions.json). The visual
 * rung probes the same binaries (src/ladder-steps.ts BROWSERS) and the flow
 * rung resolves playwright from `npm root -g` (src/ladder-steps.ts) — the
 * driver below follows both patterns. The rust image carries NO browser: the
 * tab gates on the tooling existing and says so rather than failing opaquely.
 *
 * DRIVER LIFECYCLE — restart per op, NOT a kept-alive daemon. execAs is a
 * run-to-completion exec with no persistent stdio session, so a long-lived
 * driver cannot be spoken to through the fence at all, and a daemonized
 * background process started under one exec would be invisible to the lease's
 * exec accounting and to lapse cleanup. Restart-per-op keeps every browser
 * action provably inside one fenced exec under the holder credential.
 * Continuity comes from the profile dir (.ship/browser-profile, excluded
 * from the repository like .ship/flow-out): cookies and storage persist
 * across actions; the DOM does not — every action re-loads the page at the
 * recorded URL, which is what the UI says plainly.
 */
/** One browser action, as the dashboard submits it and the driver runs it. */
export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; dy: number }
  | { action: "viewport"; w: number; h: number }
  | { action: "close" };

export const TAKEOVER_BROWSER_ACTIONS = [
  "navigate",
  "click",
  "type",
  "key",
  "scroll",
  "viewport",
  "close",
] as const;

/** Screenshot bound: base64 characters (~300 KB binary). Larger is an error, not a silent trim. */
export const TAKEOVER_BROWSER_SCREENSHOT_CAP = 400_000;
/** One browser action, end to end, including cold Chromium start. */
export const TAKEOVER_BROWSER_TIMEOUT_MS = 30_000;
/** Typed text cap, matching the console command cap. */
export const TAKEOVER_BROWSER_TEXT_LIMIT = 2000;
export const TAKEOVER_BROWSER_URL_LIMIT = 2000;
/** Bounded per-session op log, most recent last (like execsRun, but every op — repeated clicks are real history). */
export const TAKEOVER_BROWSER_OPS_LIMIT = 200;

/** Named keys the keyboard op accepts; letters are typed, not pressed. */
export const BROWSER_KEY_BASES = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
] as const;
export const BROWSER_KEY_MODIFIERS = ["Shift", "Control", "Alt", "Meta"] as const;

export function browserKeyValid(name: string): boolean {
  const parts = name.split("+");
  if (parts.length > 3) return false;
  if (!(BROWSER_KEY_BASES as readonly string[]).includes(parts[parts.length - 1]!)) return false;
  return parts.slice(0, -1).every((p) => (BROWSER_KEY_MODIFIERS as readonly string[]).includes(p));
}

/**
 * The URL guard: http(s) only. file:, about:, data:, chrome: and every other
 * scheme are refused WITH a reason — the browser runs inside the sandbox and
 * must not be a file-read or browser-internals oracle.
 */
export function browserUrlValid(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Enter a full URL (scheme://host/path)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Refused: ${parsed.protocol} URLs are not allowed — http and https only (no file:, about:, data: or browser-internal pages).`,
    };
  }
  return { ok: true };
}

const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Parse and bound an action from untrusted JSON. The same rules are enforced
 * again inside the driver — anything that can exec in the sandbox is not
 * only reachable by the worker.
 */
export function parseBrowserAction(raw: unknown): { ok: true; action: BrowserAction } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "Invalid browser action." };
  const a = raw as Record<string, unknown>;
  switch (a.action) {
    case "navigate":
      if (typeof a.url !== "string" || a.url.length > TAKEOVER_BROWSER_URL_LIMIT || a.url === "")
        return { ok: false, reason: `URL is required, up to ${TAKEOVER_BROWSER_URL_LIMIT} characters.` };
      {
        const guard = browserUrlValid(a.url);
        if (!guard.ok) return guard;
        return { ok: true, action: { action: "navigate", url: a.url } };
      }
    case "click":
      if (!intIn(a.x, 0, 8191) || !intIn(a.y, 0, 8191))
        return { ok: false, reason: "Click coordinates must be integers in 0..8191." };
      return { ok: true, action: { action: "click", x: a.x, y: a.y } };
    case "type":
      if (typeof a.text !== "string" || a.text.length > TAKEOVER_BROWSER_TEXT_LIMIT)
        return { ok: false, reason: `Text is required, up to ${TAKEOVER_BROWSER_TEXT_LIMIT} characters.` };
      return { ok: true, action: { action: "type", text: a.text } };
    case "key":
      if (typeof a.key !== "string" || !browserKeyValid(a.key))
        return { ok: false, reason: `Key must be a named key (${BROWSER_KEY_BASES.slice(0, 4).join(", ")}…), optionally with Shift/Control/Alt/Meta.` };
      return { ok: true, action: { action: "key", key: a.key } };
    case "scroll":
      if (!intIn(a.dy, -100_000, 100_000))
        return { ok: false, reason: "Scroll delta must be an integer within ±100000." };
      return { ok: true, action: { action: "scroll", dy: a.dy } };
    case "viewport":
      if (!intIn(a.w, 240, 3840) || !intIn(a.h, 240, 4320))
        return { ok: false, reason: "Viewport must be 240..3840 by 240..4320 pixels." };
      return { ok: true, action: { action: "viewport", w: a.w, h: a.h } };
    case "close":
      return { ok: true, action: { action: "close" } };
    default:
      return { ok: false, reason: `Unknown browser action (expected ${TAKEOVER_BROWSER_ACTIONS.join(", ")}).` };
  }
}

/** Canonical wire form: base64 of the JSON, safe to interpolate into the exec command. */
export function encodeBrowserAction(action: BrowserAction): string {
  return Buffer.from(JSON.stringify(action), "utf8").toString("base64");
}

/** The one-line record of an op for the takeover session (bounded per line). */
export function browserOpSummary(action: BrowserAction): string {
  switch (action.action) {
    case "navigate":
      return `navigate ${action.url.slice(0, 120)}`;
    case "click":
      return `click ${action.x},${action.y}`;
    case "type":
      return `type ${action.text.length} chars ("${action.text.slice(0, 24).replace(/[\r\n\t]+/g, " ")}")`;
    case "key":
      return `key ${action.key}`;
    case "scroll":
      return `scroll ${action.dy >= 0 ? "+" : ""}${action.dy}`;
    case "viewport":
      return `viewport ${action.w}x${action.h}`;
    case "close":
      return "close";
  }
}

/**
 * The driver that runs inside the sandbox. Written through the lease as a
 * heredoc (quoted delimiter, so no shell interpolation) on first use, then
 * executed per action. Resolves playwright from the global npm root exactly
 * like the flow rung (src/ladder-steps.ts) and the system Chromium through
 * CHROMIUM_BIN / the same probe list as the visual rung.
 *
 * The driver speaks the JSON-over-stdio protocol: argv[2] is the base64
 * action, stdout carries ONE JSON reply line. Unit tests assert against a
 * fake implementing this protocol; live-chromium proof is the orchestrator's
 * script (scripts/takeover-browser-live-proof.mjs).
 */
export const BROWSER_DRIVER_SOURCE = `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const CAP = ${TAKEOVER_BROWSER_SCREENSHOT_CAP};
const STATE_FILE = ".ship/browser-state.json";
const PROFILE = ".ship/browser-profile";
const KEYS = new Set(${JSON.stringify([...BROWSER_KEY_BASES])});
const MODS = new Set(${JSON.stringify([...BROWSER_KEY_MODIFIERS])});
const TEXT_LIMIT = ${TAKEOVER_BROWSER_TEXT_LIMIT};
const URL_LIMIT = ${TAKEOVER_BROWSER_URL_LIMIT};

function reply(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function fail(message) { reply({ ok: false, error: String(message).slice(0, 500) }); process.exit(0); }
function isHttp(u) { try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; } }
function intIn(v, lo, hi) { return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi; }
function keyValid(name) {
  const parts = String(name).split("+");
  if (parts.length > 3) return false;
  if (!KEYS.has(parts[parts.length - 1])) return false;
  return parts.slice(0, -1).every(function (p) { return MODS.has(p); });
}

let action;
try { action = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")); }
catch { fail("unreadable action"); }
if (action === null || typeof action !== "object") fail("bad action");
// Re-validate everything the server checked: this process is reachable by
// anything that can exec in the sandbox, not only by the worker.
const kind = action.action;
if (kind === "navigate" && (typeof action.url !== "string" || action.url.length > URL_LIMIT || !isHttp(action.url))) fail("only http(s) URLs are accepted");
if (kind === "click" && (!intIn(action.x, 0, 8191) || !intIn(action.y, 0, 8191))) fail("bad coordinates");
if (kind === "type" && (typeof action.text !== "string" || action.text.length > TEXT_LIMIT)) fail("bad text");
if (kind === "key" && (typeof action.key !== "string" || !keyValid(action.key))) fail("bad key");
if (kind === "scroll" && !intIn(action.dy, -100000, 100000)) fail("bad scroll");
if (kind === "viewport" && (!intIn(action.w, 240, 3840) || !intIn(action.h, 240, 4320))) fail("bad viewport");
if (![${TAKEOVER_BROWSER_ACTIONS.map((k) => `"${k}"`).join(", ")}].includes(kind)) fail("unknown action");

mkdirSync(".ship", { recursive: true });
if (kind === "close") {
  rmSync(STATE_FILE, { force: true });
  rmSync(PROFILE, { recursive: true, force: true });
  reply({ ok: true, action: "close" });
  process.exit(0);
}

let state = { url: undefined, width: 1280, height: 800 };
try { state = Object.assign(state, JSON.parse(readFileSync(STATE_FILE, "utf8"))); } catch {}
if (kind === "navigate") { state.url = action.url; delete state.focus; delete state.scroll; }
if (state.url === undefined || !isHttp(state.url)) fail("navigate to an http(s) URL first");
if (kind === "viewport") { state.width = action.w; state.height = action.h; }

let chromium;
try {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000 }).trim();
  chromium = createRequire(root + "/index.js")("playwright").chromium;
} catch { fail("this sandbox image has no global playwright (the node and go sandbox images ship it; the rust image does not)"); }
let executablePath = process.env.CHROMIUM_BIN;
if (executablePath === undefined || executablePath === "") {
  try {
    executablePath = execFileSync(
      "sh",
      ["-c", 'for b in chromium chromium-browser google-chrome google-chrome-stable; do command -v "$b" && exit 0; done; exit 1'],
      { encoding: "utf8" },
    ).trim();
  } catch { executablePath = ""; }
}
if (executablePath === "") fail("this sandbox image has no chromium binary (CHROMIUM_BIN or chromium on PATH; the node and go sandbox images ship it)");

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath,
  viewport: { width: state.width, height: state.height },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(state.url, { timeout: 20000, waitUntil: "load" });
  await page.waitForTimeout(250);
  // A fresh Chromium page loses focus even when the site's own storage
  // restores its fields. Restore focus without replaying a click (which could
  // submit a form or navigate twice), and only on the same URL.
  if (kind !== "navigate" && page.url() === state.url) {
    await page.evaluate(({ focus, scroll }) => {
      if (scroll) window.scrollTo(scroll.x, scroll.y);
      if (!focus || typeof focus.selector !== "string") return;
      const element = document.querySelector(focus.selector);
      if (!element || element.tagName !== focus.tag || element.getAttribute("name") !== focus.name) return;
      element.focus({ preventScroll: true });
      if (typeof focus.start === "number" && typeof element.setSelectionRange === "function") {
        try { element.setSelectionRange(focus.start, focus.end); } catch {}
      }
    }, { focus: state.focus, scroll: state.scroll });
  }
  if (kind === "click") await page.mouse.click(action.x, action.y);
  else if (kind === "type") await page.keyboard.type(action.text);
  else if (kind === "key") await page.keyboard.press(action.key);
  else if (kind === "scroll") await page.mouse.wheel(0, action.dy);
  await page.waitForTimeout(250);
  const continuity = await page.evaluate(() => {
    const element = document.activeElement;
    const scroll = { x: window.scrollX, y: window.scrollY };
    if (!element || element === document.body || element === document.documentElement) return { scroll };
    const parts = [];
    for (let node = element; node && node !== document.documentElement && parts.length < 32; node = node.parentElement) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const index = [...node.parentElement.children].indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
    }
    const selector = parts.join(" > ");
    if (selector.length > 2000) return { scroll };
    return { scroll, focus: { selector, tag: element.tagName, name: element.getAttribute("name"),
      start: element.selectionStart, end: element.selectionEnd } };
  });
  let image = await page.screenshot({ type: "png" });
  let format = "png";
  if (image.length * 4 > CAP * 3) { image = await page.screenshot({ type: "jpeg", quality: 60 }); format = "jpeg"; }
  const b64 = image.toString("base64");
  if (b64.length > CAP) fail("screenshot exceeds the " + CAP + "-character cap even as JPEG - narrow the viewport");
  state.url = page.url();
  writeFileSync(STATE_FILE, JSON.stringify({ url: state.url, width: state.width, height: state.height, ...continuity }));
  reply({ ok: true, action: kind, url: state.url, width: state.width, height: state.height, format, image: b64 });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await context.close().catch(function () {});
}
`;

/** Browser scratch that must stay out of the tree the run publishes (see WORKSPACE_EXCLUDES). */
export const BROWSER_EXCLUDES = [
  ".ship/browser-driver.mjs",
  ".ship/browser-state.json",
  ".ship/browser-profile/",
] as const;

/**
 * The fenced exec command for one browser action: ensure the browser scratch
 * is excluded from the repository (same mechanism as .ship/flow-out — without
 * it the profile lands in git status and the pushed commit), write the current driver
 * (so a live session picks up fixes) (quoted heredoc — no shell interpolation of the source), then run
 * it with the base64 action as argv. The action rides argv, never the shell
 * command string, so typed text cannot inject.
 */
export function browserOpCommand(actionB64: string): string {
  const exclude = BROWSER_EXCLUDES.map(
    (e) => `grep -qxF '${e}' .git/info/exclude 2>/dev/null || echo '${e}' >> .git/info/exclude`,
  ).join("; ");
  return [
    "mkdir -p .ship",
    `${exclude} || true`,
    "cat > .ship/browser-driver.mjs <<'SHIP_BROWSER_DRIVER_EOF'",
    BROWSER_DRIVER_SOURCE.replace(/\n+$/, ""),
    "SHIP_BROWSER_DRIVER_EOF",
    `exec node .ship/browser-driver.mjs '${actionB64}'`,
  ].join("\n");
}

export type BrowserDriverReply = {
  ok: true;
  action: string;
  url?: string;
  width?: number;
  height?: number;
  format?: string;
  image?: string;
};

/**
 * Parse the driver's stdio reply. The screenshot cap is enforced HERE, not
 * only in the driver: a reply larger than the cap is an honest error, never
 * a silently trimmed or truncated image (a truncated base64 is a broken
 * image the UI would render as nothing).
 */
export function parseDriverReply(r: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): { ok: true; reply: BrowserDriverReply } | { ok: false; reason: string } {
  if (r.timedOut) return { ok: false, reason: `The browser action timed out (${TAKEOVER_BROWSER_TIMEOUT_MS / 1000}s).` };
  const line = r.stdout.split("\n").filter((l) => l.trim() !== "").at(-1);
  if (line === undefined) {
    const tail = (r.stderr || r.stdout).trim().slice(-300);
    return { ok: false, reason: `The browser driver did not answer (exit ${r.exitCode})${tail !== "" ? `: ${tail}` : ""}` };
  }
  try {
    const parsed = JSON.parse(line) as {
      ok?: unknown;
      error?: unknown;
      action?: unknown;
      url?: unknown;
      width?: unknown;
      height?: unknown;
      format?: unknown;
      image?: unknown;
    };
    if (parsed.ok !== true) return { ok: false, reason: String(parsed.error ?? "The browser driver reported an error.") };
    const image = typeof parsed.image === "string" ? parsed.image : undefined;
    if (image !== undefined && image.length > TAKEOVER_BROWSER_SCREENSHOT_CAP) {
      return {
        ok: false,
        reason: `The screenshot exceeds the ${TAKEOVER_BROWSER_SCREENSHOT_CAP}-character cap — narrow the viewport.`,
      };
    }
    return {
      ok: true,
      reply: {
        ok: true,
        action: typeof parsed.action === "string" ? parsed.action : "",
        ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
        ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
        ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
        ...(typeof parsed.format === "string" ? { format: parsed.format } : {}),
        ...(image !== undefined ? { image } : {}),
      },
    };
  } catch {
    const tail = (r.stderr || r.stdout).trim().slice(-300);
    return { ok: false, reason: `The browser driver's reply was unreadable (exit ${r.exitCode})${tail !== "" ? `: ${tail}` : ""}` };
  }
}

/** The human line the panel shows under the image. */
export function browserReplyOutput(summary: string, reply: BrowserDriverReply): string {
  if (reply.image === undefined) return `Browser ${summary}.`;
  const kb = Math.round((reply.image.length * 3) / 4 / 102.4) / 10;
  return `Browser ${summary} — ${reply.url ?? "no URL"} (${reply.width ?? "?"}x${reply.height ?? "?"}, ${reply.format ?? "png"}, ${kb} KB).`;
}
