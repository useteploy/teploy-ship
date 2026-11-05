import assert from "node:assert/strict";
import { test } from "node:test";

import { observeBaseFromEnv, observeWiringFromEnv, otlpHeaderXAPIKey, parseOTELAttributes, resetObserveWiringWarnings } from "./observe-endpoint.js";

/**
 * The env-name compatibility table for the family's standard Observe contract
 * (plan DASH_AUTOCONFIG 10.3). Nontrivial on purpose: three spellings of the
 * endpoint, two spellings of the key, a transport guard, and a deprecated
 * legacy name that must keep working.
 */

interface Row {
  name: string;
  env: NodeJS.ProcessEnv;
  want: { base: string; key: string; source: string } | null;
  warnDeprecated?: boolean;
  warnProtocol?: boolean;
}

const ROWS: Row[] = [
  { name: "nothing set", env: {}, want: null },
  { name: "key only is not a configuration", env: { OBSERVE_API_KEY: "k" }, want: null },
  {
    name: "standard names",
    env: { OBSERVE_ENDPOINT: "https://observe.example.com/", OBSERVE_API_KEY: "k" },
    want: { base: "https://observe.example.com", key: "k", source: "OBSERVE_ENDPOINT" },
  },
  {
    name: "standard endpoint without a key is not Observe",
    env: { OBSERVE_ENDPOINT: "https://observe.example.com" },
    want: null,
  },
  {
    name: "legacy names still work",
    env: { OBSERVE_URL: "https://observe.example.com", OBSERVE_API_KEY: "k" },
    want: { base: "https://observe.example.com", key: "k", source: "OBSERVE_URL" },
    warnDeprecated: true,
  },
  {
    name: "legacy URL without a key stays off (unchanged behaviour, warning still names the replacement)",
    env: { OBSERVE_URL: "https://observe.example.com" },
    want: null,
    warnDeprecated: true,
  },
  {
    name: "standard wins over legacy when both are set",
    env: { OBSERVE_ENDPOINT: "https://new.example.com", OBSERVE_URL: "https://old.example.com", OBSERVE_API_KEY: "k" },
    want: { base: "https://new.example.com", key: "k", source: "OBSERVE_ENDPOINT" },
  },
  {
    name: "OTLP spelling with the key in the headers",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://observe.example.com", OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k,other=1" },
    want: { base: "https://observe.example.com", key: "k", source: "OTEL_EXPORTER_OTLP_ENDPOINT" },
  },
  {
    name: "OTLP spelling with OBSERVE_API_KEY beside it",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://observe.example.com", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OBSERVE_API_KEY: "k" },
    want: { base: "https://observe.example.com", key: "k", source: "OTEL_EXPORTER_OTLP_ENDPOINT" },
  },
  {
    name: "OTLP endpoint with no Observe credential is another vendor's collector",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" },
    want: null,
  },
  {
    name: "OTLP endpoint with grpc protocol is left to real OTel SDKs",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://observe.example.com", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OBSERVE_API_KEY: "k" },
    want: null,
    warnProtocol: true,
  },
  {
    name: "OTLP endpoint with http/json is usable (ship posts OTLP/JSON traces)",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://observe.example.com", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k" },
    want: { base: "https://observe.example.com", key: "k", source: "OTEL_EXPORTER_OTLP_ENDPOINT" },
  },
  {
    name: "standard endpoint outranks an OTLP endpoint",
    env: { OBSERVE_ENDPOINT: "https://observe.example.com", OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com", OBSERVE_API_KEY: "k" },
    want: { base: "https://observe.example.com", key: "k", source: "OBSERVE_ENDPOINT" },
  },
];

test("env-name compatibility table", () => {
  for (const row of ROWS) {
    resetObserveWiringWarnings();
    const warnings: string[] = [];
    const got = observeWiringFromEnv(row.env, (line) => warnings.push(line));
    if (row.want === null) {
      assert.equal(got, null, row.name);
    } else {
      assert.notEqual(got, null, row.name);
      assert.equal(got!.base, row.want.base, `${row.name}: base`);
      assert.equal(got!.ingestKey, row.want.key, `${row.name}: key`);
      assert.equal(got!.source, row.want.source, `${row.name}: source`);
    }
    assert.equal(warnings.some((w) => w.includes("OBSERVE_URL is deprecated")), row.warnDeprecated === true, `${row.name}: deprecation warning`);
    assert.equal(warnings.some((w) => w.includes("OTLP_PROTOCOL")), row.warnProtocol === true, `${row.name}: protocol warning`);
  }
});

test("the deprecation warning fires once per process, naming the replacement", () => {
  resetObserveWiringWarnings();
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = { OBSERVE_URL: "https://observe.example.com", OBSERVE_API_KEY: "k" };
  for (let i = 0; i < 3; i++) observeWiringFromEnv(env, (line) => warnings.push(line));
  const deprecations = warnings.filter((w) => w.includes("OBSERVE_URL is deprecated"));
  assert.equal(deprecations.length, 1);
  assert.match(deprecations[0]!, /OBSERVE_ENDPOINT/);
});

test("site, service name and resource attributes ride along", () => {
  const got = observeWiringFromEnv({
    OBSERVE_ENDPOINT: "https://observe.example.com",
    OBSERVE_API_KEY: "k",
    OBSERVE_SITE: "site_1",
    OTEL_SERVICE_NAME: "ship",
    OTEL_RESOURCE_ATTRIBUTES: "service.version=0.4.0,deployment.environment=production",
  });
  assert.notEqual(got, null);
  assert.equal(got!.site, "site_1");
  assert.equal(got!.serviceName, "ship");
  assert.deepEqual(got!.resourceAttributes, { "service.version": "0.4.0", "deployment.environment": "production" });
});

test("header and attribute parsing edges", () => {
  assert.equal(otlpHeaderXAPIKey("X-API-Key=k1,x-api-key=k2"), "k2");
  assert.equal(otlpHeaderXAPIKey("authorization=Bearer z"), "");
  assert.equal(otlpHeaderXAPIKey(""), "");
  assert.equal(otlpHeaderXAPIKey("novalue"), "");
  assert.deepEqual(parseOTELAttributes("a=1, =2 ,b=c=d"), { a: "1", b: "c=d" });
  assert.deepEqual(parseOTELAttributes(""), {});
});

test("a read-only deployment keeps its base URL without an ingest key", () => {
  // URL + share token with no OBSERVE_API_KEY has always been a valid
  // read-only wiring (telemetry evidence leg); observeBaseFromEnv must not
  // regress it by demanding the ingest key.
  resetObserveWiringWarnings();
  const got = observeBaseFromEnv({ OBSERVE_URL: "https://observe.example.com" });
  assert.notEqual(got, null);
  assert.equal(got!.base, "https://observe.example.com");
  assert.equal(got!.source, "OBSERVE_URL");
  // The standard spelling behaves the same for reads.
  assert.equal(observeBaseFromEnv({ OBSERVE_ENDPOINT: "https://observe.example.com" })?.base, "https://observe.example.com");
});
