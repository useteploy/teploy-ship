import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sentryAdapter } from "./sentry.js";
import type { AdapterOptions, HeaderBag } from "./adapter.js";

/**
 * E7 EV4 — Sentry adapter controls against the documented example payloads
 * (docs.sentry.io, fetched 2026-10-17): signature over the raw body, the
 * Request-ID as the retry-stable id, and the issue/event_alert mappings.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "event-adapters", "fixtures");
const SECRET = "sentry-client-secret";
const OPTS: AdapterOptions = { secret: SECRET, nowMs: 0, auth: "hmac" };

const bag = (h: Record<string, string>): HeaderBag => new Headers(h);

const sign = (body: string, secret = SECRET): string => createHmac("sha256", secret).update(body, "utf8").digest("hex");

const fixture = async (name: string): Promise<string> => await readFile(join(FIXTURES, name), "utf8");

test("the documented issue example verifies and maps to issue.new", async () => {
  const body = await fixture("sentry-issue-created.json");
  const headers = bag({ "sentry-hook-resource": "issue", "request-id": "8a2e4f0e-6f7b-4d3a-9c1d-2b6e8f0a5d7c", "sentry-hook-signature": sign(body) });
  assert.deepEqual(sentryAdapter.verify(headers, body, OPTS), { ok: true });
  const mapped = sentryAdapter.map("sentry-prod", headers, body, OPTS);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.equal(mapped.events.length, 1);
  const event = mapped.events[0]!;
  assert.equal(event.type, "issue.new");
  assert.equal(event.source, "sentry-prod");
  assert.equal(event.eventId, "8a2e4f0e-6f7b-4d3a-9c1d-2b6e8f0a5d7c");
  assert.equal(event.subject, "sentry:issue/1234567890");
  assert.equal(event.occurredAt, "2025-11-10T20:56:00.738Z"); // lastSeen, not receipt time
  assert.equal(event.attrs.count, 3); // Sentry sends count as a string; conditions want a number
  assert.equal(event.attrs.level, "fatal");
  assert.equal(event.attrs.project_slug, "python");
  assert.equal(mapped.deliveryId, "8a2e4f0e-6f7b-4d3a-9c1d-2b6e8f0a5d7c");
});

test("the documented event_alert example verifies and maps to alert.triggered", async () => {
  const body = await fixture("sentry-event-alert.json");
  const headers = bag({ "sentry-hook-resource": "event_alert", "request-id": "req-alert-1", "sentry-hook-signature": sign(body) });
  assert.ok(sentryAdapter.verify(headers, body, OPTS).ok);
  const mapped = sentryAdapter.map("sentry-prod", headers, body, OPTS);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const event = mapped.events[0]!;
  assert.equal(event.type, "alert.triggered");
  // The datetime field, not the float epoch, and the same subject family as
  // the issue resource so one episode spans both.
  assert.equal(event.occurredAt, "2019-08-19T21:06:17.677Z");
  assert.equal(event.subject, "sentry:issue/1117540176");
  assert.equal(event.attrs.triggered_rule, "Very Important Alert!");
  assert.equal("environment" in event.attrs, false); // only present when the SDK tags it
});

test("a mutated body fails verification (401)", async () => {
  const body = await fixture("sentry-issue-created.json");
  const headers = bag({ "sentry-hook-resource": "issue", "request-id": "r-1", "sentry-hook-signature": sign(body) });
  const mutated = body.replace('"fatal"', '"error"');
  assert.deepEqual(sentryAdapter.verify(headers, mutated, OPTS), { ok: false, status: 401, reason: "bad-signature" });
  assert.equal(sign("other-secret") === sign(body), false);
});

test("no Request-ID means no dedupe id: refused 400, never a body-hash guess", async () => {
  const body = await fixture("sentry-issue-created.json");
  const headers = bag({ "sentry-hook-resource": "issue", "sentry-hook-signature": sign(body) });
  const mapped = sentryAdapter.map("sentry-prod", headers, body, OPTS);
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.status, 400);
  assert.match(mapped.problem, /Request-ID/);
});

test("issue actions map: unresolved to regression, resolved to resolved, others to nothing", async () => {
  const body = await fixture("sentry-issue-created.json");
  for (const [action, expected] of [["unresolved", "issue.regression"], ["resolved", "issue.resolved"], ["assigned", null], ["archived", null]] as const) {
    const tweaked = body.replace('"action": "created"', `"action": "${action}"`);
    const headers = bag({ "sentry-hook-resource": "issue", "request-id": `r-${action}`, "sentry-hook-signature": sign(tweaked) });
    assert.ok(sentryAdapter.verify(headers, tweaked, OPTS).ok, `${action} still verifies`);
    const mapped = sentryAdapter.map("sentry-prod", headers, tweaked, OPTS);
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    if (expected === null) assert.equal(mapped.events.length, 0, `${action} maps to no event`);
    else assert.equal(mapped.events[0]?.type, expected);
  }
});
