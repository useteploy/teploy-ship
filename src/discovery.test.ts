import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCOVERY_PATH,
  INSTANCE_ID_KEY,
  discoveryCapabilities,
  discoveryDashboardURL,
  discoveryDoc,
  ensureInstanceId,
} from "./discovery.js";

/**
 * Programme B — the discovery document is a contract with Dash, so its shape,
 * its never-guess URL rule, its no-secrets posture and its persisted
 * instance id are each pinned here (mirroring Observe's discovery_test.go).
 */

test("the document has exactly the five family fields and names ship", () => {
  const doc = discoveryDoc({ SHIP_VERSION: "0.4.0" }, "abc123");
  assert.equal(doc.product, "ship");
  assert.deepEqual(Object.keys(doc).sort(), ["capabilities", "dashboard_url", "instance_id", "product", "version"]);
  assert.equal(doc.version, "0.4.0");
  assert.equal(doc.instance_id, "abc123");
});

test("version falls back to dev rather than an empty string", () => {
  assert.equal(discoveryDoc({}, "x").version, "dev");
  assert.equal(discoveryDoc({ SHIP_VERSION: "  " }, "x").version, "dev");
});

test("the path constant is the family path", () => {
  assert.equal(DISCOVERY_PATH, "/.well-known/teploy.json");
});

test("dashboard_url is never guessed", () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; want: string }> = [
    { name: "nothing configured", env: {}, want: "" },
    { name: "only unrelated URLs configured", env: { AI_GATEWAY_URL: "https://gw", OBSERVE_URL: "https://observe" }, want: "" },
    { name: "public url is the dashboard on ship's one listener", env: { SHIP_PUBLIC_URL: "https://ship.example.com" }, want: "https://ship.example.com" },
    { name: "dedicated dashboard url wins over public url", env: { SHIP_DASHBOARD_URL: "http://100.1.2.3:7460", SHIP_PUBLIC_URL: "https://hooks.example.com" }, want: "http://100.1.2.3:7460" },
    { name: "public url alone with a dedicated empty value", env: { SHIP_DASHBOARD_URL: "  ", SHIP_PUBLIC_URL: "https://ship.example.com/" }, want: "https://ship.example.com" },
    { name: "trailing slashes are stripped, not published", env: { SHIP_PUBLIC_URL: "https://ship.example.com///" }, want: "https://ship.example.com" },
  ];
  for (const tc of cases) {
    assert.equal(discoveryDashboardURL(tc.env), tc.want, tc.name);
    assert.equal(discoveryDoc(tc.env, "x").dashboard_url, tc.want, tc.name);
  }
});

test("dash_intake is advertised only while the dash intake secret is armed", () => {
  assert.deepEqual(discoveryCapabilities({}), []);
  assert.deepEqual(discoveryCapabilities({ SHIP_DASH_INTAKE_SECRET: "  " }), []);
  assert.deepEqual(discoveryCapabilities({ SHIP_DASH_INTAKE_SECRET: "s3cret" }), ["dash_intake"]);
});

test("the serialized document carries no credential from the environment", () => {
  const env: NodeJS.ProcessEnv = {
    SHIP_WEB_TOKEN: "master-token",
    SHIP_DASH_INTAKE_SECRET: "dash-secret",
    SHIP_INCIDENT_INTAKE_SECRET: "observe-secret",
    SHIP_WEBHOOK_SECRET: "hook-secret",
    OBSERVE_API_KEY: "obs-key",
    OBSERVE_SERVICE_TOKEN: "obs_svc_zzz",
    OBSERVE_READ_TOKEN: "share-token",
    SHIP_PUBLIC_URL: "https://ship.example.com",
  };
  const wire = JSON.stringify(discoveryDoc(env, "id1"));
  for (const secret of ["master-token", "dash-secret", "observe-secret", "hook-secret", "obs-key", "obs_svc_zzz", "share-token"]) {
    assert.ok(!wire.includes(secret), `document must not carry ${secret}`);
  }
});

// ------------------------------------------------------------- instance id

/** Minimal in-memory InstanceIdStore: get/set over a Map, like the real one. */
function memoryStore(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key),
    set: async (key: string, value: string, updatedBy?: string) => {
      void updatedBy;
      rows.set(key, value);
    },
  };
}

test("instance id is generated once, persisted, and stable across later calls", async () => {
  const store = memoryStore();
  const first = await ensureInstanceId(store, () => "generated-id");
  assert.equal(first, "generated-id");
  assert.equal(store.rows.get(INSTANCE_ID_KEY), "generated-id");
  // A LATER call (a restarted process) must return the stored id, not a new one.
  const second = await ensureInstanceId(store, () => "a-different-id");
  assert.equal(second, "generated-id");
});

test("a concurrent writer's stored value wins on read-back", async () => {
  // The set() lands, but another process wrote first and the store kept its
  // row: the read-back must adopt the stored value so both processes agree.
  const store = memoryStore();
  store.set = async (key: string, value: string) => {
    void value;
    if (!store.rows.has(key)) store.rows.set(key, "their-id");
  };
  const id = await ensureInstanceId(store, () => "my-id");
  assert.equal(id, "their-id");
});

test("a blank stored id is regenerated, and an unreadable write-back refuses", async () => {
  const blank = memoryStore({ [INSTANCE_ID_KEY]: "   " });
  assert.equal(await ensureInstanceId(blank, () => "fresh"), "fresh");

  const lying = memoryStore();
  lying.set = async () => {};
  await assert.rejects(() => ensureInstanceId(lying, () => "x"), /not readable/);
});

test("the generated id is 32 hex chars", async () => {
  const store = memoryStore();
  const id = await ensureInstanceId(store);
  assert.match(id, /^[0-9a-f]{32}$/);
});
