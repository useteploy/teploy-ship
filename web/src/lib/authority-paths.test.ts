import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SHIP_WEB_TOKEN ??= "test-token";
const { requiredRole } = await import("./session.server.js");

test("authority-governed paths are role-open so the route's grant decides; the rest keep the role gate", () => {
  // These routes call may() on every mutation (governance.ts), so a named
  // viewer holding `approve` or `policies` must reach the route at all.
  for (const path of ["/", "/runs/run-1", "/api/runs/run-1/decide", "/sources", "/projects", "/policies", "/api/policies"]) {
    assert.equal(requiredRole("POST", path), "viewer", path);
  }
  // Unchanged: secrets/accounts are admin, other mutations are editor, reads are viewer.
  assert.equal(requiredRole("POST", "/settings"), "admin");
  assert.equal(requiredRole("GET", "/settings"), "admin");
  assert.equal(requiredRole("POST", "/knowledge"), "editor");
  assert.equal(requiredRole("GET", "/knowledge"), "viewer");
  assert.equal(requiredRole("POST", "/account"), "viewer");
});
