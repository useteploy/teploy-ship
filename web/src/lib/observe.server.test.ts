import assert from "node:assert/strict";
import { test } from "node:test";

import { reportError, startSpan } from "./observe.server.js";
// The resolver's once-per-process warning latch would swallow later
// deprecation assertions; reset per test.
import { resetObserveWiringWarnings } from "../../../dist/observe-endpoint.js";

function withFetchMock<T>(fn: (calls: { url: string; init: RequestInit }[]) => T): T {
  const calls: { url: string; init: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  try {
    return fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

test("reportError is a no-op when Observe is unconfigured", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OBSERVE_API_KEY;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  resetObserveWiringWarnings();
  withFetchMock((calls) => {
    reportError(new Error("boom"));
    assert.equal(calls.length, 0);
  });
});

test("reportError posts a Sentry-shaped envelope to /api/v1/errors when configured", () => {
  process.env.OBSERVE_URL = "https://observe.test/";
  process.env.OBSERVE_API_KEY = "k";
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  resetObserveWiringWarnings();
  try {
    withFetchMock((calls) => {
      reportError(new Error("boom"), { mechanism: "uncaughtException" });
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/api\/v1\/errors$/);
      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "k");
      const body = JSON.parse(calls[0]!.init.body as string);
      assert.equal(body.error_type, "Error");
      assert.equal(body.error_value, "boom");
      assert.equal(body.mechanism, "uncaughtException");
      assert.equal(body.handled, false);
    });
  } finally {
    delete process.env.OBSERVE_URL;
    delete process.env.OBSERVE_API_KEY;
  }
});

test("startSpan is a no-op when Observe is unconfigured", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OBSERVE_API_KEY;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  resetObserveWiringWarnings();
  withFetchMock((calls) => {
    startSpan("GET /runs/:id", { "run.id": "r1" }).end("ok");
    assert.equal(calls.length, 0);
  });
});

test("startSpan posts a single-span OTLP/JSON export to /v1/traces when configured", () => {
  process.env.OBSERVE_URL = "https://observe.test";
  process.env.OBSERVE_API_KEY = "k";
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  resetObserveWiringWarnings();
  try {
    withFetchMock((calls) => {
      const span = startSpan("GET /runs/:id", { "run.id": "r1" });
      span.end("error", { "run.status": "failed" });
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/v1\/traces$/);
      const body = JSON.parse(calls[0]!.init.body as string);
      const span0 = body.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(span0.name, "GET /runs/:id");
      assert.equal(span0.status.code, 2); // error
      assert.equal(span0.traceId.length, 32);
      assert.equal(span0.spanId.length, 16);
      assert.ok(BigInt(span0.endTimeUnixNano) >= BigInt(span0.startTimeUnixNano));
      const attrs: { key: string; value: Record<string, unknown> }[] = span0.attributes;
      assert.ok(attrs.some((a) => a.key === "run.id" && a.value.stringValue === "r1"));
      assert.ok(attrs.some((a) => a.key === "run.status" && a.value.stringValue === "failed"));
    });
  } finally {
    delete process.env.OBSERVE_URL;
    delete process.env.OBSERVE_API_KEY;
  }
});

test("the family's standard spelling configures the emitters too", () => {
  delete process.env.OBSERVE_URL;
  process.env.OBSERVE_ENDPOINT = "https://observe.test/";
  process.env.OBSERVE_API_KEY = "std-key";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  resetObserveWiringWarnings();
  try {
    withFetchMock((calls) => {
      reportError(new Error("boom"));
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /^https:\/\/observe\.test\/api\/v1\/errors$/);
      assert.equal((calls[0]!.init.headers as Record<string, string>)["x-api-key"], "std-key");
    });
  } finally {
    delete process.env.OBSERVE_ENDPOINT;
    delete process.env.OBSERVE_API_KEY;
  }
});

test("the OTLP spelling with headers configures the emitters", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OBSERVE_API_KEY;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://observe.test";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=otlp-key";
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
  resetObserveWiringWarnings();
  try {
    withFetchMock((calls) => {
      reportError(new Error("boom"));
      assert.equal(calls.length, 1);
      assert.equal((calls[0]!.init.headers as Record<string, string>)["x-api-key"], "otlp-key");
    });
  } finally {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  }
});

test("a span carries OTEL_SERVICE_NAME and service.version from the contract", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OBSERVE_API_KEY = "k";
  process.env.OBSERVE_URL = "https://observe.test";
  process.env.OTEL_SERVICE_NAME = "ship";
  process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=0.4.0";
  resetObserveWiringWarnings();
  try {
    withFetchMock((calls) => {
      startSpan("GET /runs/:id").end("ok");
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0]!.init.body as string);
      const resource = body.resourceSpans[0].resource;
      const resourceAttrs: { key: string; value: Record<string, unknown> }[] = resource.attributes;
      assert.ok(resourceAttrs.some((a) => a.key === "service.name" && a.value.stringValue === "ship"), "service.name from OTEL_SERVICE_NAME");
      assert.ok(resourceAttrs.some((a) => a.key === "service.version" && a.value.stringValue === "0.4.0"), "service.version from OTEL_RESOURCE_ATTRIBUTES");
      assert.equal(body.resourceSpans[0].scopeSpans[0].scope.version, "0.4.0");
    });
  } finally {
    delete process.env.OBSERVE_URL;
    delete process.env.OBSERVE_API_KEY;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  }
});
