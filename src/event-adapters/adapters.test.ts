import { test } from "node:test";
import assert from "node:assert/strict";

import { EVENT_VENDORS, validateEventSource, type EventSourceRecord } from "../event-rules.js";
import { eventVendorAdapter, VENDOR_ADAPTERS } from "./index.js";

/**
 * E7 EV4 — registry and source-record validation: which vendors exist, which
 * auth class each one actually provides, and what a vendor source must
 * declare before a rule may reference it.
 */

const base = { id: "acme", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" } satisfies Partial<EventSourceRecord>;

test("every declared vendor has an adapter, and no other vendor resolves", () => {
  assert.deepEqual(EVENT_VENDORS, ["sentry", "datadog", "pagerduty", "jira", "gitlab"]);
  for (const vendor of EVENT_VENDORS) {
    assert.equal(VENDOR_ADAPTERS[vendor], eventVendorAdapter(vendor));
  }
});

test("vendor sources must declare an auth class the vendor actually provides", () => {
  assert.equal(validateEventSource({ ...base, vendor: "sentry", auth: "hmac" }).ok, true);
  assert.equal(validateEventSource({ ...base, vendor: "sentry", auth: "shared-secret" }).ok, false); // Sentry always signs
  assert.equal(validateEventSource({ ...base, vendor: "datadog", auth: "shared-secret" }).ok, true);
  assert.equal(validateEventSource({ ...base, vendor: "datadog", auth: "hmac" }).ok, false); // Datadog has no HMAC
  assert.equal(validateEventSource({ ...base, vendor: "pagerduty", auth: "hmac" }).ok, true);
  assert.equal(validateEventSource({ ...base, vendor: "jira", auth: "hmac" }).ok, false); // jira needs a label
  assert.equal(validateEventSource({ ...base, vendor: "jira", auth: "hmac", label: "ship" }).ok, true);
  assert.equal(validateEventSource({ ...base, vendor: "gitlab", auth: "hmac" }).ok, true); // signing token
  assert.equal(validateEventSource({ ...base, vendor: "gitlab", auth: "shared-secret" }).ok, true); // X-Gitlab-Token
  assert.equal(validateEventSource({ ...base, vendor: "stripe", auth: "hmac" }).ok, false);
  const problem = validateEventSource({ ...base, vendor: "datadog", auth: "hmac" });
  if (!problem.ok) assert.match(problem.problem, /datadog/);
});

test("tokenHeader must be a plain header name when a source declares one", () => {
  assert.equal(validateEventSource({ ...base, vendor: "datadog", auth: "shared-secret", tokenHeader: "x-datadog-token" }).ok, true);
  const bad = validateEventSource({ ...base, vendor: "datadog", auth: "shared-secret", tokenHeader: "Bad Header\nName" });
  assert.equal(bad.ok, false);
});

test("a vendor-less source stays the generic EV2 envelope source", () => {
  assert.equal(validateEventSource({ ...base, auth: "hmac" }).ok, true);
  assert.equal(validateEventSource({ ...base, auth: "shared-secret" }).ok, true);
});
