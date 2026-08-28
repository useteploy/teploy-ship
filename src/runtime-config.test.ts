import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileRuntimeConfig,
  MemoryRuntimeConfig,
  NucleusRuntimeConfig,
  RUNTIME_CONFIG_COLUMNS,
  resolveConfigValue,
  sameResolvedValue,
  seal,
  unseal,
} from "./runtime-config.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import { AKIROO_TOKEN_KEY, AKIROO_URL_KEY, normalizeAkirooBase, resolveAkirooTarget } from "./akiroo.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

async function withStore(fn: (store: RuntimeConfigStore) => Promise<void>): Promise<void> {
  await fn(new MemoryRuntimeConfig());
}

// --- the precedence rule, both directions ------------------------------------

test("a runtime value wins over the environment variable of the same name", async () => {
  await withStore(async (store) => {
    await store.set("AKIROO_URL", "https://lite.akiroo.com");
    assert.deepEqual(await resolveConfigValue(store, "AKIROO_URL", env({ AKIROO_URL: "https://stale.example" })), {
      value: "https://lite.akiroo.com",
      source: "runtime",
    });
  });
});

test("the environment is used when the runtime value is absent, empty, or whitespace", async () => {
  await withStore(async (store) => {
    const fromEnv = env({ AKIROO_URL: "https://from-the-manifest.example" });

    // Never written.
    assert.deepEqual(await resolveConfigValue(store, "AKIROO_URL", fromEnv), {
      value: "https://from-the-manifest.example",
      source: "env",
    });

    // Written and then cleared — an empty override must not shadow the
    // environment, or "disconnect" would read as "connector broken".
    await store.set("AKIROO_URL", "https://was-here.example");
    await store.set("AKIROO_URL", "   ");
    assert.deepEqual(await resolveConfigValue(store, "AKIROO_URL", fromEnv), {
      value: "https://from-the-manifest.example",
      source: "env",
    });
  });
});

test("neither side set reports unset with an empty value", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await resolveConfigValue(store, "AKIROO_URL", env({})), { value: "", source: "unset" });
    assert.deepEqual(await resolveConfigValue(store, "AKIROO_URL", env({ AKIROO_URL: "  " })), {
      value: "",
      source: "unset",
    });
  });
});

test("resolution trims both sides, so a pasted value with a newline still matches", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_TOKEN_KEY, " ship_pull_abc\n");
    const resolved = await resolveConfigValue(store, AKIROO_TOKEN_KEY, env({}));
    assert.deepEqual(resolved, { value: "ship_pull_abc", source: "runtime" });
  });
});

// --- the Akiroo pair rule (a value pair, not two values) ---------------------

test("the Akiroo target resolves as a pair: runtime wins when it holds both", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com/");
    await store.set(AKIROO_TOKEN_KEY, "ship_pull_new");
    const r = await resolveAkirooTarget(
      store,
      env({ AKIROO_URL: "https://old.example", AKIROO_PULL_TOKEN: "ship_pull_old" }),
    );
    assert.equal(r.status, "runtime");
    assert.deepEqual(r.target, { url: "https://lite.akiroo.com", token: "ship_pull_new" });
    assert.equal(r.url.source, "runtime");
    assert.equal(r.token.source, "runtime");
  });
});

test("the Akiroo target falls back to the environment when the store holds neither", async () => {
  await withStore(async (store) => {
    const r = await resolveAkirooTarget(
      store,
      env({ AKIROO_URL: "https://lite.akiroo.com/", AKIROO_PULL_TOKEN: " ship_pull_env " }),
    );
    assert.equal(r.status, "env");
    assert.deepEqual(r.target, { url: "https://lite.akiroo.com", token: "ship_pull_env" });
    assert.equal(r.url.source, "env");
    assert.equal(r.token.source, "env");
  });
});

/**
 * The reason the precedence is resolved per PAIR and not per value. Applying it
 * independently pairs the freshly connected workspace's URL with the previous
 * workspace's environment token, and Ship then posts a live pull token to a
 * host it was never issued for, every five seconds, with nothing in the logs
 * that looks wrong.
 */
test("a runtime URL never pairs with an environment token", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_URL_KEY, "https://attacker.example");
    const r = await resolveAkirooTarget(store, env({ AKIROO_PULL_TOKEN: "ship_pull_victim" }));
    assert.equal(r.status, "misconfigured");
    assert.equal(r.target, undefined, "a mixed pair must not produce a pollable target");
    assert.match(r.reason ?? "", /must not be sent to another/);
    assert.doesNotMatch(r.reason ?? "", /ship_pull_victim/, "the reason is operator-facing and must not carry the token");
  });
});

test("a runtime token never pairs with an environment URL", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_TOKEN_KEY, "ship_pull_new");
    const r = await resolveAkirooTarget(store, env({ AKIROO_URL: "https://old.example" }));
    assert.equal(r.status, "misconfigured");
    assert.equal(r.target, undefined);
  });
});

test("half a connector is misconfigured, not unset — and none at all is unset", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com");
    const half = await resolveAkirooTarget(store, env({}));
    assert.equal(half.status, "misconfigured");
    assert.match(half.reason ?? "", /AKIROO_PULL_TOKEN is not set/);

    await store.remove(AKIROO_URL_KEY);
    const none = await resolveAkirooTarget(store, env({}));
    assert.equal(none.status, "unset");
    assert.equal(none.reason, undefined);
  });
});

// --- the stored base is re-validated on every resolve ------------------------

test("normalizeAkirooBase accepts only plain http(s) origins", () => {
  assert.equal(normalizeAkirooBase("https://lite.akiroo.com/"), "https://lite.akiroo.com");
  // A tailnet Akiroo is a first-class deployment; a private-address blocklist
  // here would refuse the main legitimate case.
  assert.equal(normalizeAkirooBase("http://100.108.123.49:7460"), "http://100.108.123.49:7460");
  assert.equal(normalizeAkirooBase("https://host.example/akiroo"), "https://host.example/akiroo");

  assert.equal(normalizeAkirooBase("javascript:alert(1)"), null);
  assert.equal(normalizeAkirooBase("data:text/html,x"), null);
  assert.equal(normalizeAkirooBase("file:///etc/passwd"), null);
  // Displays as one host, authenticates as something else.
  assert.equal(normalizeAkirooBase("https://user:pass@lite.akiroo.com"), null);
  assert.equal(normalizeAkirooBase("not a url"), null);
  assert.equal(normalizeAkirooBase("   "), null);
});

test("a stored base that is not http(s) refuses to poll rather than being sent a token", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_URL_KEY, "file:///etc/passwd");
    await store.set(AKIROO_TOKEN_KEY, "ship_pull_new");
    const r = await resolveAkirooTarget(store, env({}));
    assert.equal(r.status, "misconfigured");
    assert.equal(r.target, undefined);
    assert.match(r.reason ?? "", /http\(s\)/);
  });
});

// --- source reporting is what makes the override visible ---------------------

test("resolution reports which side won for each value independently", async () => {
  await withStore(async (store) => {
    await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com");
    await store.set(AKIROO_TOKEN_KEY, "ship_pull_new");
    const r = await resolveAkirooTarget(store, env({ AKIROO_URL: "https://old.example" }));
    // Both from the store — and the Settings page can say so for each row,
    // which is the whole point: an override nobody can see costs an hour.
    assert.deepEqual(
      { url: r.url.source, token: r.token.source },
      { url: "runtime", token: "runtime" },
    );
  });
});

test("sameResolvedValue distinguishes a rotation from a no-change", () => {
  assert.equal(sameResolvedValue({ value: "a", source: "env" }, { value: "a", source: "env" }), true);
  assert.equal(sameResolvedValue({ value: "a", source: "env" }, { value: "a", source: "runtime" }), false);
  assert.equal(sameResolvedValue({ value: "a", source: "env" }, { value: "ab", source: "env" }), false);
});

// --- at rest -----------------------------------------------------------------

test("a sealed value round-trips, and looks nothing like the plaintext at rest", () => {
  const keyed = env({ SHIP_CONFIG_KEY: "an-install-wide-config-key" });
  const sealed = seal("ship_pull_secret", keyed);
  assert.notEqual(sealed, "ship_pull_secret");
  assert.ok(sealed.startsWith("enc:v1:"));
  assert.doesNotMatch(sealed, /ship_pull_secret/);
  assert.equal(unseal(sealed, keyed), "ship_pull_secret");

  // Two writes of the same value differ: a random IV per write, so an observer
  // of the table cannot tell that two orgs share a token.
  assert.notEqual(seal("ship_pull_secret", keyed), sealed);
});

test("without SHIP_CONFIG_KEY values are stored as they are today, and pass through unchanged", () => {
  const bare = env({});
  assert.equal(seal("ship_pull_secret", bare), "ship_pull_secret");
  assert.equal(unseal("ship_pull_secret", bare), "ship_pull_secret");
});

/**
 * A rotated key must NOT hand the ciphertext back as if it were the token —
 * Akiroo would answer 401 and the operator would rotate the pull token, which
 * is the one credential that is not the problem.
 */
test("a sealed value that cannot be opened throws instead of degrading", () => {
  const sealed = seal("ship_pull_secret", env({ SHIP_CONFIG_KEY: "original" }));
  assert.throws(() => unseal(sealed, env({ SHIP_CONFIG_KEY: "rotated" })), /SHIP_CONFIG_KEY was rotated/);
  assert.throws(() => unseal(sealed, env({})), /SHIP_CONFIG_KEY is not set/);
});

test("the file store seals AKIROO_PULL_TOKEN on disk and reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-config-"));
  const keyed = env({ SHIP_CONFIG_KEY: "an-install-wide-config-key" });
  const store = new FileRuntimeConfig(dir, keyed);
  await store.set(AKIROO_TOKEN_KEY, "ship_pull_secret", "tyler");
  await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com", "tyler");

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(dir, "runtime-config.json"), "utf8");
  assert.doesNotMatch(raw, /ship_pull_secret/, "the token must not be on disk in the clear");
  // The URL is not a credential and stays legible, which is what makes a
  // misdirected connector diagnosable by looking at the file.
  assert.match(raw, /lite\.akiroo\.com/);

  assert.equal(await store.get(AKIROO_TOKEN_KEY), "ship_pull_secret");
  assert.equal(await store.get(AKIROO_URL_KEY), "https://lite.akiroo.com");
});

/**
 * S3: nothing that enumerates the store may carry a value. list() is the only
 * surface a generic status or debug route would reach for, so it returns
 * metadata and a boolean; reading a secret requires naming its key.
 */
test("list reports which keys are set, and never their values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-config-"));
  const store = new FileRuntimeConfig(dir, env({}));
  await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com", "tyler");
  await store.set(AKIROO_TOKEN_KEY, "ship_pull_secret", "akiroo-connect");

  const rows = await store.list();
  assert.deepEqual(
    rows.map((r) => r.key),
    [AKIROO_TOKEN_KEY, AKIROO_URL_KEY],
  );
  assert.deepEqual(
    rows.map((r) => r.set),
    [true, true],
  );
  assert.deepEqual(rows.find((r) => r.key === AKIROO_TOKEN_KEY)?.updatedBy, "akiroo-connect");
  assert.doesNotMatch(JSON.stringify(rows), /ship_pull_secret|lite\.akiroo\.com/);
});

test("setting an empty value removes the override rather than shadowing the environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-config-"));
  const store = new FileRuntimeConfig(dir, env({}));
  await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com");
  await store.set(AKIROO_URL_KEY, "");
  assert.equal(await store.get(AKIROO_URL_KEY), undefined);
  assert.deepEqual(await store.list(), []);
});

// --- the Nucleus half --------------------------------------------------------

/** Enough of NucleusPgwire to record SQL and serve one keyed row back. */
function fakeDb(): NucleusPgwire & { sql: string[] } {
  const rows: Array<Record<string, unknown>> = [];
  const sql: string[] = [];
  const db = {
    sql,
    async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (/^CREATE TABLE/i.test(text)) return [];
      if (/^INSERT INTO ship_runtime_config/i.test(text)) {
        rows.push({
          config_key: params[0],
          config_value: params[1],
          updated_at: params[2],
          updated_by: params[3],
        });
        return [];
      }
      if (/^UPDATE ship_runtime_config/i.test(text)) {
        const row = rows.find((r) => r.config_key === params[3]);
        if (row !== undefined) {
          row.config_value = params[0];
          row.updated_at = params[1];
          row.updated_by = params[2];
        }
        return [];
      }
      if (/^DELETE FROM ship_runtime_config/i.test(text)) {
        const at = rows.findIndex((r) => r.config_key === params[0]);
        if (at >= 0) rows.splice(at, 1);
        return [];
      }
      if (/WHERE config_key = \$1/i.test(text)) {
        return rows.filter((r) => r.config_key === params[0]);
      }
      return [...rows];
    },
    kv: { setNX: async (): Promise<boolean> => true, cdel: async (): Promise<boolean> => true },
  };
  return db as unknown as NucleusPgwire & { sql: string[] };
}

test("the Nucleus store creates its own table and upserts by config_key", async () => {
  const db = fakeDb();
  const store = new NucleusRuntimeConfig(db, env({}));
  await store.set(AKIROO_URL_KEY, "https://lite.akiroo.com", "tyler");
  await store.set(AKIROO_URL_KEY, "https://other.akiroo.example", "tyler");
  assert.equal(await store.get(AKIROO_URL_KEY), "https://other.akiroo.example");
  assert.deepEqual((await store.list()).map((r) => r.key), [AKIROO_URL_KEY], "the second write must not add a twin");

  const joined = db.sql.join("\n");
  // A NEW table, per the house rule: Nucleus cannot ALTER-ADD a column to a
  // populated one, so runtime config never rides on ship_docs or ship_tasks.
  assert.match(joined, /CREATE TABLE IF NOT EXISTS ship_runtime_config/);
  assert.doesNotMatch(joined, /ALTER TABLE/i);
});

test("the store DDL and the migration probe agree on the column list", () => {
  assert.deepEqual(RUNTIME_CONFIG_COLUMNS, ["config_key", "config_value", "updated_at", "updated_by"]);
});
