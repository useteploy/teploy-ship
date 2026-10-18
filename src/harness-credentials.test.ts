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
import { FileHarnessCredentials, MemoryHarnessCredentials, admitHarnessCredentials, harnessCredentialResolver, profileCredentialNames, resolveCredentialOverlay } from "./harness-credentials.js";
import type { HarnessCredentialRef } from "./harness-credentials.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
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
  assert.ok(!(await readFile(join(dir, "harness-credentials.json"), "utf8")).includes("enc:v1:"), "clear leaves no ciphertext behind");
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
  assert.deepEqual(out.refs, [
    { project: "tyler/repo", profile: "claude-code", envName: "ANTHROPIC_AUTH_TOKEN", version: 1 },
  ], "the credential-shaped binding is the reference; the base URL rides the overlay without becoming one");
  assert.deepEqual(out.envOverlay, { ANTHROPIC_AUTH_TOKEN: "tok-stored", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" });
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
  const input = inputOf(run.json()) as { sandboxEgressAllow?: string[]; harnessCredentials?: HarnessCredentialRef[] };
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai"], "the explicit bare host stands; the derived host:443 dedupes against it");
  assert.deepEqual(input.harnessCredentials, [{ project: project.repo, profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }]);
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
  const input = inputOf(run.json()) as { sandboxEgressAllow?: string[]; harnessCredentials?: HarnessCredentialRef[] };
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai:443"], "derived from the store's value, not the empty deployment env");
  assert.equal(input.harnessCredentials, undefined, "a base URL is delivered but is not a credential reference");
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
  // And the fingerprint does not move when the field IS present: it admits no step.
  const policy = await policyFile([...ZAI_ONLY]);
  const on = await enqueue({ ...PROD_ENV, SHIP_MODEL_ROUTING_POLICY: policy }, { runId: "r-on", repo: URL_ }, { projectStore: projects, credentials: store });
  const input = inputOf(on.json()) as Parameters<typeof stepFingerprint>[0];
  const without = { ...input } as Record<string, unknown>;
  delete without.harnessCredentials;
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

test("worker: no references means no resolution and no failure — a flag-off input is untouched", async () => {
  assert.deepEqual(await resolveCredentialOverlay(undefined, undefined), { overlay: {} });
  assert.deepEqual(await resolveCredentialOverlay([], { resolve: async () => ({ value: "x" }) }), { overlay: {} });
  const gone = await resolveCredentialOverlay([{ project: "p", profile: "claude-code", envName: "ANTHROPIC_API_KEY", version: 1 }], undefined);
  assert.equal(gone.failure !== undefined && /no credential store wired/.test(gone.failure), true);
});

// ------------------------------------------------------------------ misc units

test("profileCredentialNames: the forward list narrows what a profile asks for", () => {
  assert.deepEqual(profileCredentialNames("claude-code", {}), ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  assert.deepEqual(profileCredentialNames("claude-code", { SHIP_HARNESS_ENV: "ANTHROPIC_API_KEY" }), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(profileCredentialNames("native", {}), [], "the native loop takes no harness credential");
});
