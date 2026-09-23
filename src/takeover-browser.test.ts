import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_DRIVER_SOURCE,
  BROWSER_EXCLUDES,
  TAKEOVER_BROWSER_OPS_LIMIT,
  TAKEOVER_BROWSER_SCREENSHOT_CAP,
  TAKEOVER_BROWSER_TEXT_LIMIT,
  browserKeyValid,
  browserOpCommand,
  browserOpSummary,
  browserReplyOutput,
  browserUrlValid,
  encodeBrowserAction,
  parseBrowserAction,
  parseDriverReply,
} from "./takeover-browser.js";

test("the URL guard accepts http(s) only, and refuses file:// and friends with a reason", () => {
  assert.equal(browserUrlValid("http://localhost:3000/").ok, true);
  assert.equal(browserUrlValid("https://example.com/app").ok, true);
  for (const bad of [
    "file:///etc/passwd",
    "about:blank",
    "data:text/html,<h1>hi</h1>",
    "chrome://settings",
    "ftp://example.com/pub",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    const refused = browserUrlValid(bad);
    assert.equal(refused.ok, false, bad);
    if (!refused.ok) assert.ok(refused.reason.length > 10, `${bad} refused with a reason`);
  }
});

test("browser actions parse and bound every field", () => {
  assert.deepEqual(parseBrowserAction({ action: "navigate", url: "http://x/" }), { ok: true, action: { action: "navigate", url: "http://x/" } });
  assert.equal(parseBrowserAction({ action: "navigate", url: "file:///etc/passwd" }).ok, false);
  assert.deepEqual(parseBrowserAction({ action: "click", x: 0, y: 8191 }), { ok: true, action: { action: "click", x: 0, y: 8191 } });
  assert.equal(parseBrowserAction({ action: "click", x: 8192, y: 0 }).ok, false);
  assert.equal(parseBrowserAction({ action: "click", x: 1.5, y: 0 }).ok, false);
  assert.equal(parseBrowserAction({ action: "click", x: "0", y: 0 }).ok, false);
  assert.equal(parseBrowserAction({ action: "type", text: "a".repeat(TAKEOVER_BROWSER_TEXT_LIMIT) }).ok, true);
  assert.equal(parseBrowserAction({ action: "type", text: "a".repeat(TAKEOVER_BROWSER_TEXT_LIMIT + 1) }).ok, false);
  assert.equal(parseBrowserAction({ action: "type" }).ok, false);
  assert.equal(parseBrowserAction({ action: "key", key: "Enter" }).ok, true);
  assert.equal(parseBrowserAction({ action: "key", key: "Shift+Tab" }).ok, true);
  assert.equal(parseBrowserAction({ action: "key", key: "Control+Alt+Delete" }).ok, true);
  assert.equal(parseBrowserAction({ action: "key", key: "a" }).ok, false, "letters are typed, not pressed");
  assert.equal(parseBrowserAction({ action: "key", key: "Shift+Control+Alt+Meta+Enter" }).ok, false, "modifier stack is capped");
  assert.equal(parseBrowserAction({ action: "scroll", dy: -100_000 }).ok, true);
  assert.equal(parseBrowserAction({ action: "scroll", dy: 100_001 }).ok, false);
  assert.equal(parseBrowserAction({ action: "viewport", w: 240, h: 4320 }).ok, true);
  assert.equal(parseBrowserAction({ action: "viewport", w: 239, h: 800 }).ok, false);
  assert.equal(parseBrowserAction({ action: "viewport", w: 3841, h: 800 }).ok, false);
  assert.deepEqual(parseBrowserAction({ action: "close" }), { ok: true, action: { action: "close" } });
  assert.equal(parseBrowserAction({ action: "download" }).ok, false);
  assert.equal(parseBrowserAction(null).ok, false);
  assert.equal(parseBrowserAction("navigate").ok, false);
});

test("the key whitelist is shared logic, not a duplicate list", () => {
  assert.equal(browserKeyValid("Enter"), true);
  assert.equal(browserKeyValid("Meta+ArrowDown"), true);
  assert.equal(browserKeyValid("Enter+Shift"), false, "the base key comes last");
  assert.equal(browserKeyValid(""), false);
});

test("the exec command carries the driver as a quoted heredoc and the action as base64 argv", () => {
  const b64 = encodeBrowserAction({ action: "navigate", url: "http://localhost:8000/" });
  const command = browserOpCommand(b64);
  // quoted delimiter: no shell interpolation of the driver source
  assert.match(command, /<<'SHIP_BROWSER_DRIVER_EOF'/);
  assert.match(command, new RegExp(`exec node \\.ship/browser-driver\\.mjs '${b64}'$`));
  // the driver source cannot contain the sentinel line, or the heredoc ends early
  assert.equal(BROWSER_DRIVER_SOURCE.includes("\nSHIP_BROWSER_DRIVER_EOF\n"), false);
  assert.equal(BROWSER_DRIVER_SOURCE.includes("SHIP_BROWSER_DRIVER_EOF"), false);
  // browser scratch is excluded from the repository on every op (cookies never reach a PR)
  for (const exclude of BROWSER_EXCLUDES) assert.match(command, new RegExp(`grep -qxF '${exclude.replace(/\//g, "\\/")}'`));
  // the driver re-validates the URL scheme itself — anything that can exec reaches it, not only the worker
  assert.match(BROWSER_DRIVER_SOURCE, /only http\(s\) URLs are accepted/);
});

test("the action rides base64, so typed text cannot inject into the shell command", () => {
  const b64 = encodeBrowserAction({ action: "type", text: "'; rm -rf /; echo '" });
  assert.equal(/["']/.test(b64), false, "base64 alphabet carries no quotes");
  const command = browserOpCommand(b64);
  assert.match(command, new RegExp(`'${b64}'$`));
});

test("driver replies parse, cap the screenshot honestly, and surface driver errors", () => {
  const image = Buffer.from("fake-png-bytes").toString("base64");
  const ok = parseDriverReply({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, action: "navigate", url: "http://localhost:8000/", width: 1280, height: 800, format: "png", image }) + "\n",
    stderr: "",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.reply.url, "http://localhost:8000/");
    assert.equal(ok.reply.image, image);
  }
  // over the cap: refused, never a silently truncated image
  const oversized = parseDriverReply({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, action: "navigate", image: "A".repeat(TAKEOVER_BROWSER_SCREENSHOT_CAP + 1) }) + "\n",
    stderr: "",
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.reason, /cap/);
  // driver-said-no and crashed-driver shapes
  const refused = parseDriverReply({ exitCode: 0, stdout: JSON.stringify({ ok: false, error: "no chromium binary" }) + "\n", stderr: "" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /chromium/);
  const silent = parseDriverReply({ exitCode: 1, stdout: "", stderr: "node: not found" });
  assert.equal(silent.ok, false);
  if (!silent.ok) assert.match(silent.reason, /did not answer/);
  const garbage = parseDriverReply({ exitCode: 0, stdout: "not json\n", stderr: "" });
  assert.equal(garbage.ok, false);
  const timedOut = parseDriverReply({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.match(timedOut.reason, /timed out/);
});

test("op summaries are one bounded line each, for the session record", () => {
  assert.equal(browserOpSummary({ action: "navigate", url: "http://localhost:8000/" }), "navigate http://localhost:8000/");
  assert.equal(browserOpSummary({ action: "click", x: 12, y: 34 }), "click 12,34");
  assert.equal(browserOpSummary({ action: "type", text: "hello" }), `type 5 chars ("hello")`);
  const multiline = browserOpSummary({ action: "type", text: "a\nb" });
  assert.equal(multiline.includes("\n"), false);
  assert.equal(browserOpSummary({ action: "scroll", dy: -600 }), "scroll -600");
  assert.equal(browserOpSummary({ action: "viewport", w: 800, h: 600 }), "viewport 800x600");
  assert.equal(browserOpSummary({ action: "close" }), "close");
  assert.ok(browserOpSummary({ action: "navigate", url: `http://x/${"long".repeat(100)}` }).length <= 140);
});

test("the reply line names the page state and the image weight", () => {
  const line = browserReplyOutput("navigate http://localhost:8000/", {
    ok: true,
    action: "navigate",
    url: "http://localhost:8000/",
    width: 1280,
    height: 800,
    format: "png",
    image: "A".repeat(40_000),
  });
  assert.match(line, /navigate http:\/\/localhost:8000\/ — http:\/\/localhost:8000\/ \(1280x800, png,/);
  assert.equal(browserReplyOutput("close", { ok: true, action: "close" }), "Browser close.");
  assert.ok(TAKEOVER_BROWSER_OPS_LIMIT >= 100, "the session op log keeps a real history");
});
