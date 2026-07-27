import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SHIP_WEB_TOKEN ??= "test-token";

const { sessionSetCookie, sameOrigin, isMutating } = await import("./session.server.js");
const { publicOrigin } = await import("./oidc.server.js");

function req(headers: Record<string, string>, url = "http://ship.internal:7460/runs"): Request {
  return new Request(url, { headers });
}

// ── Cookie policy ────────────────────────────────────────────────────────

test("session cookie is SameSite=Lax, so the SSO callback redirect carries it", () => {
  const cookie = sessionSetCookie({ user: "ada", role: "editor" }, false);
  assert.match(cookie, /SameSite=Lax/);
  // Strict is withheld on the cross-site-initiated navigation the IdP starts,
  // which would land the user on "/" with no session.
  assert.doesNotMatch(cookie, /SameSite=Strict/);
});

test("session cookie keeps HttpOnly and is Secure only when the origin is https", () => {
  const insecure = sessionSetCookie({ user: "ada", role: "editor" }, false);
  assert.match(insecure, /HttpOnly/);
  assert.doesNotMatch(insecure, /Secure/);
  assert.match(sessionSetCookie({ user: "ada", role: "editor" }, true), /Secure/);
});

// ── CSRF ─────────────────────────────────────────────────────────────────

test("isMutating covers the state-changing methods only", () => {
  for (const m of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(isMutating(m), false, m);
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) assert.equal(isMutating(m), true, m);
});

test("sameOrigin trusts Fetch Metadata when it is present", () => {
  assert.equal(sameOrigin(req({ "sec-fetch-site": "same-origin" })), true);
  // A typed URL or bookmark is user-initiated, not CSRF.
  assert.equal(sameOrigin(req({ "sec-fetch-site": "none" })), true);
  assert.equal(sameOrigin(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(req({ "sec-fetch-site": "same-site" })), false);
});

test("sameOrigin falls back to comparing Origin against Host", () => {
  assert.equal(sameOrigin(req({ origin: "http://ship.internal:7460", host: "ship.internal:7460" })), true);
  assert.equal(sameOrigin(req({ origin: "https://evil.example", host: "ship.internal:7460" })), false);
  assert.equal(sameOrigin(req({ origin: "not a url", host: "ship.internal:7460" })), false);
});

test("sameOrigin passes a request with neither header — a bearer caller, not a browser", () => {
  assert.equal(sameOrigin(req({})), true);
});

test("Fetch Metadata wins over a forged Origin", () => {
  assert.equal(
    sameOrigin(req({ "sec-fetch-site": "cross-site", origin: "http://ship.internal:7460", host: "ship.internal:7460" })),
    false
  );
});

// ── Forwarded headers ────────────────────────────────────────────────────

test("X-Forwarded-* is ignored unless a proxy is declared", (t) => {
  t.after(() => {
    delete process.env.SHIP_TRUST_PROXY;
    delete process.env.SHIP_PUBLIC_URL;
  });
  const spoofed = req({
    host: "ship.internal:7460",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example",
  });
  assert.equal(publicOrigin(spoofed), "http://ship.internal:7460");

  process.env.SHIP_TRUST_PROXY = "1";
  assert.equal(publicOrigin(spoofed), "https://evil.example");
});

test("a downgraded X-Forwarded-Proto cannot strip Secure from the cookie", () => {
  // The attack the gate closes: ship's teploy.yml publishes the port directly
  // (ingress: host), so with no proxy these headers are pure client input.
  const downgrade = req({ host: "ship.internal:7460", "x-forwarded-proto": "http" }, "https://ship.internal/runs");
  assert.equal(publicOrigin(downgrade).startsWith("https://"), true);
});

test("SHIP_PUBLIC_URL is authoritative over both", (t) => {
  t.after(() => {
    delete process.env.SHIP_PUBLIC_URL;
    delete process.env.SHIP_TRUST_PROXY;
  });
  process.env.SHIP_PUBLIC_URL = "https://ship.example.com/";
  process.env.SHIP_TRUST_PROXY = "1";
  assert.equal(
    publicOrigin(req({ host: "ship.internal:7460", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" })),
    "https://ship.example.com"
  );
});

test("a malformed SHIP_PUBLIC_URL falls through instead of failing the login", (t) => {
  t.after(() => delete process.env.SHIP_PUBLIC_URL);
  process.env.SHIP_PUBLIC_URL = "notaurl";
  assert.equal(publicOrigin(req({ host: "ship.internal:7460" })), "http://ship.internal:7460");
});
