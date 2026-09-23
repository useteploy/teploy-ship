import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";

import { handleIncidentIntake } from "./incident-intake.server.js";
import type { IncidentConfig, IncidentProjectView } from "../../../dist/incidents.js";

/**
 * S17 incident intake — the receiver's contract against the real Observe
 * webhook shape (teploy-observe internal/platform/webhooks.go fireHTTP):
 * a JSON AlertPayload POST, X-Observe-Timestamp + X-Observe-Signature
 * (sha256=hex HMAC-SHA256(secret, "<ts>.<body>")), X-Observe-Delivery
 * stable across retries of one firing.
 */

const SECRET = "test-intake-secret";

const PROJECTS: IncidentProjectView[] = [
  { repo: "tyler/web", url: "https://git.example.com/tyler/web.git", observeService: "fylun-web" },
];

function memoryRuntime(observed: { claimed: string[] } = { claimed: [] }) {
  const values = new Map<string, string>();
  const config: IncidentConfig = {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
  return {
    values,
    runtime: {
      config,
      projects: { list: async () => PROJECTS },
      deliveries: {
        async claim(_source: string, deliveryId: string) {
          if (observed.claimed.includes(deliveryId)) return false;
          observed.claimed.push(deliveryId);
          return true;
        },
      },
    },
  };
}

function signedRequest(body: string, over: Record<string, string> = {}, secret = SECRET): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  return new Request("https://ship.test/api/incidents/intake", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-observe-timestamp": ts, "x-observe-signature": signature, ...over },
  });
}

const ALERT = JSON.stringify({
  alert_id: "al-1",
  rule_id: "rule-413",
  rule_name: "413s on checkout",
  metric: "error_rate",
  value: 12.5,
  threshold: "1",
  site_id: "fylun-web",
  timestamp: "2026-09-23T10:00:00Z",
});

test("intake is OFF by default: no SHIP_INCIDENT_INTAKE_SECRET means a 503 and nothing written", async () => {
  const previous = process.env.SHIP_INCIDENT_INTAKE_SECRET;
  delete process.env.SHIP_INCIDENT_INTAKE_SECRET;
  const { runtime, values } = memoryRuntime();
  try {
    const res = await handleIncidentIntake(signedRequest(ALERT), { runtime });
    assert.equal(res.status, 503);
    assert.equal(values.size, 0);
  } finally {
    if (previous !== undefined) process.env.SHIP_INCIDENT_INTAKE_SECRET = previous;
  }
});

test("a bad signature is a 401; a stale timestamp is refused even with a valid MAC", async () => {
  const { runtime } = memoryRuntime();
  const wrongKey = signedRequest(ALERT, {}, "not-the-secret");
  assert.equal((await handleIncidentIntake(wrongKey, { runtime, secret: SECRET })).status, 401);

  const ts = String(Math.floor(Date.now() / 1000) - 3_600);
  const body = ALERT;
  const signature = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
  const stale = new Request("https://ship.test/api/incidents/intake", {
    method: "POST",
    body,
    headers: { "x-observe-timestamp": ts, "x-observe-signature": signature },
  });
  const res = await handleIncidentIntake(stale, { runtime, secret: SECRET });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /freshness/);
});

test("a signed alert opens an attributed incident (201), and a re-fire of the same rule updates it (200)", async () => {
  const { runtime, values } = memoryRuntime();
  const first = await handleIncidentIntake(signedRequest(ALERT, { "x-observe-delivery": "d1" }), { runtime, secret: SECRET });
  assert.equal(first.status, 201);
  const created = (await first.json()) as { outcome: string; incidentId: string; status: string };
  assert.equal(created.outcome, "created");
  assert.equal(created.status, "attributed");
  const record = JSON.parse(values.get(`SHIP_INCIDENT_${created.incidentId}`) ?? "{}") as {
    source?: string;
    observe?: { fingerprint: string; alertCount: number };
    attribution?: { repo: string };
  };
  assert.equal(record.source, "observe");
  assert.equal(record.observe?.fingerprint, "rule-413");
  assert.equal(record.observe?.alertCount, 1);
  assert.equal(record.attribution?.repo, "tyler/web");

  const refire = JSON.stringify({ ...JSON.parse(ALERT), alert_id: "al-2" });
  const second = await handleIncidentIntake(signedRequest(refire, { "x-observe-delivery": "d2" }), { runtime, secret: SECRET });
  assert.equal(second.status, 200);
  const updated = (await second.json()) as { outcome: string; incidentId: string };
  assert.equal(updated.outcome, "refired");
  assert.equal(updated.incidentId, created.incidentId, "same record, not a second incident");
  const after = JSON.parse(values.get(`SHIP_INCIDENT_${created.incidentId}`) ?? "{}") as { observe?: { alertCount: number } };
  assert.equal(after.observe?.alertCount, 2);
});

test("a resent delivery (same X-Observe-Delivery) collapses before anything is written", async () => {
  const observed = { claimed: [] as string[] };
  const { runtime } = memoryRuntime(observed);
  const again = await handleIncidentIntake(signedRequest(ALERT, { "x-observe-delivery": "same" }), { runtime, secret: SECRET });
  assert.equal(again.status, 201);
  const resent = await handleIncidentIntake(signedRequest(ALERT, { "x-observe-delivery": "same" }), { runtime, secret: SECRET });
  assert.equal(resent.status, 200);
  assert.match(await resent.text(), /duplicate delivery/);
});

test("a payload with no alert id or rule id is skipped, not recorded; malformed JSON is a 400", async () => {
  const { runtime, values } = memoryRuntime();
  const bare = await handleIncidentIntake(signedRequest(JSON.stringify({ site_id: "fylun-web" }), { "x-observe-delivery": "d3" }), { runtime, secret: SECRET });
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /nothing to dedupe on/);
  assert.equal(values.size, 0);

  const malformed = await handleIncidentIntake(signedRequest("{not json", { "x-observe-delivery": "d4" }), { runtime, secret: SECRET });
  assert.equal(malformed.status, 400);
});

test("the stored raw alert is redacted through the bounded-output helper", async () => {
  const { runtime, values } = memoryRuntime();
  const noisy = JSON.stringify({
    ...JSON.parse(ALERT),
    api_key: "sk-abcdefghijklmnopqrstuvwx",
    Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  });
  const res = await handleIncidentIntake(signedRequest(noisy, { "x-observe-delivery": "d5" }), { runtime, secret: SECRET });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { incidentId: string };
  const record = JSON.parse(values.get(`SHIP_INCIDENT_${created.incidentId}`) ?? "{}") as { observe?: { raw?: string } };
  const raw = record.observe?.raw ?? "";
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwx"), "provider tokens are redacted");
  assert.ok(!/Bearer eyJ/.test(raw), "bearer headers are redacted");
  assert.match(raw, /rule-413/, "the alert's own facts survive");
});
