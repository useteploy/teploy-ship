import assert from "node:assert/strict";
import { test } from "node:test";
import { withSecurityHeaders } from "./response-security.server.js";

for (const [type, body] of [["text/html", "<html>console</html>"], ["application/json", '{"route":"runs"}']]) {
  test(`TS-33: ${type} cannot be reused as another representation`, async () => {
    const result = withSecurityHeaders(new Response(body, {
      headers: { "content-type": type, "vary": "Accept-Encoding, accept", "cache-control": "public, max-age=60" },
    }), new Request("http://ship.test/runs"));
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(result.headers.get("vary")?.toLowerCase().split(", "),
      ["accept-encoding", "accept", "accept-language", "x-neutron-data", "x-neutron-routes"]);
    assert.equal(result.headers.get("content-type"), type);
    assert.equal(await result.text(), body);
  });
}

test("login redirects and authorization errors preserve status, cookies and security headers", () => {
  for (const status of [302, 401, 403]) {
    const result = withSecurityHeaders(new Response(null, { status, headers: {
      location: "/login", "set-cookie": "ship_session=; Max-Age=0", vary: "*",
    } }), new Request("https://ship.test/settings"));
    assert.equal(result.status, status);
    assert.equal(result.headers.get("location"), "/login");
    assert.equal(result.headers.get("set-cookie"), "ship_session=; Max-Age=0");
    assert.equal(result.headers.get("vary"), "*");
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  }
});
