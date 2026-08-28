import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SHIP_WEB_TOKEN ??= "test-token";

const { connectAccess, isTopLevelNavigation, safeNextPath } = await import("./connect.server.js");

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://ship.internal:7460/connect/return?request=r1", { headers });
}

test("only an admin may start or finish a connect", () => {
  assert.equal(connectAccess(null), "sign-in");
  assert.equal(connectAccess({ user: "vee", role: "viewer" }), "forbidden");
  assert.equal(connectAccess({ user: "ed", role: "editor" }), "forbidden", "editor approves runs, not connectors");
  assert.equal(connectAccess({ user: "ada", role: "admin" }), "allowed");
});

test("the return leg runs for a navigation, not for something a page fetched", () => {
  // /connect/return spends a single-use handshake and makes an outbound
  // request. A prefetch, an <img>, or a mail client's link scanner would
  // otherwise burn it before the operator arrived.
  assert.ok(isTopLevelNavigation(req({ "sec-fetch-dest": "document" })));
  assert.ok(isTopLevelNavigation(req()), "a client that sends no such header is not refused");
  assert.ok(!isTopLevelNavigation(req({ "sec-fetch-dest": "image" })));
  assert.ok(!isTopLevelNavigation(req({ "sec-fetch-dest": "empty" })), "fetch/XHR");
  assert.ok(!isTopLevelNavigation(req({ "sec-fetch-dest": "iframe" })));
});

test("the login return-to is bounded to a same-site path", () => {
  assert.equal(safeNextPath("/connect"), "/connect");
  assert.equal(safeNextPath("/connect/return?request=r1&akiroo=https%3A%2F%2Fa.example"), "/connect/return?request=r1&akiroo=https%3A%2F%2Fa.example");
  assert.equal(safeNextPath("/settings?view=system"), "/settings?view=system");
  // Every one of these starts with a slash and every one of them leaves the site.
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("javascript:alert(1)"), "/");
  assert.equal(safeNextPath("/x\r\nLocation: https://evil.example"), "/");
  assert.equal(safeNextPath(null), "/");
  assert.equal(safeNextPath(""), "/");
});
