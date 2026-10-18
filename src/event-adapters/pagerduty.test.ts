import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { pagerdutyAdapter } from "./pagerduty.js";
import type { AdapterOptions, HeaderBag } from "./adapter.js";

/**
 * E7 EV4 — PagerDuty v3 adapter controls against the documented payload
 * (docs.pagerduty.com, fetched 2026-10-17): the v1= signature list, rotation
 * by accepting any entry, the event id as the dedupe id, and the incident
 * state mapping.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "event-adapters", "fixtures");
const SECRET = "pd-webhook-signing-secret";
const OPTS: AdapterOptions = { secret: SECRET, nowMs: 0, auth: "hmac" };

const bag = (h: Record<string, string>): HeaderBag => new Headers(h);

const sign = (body: string, secret = SECRET): string => createHmac("sha256", secret).update(body, "utf8").digest("hex");

const fixture = async (): Promise<string> => await readFile(join(FIXTURES, "pagerduty-incident-triggered.json"), "utf8");

test("the documented incident example verifies and maps to incident.triggered", async () => {
  const body = await fixture();
  const headers = bag({ "x-pagerduty-signature": `v1=${sign(body)}` });
  assert.deepEqual(pagerdutyAdapter.verify(headers, body, OPTS), { ok: true });
  const mapped = pagerdutyAdapter.map("pd-main", headers, body, OPTS);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const event = mapped.events[0]!;
  assert.equal(event.type, "incident.triggered");
  assert.equal(event.eventId, "5ac64822-4adc-4fda-ade0-410becf0de4f"); // event.id: stable across redelivery
  assert.equal(event.subject, "pagerduty:PGR0VU2");
  assert.equal(event.occurredAt, "2020-10-02T18:45:22.169Z"); // event.occurred_at, not receipt time
  assert.equal(event.repoHint, "API Service"); // service.summary is the attribution hint
  assert.equal(event.attrs.priority, "P1");
  assert.equal(event.attrs.urgency, "high");
  assert.equal(mapped.deliveryId, null); // no delivery header was sent
});

test("a mutated body fails verification (401)", async () => {
  const body = await fixture();
  const headers = bag({ "x-pagerduty-signature": `v1=${sign(body)}` });
  const mutated = body.replace("A little bump in the road", "A little bump in the road?");
  const result = pagerdutyAdapter.verify(headers, mutated, OPTS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
  // No v1= entries at all is malformed, not a match.
  assert.equal(pagerdutyAdapter.verify(bag({ "x-pagerduty-signature": "v2=abc" }), body, OPTS).ok, false);
  assert.equal(pagerdutyAdapter.verify(bag({}), body, OPTS).ok, false);
});

test("a rotated signature list still verifies when only the second entry matches", async () => {
  const body = await fixture();
  // The old key's signature first, the current second — zero-downtime rotation.
  const stale = sign(body, "the-retired-signing-secret");
  const current = sign(body);
  const headers = bag({ "x-pagerduty-signature": `v1=${stale},v1=${current}` });
  assert.deepEqual(pagerdutyAdapter.verify(headers, body, OPTS), { ok: true });
  // And the reverse order, because the docs do not promise an order.
  assert.deepEqual(pagerdutyAdapter.verify(bag({ "x-pagerduty-signature": `v1=${current},v1=${stale}` }), body, OPTS), { ok: true });
  // But a list where nothing matches is still refused.
  assert.equal(pagerdutyAdapter.verify(bag({ "x-pagerduty-signature": `v1=${stale},v1=${sign(body, "also-wrong")}` }), body, OPTS).ok, false);
});

test("an event without event.id is refused 400", async () => {
  const body = await fixture();
  const parsed = JSON.parse(body) as { event: Record<string, unknown> };
  delete parsed.event.id;
  const mapped = pagerdutyAdapter.map("pd-main", bag({}), JSON.stringify(parsed), OPTS);
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.status, 400);
  assert.match(mapped.problem, /event\.id/);
});

test("incident states map: resolved closes, reopened re-triggers, acknowledged records only", async () => {
  const body = await fixture();
  const typeOf = (type: string): string => {
    const payload = body.replace('"incident.triggered"', `"${type}"`).replace('"5ac64822-4adc-4fda-ade0-410becf0de4f"', `"id-${type.replace(/\./g, "-")}"`);
    const mapped = pagerdutyAdapter.map("pd-main", bag({ "x-webhook-id": "delivery-1" }), payload, OPTS);
    assert.equal(mapped.ok, true);
    return mapped.ok && mapped.events.length > 0 ? mapped.events[0]!.type : "none";
  };
  assert.equal(typeOf("incident.resolved"), "incident.resolved");
  assert.equal(typeOf("incident.reopened"), "incident.triggered");
  assert.equal(typeOf("incident.acknowledged"), "incident.acknowledged");
  // Types the engine does not order on are claimed and recorded, never a task.
  assert.equal(typeOf("incident.priority_updated"), "none");
});
