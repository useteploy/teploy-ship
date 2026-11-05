import assert from "node:assert/strict";
import { test } from "node:test";

import { observeServiceAuthFromEnv, readAlertHistory, readAlertRules } from "./observe-service.js";
import { resetObserveWiringWarnings } from "./observe-endpoint.js";

/**
 * The obs_svc_ service-token read path: wiring resolution, Bearer
 * authentication against /api/v1/service/*, and Observe's documented error
 * contract translated into reasons that distinguish "the wiring is wrong"
 * from anything about the alerts.
 */

const AUTH_ENV: NodeJS.ProcessEnv = {
  OBSERVE_ENDPOINT: "https://observe.test",
  OBSERVE_SERVICE_TOKEN: "obs_svc_zzz",
  OBSERVE_SITE: "site_1",
};

test("auth resolves only with endpoint, obs_svc_ token and site", () => {
  resetObserveWiringWarnings();
  assert.deepEqual(observeServiceAuthFromEnv(AUTH_ENV), { base: "https://observe.test", token: "obs_svc_zzz", siteId: "site_1" });
  assert.equal(observeServiceAuthFromEnv({ ...AUTH_ENV, OBSERVE_SITE: "" }), undefined);
  assert.equal(observeServiceAuthFromEnv({ ...AUTH_ENV, OBSERVE_SERVICE_TOKEN: "" }), undefined);
  assert.equal(observeServiceAuthFromEnv({ OBSERVE_SERVICE_TOKEN: "obs_svc_z", OBSERVE_SITE: "s" }), undefined);
});

test("a token without the obs_svc_ prefix is refused locally with a warning", () => {
  resetObserveWiringWarnings();
  const warnings: string[] = [];
  const got = observeServiceAuthFromEnv(
    { ...AUTH_ENV, OBSERVE_SERVICE_TOKEN: "obs_ingest_key" },
    (line) => warnings.push(line),
  );
  assert.equal(got, undefined);
  assert.ok(warnings.some((w) => w.includes("obs_svc_")));
});

function mockFetch(status: number, body: unknown): { fetch: typeof fetch; urls: string[]; auths: (string | null)[] } {
  const urls: string[] = [];
  const auths: (string | null)[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    auths.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: impl, urls, auths };
}

test("readAlertRules authenticates with Bearer against the service API and parses rules", async () => {
  const { fetch, urls, auths } = mockFetch(200, [
    { rule_id: "r1", name: "errors", metric: "error_rate", severity: "critical", enabled: true },
  ]);
  const got = await readAlertRules({ base: "https://observe.test", token: "obs_svc_z", siteId: "site 1" }, { fetch });
  assert.deepEqual(got, { kind: "ok", value: [{ rule_id: "r1", name: "errors", metric: "error_rate", severity: "critical", enabled: true }] });
  assert.equal(urls[0], "https://observe.test/api/v1/service/sites/site%201/alerts/rules");
  assert.equal(auths[0], "Bearer obs_svc_z");
});

test("readAlertHistory caps the limit and parses entries", async () => {
  const { fetch, urls } = mockFetch(200, [
    { alert_id: "a1", rule_id: "r1", triggered_at: "2026-11-05T00:00:00Z", metric_value: 0.5, threshold: 0.1, status: "triggered" },
  ]);
  const got = await readAlertHistory({ base: "https://observe.test", token: "obs_svc_z", siteId: "s" }, 500, { fetch });
  assert.equal(got.kind, "ok");
  assert.deepEqual(got.value, [
    { alert_id: "a1", rule_id: "r1", triggered_at: "2026-11-05T00:00:00Z", metric_value: 0.5, threshold: 0.1, status: "triggered" },
  ]);
  assert.match(urls[0]!, /limit=200$/);
});

test("Observe's documented refusals become distinct, actionable reasons", async () => {
  const cases: Array<[number, RegExp]> = [
    [401, /refused the service token/],
    [403, /alerts:read scope/],
    [404, /not managed by this token/],
    [429, /rate-limiting/],
    [503, /store is unavailable/],
    [500, /answered 500/],
  ];
  for (const [status, pattern] of cases) {
    const { fetch } = mockFetch(status, {});
    const got = await readAlertRules({ base: "https://observe.test", token: "obs_svc_z", siteId: "s" }, { fetch });
    assert.equal(got.kind, "rejected", String(status));
    assert.match((got as { reason: string }).reason, pattern, String(status));
  }
});

test("an unreachable Observe and an unparseable body are wiring faults, not empty lists", async () => {
  const unreachable = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const got = await readAlertRules({ base: "https://observe.test", token: "obs_svc_z", siteId: "s" }, { fetch: unreachable });
  assert.equal(got.kind, "rejected");
  assert.match((got as { reason: string }).reason, /ECONNREFUSED/);

  const { fetch: badBody } = mockFetch(200, { nope: true });
  const got2 = await readAlertRules({ base: "https://observe.test", token: "obs_svc_z", siteId: "s" }, { fetch: badBody });
  assert.equal(got2.kind, "rejected");
  assert.match((got2 as { reason: string }).reason, /unexpected body/);
});
