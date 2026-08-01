import assert from "node:assert/strict";
import { test } from "node:test";

import { reportError, startSpan } from "./observe.server.js";

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
  delete process.env.OBSERVE_API_KEY;
  withFetchMock((calls) => {
    reportError(new Error("boom"));
    assert.equal(calls.length, 0);
  });
});

test("reportError posts a Sentry-shaped envelope to /api/v1/errors when configured", () => {
  process.env.OBSERVE_URL = "https://observe.test/";
  process.env.OBSERVE_API_KEY = "k";
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
  delete process.env.OBSERVE_API_KEY;
  withFetchMock((calls) => {
    startSpan("GET /runs/:id", { "run.id": "r1" }).end("ok");
    assert.equal(calls.length, 0);
  });
});

test("startSpan posts a single-span OTLP/JSON export to /v1/traces when configured", () => {
  process.env.OBSERVE_URL = "https://observe.test";
  process.env.OBSERVE_API_KEY = "k";
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
