import assert from "node:assert/strict";
import test from "node:test";

import { EXCHANGE_MAX_BYTES, exchangeConnectRequest, requestIsSpent } from "./akiroo-connect.js";
import { challengeFor } from "./connect-requests.js";

const REQUEST = "yBkFq3nJm2xQ4wZa9tPvGw";
const VERIFIER = "Ck9wQm5uZ0FhWmxUcmFuZG9tMzJieXRlc2hlcmU";
const DELIVERY = "RGVsaXZlcnlDb2RlRnJvbUFraXJvb0Fwcm92YWwx";
const AKIROO = "https://lite.akiroo.com";

interface Call {
  url: string;
  init: RequestInit;
}

function recorder(reply: () => Response | Promise<Response>): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function exchange(overrides: Partial<Parameters<typeof exchangeConnectRequest>[0]> = {}) {
  return exchangeConnectRequest({
    origin: AKIROO,
    requestId: REQUEST,
    verifier: VERIFIER,
    deliveryCode: DELIVERY,
    ...overrides,
  });
}

test("the exchange posts the request id and the verifier, refuses redirects, and keeps the origin it was given", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json({ pull_token: "pt-live", akiroo_url: AKIROO, org_label: "Acme", org_id: "org-1" }),
  );
  const outcome = await exchange({ origin: `${AKIROO}/`, fetchImpl });

  assert.ok(outcome.ok);
  assert.equal(outcome.pullToken, "pt-live");
  assert.equal(outcome.akirooUrl, AKIROO, "trailing slash normalised away");
  assert.equal(outcome.orgLabel, "Acme");
  assert.equal(outcome.orgId, "org-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${AKIROO}/api/connections/teploy_ship/handshake/exchange`);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(calls[0]!.init.redirect, "error", "following a redirect would move the credential off the shown origin");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    request_id: REQUEST,
    verifier: VERIFIER,
    delivery_code: DELIVERY,
  });
});

test("the exchange carries the delivery code, and carries it only in the body", async () => {
  // The third factor, and the one that binds the approval to the Ship the
  // owner was looking at. Akiroo requires it in the same atomic claim as the
  // request id and the verifier, so an exchange that dropped it would refuse
  // every connect — and one that put it in the query string would write a live
  // bearer credential into the workspace's access log.
  const { calls, fetchImpl } = recorder(() => json({ pull_token: "pt-live", akiroo_url: AKIROO }));
  await exchange({ fetchImpl });
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.delivery_code, DELIVERY);
  assert.ok(!calls[0]!.url.includes(DELIVERY));
});

test("the exchange keeps a path prefix — one representation on every leg", async () => {
  // The approve link, this exchange and the outbox poll all address the
  // workspace the same way. An Akiroo served under /akiroo answers its
  // handshake there and nowhere else.
  const { calls, fetchImpl } = recorder(() =>
    json({ pull_token: "pt-live", akiroo_url: `${AKIROO}/akiroo` }),
  );
  const outcome = await exchange({ origin: `${AKIROO}/akiroo/`, fetchImpl });
  assert.ok(outcome.ok);
  assert.equal(calls[0]!.url, `${AKIROO}/akiroo/api/connections/teploy_ship/handshake/exchange`);
  assert.equal(outcome.akirooUrl, `${AKIROO}/akiroo`);
});

test("the verifier travels ONLY in the POST body, never in the URL", async () => {
  // The PKCE property, asserted where it can actually regress: the browser legs
  // carry the challenge, and this leg is the only place the preimage exists on
  // the wire. A future edit that moved it into a query string would put it in
  // Akiroo's access log, which is the one thing this design buys.
  const { calls, fetchImpl } = recorder(() => json({ pull_token: "pt-live", akiroo_url: AKIROO }));
  await exchange({ fetchImpl });
  assert.ok(!calls[0]!.url.includes(VERIFIER));
  assert.ok(!calls[0]!.url.includes(challengeFor(VERIFIER)));
});

test("a spent or expired handshake is named as such, and says to start again", async () => {
  for (const [reason, failure] of [
    ["expired", "expired"],
    ["already_used", "already-used"],
    ["unknown_request", "unknown-request"],
  ] as const) {
    const { fetchImpl } = recorder(() => json({ error: "no", reason }, 400));
    const outcome = await exchange({ fetchImpl });
    assert.ok(!outcome.ok);
    assert.equal(outcome.failure, failure);
    assert.ok(requestIsSpent(outcome.failure), `${failure} means the handshake is gone`);
    assert.match(outcome.message, /start the connect again/i);
  }
});

test("a verifier the workspace will not accept is a refusal, not a spent handshake", async () => {
  // The distinction is the operator's next move: a spent handshake means start
  // again, a rejected verifier means the two sides disagree about what was
  // approved and starting again will do the same thing.
  //
  // The literal string matters and is the point of this test. Akiroo emits
  // `verifier_mismatch` (connections_handshake.go errConnectVerifier); Ship
  // branched on `bad_verifier` and reached the same answer only because the
  // default fallthrough happens to be "rejected" too. Pinned against a status
  // that does NOT fall through to "rejected" on its own, so a reason string
  // that stops matching is a failure rather than a coincidence.
  const { fetchImpl } = recorder(() => json({ error: "no", reason: "verifier_mismatch" }, 409));
  const outcome = await exchange({ fetchImpl });
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure, "rejected");
  assert.ok(!requestIsSpent(outcome.failure));

  // The reason Akiroo does NOT emit gets no special handling: it is an
  // unrecognised string, and 409 classifies it as a spent handshake.
  const stale = recorder(() => json({ error: "no", reason: "bad_verifier" }, 409));
  const staleOutcome = await exchange({ fetchImpl: stale.fetchImpl });
  assert.ok(!staleOutcome.ok);
  assert.equal(staleOutcome.failure, "already-used");
});

test("a rate limit, an outage and an unreachable host are NOT reported as a dead handshake", async () => {
  const limited = recorder(() => json({ error: "slow down" }, 429));
  const one = await exchange({ fetchImpl: limited.fetchImpl });
  assert.ok(!one.ok);
  assert.equal(one.failure, "rate-limited");
  assert.ok(!requestIsSpent(one.failure));

  // A 5xx is the workspace ANSWERING. Reporting it as unreachable sent the
  // operator to debug outbound networking that had just demonstrably worked,
  // while the thing to read was the workspace's own log.
  const down = recorder(() => json({ error: "boom" }, 503));
  const two = await exchange({ fetchImpl: down.fetchImpl });
  assert.ok(!two.ok);
  assert.equal(two.failure, "workspace-error");
  assert.ok(!requestIsSpent(two.failure));
  assert.match(two.message, /answered/i);
  assert.doesNotMatch(two.message, /could not reach/i);

  const refused = recorder(() => {
    throw new Error(`connect ECONNREFUSED ${AKIROO}/api/...?verifier=${VERIFIER}`);
  });
  const three = await exchange({ fetchImpl: refused.fetchImpl });
  assert.ok(!three.ok);
  assert.equal(three.failure, "unreachable", "nothing answered at all — this is the only unreachable");
  assert.match(three.message, /could not reach/i);
  // The transport error quoted the URL; the message handed to the operator must not.
  assert.ok(!three.message.includes(VERIFIER));
});

test("an answer that is not an Akiroo answer mints nothing", async () => {
  const html = recorder(() => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
  const one = await exchange({ fetchImpl: html.fetchImpl });
  assert.ok(!one.ok);
  assert.equal(one.failure, "bad-response");

  const empty = recorder(() => json({ akiroo_url: AKIROO }));
  const two = await exchange({ fetchImpl: empty.fetchImpl });
  assert.ok(!two.ok);
  assert.equal(two.failure, "bad-response");
});

test("an oversized body is capped as it is read, with or without a content-length", async () => {
  // The regression this pins: the cap used to be a Content-Length check in
  // front of an unbounded .text(), so a chunked reply — the one shape a hostile
  // server fully controls — was read in its entirety.
  const huge = `{"pull_token":"pt-live","pad":"${"x".repeat(EXCHANGE_MAX_BYTES + 1024)}"}`;
  const chunked = recorder(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(huge));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const outcome = await exchange({ fetchImpl: chunked.fetchImpl });
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure, "bad-response");
  assert.ok(!chunked.calls[0]!.url.includes("pad"));

  // A body just under the cap still parses, so the cap is a cap and not a ban.
  const fine = recorder(() => json({ pull_token: "pt-live", akiroo_url: AKIROO, org_label: "y".repeat(1024) }));
  assert.ok((await exchange({ fetchImpl: fine.fetchImpl })).ok);
});

test("a workspace cannot answer with a different host than the one the connect was started against", async () => {
  const { fetchImpl } = recorder(() => json({ pull_token: "pt-live", akiroo_url: "https://evil.example" }));
  const outcome = await exchange({ fetchImpl });
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure, "origin-mismatch");
  assert.ok(!outcome.message.includes("pt-live"), "no token in an operator-facing message");
});

test("an origin that is not a plain http(s) base is refused before anything is sent", async () => {
  for (const origin of ["javascript:alert(1)", "https://user:pw@lite.akiroo.com", ""]) {
    const { calls, fetchImpl } = recorder(() => json({ pull_token: "pt-live" }));
    const outcome = await exchange({ origin, fetchImpl });
    assert.ok(!outcome.ok, origin);
    assert.equal(outcome.failure, "bad-response");
    assert.equal(calls.length, 0, "userinfo is refused, not stripped and followed");
  }
});

test("no exchange failure message ever carries the verifier, the delivery code or the token", async () => {
  const bodies: Array<() => Response> = [
    () => json({ reason: "expired", verifier: VERIFIER, pull_token: "pt-live" }, 400),
    () => json({ pull_token: "pt-live", akiroo_url: "https://evil.example" }),
    () => new Response(VERIFIER, { status: 400, headers: { "content-type": "text/plain" } }),
  ];
  for (const reply of bodies) {
    const { fetchImpl } = recorder(reply);
    const outcome = await exchange({ fetchImpl });
    assert.ok(!outcome.ok);
    assert.ok(!outcome.message.includes(VERIFIER));
    assert.ok(!outcome.message.includes(DELIVERY));
    assert.ok(!outcome.message.includes("pt-live"));
  }
});
