import assert from "node:assert/strict";
import { test } from "node:test";

import { checkConnections } from "./connections.server.js";
import { resetObserveWiringWarnings } from "../../../dist/observe-endpoint.js";

/**
 * The Observe connection row under the family env contract: every endpoint
 * spelling reaches the same /health ping, and a configured obs_svc_ service
 * token upgrades the check to a real alerts:read call that proves endpoint,
 * credential, scope and site ownership — with Observe's documented refusals
 * reported as themselves.
 */

const ENV_KEYS = ["OBSERVE_URL", "OBSERVE_ENDPOINT", "OBSERVE_API_KEY", "OBSERVE_SITE", "OBSERVE_SERVICE_TOKEN", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"] as const;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) env[key] = "";
  return env;
}

function fetchOk(body: unknown, status = 200): { fetch: typeof fetch; urls: string[]; auths: (string | null)[] } {
  const urls: string[] = [];
  const auths: (string | null)[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    auths.push(new Headers(init?.headers).get("authorization"));
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, urls, auths };
}

function observeRow(checks: Awaited<ReturnType<typeof checkConnections>>): (typeof checks)[number] {
  const row = checks.find((c) => c.name === "Teploy Observe");
  assert.notEqual(row, undefined);
  return row!;
}

test("unconfigured Observe names the standard env and fetches nothing", async () => {
  resetObserveWiringWarnings();
  const { fetch, urls } = fetchOk(null);
  const row = observeRow(await checkConnections(cleanEnv(), fetch));
  assert.equal(row.state, "Not configured");
  assert.match(row.detail, /OBSERVE_ENDPOINT/);
  assert.equal(urls.length, 0);
});

test("every endpoint spelling reaches the same /health ping", async () => {
  for (const spell of [
    { OBSERVE_ENDPOINT: "https://observe.test" },
    { OBSERVE_URL: "https://observe.test" },
    { OTEL_EXPORTER_OTLP_ENDPOINT: "https://observe.test", OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k" },
  ]) {
    resetObserveWiringWarnings();
    const { fetch, urls } = fetchOk(null);
    const row = observeRow(await checkConnections({ ...cleanEnv(), ...spell }, fetch));
    assert.equal(row.state, "Reachable", JSON.stringify(spell));
    assert.equal(urls[0], "https://observe.test/health", JSON.stringify(spell));
  }
});

test("a configured service token upgrades the check to an alerts:read proof", async () => {
  resetObserveWiringWarnings();
  const { fetch, urls, auths } = fetchOk([{ rule_id: "r1", name: "errors", metric: "error_rate", severity: "critical", enabled: true }]);
  const row = observeRow(
    await checkConnections(
      { ...cleanEnv(), OBSERVE_ENDPOINT: "https://observe.test", OBSERVE_SERVICE_TOKEN: "obs_svc_z", OBSERVE_SITE: "s1" },
      fetch,
    ),
  );
  assert.equal(row.state, "Reachable");
  assert.match(row.detail, /1 alert rule\(s\) readable on site s1/);
  assert.deepEqual(urls, ["https://observe.test/health", "https://observe.test/api/v1/service/sites/s1/alerts/rules"]);
  assert.equal(auths[1], "Bearer obs_svc_z");
});

test("a refused service token is its own state with Observe's reason, not 'reachable'", async () => {
  resetObserveWiringWarnings();
  // health ok, token read 403
  let call = 0;
  const impl = (async (url: string | URL | Request) => {
    call += 1;
    if (call === 1) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }) as typeof fetch;
  const row = observeRow(
    await checkConnections(
      { ...cleanEnv(), OBSERVE_ENDPOINT: "https://observe.test", OBSERVE_SERVICE_TOKEN: "obs_svc_z", OBSERVE_SITE: "s1" },
      impl,
    ),
  );
  assert.equal(row.state, "Token refused");
  assert.match(row.detail, /alerts:read scope/);
  assert.match(row.detail, /incidents page will show no alert state/);
});
