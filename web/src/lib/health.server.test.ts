import assert from "node:assert/strict";
import { test } from "node:test";

import { handleHealth } from "./health.server.js";
import type { HealthRuntime } from "./health.server.js";
import { shipRuntime } from "./store.server.js";
import { loader } from "../routes/health.js";

/**
 * SHIP-04: /health checked the store only when SHIP_STORE was "nucleus", so on
 * PostgreSQL (production's store, and the install default) it answered 200
 * with "nucleus":"n/a" while the database was down. These pin: the configured
 * store is checked whatever it is, an unreachable one is a 503, and the
 * neutral `store` field travels next to the legacy `nucleus` one.
 */

// Nothing listens on port 1: a refused connection, immediately, no network.
const DEAD_STORE = "postgres://ship@127.0.0.1:1/ship?sslmode=disable";
const ENV_KEYS = ["SHIP_STORE", "NUCLEUS_URL", "SHIP_VERSION"] as const;

async function withEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>): Promise<void> {
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

function fakeRuntime(over: { ping?: () => Promise<void>; workers?: Array<{ lastSeen: string }> } = {}): () => Promise<HealthRuntime> {
  return async () => ({
    ping: over.ping ?? (async () => {}),
    fleet: { list: async () => over.workers ?? [] },
  });
}

test("the route: an unreachable PostgreSQL store is a 503, not a 200 with n/a", async () => {
  await withEnv({ SHIP_STORE: "postgres", NUCLEUS_URL: DEAD_STORE }, async () => {
    const res = await loader();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.store, "unreachable");
    assert.equal(body.store_kind, "postgres");
    assert.equal(body.nucleus, "unreachable", "the legacy field must not say n/a for a configured store");
  });
});

test("a reachable PostgreSQL store reports ok under both names, with the fleet", async () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const res = await handleHealth({
    env: { SHIP_STORE: "postgres" },
    now: () => now,
    runtime: fakeRuntime({ workers: [{ lastSeen: "2026-11-14T11:59:50Z" }, { lastSeen: "2026-11-14T11:00:00Z" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    { status: body.status, store: body.store, store_kind: body.store_kind, nucleus: body.nucleus, worker: body.worker },
    { status: "ok", store: "ok", store_kind: "postgres", nucleus: "ok", worker: "ok (1)" },
  );
});

test("a store that stops answering after boot is a 503 on PostgreSQL and on Nucleus alike", async () => {
  for (const kind of ["postgres", "nucleus"]) {
    const res = await handleHealth({
      env: { SHIP_STORE: kind },
      runtime: fakeRuntime({ ping: async () => { throw new Error("connection refused"); } }),
    });
    assert.equal(res.status, 503, kind);
    const body = await res.json();
    assert.equal(body.store, "unreachable", kind);
    assert.equal(body.nucleus, "unreachable", kind);
  }
});

test("no live worker is reported, never fatal", async () => {
  const res = await handleHealth({ env: { SHIP_STORE: "postgres" }, runtime: fakeRuntime() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).worker, "none");
});

test("the file store is checked too, and keeps the legacy n/a fields", async () => {
  const ok = await handleHealth({ env: {}, runtime: fakeRuntime() });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual({ store: body.store, store_kind: body.store_kind, nucleus: body.nucleus, worker: body.worker }, { store: "ok", store_kind: "file", nucleus: "n/a", worker: "n/a" });
  const down = await handleHealth({ env: {}, runtime: fakeRuntime({ ping: async () => { throw new Error("EACCES"); } }) });
  assert.equal(down.status, 503);
});

test("an unknown store kind is down, not unchecked", async () => {
  const res = await handleHealth({ env: { SHIP_STORE: "mysql" }, runtime: async () => { throw new Error("unknown SHIP_STORE: mysql"); } });
  assert.equal(res.status, 503);
});

test("the version is the shared one: SHIP_VERSION overrides, \"dev\" never shadows a real build", async () => {
  const set = await handleHealth({ env: { SHIP_VERSION: "9.9.9" }, runtime: fakeRuntime() });
  assert.equal((await set.json()).version, "9.9.9");
  // In this checkout there is no dist/VERSION, so the package version answers.
  const dev = await handleHealth({ env: { SHIP_VERSION: "dev" }, runtime: fakeRuntime() });
  assert.notEqual((await dev.json()).version, "dev");
});

test("a store that was down at the first request is retried, not pinned for the process lifetime", async () => {
  await withEnv({ SHIP_STORE: "postgres", NUCLEUS_URL: DEAD_STORE }, async () => {
    const first = shipRuntime();
    await assert.rejects(first);
    const second = shipRuntime();
    assert.notEqual(second, first, "a failed runtime must not be cached");
    await assert.rejects(second);
  });
});
