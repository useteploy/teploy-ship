import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_CLOCK_SKEW_MS, defaultProbes, formatDoctor, nucleusProbes, renderDoctor, runDoctor } from "./install-doctor.js";
import type { DoctorProbes, StoreQueryClient } from "./install-doctor.js";

// Fake secrets assembled at runtime so no secret-shaped literal sits in source.
const FAKE_WEB_TOKEN = "webtok" + "-" + "Zq9".repeat(8);
const FAKE_MODEL_KEY = "sk" + "-" + "c3".repeat(20);
const FAKE_DB_PASSWORD = "hunter" + "2".repeat(6) + "pw";
const FAKE_GH = "ghp" + "_" + "d4".repeat(20);

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function allGood(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: "v22.1.0",
    env: { SHIP_WEB_TOKEN: FAKE_WEB_TOKEN, ANTHROPIC_API_KEY: FAKE_MODEL_KEY, NUCLEUS_URL: `postgres://ship:${FAKE_DB_PASSWORD}@db.internal:5432/ship` },
    stateDir: "/var/lib/ship",
    webPort: 7460,
    writeProbe: async () => {},
    freeMb: async () => 50_000,
    portState: async () => "free",
    storeReachable: async () => true,
    nowMs: NOW,
    referenceMs: async () => NOW + 1000,
    ...over,
  };
}

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

test("every probe answering well is the only way to be ready", async () => {
  const r = await runDoctor(allGood());
  assert.equal(r.verdict, "ready");
  assert.equal(r.counts.fail + r.counts.unknown, 0);
});

test("unknown is not pass: no probes at all is incomplete, never ready", async () => {
  const r = await runDoctor({ nodeVersion: "v22.0.0", env: { SHIP_WEB_TOKEN: "x", ANTHROPIC_API_KEY: "y" }, stateDir: "/x", webPort: 1, nowMs: NOW });
  assert.equal(r.verdict, "incomplete");
  for (const id of ["state-dir-writable", "state-dir-space", "web-port", "store-connectivity", "clock"]) {
    assert.equal(byId(r, id).status, "unknown", id);
    assert.ok(byId(r, id).remedy);
  }
});

test("a throwing free-space or port probe is unknown, not pass", async () => {
  const r = await runDoctor(
    allGood({
      freeMb: async () => {
        throw new Error("boom");
      },
      portState: async () => {
        throw new Error("boom");
      },
      referenceMs: async () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(byId(r, "state-dir-space").status, "unknown");
  assert.equal(byId(r, "web-port").status, "unknown");
  assert.equal(byId(r, "clock").status, "unknown");
  assert.equal(r.verdict, "incomplete");
});

test("each failure mode is reported as fail with a remedy", async () => {
  const r = await runDoctor(
    allGood({
      nodeVersion: "v18.19.0",
      writeProbe: async () => {
        throw new Error("EACCES");
      },
      freeMb: async () => 10,
      portState: async () => "in-use",
      env: { NUCLEUS_URL: "mysql://h/db" },
      storeReachable: async () => false,
      referenceMs: async () => NOW + MAX_CLOCK_SKEW_MS + 1,
    }),
  );
  for (const id of ["node-version", "state-dir-writable", "state-dir-space", "web-port", "env-web-token", "env-model-credential", "store-url", "store-connectivity", "clock"]) {
    assert.equal(byId(r, id).status, "fail", id);
    assert.ok(byId(r, id).remedy, `${id} remedy`);
  }
  assert.equal(r.verdict, "not-ready");
});

test("an unset clock fails regardless of any reference", async () => {
  const r = await runDoctor(allGood({ nowMs: 0, referenceMs: async () => 0 }));
  assert.equal(byId(r, "clock").status, "fail");
});

test("store url shape passing does not imply connectivity passing", async () => {
  const r = await runDoctor(allGood({ storeReachable: undefined }));
  assert.equal(byId(r, "store-url").status, "pass");
  assert.equal(byId(r, "store-connectivity").status, "unknown");
  assert.equal(r.verdict, "incomplete");
});

test("no NUCLEUS_URL is a valid local install but connectivity stays unknown", async () => {
  const r = await runDoctor(allGood({ env: { SHIP_WEB_TOKEN: "t", AI_GATEWAY_URL: "https://gw.example" } }));
  assert.equal(byId(r, "store-url").status, "pass");
  assert.equal(byId(r, "store-connectivity").status, "unknown");
});

test("empty / whitespace env values count as missing", async () => {
  const r = await runDoctor(allGood({ env: { SHIP_WEB_TOKEN: "  ", ANTHROPIC_API_KEY: "" } }));
  assert.equal(byId(r, "env-web-token").status, "fail");
  assert.equal(byId(r, "env-model-credential").status, "fail");
});

test("NEGATIVE CONTROL: planted secrets never appear in JSON or text output", async () => {
  const leaky = allGood({
    // an error that quotes a credential, and an unparseable URL carrying one
    writeProbe: async () => {
      throw new Error(`write failed using ${FAKE_GH} at postgres://ship:${FAKE_DB_PASSWORD}@h/db`);
    },
  });
  const r = await runDoctor(leaky);
  const json = renderDoctor(r);
  const text = formatDoctor(r);
  for (const secret of [FAKE_WEB_TOKEN, FAKE_MODEL_KEY, FAKE_DB_PASSWORD, FAKE_GH]) {
    assert.ok(!json.json.includes(secret), `json leaked ${secret.slice(0, 6)}`);
    assert.ok(!text.includes(secret), `text leaked ${secret.slice(0, 6)}`);
  }
  assert.ok(json.redactions >= 1, "the gate actually fired on the leaky error");
  assert.doesNotThrow(() => JSON.parse(json.json));
});

test("env values are never in the report even before redaction", async () => {
  const raw = JSON.stringify(await runDoctor(allGood()));
  for (const secret of [FAKE_WEB_TOKEN, FAKE_MODEL_KEY, FAKE_DB_PASSWORD]) assert.ok(!raw.includes(secret));
});

test("unparseable NUCLEUS_URL detail does not echo the input", async () => {
  const r = await runDoctor(allGood({ env: { SHIP_WEB_TOKEN: "t", ANTHROPIC_API_KEY: "k", NUCLEUS_URL: `://${FAKE_DB_PASSWORD}` } }));
  assert.equal(byId(r, "store-url").status, "fail");
  assert.ok(!JSON.stringify(r).includes(FAKE_DB_PASSWORD));
});

test("real probes: writable temp dir passes, scratch file is removed, port probe sees a listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const busy = (srv.address() as { port: number }).port;
  try {
    const base = { env: {}, stateDir: dir, webPort: busy, nodeVersion: process.version };
    const p = defaultProbes(base);
    const r = await runDoctor(p);
    assert.equal(byId(r, "state-dir-writable").status, "pass");
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(byId(r, "web-port").status, "fail");
    assert.ok(["pass", "fail"].includes(byId(r, "state-dir-space").status), "statfs gave a real answer");
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real write probe against an unwritable path fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  try {
    // A regular file as the parent makes mkdir fail with ENOTDIR on any platform and for root.
    writeFileSync(join(dir, "afile"), "x");
    const p = defaultProbes({ env: {}, stateDir: join(dir, "afile", "ship"), webPort: 0, nodeVersion: process.version });
    const r = await runDoctor(p);
    assert.equal(byId(r, "state-dir-writable").status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// nucleusProbes — the live store probes doctorCommand injects with NUCLEUS_URL
// ---------------------------------------------------------------------------

/** A fake store client: answers per-SQL, so the probes' read-only surface is pinned. */
function fakeClient(behavior: { sql?: (sql: string) => unknown; error?: (sql: string) => Error | undefined }): StoreQueryClient {
  return {
    async query(sql: string) {
      const error = behavior.error?.(sql);
      if (error !== undefined) throw error;
      const value = behavior.sql?.(sql);
      return value === undefined ? [] : [{ t: value }];
    },
    async close() {},
  };
}

test("nucleusProbes: liveness is SELECT 1, answered true, unanswered false — never unknown-pass", async () => {
  const probes = nucleusProbes("postgres://store:5432/ship", { connect: () => fakeClient({}) });
  assert.equal(await probes.storeReachable("postgres://store:5432/ship"), true, "a store that answers SELECT 1 is reachable");

  const dead = nucleusProbes("postgres://store:5432/ship", {
    connect: () => fakeClient({ error: () => new Error("ECONNREFUSED") }),
  });
  assert.equal(await dead.storeReachable("postgres://store:5432/ship"), false, "a store that does not answer is fail, not unknown");
});

test("nucleusProbes: the store's clock is the reference — Date, epoch-number and ISO string all parse", async () => {
  const ref = NOW - 2_000;
  const byDate = nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: () => new Date(ref) }) });
  const byNumber = nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: () => ref }) });
  const byString = nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: () => new Date(ref).toISOString() }) });
  assert.equal(await byDate.referenceMs(), ref);
  assert.equal(await byNumber.referenceMs(), ref);
  assert.equal(await byString.referenceMs(), ref);
});

test("nucleusProbes: a store without a time query degrades the clock to unknown, never a guess", async () => {
  const noTime = nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: (sql) => (sql.includes("now()") ? "not-a-time" : undefined) }) });
  assert.equal(await noTime.referenceMs(), undefined);
  const throwing = nucleusProbes("postgres://s/x", { connect: () => fakeClient({ error: (sql) => (sql.includes("now()") ? new Error("unknown function") : undefined) }) });
  assert.equal(await throwing.referenceMs(), undefined);

  // And doctor reports that honestly: reachable store, clock unknown.
  const r = await runDoctor(allGood({ ...nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: (sql) => (sql.includes("now()") ? "not-a-time" : undefined) }) }) }));
  assert.equal(byId(r, "store-connectivity").status, "pass");
  assert.equal(byId(r, "clock").status, "unknown");
  assert.equal(r.verdict, "incomplete");
});

test("nucleusProbes wired through runDoctor: an answering store with its clock is ready; a silent store fails connectivity", async () => {
  const good = await runDoctor(allGood({ ...nucleusProbes("postgres://s/x", { connect: () => fakeClient({ sql: () => new Date(NOW + 1000) }) }) }));
  assert.equal(good.verdict, "ready");
  assert.equal(byId(good, "store-connectivity").status, "pass");
  assert.equal(byId(good, "clock").status, "pass");

  const silent = await runDoctor(
    allGood({
      ...nucleusProbes("postgres://s/x", { connect: () => fakeClient({ error: () => new Error("connection refused") }) }),
    }),
  );
  assert.equal(byId(silent, "store-connectivity").status, "fail");
  assert.equal(byId(silent, "clock").status, "unknown");
  assert.equal(silent.verdict, "not-ready");
});
