import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { discoveryEnabled, handleDiscovery } from "./discovery.server.js";
import { DISCOVERY_PATH, ensureInstanceId } from "../../../dist/discovery.js";

/**
 * Programme B — the discovery route's own posture, pinned. Observe holds the
 * equivalent properties with TestDiscoveryAndServiceRoutesAreNotOnIngest-
 * Listener: there, discovery stays off the internet-facing listener. Ship has
 * one listener that is BOTH the dashboard and the webhook-receiver port, so
 * the same default-deny is expressed as: the route refuses (404) until the
 * operator declares the port private with SHIP_DISCOVERY.
 */

const ENV_KEYS = ["SHIP_DISCOVERY", "SHIP_VERSION", "SHIP_DASHBOARD_URL", "SHIP_PUBLIC_URL", "SHIP_DASH_INTAKE_SECRET"] as const;

async function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (over[key] === undefined) delete process.env[key];
    else process.env[key] = over[key];
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("discovery is off unless explicitly enabled", () => {
  assert.equal(discoveryEnabled({}), false);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: "" }), false);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: "0" }), false);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: "off" }), false);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: "1" }), true);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: "on" }), true);
  assert.equal(discoveryEnabled({ SHIP_DISCOVERY: " YES " }), true);
});

test("default deny: the route answers 404 while SHIP_DISCOVERY is off", async () => {
  await withEnv({}, async () => {
    const res = await handleDiscovery({ instanceId: async () => "should-not-be-reached" });
    assert.equal(res.status, 404);
    // Nothing about the 404 confirms discovery exists — same as Observe's
    // ingest listener, which 404s the path rather than explaining.
    assert.equal((await res.json()).title, "not found");
  });
});

test("enabled: the family document is served with no-store and five fields", async () => {
  await withEnv(
    { SHIP_DISCOVERY: "on", SHIP_VERSION: "9.9.9", SHIP_DASHBOARD_URL: "https://ship.internal", SHIP_DASH_INTAKE_SECRET: "s" },
    async () => {
      const res = await handleDiscovery({ instanceId: async () => "id-1" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("content-type"), "application/json");
      const doc = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(doc).sort(), ["capabilities", "dashboard_url", "instance_id", "product", "version"]);
      assert.equal(doc.product, "ship");
      assert.equal(doc.version, "9.9.9");
      assert.equal(doc.instance_id, "id-1");
      assert.equal(doc.dashboard_url, "https://ship.internal");
      assert.deepEqual(doc.capabilities, ["dash_intake"]);
    },
  );
});

test("enabled but the store cannot produce an identity: 503, never a half-made document", async () => {
  await withEnv({ SHIP_DISCOVERY: "on" }, async () => {
    const res = await handleDiscovery({ instanceId: async () => { throw new Error("store down"); } });
    assert.equal(res.status, 503);
  });
});

test("the served instance id is the persisted one across requests", async () => {
  await withEnv({ SHIP_DISCOVERY: "on" }, async () => {
    const rows = new Map<string, string>();
    const store = {
      get: async (key: string) => rows.get(key),
      set: async (key: string, value: string) => {
        rows.set(key, value);
      },
    };
    const byStore = () => ensureInstanceId(store);
    const first = await handleDiscovery({ instanceId: byStore });
    const second = await handleDiscovery({ instanceId: byStore });
    assert.equal(((await first.json()) as { instance_id: string }).instance_id, ((await second.json()) as { instance_id: string }).instance_id);
  });
});

// -- listener-placement pins -------------------------------------------------
//
// The structural guarantees the handler cannot express alone.

test("the layout exempts exactly the discovery path, never a prefix", async () => {
  const source = readFileSync(join(import.meta.dirname, "../routes/_layout.tsx"), "utf8");
  assert.ok(source.includes('path === "/.well-known/teploy.json"'), "the exemption must stay an exact match on the family path");
  assert.ok(!source.includes('startsWith("/.well-known'), "a prefix exemption would open every future path under /.well-known to no-auth");
  // The webhook-receiver families stay the only unauthenticated POST surfaces.
  assert.ok(source.includes('path.startsWith("/hooks/")'));
});

test("the route exists at the [.]-escaped path and wires the handler", async () => {
  // neutron maps a literal dot in a segment through the `[.]` escape; a
  // "cleanup" to .well-known/ or teploy.json.tsx would silently move the
  // route to a path nothing requests (dot-directories are skipped by the
  // route walker; dots in file names split into path segments).
  const source = readFileSync(join(import.meta.dirname, "../routes/[.]well-known/teploy[.]json.tsx"), "utf8");
  assert.ok(source.includes("handleDiscovery"), "the route must serve through the handler, not a copy of it");
  assert.equal(DISCOVERY_PATH, "/.well-known/teploy.json");
});
