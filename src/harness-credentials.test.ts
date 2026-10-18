import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentOutput, ExecutorProvider } from "./durable.js";
import { HARNESS_VERSIONS } from "./harness.js";
import { externalAdapters, shq } from "./harness-external.js";
import { FileHarnessCredentials, MemoryHarnessCredentials, NucleusHarnessCredentials, admitHarnessCredentials, harnessCredentialResolver, harnessDestinationCheck, profileCredentialNames, resolveCredentialOverlay } from "./harness-credentials.js";
import type { HarnessCredentialRef } from "./harness-credentials.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";
import { threadWarmStore } from "./thread-warm.js";
import { stepFingerprint } from "./step-fingerprint.js";
import { checkDestinationHost } from "./model-routing.js";
import { FileProjectStore } from "./projects.js";

/**
 * H2 (SHIP_HARNESS_CRED) — the sealed per-project harness credential store,
 * the two enqueue gates, and the worker-side delivery. Negative controls per
 * the slice row: a missing credential refused at enqueue BY NAME with no run
 * appended; a destination outside the routing policy refused; a stored value
 * absent from the recorded input, the event log and the live feed of a full
 * fake run that prints it; storing refused while encryption is unset; flag
 * off byte-identical. The production ensemble this must not break —
 * claude-code rerouted to api.z.ai under policy 2026-10-16.1 with
 * SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai — is pinned as its own test.
 */

const SEAL_ENV = { SHIP_CONFIG_KEY: "h2-test-config-key" };

// ------------------------------------------------------------- policy fixture

/** The production policy's shape (2026-10-16.1): api.z.ai, retention none. */
function policyFile(entries: Array<{ host: string; class: string; retention: string; model?: string }>): Promise<string> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-h2-policy-"));
    const path = join(dir, "policy.json");
    const doc = {
      schemaVersion: 1,
      version: "2026-10-16.1",
      roles: {
        worker: entries.map((e, i) => ({
          model: e.model ?? `vendor/model-${i}`,
          effort: "medium",
          capabilities: ["tools"],
          dataDestination: { host: e.host, class: e.class },
          retention: e.retention,
          maxContext: 200000,
        })),
      },
    };
    await writeFile(path, JSON.stringify(doc, null, 2));
    return path;
  })();
}

const ZAI_ONLY = [{ host: "api.z.ai", class: "hosted", retention: "none" }] as const;

// ------------------------------------------------------------------ env control

/** Every env var the gate, the derivation or the enqueue path could read. */
const H2_ENV = [
  "SHIP_HARNESS_CRED",
  "SHIP_CONFIG_KEY",
  "SHIP_MODEL_ROUTING",
  "SHIP_MODEL_ROUTING_POLICY",
  "SHIP_MODEL_ROUTING_DESTINATIONS",
  "SHIP_MODEL_ROUTING_DATA_CLASS",
  "SHIP_MODEL_ROUTING_MAX_RETENTION",
  "SHIP_HARNESS",
  "SHIP_HARNESS_ENV",
  "SHIP_HARNESS_MODEL",
  "SHIP_HARNESS_MODEL_CLAUDE_CODE",
  "SHIP_HARNESS_MODEL_OPENCODE",
  "SHIP_HARNESS_MODEL_CODEX",
  "SHIP_HARNESS_ATTEMPTS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "ZHIPU_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENCODE_CONFIG_CONTENT",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "AI_GATEWAY_URL",
  "AI_GATEWAY_KEY",
  // Noise that would move unrelated input fields between the two enqueues of
  // a byte-identity comparison.
  "SHIP_TESTS",
  "SHIP_TELEMETRY",
  "SHIP_PREVIEW",
  "SHIP_TEST_DETECT",
  "SHIP_STACK_DETECT",
  "SHIP_PREVIEW_TAILNET_IP",
  "SHIP_PREVIEW_MAIN_URL",
  "SHIP_HARNESS_RECORD",
  "SHIP_WARM_CACHE",
  "SHIP_LOOK",
  "SHIP_DELEGATE",
  "SHIP_STEER_REPLY",
  "SHIP_MCP",
  "SHIP_SKILLS",
  "SHIP_CHANGE_CLASS",
  "SHIP_INCIDENT_FIX",
] as const;

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const names = [...H2_ENV, ...Object.keys(values)];
  for (const k of names) {
    saved[k] = process.env[k];
    if (!(k in values)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

type Started = { type: string; data: Record<string, unknown> };

/** Enqueue under a controlled env against a fake runtime; records what append saw. */
async function enqueue(
  env: Record<string, string | undefined>,
  run: { runId: string; repo?: string },
  opts?: { projectStore?: FileProjectStore; credentials?: ShipRuntime["harnessCredentials"] },
): Promise<{ json: () => string; started: Started[] }> {
  const started: Started[] = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: opts?.projectStore ?? { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    ...(opts?.credentials !== undefined ? { harnessCredentials: opts.credentials } : {}),
    store: {
      append: async (_runId: string, event: Started) => {
        if (event.type === "run-started") started.push(event);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  await withEnv(env, async () => {
    await enqueueRun(runtime, {
      runId: run.runId,
      task: "t",
      model: "m",
      ...(run.repo !== undefined ? { repo: run.repo } : {}),
    });
  });
  return { json: () => JSON.stringify(started[0]?.data.input as Record<string, unknown>), started };
}

function inputOf(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

// ------------------------------------------------------------------ the store

test("store: set/presence/resolve roundtrip, versions never reused, sealed at rest, clear removes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-store-"));
  const store = new FileHarnessCredentials(dir, SEAL_ENV);
  const first = await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: " sk-ant-STORED-ONE ", actor: "tyler" });
  assert.equal(first.version, 1, "first store is version 1");
  assert.equal(first.setBy, "tyler");
  const second = await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-STORED-TWO", actor: "tyler" });
  assert.equal(second.version, 2, "a rewrite bumps the version; a recorded reference keeps naming the old one");
  assert.deepEqual(
    (await store.presence("tyler/repo")).map((p) => [p.profile, p.envName, p.version]),
    [["claude-code", "ANTHROPIC_API_KEY", 2]],
  );
  assert.deepEqual(await store.presence("other/repo"), [], "bindings are per project");
  assert.deepEqual(await store.resolve("tyler/repo", "claude-code", "ANTHROPIC_API_KEY"), { value: "sk-ant-STORED-TWO", version: 2 }, "trimmed on store, like runtime-config");
  // Sealed at rest: the state file carries ciphertext, never the value.
  const raw = await readFile(join(dir, "harness-credentials.json"), "utf8");
  assert.ok(!raw.includes("sk-ant-STORED"), "no value in the state file");
  assert.ok(raw.includes("enc:v1:"), "the row is sealed");
  await store.clear({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY" });
  assert.deepEqual(await store.presence("tyler/repo"), []);
  assert.equal(await store.resolve("tyler/repo", "claude-code", "ANTHROPIC_API_KEY"), undefined);
  const afterClear = await readFile(join(dir, "harness-credentials.json"), "utf8");
  assert.ok(!afterClear.includes("enc:v1:"), "clear leaves no ciphertext behind");
  assert.ok(!afterClear.includes("sk-ant-STORED"), "and no value either");
  // S4: the clear leaves a TOMBSTONE, so the next store cannot restart the
  // version count at 1 — a version an earlier run's input still names must
  // never be minted twice.
  const third = await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-STORED-THREE", actor: "tyler" });
  assert.equal(third.version, 3, "the tombstone's version still counts");
});

test("store: S4 NEGATIVE CONTROL — overlapping sets mint distinct versions, never a duplicate", async () => {
  for (const store of [new FileHarnessCredentials(await mkdtemp(join(tmpdir(), "ship-h2-race-")), SEAL_ENV), new MemoryHarnessCredentials(SEAL_ENV)]) {
    const both = await Promise.all([
      store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-RACE-ONE", actor: "tyler" }),
      store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-RACE-TWO", actor: "tyler" }),
    ]);
    assert.deepEqual([...new Set(both.map((p) => p.version))].sort(), [1, 2], `${store.constructor.name}: two concurrent stores read-modify-wrote without minting the same version`);
    assert.deepEqual((await store.presence("tyler/repo")).map((p) => p.version), [2], "one row, the later write's version");
  }
});

test("store: S4 — a Nucleus set claims its version slot through kv.setNX, and a racing duplicate is refused", async () => {
  const rows = new Map<string, { doc: string }>();
  const taken = new Set<string>();
  const claims: string[] = [];
  // Hand the store a STALE doc once: the racing-writer shape, where B reads
  // the row before A's write lands, so B computes the version A is minting.
  let staleOnce = false;
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("CREATE TABLE")) return [];
      if (sql.startsWith("SELECT binding, doc")) return [...rows.entries()].map(([binding, row]) => ({ binding, doc: row.doc }));
      if (sql.startsWith("SELECT doc FROM")) {
        if (params === undefined || params.length === 0) return [...rows.values()].map((row) => ({ doc: row.doc }));
        const key = String(params[0]);
        const hit = rows.get(key);
        if (hit === undefined) return [];
        const row = JSON.parse(hit.doc) as { version: number; clearedAt?: string };
        if (staleOnce && row.version > 1) {
          staleOnce = false;
          return [{ doc: JSON.stringify({ ...row, version: row.version - 1 }) }];
        }
        return [{ doc: hit.doc }];
      }
      if (sql.startsWith("SELECT binding FROM")) return rows.has(String(params[0])) ? [{ binding: String(params[0]) }] : [];
      if (sql.startsWith("UPDATE")) {
        if (!rows.has(String(params[1]))) return [];
        rows.set(String(params[1]), { doc: String(params[0]) });
        return [];
      }
      if (sql.startsWith("INSERT")) {
        rows.set(String(params[0]), { doc: String(params[1]) });
        return [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    kv: { setNX: async (key: string) => (claims.push(key), taken.has(key) ? false : (taken.add(key), true)) },
  } as unknown as import("./nucleus-pgwire.js").NucleusPgwire;
  const store = new NucleusHarnessCredentials(db, SEAL_ENV);
  const first = await store.set({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY", value: "sk-cx-one", actor: "t" });
  assert.equal(first.version, 1);
  const second = await store.set({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY", value: "sk-cx-two", actor: "t" });
  assert.equal(second.version, 2);
  // The stale read computes version 2 again; the version-2 slot is already
  // claimed, so the store refuses rather than minting a duplicate version.
  staleOnce = true;
  await assert.rejects(store.set({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY", value: "sk-cx-three", actor: "t" }), /minting version 2/);
  // A clear tombstones rather than deletes, so the count never restarts.
  await store.clear({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY" });
  assert.deepEqual(await store.presence("tyler/repo"), []);
  const third = await store.set({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY", value: "sk-cx-four", actor: "t" });
  assert.equal(third.version, 3, "the Nucleus tombstone keeps the version floor too");
});

test("store: a binding shape the delivery path could not act on refuses the write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-shape-"));
  const store = new FileHarnessCredentials(dir, SEAL_ENV);
  await assert.rejects(store.set({ project: "tyler/repo", profile: "native", envName: "ANTHROPIC_API_KEY", value: "k", actor: "t" }), /external harness id/);
  await assert.rejects(store.set({ project: "tyler/repo", profile: "claude-code", envName: "anthropic_key", value: "k", actor: "t" }), /UPPER_SNAKE_CASE/);
  await assert.rejects(store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "  ", actor: "t" }), /cannot be empty/);
  assert.deepEqual(await store.presence("tyler/repo"), []);
});

test("store: NEGATIVE CONTROL — storing is refused while encryption is not configured (fail closed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-unsealed-"));
  const store = new FileHarnessCredentials(dir, {});
  await assert.rejects(
    store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-CLEARTEXT", actor: "tyler" }),
    /SHIP_CONFIG_KEY/,
  );
  assert.deepEqual(await store.presence("tyler/repo"), [], "nothing was written");
  assert.ok(!(await readFile(join(dir, "harness-credentials.json"), "utf8").catch(() => "")).includes("sk-ant-CLEARTEXT"));
});

test("store: a rotated SHIP_CONFIG_KEY throws rather than handing back ciphertext", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-rotated-"));
  await new FileHarnessCredentials(dir, SEAL_ENV).set({ project: "tyler/repo", profile: "codex", envName: "CODEX_API_KEY", value: "sk-cx", actor: "t" });
  await assert.rejects(new FileHarnessCredentials(dir, { SHIP_CONFIG_KEY: "a-different-key" }).resolve("tyler/repo", "codex", "CODEX_API_KEY"), /could not be opened|SHIP_CONFIG_KEY/);
});

// ----------------------------------------------------------- the gate (direct)

test("gate: NEGATIVE CONTROL — a missing credential is refused by name, before any run exists", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "harness-credential-missing");
  assert.match(out.reason, /ANTHROPIC_API_KEY/);
  assert.match(out.reason, /Project settings/);
});

test("gate: a stored credential satisfies the presence requirement when the deployment env has none", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_AUTH_TOKEN", value: "tok-stored", actor: "t" });
  // A key alone derives api.anthropic.com, which the z.ai-only policy refuses
  // — so reroute through the production base URL to test presence in isolation.
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_BASE_URL", value: "https://api.z.ai/api/anthropic", actor: "t" });
  const out = await admitHarnessCredentials({ refs: [{ id: "claude-code" }], project: "tyler/repo", store, env: { SHIP_HARNESS_CRED: "on", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" } });
  assert.equal(out.ok, true, out.ok === false ? out.reason : "");
  assert.deepEqual(
    out.refs,
    [
      { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_AUTH_TOKEN", version: 1 },
      { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_BASE_URL", version: 1 },
    ],
    "B1: EVERY delivered binding is a reference — the base URL too, so the worker delivers exactly the env the gate judged",
  );
  assert.deepEqual(out.overlays, { "claude-code": { ANTHROPIC_AUTH_TOKEN: "tok-stored", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } }, "S1: the overlay is per profile");
  assert.deepEqual(out.destinations, { "claude-code": ["api.z.ai"] }, "S2: the approved host set is recorded for the worker's re-check");
});

test("gate: NEGATIVE CONTROL — a destination outside the policy is refused by name", async () => {
  // The policy DECLARES api.anthropic.com (so the refusal is about
  // permission, not about an unknown host) and permits only api.z.ai.
  const policy = await policyFile([...ZAI_ONLY, { host: "api.anthropic.com", class: "hosted", retention: "none" }]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", ANTHROPIC_API_KEY: "sk-ant-x", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "destination-not-allowed");
  assert.match(out.reason, /api\.anthropic\.com/);
  assert.match(out.reason, /private/);
});

test("gate: a host the destination list permits but no policy entry declares is refused", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "destination-not-in-policy");
  assert.match(out.reason, /api\.openai\.com/);
});

test("gate: a destination that retains more than the data class allows is refused", async () => {
  const policy = await policyFile([{ host: "api.z.ai", class: "hosted", retention: "long" }]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "retention-exceeds");
});

test("gate: no routing policy loaded refuses by name when a host needs judging", async () => {
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", ANTHROPIC_API_KEY: "sk-ant-x" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "no-routing-policy");
});

test("gate: a subscription token with no derivable host is refused — Decision 11, named", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.anthropic.com" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "credential-destination-unknown");
  assert.match(out.reason, /Decision 11/);
});

test("gate: an unreadable sealed store refuses rather than judging half a store", async () => {
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "k", actor: "t" });
  const rotated = new MemoryHarnessCredentials({ SHIP_CONFIG_KEY: "rotated" });
  // Reuse the SAME rows through a store whose key cannot open them: point the
  // resolver at the first store's rows by re-sealing is unnecessary — a
  // rotated reader over a shared file is the real shape, so exercise it via
  // FileHarnessCredentials.
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-unreadable-"));
  const writer = new FileHarnessCredentials(dir, SEAL_ENV);
  await writer.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "k", actor: "t" });
  void rotated;
  const out = await admitHarnessCredentials({
    refs: [{ id: "claude-code" }],
    project: "tyler/repo",
    store: new FileHarnessCredentials(dir, { SHIP_CONFIG_KEY: "rotated" }),
    env: { SHIP_HARNESS_CRED: "on" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "credential-store-unreadable");
});

// --------------------------------------------------- S3: the config blob + SHIP_HARNESS_ENV

const CONFIG_BLOB = JSON.stringify({ provider: { "custom-gw": { options: { baseURL: "https://api.config-gw.example.com" } } } });

test("gate: S3 — an opencode config blob's provider baseURL is judged like any base URL", async () => {
  // Without the parse, the OPENAI key derives api.openai.com (declared) and
  // the blob's api.config-gw.example.com would dial ungated — the hole this
  // test pins shut.
  const policy = await policyFile([{ host: "api.openai.com", class: "hosted", retention: "none" }]);
  const refused = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: CONFIG_BLOB, SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "destination-not-in-policy", "the config-declared host reaches the policy check");
  assert.match(refused.reason, /api\.config-gw\.example\.com/);
  const allowed = await policyFile([
    { host: "api.openai.com", class: "hosted", retention: "none" },
    { host: "api.config-gw.example.com", class: "hosted", retention: "none" },
  ]);
  const ok = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: CONFIG_BLOB, SHIP_MODEL_ROUTING_POLICY: allowed, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com,api.config-gw.example.com" },
  });
  assert.equal(ok.ok, true, ok.ok === false ? ok.reason : "");
  assert.deepEqual(ok.destinations, { opencode: ["api.openai.com", "api.config-gw.example.com"] });
});

test("gate: S3 — an unparseable config blob is refused by name, never guessed", async () => {
  const policy = await policyFile([{ host: "api.openai.com", class: "hosted", retention: "none" }]);
  const out = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: "{not json", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "harness-config-unparseable");
  // JSONC is the same refusal: a comment can hide a destination.
  const jsonc = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: '{\n  // routed elsewhere\n  "provider": {}\n}', SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(jsonc.ok, false);
  assert.equal(jsonc.code, "harness-config-unparseable");
});

test("gate: S3 — run-time substitutions anywhere in the blob are refused (fail closed)", async () => {
  const policy = await policyFile([{ host: "api.openai.com", class: "hosted", retention: "none" }]);
  // The substituted baseURL: the URL parse fails silently in the old reader
  // and the derivation approved the vendor's default host while the harness
  // dialed the substituted one.
  const substituted = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: {
      SHIP_HARNESS_CRED: "on",
      OPENAI_API_KEY: "sk-oai",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { "custom-gw": { options: { baseURL: "https://{env:GW_HOST}/v1", apiKey: "sk-x" } } } }),
      SHIP_MODEL_ROUTING_POLICY: policy,
      SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com",
    },
  });
  assert.equal(substituted.ok, false);
  assert.equal(substituted.code, "harness-config-destination-unreadable");
  assert.match(substituted.reason, /\{env:/);
  // Even a substitution that only touches a KEY value refuses: the same blob
  // can substitute into a URL elsewhere, and this reader does not parse
  // vendor fields it has not been told about.
  const keyOnly = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: {
      SHIP_HARNESS_CRED: "on",
      OPENAI_API_KEY: "sk-oai",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "{env:OPENAI_API_KEY}" } } } }),
      SHIP_MODEL_ROUTING_POLICY: policy,
      SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com",
    },
  });
  assert.equal(keyOnly.ok, false);
  assert.equal(keyOnly.code, "harness-config-destination-unreadable");
});

test("gate: S3 — cloud apis, underivable provider defaults, local MCP, share and plugins refuse", async () => {
  const policy = await policyFile([{ host: "api.openai.com", class: "hosted", retention: "none" }]);
  const cases: Array<[string, string, RegExp]> = [
    ["a bedrock api", JSON.stringify({ provider: { "my-bedrock": { api: "bedrock", options: { apiKey: "k" } } } }), /bedrock/],
    ["a vertex api", JSON.stringify({ provider: { v: { api: "vertex" } } }), /vertex/],
    ["an unparseable baseURL", JSON.stringify({ provider: { gw: { options: { baseURL: "https://api.gw.example.com/v1", base_url: "not a url" } } } }), /not a URL/],
    ["an unknown provider default", JSON.stringify({ provider: { "mystery-vendor": { options: { apiKey: "k" } } } }), /mystery-vendor/],
    ["a local MCP server", JSON.stringify({ provider: {}, mcp: { tools: { type: "local", command: ["npx", "something"] } } }), /local/],
    ["share", JSON.stringify({ provider: {}, share: true }), /share/],
    ["plugins", JSON.stringify({ provider: {}, plugin: { pinner: {} } }), /plugin/],
  ];
  for (const [what, blob, why] of cases) {
    const out = await admitHarnessCredentials({
      refs: [{ id: "opencode" }],
      project: null,
      store: undefined,
      env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: blob, SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
    });
    assert.equal(out.ok, false, what);
    assert.equal(out.code, "harness-config-destination-unreadable", what);
    assert.match(out.reason ?? "", why, what);
  }
});

test("gate: S3 — known provider defaults and remote MCP urls are derived and judged", async () => {
  // A provider with a key but no baseURL dials its id's default: the known
  // ids derive that host, and the policy judges it.
  const refusedDefault = await policyFile([{ host: "api.openai.com", class: "hosted", retention: "none" }]);
  const anthropicKey = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { apiKey: "sk-ant" } } } }), SHIP_MODEL_ROUTING_POLICY: refusedDefault, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(anthropicKey.ok, false);
  assert.equal(anthropicKey.code, "destination-not-in-policy", "the derived default (api.anthropic.com) reaches the policy check");
  assert.match(anthropicKey.reason, /api\.anthropic\.com/);
  const allowed = await policyFile([
    { host: "api.openai.com", class: "hosted", retention: "none" },
    { host: "api.anthropic.com", class: "hosted", retention: "none" },
    { host: "mcp.example.com", class: "hosted", retention: "none" },
  ]);
  const ok = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: {
      SHIP_HARNESS_CRED: "on",
      OPENAI_API_KEY: "sk-oai",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { apiKey: "sk-ant" } } }, mcp: { docs: { type: "remote", url: "https://mcp.example.com/sse" } } }),
      SHIP_MODEL_ROUTING_POLICY: allowed,
      SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com,api.anthropic.com,mcp.example.com",
    },
  });
  assert.equal(ok.ok, true, ok.ok === false ? ok.reason : "");
  assert.deepEqual(ok.destinations, { opencode: ["api.openai.com", "api.anthropic.com", "mcp.example.com"] }, "the known default and the remote MCP host are both judged");
});

test("gate: S3 — SHIP_HARNESS_ENV names outside the flag's allowlist are refused by name; permitted ones pass", async () => {
  const policy = await policyFile([
    { host: "api.openai.com", class: "hosted", retention: "none" },
    { host: "proxy.example.com", class: "hosted", retention: "none" },
  ]);
  // An unknown URL-shaped addition is refused — not because it LOOKS like a
  // URL, but because it is not on the allowlist of permitted additions.
  const refused = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", SHIP_HARNESS_ENV: "OPENAI_API_KEY,MY_GW_URL", MY_GW_URL: "https://anywhere.example.com", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "harness-env-forward-refused");
  assert.match(refused.reason, /MY_GW_URL/);
  // The explicit never-list: proxy overrides, config-file pointers and
  // cloud-provider switches are refused with their reason, whatever they
  // look like and whether or not they are even set.
  for (const [name, why] of [
    ["HTTPS_PROXY", /proxy override/],
    ["https_proxy", /proxy override/i],
    ["OPENCODE_CONFIG", /config FILE/],
    ["OPENCODE_CONFIG_DIR", /config DIRECTORY/],
    ["CLAUDE_CODE_USE_BEDROCK", /Bedrock/],
    ["AWS_ACCESS_KEY_ID", /cloud-provider/],
  ] as const) {
    const out = await admitHarnessCredentials({
      refs: [{ id: name === "CLAUDE_CODE_USE_BEDROCK" || name === "AWS_ACCESS_KEY_ID" ? "claude-code" : "opencode" }],
      project: null,
      store: undefined,
      env: {
        SHIP_HARNESS_CRED: "on",
        ...(name === "CLAUDE_CODE_USE_BEDROCK" || name === "AWS_ACCESS_KEY_ID" ? { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://proxy.example.com" } : { OPENAI_API_KEY: "sk-oai" }),
        SHIP_HARNESS_ENV: `${name === "CLAUDE_CODE_USE_BEDROCK" || name === "AWS_ACCESS_KEY_ID" ? "ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL" : "OPENAI_API_KEY"},${name}`,
        SHIP_MODEL_ROUTING_POLICY: policy,
        SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com,proxy.example.com",
      },
    });
    assert.equal(out.ok, false, `${name} must refuse`);
    assert.equal(out.code, "harness-env-forward-refused", name);
    assert.match(out.reason ?? "", why, name);
    assert.match(out.reason ?? "", new RegExp(name), `${name} is named`);
  }
  // OPENAI_BASE_URL is in opencode's own derivation (PROVIDER_EGRESS), so
  // forwarding it is fine — and its host is judged like any base URL.
  const ok = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", SHIP_HARNESS_ENV: "OPENAI_API_KEY,OPENAI_BASE_URL", OPENAI_BASE_URL: "https://proxy.example.com", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com,proxy.example.com" },
  });
  assert.equal(ok.ok, true, ok.ok === false ? ok.reason : "");
  assert.deepEqual(ok.destinations, { opencode: ["proxy.example.com"] });
  // A deliberate extra (a destination-free knob) is permitted.
  const extra = await admitHarnessCredentials({
    refs: [{ id: "opencode" }],
    project: null,
    store: undefined,
    env: { SHIP_HARNESS_CRED: "on", OPENAI_API_KEY: "sk-oai", SHIP_HARNESS_ENV: "OPENAI_API_KEY,OPENCODE_DISABLE_TELEMETRY", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com" },
  });
  assert.equal(extra.ok, true, extra.ok === false ? extra.reason : "");
});

// -------------------------------------------------------- the enqueue surface

const PROD_ENV = {
  SHIP_HARNESS: "claude-code",
  SHIP_HARNESS_CRED: "on",
  // The production shape since 2026-10-17: the z.ai coding plan through an
  // Anthropic-compatible base URL, so the provider host IS derivable.
  ANTHROPIC_AUTH_TOKEN: "zai-plan-token",
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai",
} as const;

test("enqueue: the production ensemble passes — claude-code on api.z.ai under policy 2026-10-16.1", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-prod-"));
  const projects = new FileProjectStore(dir);
  const URL_ = "https://git.example.com/tyler/ship";
  await projects.set({ repo: URL_, url: URL_, sandboxEgressAllow: ["api.z.ai"], autoMerge: false, autoDeploy: false });
  const project = (await projects.forRepo(URL_))!;
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-PROD-STORED", actor: "tyler" });
  const run = await enqueue({ ...PROD_ENV, SHIP_MODEL_ROUTING_POLICY: policy }, { runId: "r-prod", repo: URL_ }, { projectStore: projects, credentials: store });
  const input = inputOf(run.json()) as { sandboxEgressAllow?: string[]; harnessCredentials?: HarnessCredentialRef[]; harnessDestinations?: Record<string, string[]> };
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai"], "the explicit bare host stands; the derived host:443 dedupes against it");
  assert.deepEqual(input.harnessCredentials, [{ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }]);
  assert.deepEqual(input.harnessDestinations, { "claude-code": ["api.z.ai"] }, "S2: what admission approved is recorded for the worker's re-check");
  assert.ok(!run.json().includes("sk-ant-PROD-STORED"), "NEGATIVE CONTROL: the stored value is nowhere in the recorded input");
});

test("enqueue: a stored base URL derives the provider host the daemon allowlist carries", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-baseurl-"));
  const URL_ = "https://git.example.com/tyler/base";
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: URL_, url: URL_, autoMerge: false, autoDeploy: false });
  const project = (await projects.forRepo(URL_))!;
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_BASE_URL", value: "https://api.z.ai/api/anthropic", actor: "tyler" });
  const run = await enqueue(
    { ...PROD_ENV, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined, CLAUDE_CODE_OAUTH_TOKEN: "oauth", SHIP_MODEL_ROUTING_POLICY: policy },
    { runId: "r-baseurl", repo: URL_ },
    { projectStore: projects, credentials: store },
  );
  // The OAuth token satisfies presence but derives no host; the STORE's base
  // URL is what makes the destination judgeable — and judges it to api.z.ai.
  // B1: the base URL is now DELIVERED, by reference, so the exec env is
  // exactly the env the gate judged — this assert is the flipped review
  // finding (a stored base URL the gate approved but the exec never saw sent
  // the token to the vendor's default host instead).
  const input = inputOf(run.json()) as { sandboxEgressAllow?: string[]; harnessCredentials?: HarnessCredentialRef[]; harnessDestinations?: Record<string, string[]> };
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai:443"], "derived from the store's value, not the empty deployment env");
  assert.deepEqual(
    input.harnessCredentials,
    [{ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_BASE_URL", version: 1 }],
    "a stored base URL is delivered by reference (never a value in the input)",
  );
  assert.deepEqual(input.harnessDestinations, { "claude-code": ["api.z.ai"] });
});

test("enqueue: NEGATIVE CONTROL — a missing credential refuses by name and appends no run", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const env = { ...PROD_ENV, ANTHROPIC_AUTH_TOKEN: undefined, SHIP_MODEL_ROUTING_POLICY: policy };
  const run = { runId: "r-missing", repo: "https://git.example.com/tyler/a" };
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-missing-"));
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: run.repo, url: run.repo, autoMerge: false, autoDeploy: false });
  await assert.rejects(enqueue(env, run, { projectStore: projects }), /run refused \(harness-credential-missing\).*ANTHROPIC_API_KEY/);
});

test("enqueue: NEGATIVE CONTROL — a destination outside the policy refuses by name and appends no run", async () => {
  const policy = await policyFile([...ZAI_ONLY, { host: "api.anthropic.com", class: "hosted", retention: "none" }]);
  const env = { ...PROD_ENV, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: "sk-ant-x", SHIP_MODEL_ROUTING_POLICY: policy };
  await assert.rejects(enqueue(env, { runId: "r-outside", repo: "https://git.example.com/tyler/a" }), /run refused \(destination-not-allowed\).*api\.anthropic\.com/);
});

test("enqueue: NEGATIVE CONTROL — flag off is byte-identical: no gate, no field, no derivation change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-off-"));
  const URL_ = "https://git.example.com/tyler/off";
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: URL_, url: URL_, autoMerge: false, autoDeploy: false });
  const project = (await projects.forRepo(URL_))!;
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-FLAGOFF", actor: "tyler" });
  const env = { SHIP_HARNESS: "claude-code", ANTHROPIC_API_KEY: "sk-ant-env", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" };
  // No policy in env: the flag-off run must not need one.
  const withStore = await enqueue(env, { runId: "r-off", repo: URL_ }, { projectStore: projects, credentials: store });
  const withoutStore = await enqueue(env, { runId: "r-off", repo: URL_ }, { projectStore: projects });
  assert.equal(withStore.json(), withoutStore.json(), "a store holding bindings changes nothing about a flag-off input");
  assert.ok(!("harnessCredentials" in inputOf(withStore.json())), "no field");
  assert.ok(!withStore.json().includes("sk-ant-FLAGOFF"));
  // And the fingerprint does not move when the fields ARE present: neither
  // admits a step.
  const policy = await policyFile([...ZAI_ONLY]);
  const on = await enqueue({ ...PROD_ENV, SHIP_MODEL_ROUTING_POLICY: policy }, { runId: "r-on", repo: URL_ }, { projectStore: projects, credentials: store });
  const input = inputOf(on.json()) as Parameters<typeof stepFingerprint>[0];
  const without = { ...input } as Record<string, unknown>;
  delete without.harnessCredentials;
  delete without.harnessDestinations;
  assert.equal(stepFingerprint(input), stepFingerprint(without as Parameters<typeof stepFingerprint>[0]));
});

// ------------------------------------------------------------ checkDestinationHost

test("checkDestinationHost: declared and permitted passes; undeclared or over-retentive refuses; a class entry admits", () => {
  const policy: import("./model-routing.js").RoutingPolicy = {
    version: "t",
    roles: {
      worker: [
        { model: "a/one", effort: "medium", capabilities: ["tools"], dataDestination: { host: "api.z.ai", class: "hosted" }, retention: "none", maxContext: 1000 },
        { model: "a/two", effort: "medium", capabilities: ["tools"], dataDestination: { host: "api.other.com", class: "vendor" }, retention: "short", maxContext: 1000 },
      ],
    },
    fallbackOn: [],
  };
  const task: import("./model-routing.js").RouteTask = { needs: ["tools"], contextTokens: 1, maxOutputTokens: 1, dataClass: "internal", allowedDestinations: ["api.z.ai"], reservedBudget: 1, uncertainSideEffects: false };
  assert.equal(checkDestinationHost(policy, "api.z.ai", task).ok, true);
  assert.equal(checkDestinationHost(policy, "API.Z.AI", task).ok, true, "host matching is case-insensitive");
  const other = checkDestinationHost(policy, "api.other.com", task);
  assert.equal(other.ok === false ? other.code : "", "destination-not-allowed", "declared but not in the permitted list");
  const undeclared = checkDestinationHost(policy, "api.unknown.com", { ...task, allowedDestinations: ["api.unknown.com"] });
  assert.equal(undeclared.ok === false ? undeclared.code : "", "destination-not-in-policy", "a destination list entry is not a declaration; the policy must know the host");
  const byClass = checkDestinationHost(policy, "api.other.com", { ...task, allowedDestinations: ["class:vendor"] });
  assert.equal(byClass.ok, true, "a class: destination admits the entry, the same rule candidates are judged by");
  const privateTask = { ...task, dataClass: "private" as const, allowedDestinations: ["class:vendor"] };
  const retention = checkDestinationHost(policy, "api.other.com", privateTask);
  assert.equal(retention.ok === false ? retention.code : "", "retention-exceeds", "private tolerates retention none only");
});

// ------------------------------------------------------------ worker delivery

const neverModel: ModelAdapter = {
  provider: "never",
  modelId: "never",
  async doGenerate() {
    throw new Error("an external harness run must never call Ship's model");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

const STORED_KEY = "sk-ant-api03-H2STORED-9876543210zyxwvu";

async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

/**
 * A leaky fake `claude` for the delivery control: dumps its env to a file
 * OUTSIDE the workspace (the proof the value arrived), prints env and the
 * bare key and its base64 to stdout and stderr, and closes with a result
 * event that quotes the key.
 */
async function leakyClaude(recordTo: string): Promise<{ bin: string; work: string }> {
  const bin = await mkdtemp(join(tmpdir(), "h2-leak-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-leak-work-"));
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: `done; key=$ANTHROPIC_API_KEY`,
    session_id: "6f47a1d0-8d2c-4b0a-9d3f-2a1b4c5d6e7f",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -H x-api-key:$ANTHROPIC_API_KEY" } }] } });
  await fakeBin(
    bin,
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`,
      `env > ${shq(join(recordTo, "envdump"))}`,
      `env`,
      `echo "$ANTHROPIC_API_KEY"`,
      `printf %s "$ANTHROPIC_API_KEY" | base64`,
      `echo '${tool.replace(/\$/g, "\\$")}'`,
      `env >&2`,
      `echo '${result.replace(/\$/g, "\\$")}'`,
    ].join("\n"),
  );
  return { bin, work };
}

test("worker: NEGATIVE CONTROL — a stored value never appears in the input, event log, live feed or run output of a full fake run", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "h2-leak-rec-"));
  const { bin, work } = await leakyClaude(recordTo);
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: STORED_KEY, actor: "tyler" });
  const refs: HarnessCredentialRef[] = [{ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }];
  const liveFeed: unknown[] = [];
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: {}, credentials: harnessCredentialResolver(store) }),
    live: { async set(_runId, update) { liveFeed.push(update); } },
  });
  const eventStore = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-leak",
    store: eventStore,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, harnessCredentials: refs },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));

  // Control: the value really reached the vendor process — a clean record
  // means scrubbed, not absent.
  assert.ok((await readFile(join(recordTo, "envdump"), "utf8")).includes(`ANTHROPIC_API_KEY=${STORED_KEY}`), "the harness saw the unsealed key");

  const encoded = Buffer.from(STORED_KEY).toString("base64");
  const events = JSON.stringify(await eventStore.load("run-h2-leak"));
  assert.ok(!events.includes(STORED_KEY), "no recorded event carries the value — this is the recorded input, the step results the PR body quotes and every API response's source");
  assert.ok(!events.includes(encoded), "nor its base64");
  assert.match(events, /\[redacted ANTHROPIC_API_KEY\]/, "the exact-value scrub left its marker");
  const out = outcome.output as DurableAgentOutput;
  assert.ok(!JSON.stringify(outcome).includes(STORED_KEY), "the run output (summary included) does not carry it");
  const live = JSON.stringify(liveFeed);
  assert.ok(!live.includes(STORED_KEY), "the live feed never carries it");
});

test("worker: a reference the store cannot resolve is a recorded, named refusal — nothing runs", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "h2-gone-rec-"));
  const bin = await mkdtemp(join(tmpdir(), "h2-gone-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-gone-work-"));
  // The binary records being executed; the control is that it never is.
  await fakeBin(bin, "claude", [`if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`, `touch ${shq(join(recordTo, "ran"))}`].join("\n"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const refs: HarnessCredentialRef[] = [{ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }];
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: externalAdapters({ env: {} }) });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-h2-gone", store, input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, harnessCredentials: refs } });
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary ?? "", /ANTHROPIC_API_KEY.*tyler\/repo.*no (longer )?available|not available/);
  assert.match(out.summary ?? "", /agent was not started/i);
  await assert.rejects(readFile(join(recordTo, "ran")), "the vendor binary never executed");
});

/**
 * A fake `claude` that records its exec env OUTSIDE the workspace (the proof
 * of what was delivered) and finishes cleanly — no output noise, no leak.
 */
async function recordingClaude(recordTo: string): Promise<{ bin: string; work: string }> {
  const bin = await mkdtemp(join(tmpdir(), "h2-rec-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-rec-work-"));
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "done",
    session_id: "7b6b4e1f-1111-2222-3333-444455556666",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  await fakeBin(
    bin,
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`,
      `env > ${shq(join(recordTo, "envdump"))}`,
      `touch ${shq(join(recordTo, "ran"))}`,
      `echo '${result.replace(/\$/g, "\\$")}'`,
    ].join("\n"),
  );
  return { bin, work };
}

test("worker: B1 — a stored base URL reaches the exec env, and the gate judged exactly that URL", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const dir = await mkdtemp(join(tmpdir(), "ship-h2-b1-"));
  const projects = new FileProjectStore(dir);
  const URL_ = "https://git.example.com/tyler/b1";
  await projects.set({ repo: URL_, url: URL_, autoMerge: false, autoDeploy: false });
  const project = (await projects.forRepo(URL_))!;
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_BASE_URL", value: "https://api.z.ai/api/anthropic", actor: "tyler" });
  // Enqueue half: the deployment env holds ONLY a token; the gate must judge
  // the STORE's base URL (api.z.ai), not an undialable default.
  const run = await enqueue(
    {
      SHIP_HARNESS: "claude-code",
      SHIP_HARNESS_CRED: "on",
      ANTHROPIC_AUTH_TOKEN: "h2-b1-env-token",
      SHIP_MODEL_ROUTING_POLICY: policy,
      SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai",
    },
    { runId: "r-b1", repo: URL_ },
    { projectStore: projects, credentials: store },
  );
  const input = inputOf(run.json()) as { sandboxEgressAllow?: string[]; harnessCredentials?: HarnessCredentialRef[] };
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai:443"], "the gate judged the store's base URL");
  assert.deepEqual(input.harnessCredentials, [{ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_BASE_URL", version: 1 }]);
  // Worker half: the same run, executed — the exec env must carry the base
  // URL the gate approved (B1: previously only credential-shaped names were
  // delivered, so the token dialled api.anthropic.com with the policy
  // believing it had approved api.z.ai).
  const recordTo = await mkdtemp(join(tmpdir(), "h2-b1-rec-"));
  const { bin, work } = await recordingClaude(recordTo);
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({
      env: { ANTHROPIC_AUTH_TOKEN: "h2-b1-env-token", SHIP_HARNESS_CRED: "on", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
      credentials: harnessCredentialResolver(store),
    }),
  });
  const eventStore = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-b1",
    store: eventStore,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, harnessCredentials: input.harnessCredentials, harnessDestinations: { "claude-code": ["api.z.ai"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const envdump = await readFile(join(recordTo, "envdump"), "utf8");
  assert.ok(envdump.includes("ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic"), "the exec env carries the stored base URL");
  assert.ok(envdump.includes("ANTHROPIC_AUTH_TOKEN=h2-b1-env-token"), "and the deployment env's token");
  assert.ok(!JSON.stringify(await eventStore.load("run-h2-b1")).includes("api.z.ai/api/anthropic\""), "the URL rides the input as a reference, never a value");
});

test("worker: S2 NEGATIVE CONTROL — a worker env that dials somewhere else than admission approved refuses by name, nothing runs", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "h2-s2-rec-"));
  const bin = await mkdtemp(join(tmpdir(), "h2-s2-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-s2-work-"));
  await fakeBin(bin, "claude", [`if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`, `touch ${shq(join(recordTo, "ran"))}`].join("\n"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  // Enqueue approved api.z.ai; THIS worker's env carries a different base URL.
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://moved.example.com/v1", SHIP_HARNESS_CRED: "on" } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-s2",
    store,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, harnessDestinations: { "claude-code": ["api.z.ai"] } },
  });
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary ?? "", /harness-destination-changed/);
  assert.match(out.summary ?? "", /api\.z\.ai/);
  assert.match(out.summary ?? "", /moved\.example\.com/);
  await assert.rejects(readFile(join(recordTo, "ran")), "the vendor binary never executed");
});

test("worker: S2 NEGATIVE CONTROL — a flag-on worker refuses an input that records no destinations (enqueued flag-off)", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "h2-s2c-rec-"));
  const bin = await mkdtemp(join(tmpdir(), "h2-s2c-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-s2c-work-"));
  await fakeBin(bin, "claude", [`if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`, `touch ${shq(join(recordTo, "ran"))}`].join("\n"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  // No harnessDestinations on the input at all — the flag-off enqueue shape —
  // while THIS worker runs with the flag on. Skipping the re-check here is
  // the hole: nobody ever judged this destination.
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", SHIP_HARNESS_CRED: "on" } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-s2c",
    store,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! } },
  });
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary ?? "", /harness-destination-changed/);
  assert.match(out.summary ?? "", /records no approved provider destinations/);
  await assert.rejects(readFile(join(recordTo, "ran")), "the vendor binary never executed");
});

test("worker: S2 — the re-check reads the routing policy and data class from the WORKER env, not the overlaid run env", async () => {
  const policy = await policyFile([{ host: "api.z.ai", class: "hosted", retention: "none" }]);
  const base = {
    id: "claude-code",
    approved: ["api.z.ai"] as string[],
    env: { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", SHIP_HARNESS_CRED: "on" },
  };
  // The overlaid env claims a permissive policy and data class; the worker's
  // own env carries none. The judgment must follow the WORKER: a stored
  // binding must not steer the judgment of its own delivery.
  const steered = harnessDestinationCheck({
    ...base,
    env: { ...base.env, SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DATA_CLASS: "hosted", SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
    policyEnv: {},
  });
  assert.match(steered ?? "", /no routing policy is loaded on this worker/);
  // And the other way round: the worker's env decides even when the run env
  // carries a stricter-looking set.
  const workerJudged = harnessDestinationCheck({
    ...base,
    env: { ...base.env, SHIP_MODEL_ROUTING_DATA_CLASS: "private" },
    policyEnv: { SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai", SHIP_MODEL_ROUTING_DATA_CLASS: "hosted" },
  });
  assert.equal(workerJudged, undefined, "the worker's policy and data class are what the re-check answered");
  // A worker whose own data class cannot tolerate the host's retention
  // refuses on the WORKER's facts, whatever the run env claims.
  const retaining = await policyFile([{ host: "api.z.ai", class: "hosted", retention: "long" }]);
  const workerRefuses = harnessDestinationCheck({
    ...base,
    env: { ...base.env, SHIP_MODEL_ROUTING_DATA_CLASS: "hosted" },
    policyEnv: { SHIP_MODEL_ROUTING_POLICY: retaining, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai", SHIP_MODEL_ROUTING_DATA_CLASS: "private" },
  });
  assert.match(workerRefuses ?? "", /retention-exceeds|does not permit/);
});

test("worker: S3 — a config blob the worker cannot read refuses the re-check even when the derived hosts match", async () => {
  // Approved api.openai.com (from the key); the worker's blob carries a
  // substituted baseURL that derives NOTHING — so the host sets would
  // compare equal while the harness dialed the substituted host.
  const refusal = harnessDestinationCheck({
    id: "opencode",
    approved: ["api.openai.com"],
    env: {
      SHIP_HARNESS_CRED: "on",
      OPENAI_API_KEY: "sk-oai",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { "custom-gw": { options: { baseURL: "https://{env:GW_HOST}/v1", apiKey: "sk-x" } } } }),
    },
  });
  assert.match(refusal ?? "", /\{env:/);
  // And a readable blob's hosts are re-judged like any base URL: a blob that
  // moved since enqueue refuses by name.
  const moved = harnessDestinationCheck({
    id: "opencode",
    approved: ["api.openai.com"],
    env: {
      SHIP_HARNESS_CRED: "on",
      OPENAI_API_KEY: "sk-oai",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { "custom-gw": { options: { baseURL: "https://moved.example.com/v1", apiKey: "sk-x" } } } }),
    },
  });
  assert.match(moved ?? "", /moved since enqueue/);
});

test("worker: S2 — a worker that cannot re-judge the approved destination refuses rather than inherit the approval", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "h2-s2b-rec-"));
  const bin = await mkdtemp(join(tmpdir(), "h2-s2b-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-s2b-work-"));
  await fakeBin(bin, "claude", [`if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`, `touch ${shq(join(recordTo, "ran"))}`].join("\n"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  // The derived host matches what admission approved — but this worker has no
  // routing policy, so permission cannot be re-established at exec time.
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", SHIP_HARNESS_CRED: "on" } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-s2b",
    store,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, harnessDestinations: { "claude-code": ["api.z.ai"] } },
  });
  const out = outcome.output as DurableAgentOutput;
  assert.equal(out.status, "error");
  assert.match(out.summary ?? "", /harness-destination-changed/);
  assert.match(out.summary ?? "", /routing policy/);
  await assert.rejects(readFile(join(recordTo, "ran")), "the vendor binary never executed");
});

test("worker: no references means no resolution and no failure — a flag-off input is untouched", async () => {
  assert.deepEqual(await resolveCredentialOverlay(undefined, undefined), { overlay: {} });
  assert.deepEqual(await resolveCredentialOverlay([], { resolve: async () => ({ value: "x" }) }), { overlay: {} });
  const gone = await resolveCredentialOverlay([{ project: "p", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }], undefined);
  assert.equal(gone.failure !== undefined && /no credential store wired/.test(gone.failure), true);
});

test("worker: S1 — a reference is delivered only to the profile it was sealed for", async () => {
  const refs: HarnessCredentialRef[] = [{ project: "tyler/repo", profile: "codex", envName: "OPENAI_API_KEY", version: 1 }];
  const resolver = { resolve: async () => ({ value: "sk-codex-only", version: 1 }) };
  const other = await resolveCredentialOverlay(refs, resolver, "opencode");
  assert.deepEqual(other, { overlay: {} }, "the opencode attempt does not receive codex's stored key just because the name would fit");
  assert.equal(other.failure, undefined, "and it is not a failure: the run simply holds nothing for that profile");
  const mine = await resolveCredentialOverlay(refs, resolver, "codex");
  assert.deepEqual(mine, { overlay: { OPENAI_API_KEY: "sk-codex-only" } });
});

test("worker: S4 — a rotated binding is delivered at its current value, with a note that says so", async () => {
  const ref: HarnessCredentialRef = { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 };
  const rotated = await resolveCredentialOverlay([ref], { resolve: async () => ({ value: "sk-ant-NEW", version: 3 }) });
  assert.deepEqual(rotated.overlay, { ANTHROPIC_API_KEY: "sk-ant-NEW" });
  assert.deepEqual(rotated.rotation, ["ANTHROPIC_API_KEY: this run's input recorded version 1 at enqueue, the store now holds version 3 (the credential was rotated after enqueue; the run used the current value)"]);
  const same = await resolveCredentialOverlay([ref], { resolve: async () => ({ value: "sk-ant-SAME", version: 1 }) });
  assert.equal(same.rotation, undefined, "no note when the recorded version is what the store still holds");
});

// ------------------------------------------------------------------ misc units

test("profileCredentialNames: the forward list narrows what a profile asks for", () => {
  assert.deepEqual(profileCredentialNames("claude-code", {}), ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  assert.deepEqual(profileCredentialNames("claude-code", { SHIP_HARNESS_ENV: "ANTHROPIC_API_KEY" }), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(profileCredentialNames("native", {}), [], "the native loop takes no harness credential");
});

test("worker: S4 — a full run records the rotation note on the harness-run step", async () => {
  const policy = await policyFile([...ZAI_ONLY]);
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-ROTATE-OLD-1111111111", actor: "t" });
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_BASE_URL", value: "https://api.z.ai/api/anthropic", actor: "t" });
  await store.set({ project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", value: "sk-ant-ROTATE-NEW-2222222222", actor: "t" });
  const recordTo = await mkdtemp(join(tmpdir(), "h2-rot-rec-"));
  const { bin, work } = await recordingClaude(recordTo);
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({
      env: { SHIP_HARNESS_CRED: "on", SHIP_MODEL_ROUTING_POLICY: policy, SHIP_MODEL_ROUTING_DESTINATIONS: "api.z.ai" },
      credentials: harnessCredentialResolver(store),
    }),
  });
  const eventStore = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-rot",
    store: eventStore,
    input: {
      task: "t",
      harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! },
      // Recorded at enqueue, when ANTHROPIC_API_KEY was version 1; the store
      // now holds 3 (the rewrite above) — delivered at the current value.
      harnessCredentials: [
        { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 },
        { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_BASE_URL", version: 1 },
      ],
      harnessDestinations: { "claude-code": ["api.z.ai"] },
    },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const events = JSON.stringify(await eventStore.load("run-h2-rot"));
  assert.match(events, /"credentialRotation":\["ANTHROPIC_API_KEY: this run's input recorded version 1 at enqueue, the store now holds version 2/);
  assert.ok((await readFile(join(recordTo, "envdump"), "utf8")).includes("ANTHROPIC_API_KEY=sk-ant-ROTATE-NEW-2222222222"), "the current value was delivered");
  assert.ok(!events.includes("sk-ant-ROTATE"), "and neither value is anywhere in the log");
});

// ---------------------------------------- S1 across attempts (P5-4 multi-harness)

/** The multi-harness S1 fixture: a file:// bare repo plus fake codex+opencode binaries that dump their exec env outside the workspace. */
async function attemptsFixture(): Promise<{ repo: string; provider: ExecutorProvider; envOf: (id: string) => Promise<string> }> {
  const bare = await mkdtemp(join(tmpdir(), "h2-s1-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "h2-s1-seed-"));
  const seeder = new LocalExecutor({ root: seed });
  await seeder.exec(`git init -q -b main . && git config user.email t@t && git config user.name t && printf 'hello\\n' > f.txt && git add -A && git commit -qm seed && git clone -q --bare . ${bare}/owner/repo.git`);
  const bin = await mkdtemp(join(tmpdir(), "h2-s1-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-s1-work-"));
  const rec = await mkdtemp(join(tmpdir(), "h2-s1-rec-"));
  const codexStream = [
    JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join("\n");
  const opencodeStream = [
    JSON.stringify({ type: "step_start", part: {} }),
    JSON.stringify({ type: "text", part: { type: "text", text: "done" } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
  ].join("\n");
  await fakeBin(
    bin,
    "codex",
    [
      `if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0 (fake)"; exit 0; fi`,
      `env > ${shq(join(rec, "codex-env"))}`,
      `echo '${codexStream.replace(/\$/g, "\\$")}'`,
    ].join("\n"),
  );
  await fakeBin(
    bin,
    "opencode",
    [
      `if [ "$1" = "--version" ]; then echo "opencode 2.0.26 (fake)"; exit 0; fi`,
      `env > ${shq(join(rec, "opencode-env"))}`,
      `echo '${opencodeStream.replace(/\$/g, "\\$")}'`,
    ].join("\n"),
  );
  const executor0 = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const workspaces = new Map<string, string>([["ws-0", work]]);
  let n = 0;
  const provider: ExecutorProvider = {
    isolated: true,
    async create() {
      const handle = `ws-${n++}`;
      const dir = await mkdtemp(join(tmpdir(), `h2-s1-ws-${handle}-`));
      workspaces.set(handle, dir);
      return { handle };
    },
    attach: (handle: string) => new LocalExecutor({ root: workspaces.get(handle) ?? handle, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } }),
  };
  void executor0;
  return {
    repo: `file://${bare}/owner/repo.git`,
    provider,
    envOf: async (id) => readFile(join(rec, `${id}-env`), "utf8"),
  };
}

test("worker: S1 across attempts — OPENAI_API_KEY stored for codex is not delivered to the opencode attempt", async () => {
  const policy = await policyFile([
    { host: "api.openai.com", class: "hosted", retention: "none" },
    { host: "api.z.ai", class: "hosted", retention: "none" },
  ]);
  const { repo, provider, envOf } = await attemptsFixture();
  const store = new MemoryHarnessCredentials(SEAL_ENV);
  await store.set({ project: "owner/repo", profile: "codex", envName: "OPENAI_API_KEY", value: "sk-s1-codex-only-key", actor: "t" });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({
      env: {
        SHIP_HARNESS_CRED: "on",
        SHIP_MODEL_ROUTING_POLICY: policy,
        SHIP_MODEL_ROUTING_DESTINATIONS: "api.openai.com,api.z.ai",
        // The opencode attempt's credential comes from the deployment env and
        // routes to api.z.ai only under a zhipu/zai model id.
        ZHIPU_API_KEY: "zh-s1",
        SHIP_HARNESS_MODEL_OPENCODE: "zhipu/glm-4",
      },
      credentials: harnessCredentialResolver(store),
    }),
  });
  const eventStore = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-s1",
    store: eventStore,
    input: {
      task: "t",
      repo,
      harness: { id: "codex", version: HARNESS_VERSIONS.codex! },
      harnessAttempts: [
        { id: "codex", version: HARNESS_VERSIONS.codex! },
        { id: "opencode", version: HARNESS_VERSIONS.opencode! },
      ],
      harnessCredentials: [{ project: "owner/repo", profile: "codex", envName: "OPENAI_API_KEY", version: 1 }],
      harnessDestinations: { codex: ["api.openai.com"], opencode: ["api.z.ai"] },
    },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const codexEnv = await envOf("codex");
  const opencodeEnv = await envOf("opencode");
  assert.ok(codexEnv.includes("OPENAI_API_KEY=sk-s1-codex-only-key"), "the codex attempt received its stored key");
  assert.ok(!opencodeEnv.includes("sk-s1-codex-only-key"), "the opencode attempt did not: a binding sealed for codex never crosses profiles by name");
  assert.ok(opencodeEnv.includes("ZHIPU_API_KEY=zh-s1"), "the opencode attempt did receive its own env-sourced credential");
  assert.ok(!JSON.stringify(await eventStore.load("run-h2-s1")).includes("sk-s1-codex-only-key"), "and the value is nowhere in the log");
});

// -------------------------------- H2 hardening: publish + snapshot exact-value scan

/**
 * A leaky fake `claude` for the publish/snapshot controls: dumps its env into
 * a file INSIDE the workspace (the `env > x` shape) and finishes cleanly.
 */
async function workspaceLeakingClaude(): Promise<{ bin: string; work: string }> {
  const bin = await mkdtemp(join(tmpdir(), "h2-leak2-bin-"));
  const work = await mkdtemp(join(tmpdir(), "h2-leak2-work-"));
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "done",
    session_id: "8c7c5f2e-9999-8888-7777-666655554444",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  await fakeBin(
    bin,
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "claude 2.1.246 (fake)"; exit 0; fi`,
      `env > agent-env-dump.txt`,
      `echo '${result.replace(/\$/g, "\\$")}'`,
    ].join("\n"),
  );
  return { bin, work };
}

test("publish: NEGATIVE CONTROL — a workspace carrying a forwarded credential value is refused at the push, by name", async () => {
  const bare = await mkdtemp(join(tmpdir(), "h2-push-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "h2-push-seed-"));
  const seeder = new LocalExecutor({ root: seed });
  await seeder.exec(`git init -q -b main . && git config user.email t@t && git config user.name t && printf 'hello\\n' > f.txt && git add -A && git commit -qm seed && git clone -q --bare . ${bare}/owner/repo.git`);
  const { bin, work } = await workspaceLeakingClaude();
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-PUBLISH-LEAK-9876" } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-push",
    store,
    input: { task: "t", repo: `file://${bare}/owner/repo.git`, harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const events = await store.load("run-h2-push");
  const push = events.find((e) => e.type === "step-completed" && e.name === "repo-push");
  const result = (push?.data as { result?: { kind?: string; message?: string } }).result;
  assert.equal(result?.kind, "refused", `the push refused: ${JSON.stringify(result)}`);
  assert.match(result?.message ?? "", /credential-material-in-workspace/);
  assert.match(result?.message ?? "", /ANTHROPIC_AUTH_TOKEN/);
  // The refusal names the credential and a count — never a filename (an
  // agent controls those) and never the value.
  assert.ok(!(result?.message ?? "").includes("agent-env-dump.txt"), "no filename in the refusal");
  assert.ok(!JSON.stringify(events).includes("sk-ant-PUBLISH-LEAK-9876"), "the value is never in the log");
  // The branch never left the sandbox: the bare repo has only the seed commit.
  const branches = await seeder.exec(`git --git-dir ${shq(join(bare, "owner/repo.git"))} for-each-ref --format='%(refname)' refs/heads`);
  assert.ok(!branches.stdout.includes("teploy/"), "no run branch was pushed");
});

test("thread snapshot: NEGATIVE CONTROL — a workspace carrying a forwarded credential value is not snapshotted", async () => {
  const { bin, work } = await workspaceLeakingClaude();
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const images = new Map<string, string>();
  const workspaces = new Map<string, string>();
  let n = 0;
  const provider: ExecutorProvider = {
    isolated: true,
    async create() {
      const handle = `ws-${n++}`;
      workspaces.set(handle, work);
      return { handle };
    },
    attach: () => executor,
    async snapshot(handle: string) {
      const image = `snap:${n++}`;
      images.set(image, workspaces.get(handle) ?? handle);
      return image;
    },
    async createFrom(image: string) {
      const handle = `ws-${n++}`;
      workspaces.set(handle, images.get(image) ?? image);
      return { handle };
    },
  };
  const cfg = new MemoryRuntimeConfig();
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-SNAP-LEAK-54321" } }),
    threadWarm: threadWarmStore(cfg),
    loadEvents: (runId) => store.load(runId),
  });
  const store = new MemoryEventStore();
  await store.append("run-snap-root", { v: 1, seq: 0, type: "run-started", at: "2026-10-18T00:00:00Z", data: { workflow: "coding-agent", input: { task: "root" } } });
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-h2-snap",
    store,
    input: { task: "t", warmThread: true, parentRunId: "run-snap-root", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const snap = (await store.load("run-h2-snap")).find((e) => e.type === "step-completed" && e.name === "thread-snapshot");
  const result = (snap?.data as { result?: { skipped?: string } }).result;
  assert.match(result?.skipped ?? "", /no snapshot: credential-material-in-workspace/);
  assert.match(result?.skipped ?? "", /ANTHROPIC_AUTH_TOKEN/);
  assert.equal(images.size, 0, "no image was ever taken");
  assert.equal(await cfg.get("thread-warm:run-snap-root"), undefined, "and nothing was recorded for the thread");
  assert.ok(!JSON.stringify(await store.load("run-h2-snap")).includes("sk-ant-SNAP-LEAK-54321"), "the value is never in the log");
});
