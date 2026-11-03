import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";

process.env.SHIP_WEB_TOKEN ??= "test-token";
process.env.TEPLOY_SHIP_STATE ??= mkdtempSync(join(tmpdir(), "ship-web-renew-"));
process.env.SHIP_STORE ??= "file";

const { renewedSessionCookie, signSession, verifySession, SESSION_COOKIE } = await import("./session.server.js");
const { shipRuntime } = await import("./store.server.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

function req(cookie: string, headers: Record<string, string> = {}): Request {
  return new Request("http://ship.test/runs", { headers: { cookie: `${SESSION_COOKIE}=${cookie}`, ...headers } });
}

function claims(setCookie: string): Record<string, unknown> {
  const token = /^ship_session=([^;]+)/.exec(setCookie)![1]!;
  return JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8")) as Record<string, unknown>;
}

function legacyCookie(payload: Record<string, unknown>): string {
  // A pre-sliding cookie: same signature scheme, no iat.
  const key = createHash("sha256").update(`ship-session:${process.env.SHIP_SESSION_SECRET ?? process.env.SHIP_WEB_TOKEN}`).digest();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

test("an old password session is re-issued with a fresh iat/exp and its current role", async () => {
  const runtime = await shipRuntime();
  await runtime.users.create("ada", "correct horse battery", "viewer");
  const cookie = signSession({ user: "ada", role: "viewer" }, "pw", T0);
  await runtime.users.setRole("ada", "editor");

  const now = T0 + 2 * DAY;
  const set = await renewedSessionCookie(req(cookie), now);
  assert.ok(set !== null, "renewed");
  assert.match(set, /Max-Age=2592000/);
  assert.match(set, /HttpOnly/);
  assert.doesNotMatch(set, /Secure/, "http origin keeps the insecure decision");
  const c = claims(set);
  assert.equal(c.iat, Math.floor(now / 1000));
  assert.equal(c.exp, Math.floor(now / 1000) + 30 * 24 * 60 * 60);
  assert.equal(c.r, "editor", "role re-read from the store");
  assert.equal(c.k, "pw");
});

test("a cookie issued within the last day is left alone", async () => {
  const cookie = signSession({ user: "token", role: "admin" }, "pw", T0);
  assert.equal(await renewedSessionCookie(req(cookie), T0 + 23 * 60 * 60 * 1000), null);
});

test("a cookie without iat counts as old", async () => {
  const exp = Math.floor(T0 / 1000) + 10 * 24 * 60 * 60;
  const cookie = legacyCookie({ u: "ada", r: "editor", k: "pw", exp });
  assert.equal(verifySession(cookie, T0)?.user, "ada");
  const set = await renewedSessionCookie(req(cookie), T0);
  assert.ok(set !== null);
  assert.equal(claims(set).iat, Math.floor(T0 / 1000));
});

test("SSO renewal slides the cookie but never extends rv", async () => {
  const cookie = signSession({ user: "https://idp.test#u1", display: "tyler", role: "admin" }, "sso", T0);
  const originalRv = claims(`ship_session=${cookie}`).rv;
  // Renew is due after a day but the 12h rv window has already closed by
  // then; prove carry-forward with an older iat but an rv still open.
  const rv = Math.floor(T0 / 1000) + 30 * 60 * 60;
  const old = signSession({ user: "https://idp.test#u1", display: "tyler", role: "admin" }, "sso", T0, rv);
  const now = T0 + 25 * 60 * 60 * 1000;
  const set = await renewedSessionCookie(req(old), now);
  assert.ok(set !== null);
  const c = claims(set);
  assert.equal(c.rv, rv, "rv carried forward unchanged");
  assert.equal(c.d, "tyler");
  assert.equal(c.k, "sso");
  // And a session past its rv is dead, so it is not renewed.
  assert.equal(await renewedSessionCookie(req(cookie), T0 + 25 * 60 * 60 * 1000), null);
  assert.equal(originalRv, Math.floor(T0 / 1000) + 12 * 60 * 60);
});

test("a master-credential cookie from a rotated token is not renewed", async (t) => {
  const prevSecret = process.env.SHIP_SESSION_SECRET;
  const prevToken = process.env.SHIP_WEB_TOKEN;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.SHIP_SESSION_SECRET;
    else process.env.SHIP_SESSION_SECRET = prevSecret;
    process.env.SHIP_WEB_TOKEN = prevToken;
  });
  process.env.SHIP_SESSION_SECRET = "stable";
  process.env.SHIP_WEB_TOKEN = "original";
  const cookie = signSession({ user: "token", role: "admin" }, "pw", T0);
  assert.ok((await renewedSessionCookie(req(cookie), T0 + 2 * DAY)) !== null, "renews while cv matches");
  process.env.SHIP_WEB_TOKEN = "rotated";
  assert.equal(await renewedSessionCookie(req(cookie), T0 + 2 * DAY), null);
});

test("a removed account's session is not renewed", async () => {
  const runtime = await shipRuntime();
  await runtime.users.create("gone", "correct horse battery", "editor");
  const cookie = signSession({ user: "gone", role: "editor" }, "pw", T0);
  await runtime.users.remove("gone");
  assert.equal(await renewedSessionCookie(req(cookie), T0 + 2 * DAY), null);
});

test("bearer calls and logged-out requests are not renewed", async () => {
  const cookie = signSession({ user: "token", role: "admin" }, "pw", T0);
  assert.equal(
    await renewedSessionCookie(req(cookie, { authorization: `Bearer ${process.env.SHIP_WEB_TOKEN}` }), T0 + 2 * DAY),
    null,
  );
  assert.equal(await renewedSessionCookie(new Request("http://ship.test/runs"), T0 + 2 * DAY), null);
});
