import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";

import { handleDashIncidentIntake, handleIncidentIntake } from "./incident-intake.server.js";
import type { IncidentConfig, IncidentProjectView } from "../../../dist/incidents.js";

/**
 * Teploy Dash incident intake — the receiver against the normative Event v2
 * wire contract (Teploy/_internal/DASH_AUTOCONFIG_PLAN 2.5): X-Teploy-
 * Timestamp + X-Teploy-Signature (sha256=hex HMAC-SHA256(secret, "<ts>.
 * <body>")), X-Teploy-Delivery, X-Teploy-Event-Version: 2.
 */

const SECRET = "test-dash-secret";

const PROJECTS: IncidentProjectView[] = [
  { repo: "tyler/akiroo", url: "https://git.example.com/tyler/akiroo.git", teployApps: ["akiroo-lite"] },
];

function memoryRuntime() {
  const values = new Map<string, string>();
  const claimed: string[] = [];
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
    claimed,
    runtime: {
      config,
      projects: { list: async () => PROJECTS },
      deliveries: {
        async claim(_source: string, deliveryId: string) {
          if (claimed.includes(deliveryId)) return false;
          claimed.push(deliveryId);
          return true;
        },
      },
    },
  };
}

function signed(body: string, over: Record<string, string> = {}, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))): Request {
  const signature = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  return new Request("https://ship.test/api/incidents/intake/dash", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-teploy-timestamp": ts, "x-teploy-signature": signature, "x-teploy-event-version": "2", ...over },
  });
}

const EVENT = {
  monitor_id: "fleet-8f1c",
  monitor_name: "app.akiroo.com",
  status: "down",
  message: "unexpected status 502",
  occurred_at: "2026-11-03T22:31:00Z",
  source: "monitor",
  delivery_id: "dl-1",
  version: 2,
  kind: "incident_opened",
  reason: "",
  incident_id: "inc_3f9a",
  rule_id: "fleet-8f1c",
  service: "akiroo-lite",
  app: "akiroo-lite",
  server: "deploy-home2",
  target: "https://app.akiroo.com/",
  severity: "critical",
  started_at: "2026-11-03T22:28:00Z",
  duration_s: 0,
  consecutive_failures: 3,
  url: "",
};

const body = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...EVENT, ...over });

test("Dash intake is OFF by default: no SHIP_DASH_INTAKE_SECRET is a 503 and nothing written", async () => {
  const previous = process.env.SHIP_DASH_INTAKE_SECRET;
  delete process.env.SHIP_DASH_INTAKE_SECRET;
  const { runtime, values } = memoryRuntime();
  try {
    const res = await handleDashIncidentIntake(signed(body()), { runtime });
    assert.equal(res.status, 503);
    assert.equal(values.size, 0);
  } finally {
    if (previous !== undefined) process.env.SHIP_DASH_INTAKE_SECRET = previous;
  }
});

test("Dash signature: good verifies; wrong key, tampered body, Observe-family headers and a stale timestamp are 401", async () => {
  const { runtime, values } = memoryRuntime();
  assert.equal((await handleDashIncidentIntake(signed(body(), { "x-teploy-delivery": "g1" }), { runtime, secret: SECRET })).status, 201);

  assert.equal((await handleDashIncidentIntake(signed(body(), {}, "not-the-secret"), { runtime, secret: SECRET })).status, 401);

  const good = signed(body({ incident_id: "inc_t" }));
  const tampered = new Request(good.url, { method: "POST", body: body({ incident_id: "inc_t", severity: "info" }), headers: good.headers });
  assert.equal((await handleDashIncidentIntake(tampered, { runtime, secret: SECRET })).status, 401);

  // The Observe header family does not authenticate on the Dash route.
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = body({ incident_id: "inc_o" });
  const observeSigned = new Request("https://ship.test/api/incidents/intake/dash", {
    method: "POST",
    body: raw,
    headers: { "x-observe-timestamp": ts, "x-observe-signature": `sha256=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}` },
  });
  assert.equal((await handleDashIncidentIntake(observeSigned, { runtime, secret: SECRET })).status, 401);

  const stale = await handleDashIncidentIntake(signed(body({ incident_id: "inc_s" }), {}, SECRET, String(Math.floor(Date.now() / 1000) - 301)), { runtime, secret: SECRET });
  assert.equal(stale.status, 401);
  assert.match(await stale.text(), /freshness/);
  assert.equal([...values.keys()].filter((k) => k !== "SHIP_INCIDENTS_INDEX").length, 1, "only the good delivery wrote a record");
});

test("Dash deliveries do not authenticate on the Observe route either (separate secrets, separate paths)", async () => {
  const { runtime } = memoryRuntime();
  const res = await handleIncidentIntake(signed(body()), { runtime, secret: SECRET });
  assert.equal(res.status, 401);
});

test("Dash dedupe: a resent X-Teploy-Delivery collapses before anything is written; body delivery_id is the fallback", async () => {
  const { runtime } = memoryRuntime();
  assert.equal((await handleDashIncidentIntake(signed(body(), { "x-teploy-delivery": "same" }), { runtime, secret: SECRET })).status, 201);
  const resent = await handleDashIncidentIntake(signed(body({ kind: "incident_repeat" }), { "x-teploy-delivery": "same" }), { runtime, secret: SECRET });
  assert.equal(resent.status, 200, "a different kind under the same delivery id is still its own claim");
  const again = await handleDashIncidentIntake(signed(body({ kind: "incident_repeat" }), { "x-teploy-delivery": "same" }), { runtime, secret: SECRET });
  assert.match(await again.text(), /duplicate delivery/);

  const { runtime: r2, claimed } = memoryRuntime();
  await handleDashIncidentIntake(signed(body({ delivery_id: "from-body" })), { runtime: r2, secret: SECRET });
  assert.deepEqual(claimed, ["from-body:incident_opened"]);
});

test("Dash lifecycle over the wire: opened 201 -> repeat 200 (same record) -> recovered 200 closes it", async () => {
  const { runtime, values } = memoryRuntime();
  const opened = await handleDashIncidentIntake(signed(body(), { "x-teploy-delivery": "d1" }), { runtime, secret: SECRET });
  assert.equal(opened.status, 201);
  const created = (await opened.json()) as { outcome: string; incidentId: string; status: string };
  assert.equal(created.outcome, "created");
  assert.equal(created.status, "attributed");

  const repeat = await handleDashIncidentIntake(signed(body({ kind: "incident_repeat", duration_s: 60 }), { "x-teploy-delivery": "d2" }), { runtime, secret: SECRET });
  assert.equal(repeat.status, 200);
  const repeated = (await repeat.json()) as { outcome: string; incidentId: string };
  assert.equal(repeated.outcome, "refired");
  assert.equal(repeated.incidentId, created.incidentId);

  const up = await handleDashIncidentIntake(
    signed(body({ kind: "incident_recovered", status: "up", message: "200 OK", duration_s: 300 }), { "x-teploy-delivery": "d3" }),
    { runtime, secret: SECRET },
  );
  assert.equal(up.status, 200);
  const closed = (await up.json()) as { outcome: string; status: string };
  assert.equal(closed.outcome, "recovered");
  assert.equal(closed.status, "recovered");
  const record = JSON.parse(values.get(`SHIP_INCIDENT_${created.incidentId}`) ?? "{}") as {
    source?: string;
    dash?: { resolution?: { message: string }; eventCount: number };
  };
  assert.equal(record.source, "dash");
  assert.equal(record.dash?.eventCount, 2);
  assert.equal(record.dash?.resolution?.message, "200 OK");
});

test("Dash test-send: kind test is a 200 ack with no record; retired is resolved; malformed JSON is a 400", async () => {
  const { runtime, values } = memoryRuntime();
  const probe = await handleDashIncidentIntake(signed(body({ kind: "test" }), { "x-teploy-delivery": "t1" }), { runtime, secret: SECRET });
  assert.equal(probe.status, 200);
  assert.match(await probe.text(), /test/);
  assert.equal(values.size, 0);

  await handleDashIncidentIntake(signed(body(), { "x-teploy-delivery": "r1" }), { runtime, secret: SECRET });
  const retired = await handleDashIncidentIntake(signed(body({ kind: "incident_recovered", status: "up", reason: "retired" }), { "x-teploy-delivery": "r2" }), { runtime, secret: SECRET });
  assert.equal(((await retired.json()) as { status: string }).status, "resolved");

  assert.equal((await handleDashIncidentIntake(signed("{nope", { "x-teploy-delivery": "m1" }), { runtime, secret: SECRET })).status, 400);
});
