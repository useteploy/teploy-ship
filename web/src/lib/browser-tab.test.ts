import assert from "node:assert/strict";
import { test } from "node:test";
import { clickPoint, resolveNavUrl } from "./browser-tab.js";

test("the nav bar resolves absolute http(s) and /path against the current page", () => {
  assert.deepEqual(resolveNavUrl("http://localhost:3000/", undefined), { ok: true, url: "http://localhost:3000/" });
  assert.deepEqual(resolveNavUrl("  https://example.com/app  ", undefined), { ok: true, url: "https://example.com/app" });
  assert.deepEqual(resolveNavUrl("/page2.html", "http://localhost:8000/index.html"), { ok: true, url: "http://localhost:8000/page2.html" });
  assert.deepEqual(resolveNavUrl("page2.html", "http://localhost:8000/dir/"), { ok: true, url: "http://localhost:8000/dir/page2.html" });
});

test("the nav bar refuses non-http schemes with a reason, before any request is made", () => {
  for (const bad of ["file:///etc/passwd", "about:blank", "data:text/html,x", "ftp://host/f"]) {
    const refused = resolveNavUrl(bad, "http://localhost:8000/");
    assert.equal(refused.ok, false, bad);
    if (!refused.ok) assert.ok(refused.reason.length > 5, `${bad} refused with a reason`);
  }
});

test("a bare path with no current page asks for a full URL instead of guessing a base", () => {
  const refused = resolveNavUrl("/app", undefined);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /full http/);
  assert.equal(resolveNavUrl("", "http://localhost:8000/").ok, false);
});

test("click mapping is 1:1 at natural size and guards degenerate image sizes", () => {
  // unscaled (the normal render): displayed == natural
  assert.deepEqual(clickPoint(120, 64, 1280, 1280, 800, 800), { x: 120, y: 64 });
  // a zero-size image (not loaded, or collapsed) never divides by zero
  assert.equal(clickPoint(120, 64, 0, 1280, 800, 800), null);
  assert.equal(clickPoint(120, 64, 1280, 0, 800, 800), null);
  assert.equal(clickPoint(120, 64, 1280, 1280, 0, 800), null);
  assert.equal(clickPoint(120, 64, 1280, 1280, 800, 0), null);
  assert.equal(clickPoint(NaN, 64, 1280, 1280, 800, 800), null);
  // if a future style scales the image, coordinates follow the ratio
  assert.deepEqual(clickPoint(640, 400, 640, 1280, 400, 800), { x: 1280, y: 800 });
  // never negative
  assert.deepEqual(clickPoint(-5, -5, 1280, 1280, 800, 800), { x: 0, y: 0 });
});
