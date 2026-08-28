import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin } from "./session.server.js";

/**
 * The CSRF same-origin predicate, pinned on the shapes that matter.
 *
 * The opaque-origin fallback was added after a live incident (2026-08-28):
 * privacy extensions sent `Origin: null` on ordinary same-origin form posts
 * and every connect attempt was refused. Referer is the tiebreaker — present
 * and on-host passes, anything else still refuses.
 */
function post(headers: Record<string, string>): Request {
  return new Request("http://ship.internal:7460/connect", { method: "POST", headers });
}

test("fetch metadata decides when present", () => {
  assert.equal(sameOrigin(post({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "none" })), true);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "same-site" })), false);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "cross-site" })), false);
});

test("a matching origin passes", () => {
  assert.equal(sameOrigin(post({ origin: "http://ship.internal:7460" })), true);
  assert.equal(sameOrigin(post({ origin: "http://evil.example" })), false);
});

test("no origin headers at all is not the CSRF case", () => {
  assert.equal(sameOrigin(post({})), true);
});

test("opaque origin falls back to referer", () => {
  assert.equal(
    sameOrigin(post({ origin: "null", referer: "http://ship.internal:7460/connect" })),
    true,
    "a nulled origin with a same-host referer is the mangled-legitimate case",
  );
  assert.equal(
    sameOrigin(post({ origin: "null", referer: "http://evil.example/page" })),
    false,
    "a referer naming another host does not rescue a nulled origin",
  );
  assert.equal(
    sameOrigin(post({ origin: "null" })),
    false,
    "a nulled origin with no referer stays refused — the sandboxed-frame case",
  );
});
