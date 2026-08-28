import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SHIP_WEB_TOKEN ??= "test-token";
// The connect action writes a real pending-request row, so point the file store
// somewhere disposable before anything imports it.
process.env.TEPLOY_SHIP_STATE ??= mkdtempSync(join(tmpdir(), "ship-web-authz-"));
process.env.SHIP_STORE ??= "file";

const { requiredRole, signSession, SESSION_COOKIE } = await import("./session.server.js");
const connect = await import("../routes/connect/index.js");
const connectReturn = await import("../routes/connect/return.js");
// The wire name comes from the constant, never a literal: a test that spelled it
// itself is exactly how Ship read "code" while Akiroo sent "delivery" and both
// suites stayed green.
const { DELIVERY_CODE_PARAM } = await import("teploy-ship/runtime");

type Role = "viewer" | "editor" | "admin";

/**
 * A signed-in request to the connect surface. Same-origin unless told otherwise.
 *
 * An admin rides the master-credential identity ("token") and the lesser roles
 * ride an SSO-kind session, because those are the two session shapes whose role
 * comes from the cookie itself. A plain password session re-reads its role from
 * the user store on every request, which would make this a test of the user
 * store rather than of the routes' gates.
 */
function as(role: Role | null, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("sec-fetch-site", "same-origin");
  if (role === "admin") {
    headers.set("cookie", `${SESSION_COOKIE}=${signSession({ user: "token", role: "admin" })}`);
  } else if (role !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}`);
  }
  return new Request(url, { ...init, headers });
}

function form(fields: Record<string, string>): BodyInit {
  return new URLSearchParams(fields);
}

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
  assert.equal(requiredRole("POST", "/logout"), "viewer", "anyone signed in can sign out");
});

/**
 * This used to be a vacuous assertion. /connect was on the layout's public-path
 * list, so the middleware returned before requiredRole was consulted and the
 * test pinned a branch nothing executed. The exemption existed because the
 * operator arrived from Akiroo carrying a code; Ship starts the handshake now,
 * so it is gone and this is the live gate again.
 */
test("the connect pages are admin in both directions, on the path the middleware actually takes", () => {
  assert.equal(requiredRole("GET", "/connect"), "admin");
  assert.equal(requiredRole("POST", "/connect"), "admin");
  assert.equal(requiredRole("GET", "/connect/return"), "admin");
  assert.equal(requiredRole("POST", "/connect/return"), "admin");
});

/**
 * And the routes' own gates, because the list above lives in another file. An
 * action reachable without the loader's check is a real bypass: nothing makes a
 * browser fetch a loader before posting to a route.
 */
test("every connect entry point refuses a non-admin on its own, loader and action alike", async () => {
  for (const role of [null, "viewer", "editor"] as const) {
    const page = await connect.loader({ request: as(role, "http://ship.internal/connect") });
    assert.equal((page as { state: string }).state, "forbidden", `GET /connect as ${role ?? "nobody"}`);

    const posted = await connect.action({
      request: as(role, "http://ship.internal/connect", { method: "POST", body: form({ akiroo: "https://a.akiroo.test" }) }),
    });
    assert.ok(posted instanceof Response, `POST /connect as ${role ?? "nobody"}`);
    assert.equal(posted.status, 403);

    const returned = await connectReturn.loader({
      request: as(role, "http://ship.internal/connect/return?request=r1"),
    });
    assert.equal((returned as { state: string }).state, "forbidden", `GET /connect/return as ${role ?? "nobody"}`);
  }
});

test("an admin's connect POST is still refused when it did not come from this site", async () => {
  const posted = await connect.action({
    request: new Request("http://ship.internal/connect", {
      method: "POST",
      body: form({ akiroo: "https://a.akiroo.test" }),
      headers: {
        cookie: `${SESSION_COOKIE}=${signSession({ user: "token", role: "admin" })}`,
        "sec-fetch-site": "cross-site",
      },
    }),
  });
  assert.ok(posted instanceof Response);
  assert.equal(posted.status, 403);
});

test("starting a connect stores it locally and hands the browser the challenge, never the verifier", async () => {
  const result = await connect.action({
    request: as("admin", "http://ship.internal/connect", {
      method: "POST",
      body: form({ akiroo: "https://a.akiroo.test/" }),
    }),
  });
  const data = result as { state: string; approve?: string; origin?: string };
  assert.equal(data.state, "handoff");
  const approve = new URL(data.approve!);
  assert.equal(approve.origin, "https://a.akiroo.test");
  assert.equal(approve.pathname, "/connect/approve");
  assert.ok(approve.searchParams.get("request"));
  assert.ok(approve.searchParams.get("challenge"));
  assert.equal(approve.searchParams.get("ship"), "http://ship.internal");

  // The verifier is the one value that must never reach a browser. It is not a
  // parameter of the URL builder, so the only way it could appear here is if
  // the challenge were the verifier itself.
  const { shipRuntime } = await import("./store.server.js");
  const runtime = await shipRuntime();
  const claimed = await runtime.connectRequests.claim(approve.searchParams.get("request")!);
  assert.ok(claimed.ok);
  assert.ok(!data.approve!.includes(claimed.request.verifier));
});

test("an address that is not a plain http(s) workspace stores nothing", async () => {
  for (const bad of ["not a url", "javascript:alert(1)", "https://user:pw@a.akiroo.test", "ftp://a.akiroo.test"]) {
    const result = await connect.action({
      request: as("admin", "http://ship.internal/connect", { method: "POST", body: form({ akiroo: bad }) }),
    });
    assert.equal((result as { state: string }).state, "bad-url", bad);
  }
});

/**
 * The property the whole reversal exists for. An admin who follows a
 * /connect/return link they were sent reaches a Ship that has no local row for
 * it, so nothing is exchanged and nothing is stored — and, critically, no
 * outbound request is made to whatever address the link named.
 */
test("a return for a handshake this Ship never started is refused without contacting anyone", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the refused path must not reach the network");
  }) as typeof fetch;
  try {
    const result = await connectReturn.loader({
      request: as(
        "admin",
        "http://ship.internal/connect/return?request=not-ours&akiroo=https%3A%2F%2Fattacker.example",
      ),
    });
    const data = result as { state: string; message: string };
    assert.equal(data.state, "refused");
    assert.match(data.message, /did not start that connect/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * A valid-shaped delivery code. Its value is irrelevant to Ship — Akiroo's
 * atomic claim is what judges it — but its PRESENCE is now required, so the
 * tests that exercise the happy shape have to carry one.
 */
const CODE = "RGVsaXZlcnlDb2RlRnJvbUFraXJvb0Fwcm92YWwx";

/** Start a real handshake and hand back the request id it stored. */
async function started(akiroo: string): Promise<string> {
  const result = (await connect.action({
    request: as("admin", "http://ship.internal/connect", { method: "POST", body: form({ akiroo }) }),
  })) as { approve: string };
  return new URL(result.approve).searchParams.get("request")!;
}

async function withNoNetwork<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("this path must not reach the network");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a return that names a different workspace than the one typed is refused, and the row is spent", async () => {
  const started = (await connect.action({
    request: as("admin", "http://ship.internal/connect", {
      method: "POST",
      body: form({ akiroo: "https://mine.akiroo.test" }),
    }),
  })) as { approve: string };
  const requestId = new URL(started.approve).searchParams.get("request")!;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a mismatched return must not reach the network");
  }) as typeof fetch;
  try {
    const first = (await connectReturn.loader({
      request: as(
        "admin",
        `http://ship.internal/connect/return?request=${requestId}&akiroo=https%3A%2F%2Fattacker.example`,
      ),
    })) as { state: string; message: string };
    assert.equal(first.state, "refused");
    // Both addresses named. An Akiroo whose PUBLIC_BASE_URL disagrees with the
    // address it was reached on lands in exactly this branch, and a refusal
    // that says only "a different workspace" sends the operator hunting for an
    // attacker instead of for the setting that is wrong.
    assert.match(first.message, /attacker\.example/, "the address that arrived");
    assert.match(first.message, /mine\.akiroo\.test/, "the address this connect was started against");

    // Spent, not left live: a refused return has already consumed the one
    // chance this handshake had, so a second attempt cannot retry it with a
    // better-looking parameter.
    const second = (await connectReturn.loader({
      request: as("admin", `http://ship.internal/connect/return?request=${requestId}`),
    })) as { state: string; message: string };
    assert.equal(second.state, "refused");
    assert.match(second.message, /already been completed/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * This test used to pass `request=r1`, which no Ship ever started — so it was
 * refused by the unknown-request branch whether or not the navigation guard
 * existed, and deleting the guard left it green. It drives a REAL pending
 * request now, and asserts the row survives: a prefetch or a link scanner must
 * not burn a handshake, which is the whole reason the guard is here.
 */
test("a return that is not a top-level navigation is refused, and does not spend the handshake", async () => {
  const requestId = await started("https://nav.akiroo.test");
  const result = await withNoNetwork(
    async () =>
      (await connectReturn.loader({
        request: as(
          "admin",
          `http://ship.internal/connect/return?request=${requestId}&akiroo=https%3A%2F%2Fnav.akiroo.test&${DELIVERY_CODE_PARAM}=${CODE}`,
          { headers: { "sec-fetch-dest": "image" } },
        ),
      })) as { state: string; message: string },
  );
  assert.equal(result.state, "refused");

  // Still claimable, so the operator's own navigation a moment later still
  // works. If the guard were removed the loader above would have claimed it.
  const { shipRuntime } = await import("./store.server.js");
  const claimed = await (await shipRuntime()).connectRequests.claim(requestId);
  assert.ok(claimed.ok, "the handshake was left alone");
});

/**
 * Contract step 6. The workspace check used to be skipped entirely when the
 * `akiroo` parameter was absent, so the cheapest possible link — one that
 * simply left a parameter off — bypassed the only guard on this leg.
 */
test("a return with no akiroo parameter at all is refused, not waved through", async () => {
  const requestId = await started("https://named.akiroo.test");
  const result = await withNoNetwork(
    async () =>
      (await connectReturn.loader({
        request: as("admin", `http://ship.internal/connect/return?request=${requestId}&${DELIVERY_CODE_PARAM}=${CODE}`),
      })) as { state: string; message: string },
  );
  assert.equal(result.state, "refused");
  assert.match(result.message, /named\.akiroo\.test/, "it still says which workspace it expected");
});

/**
 * The delivery code is what binds the approval to the Ship the owner was
 * looking at. Without it an attacker who induced an approval displaying the
 * victim's own Ship could redeem the pull token from their own server; with it
 * the code goes to the displayed address and they never see it.
 */
test("a return with no delivery code is refused without contacting the workspace", async () => {
  const requestId = await started("https://coded.akiroo.test");
  const result = await withNoNetwork(
    async () =>
      (await connectReturn.loader({
        request: as(
          "admin",
          `http://ship.internal/connect/return?request=${requestId}&akiroo=https%3A%2F%2Fcoded.akiroo.test`,
        ),
      })) as { state: string; message: string },
  );
  assert.equal(result.state, "refused");
  assert.match(result.message, /code the workspace issues/i);
});

test("a delivery code that is not shaped like one is refused too", async () => {
  const requestId = await started("https://shaped.akiroo.test");
  const result = await withNoNetwork(
    async () =>
      (await connectReturn.loader({
        request: as(
          "admin",
          `http://ship.internal/connect/return?request=${requestId}&akiroo=https%3A%2F%2Fshaped.akiroo.test&${DELIVERY_CODE_PARAM}=nope`,
        ),
      })) as { state: string },
  );
  assert.equal(result.state, "refused");
});

/**
 * The whole leg, end to end, with the workspace stubbed. The assertion that
 * matters is on the BODY Ship POSTs: the delivery code the browser carried has
 * to reach the exchange, and the verifier has to reach it too and nothing else.
 */
test("a complete return carries the delivery code into the exchange and stores the token", async () => {
  const requestId = await started("https://done.akiroo.test");
  const realFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    assert.equal(String(input), "https://done.akiroo.test/api/connections/teploy_ship/handshake/exchange");
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ pull_token: "pt-live", akiroo_url: "https://done.akiroo.test", org_id: "org-9", org_label: "Done" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const result = await connectReturn.loader({
      request: as(
        "admin",
        `http://ship.internal/connect/return?request=${requestId}&akiroo=https%3A%2F%2Fdone.akiroo.test&${DELIVERY_CODE_PARAM}=${CODE}`,
      ),
    });
    assert.ok(result instanceof Response);
    assert.equal(result.status, 302);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(body.request_id, requestId);
  assert.equal(body.delivery_code, CODE, "the code the browser carried, forwarded verbatim");
  assert.equal(typeof body.verifier, "string");
  assert.ok(String(body.verifier).length >= 40);

  const { shipRuntime } = await import("./store.server.js");
  const runtime = await shipRuntime();
  assert.equal(await runtime.config.get("AKIROO_PULL_TOKEN"), "pt-live");
  assert.equal(await runtime.config.get("AKIROO_URL"), "https://done.akiroo.test");
});
