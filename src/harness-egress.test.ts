import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { providerEgressAllow, withProviderEgress } from "./harness-external.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { stepFingerprint } from "./step-fingerprint.js";
import { FileProjectStore } from "./projects.js";

/**
 * Provider egress for external harnesses (docs/adapters.md "Egress for
 * external harnesses"). An external harness calls its model vendor from
 * INSIDE the sandbox, so the vendor host has to be on the run's own
 * sandboxEgressAllow or every model call dies at the proxy — the production
 * failure of 2026-10-17 (`egress denied by the sandbox allowlist:
 * api.z.ai:443` under ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic,
 * fixed by hand until this derivation existed). These tests hold the
 * derivation, the enqueue materialisation (merged with the project's own
 * list), and the fence: nothing derived ⇒ byte-identical inputs and an
 * unmoved step fingerprint, for native runs and external runs alike.
 */

/** Every env var the derivation or the enqueue path could read. */
const PROVIDER_ENV = [
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
] as const;

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const names = [...PROVIDER_ENV, ...Object.keys(values)];
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

/**
 * Enqueue under a controlled env and return the recorded inputs' JSON, one
 * per run — the exact bytes the log will carry.
 */
async function enqueueInputs(
  env: Record<string, string | undefined>,
  runs: Array<{ runId: string; repo?: string; mode?: "scan" }>,
  projectStore?: FileProjectStore,
): Promise<string[]> {
  return withEnv(env, async () => {
    const started: Started[] = [];
    const runtime = {
      kind: "file",
      evidence: { forRepo: async () => null },
      projects: projectStore ?? { list: async () => [], forRepo: async () => null },
      governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
      store: {
        append: async (_runId: string, event: Started) => {
          if (event.type === "run-started") started.push(event);
        },
      },
      saveMeta: async () => {},
    } as unknown as ShipRuntime;
    for (const run of runs) {
      await enqueueRun(runtime, {
        runId: run.runId,
        task: "t",
        model: "m",
        ...(run.repo !== undefined ? { repo: run.repo } : {}),
        ...(run.mode !== undefined ? { mode: run.mode } : {}),
      });
    }
    return started.map((e) => JSON.stringify((e.data.input as Record<string, unknown>)));
  });
}

function inputOf(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

// ------------------------------------------------------------- the derivation

test("derivation: claude under ANTHROPIC_BASE_URL derives that host — the 2026-10-17 production finding", () => {
  const derived = providerEgressAllow([{ id: "claude-code" }], {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_API_KEY: "sk-ant-x",
  });
  assert.deepEqual(derived, ["api.z.ai:443"], "the base URL's host replaces the vendor default; path and scheme are dropped");
});

test("derivation: claude with a forwarded key and no base URL derives the vendor default; OAuth alone derives nothing", () => {
  assert.deepEqual(providerEgressAllow([{ id: "claude-code" }], { ANTHROPIC_API_KEY: "sk-ant-x" }), ["api.anthropic.com:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "claude-code" }], { ANTHROPIC_AUTH_TOKEN: "tok" }), ["api.anthropic.com:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "claude-code" }], { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" }), []);
});

test("derivation: opencode derives api.z.ai for the z.ai key only when the model routes there", () => {
  const zai = { ZHIPU_API_KEY: "z", SHIP_HARNESS_MODEL_OPENCODE: "zai-coding-plan/glm-5.3" };
  assert.deepEqual(providerEgressAllow([{ id: "opencode" }], zai), ["api.z.ai:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "opencode" }], { ...zai, SHIP_HARNESS_MODEL_OPENCODE: "zhipu/glm-4.6" }), ["api.z.ai:443"]);
  // The shared SHIP_HARNESS_MODEL is read too, and a model elsewhere routes nothing to z.ai.
  assert.deepEqual(providerEgressAllow([{ id: "opencode" }], { ZHIPU_API_KEY: "z", SHIP_HARNESS_MODEL: "zai-coding-plan/glm-5.3" }), ["api.z.ai:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "opencode" }], { ...zai, SHIP_HARNESS_MODEL_OPENCODE: "anthropic/claude-4" }), []);
  assert.deepEqual(providerEgressAllow([{ id: "opencode" }], { ZHIPU_API_KEY: "z" }), [], "no model named: which provider the key serves is a guess Ship does not make");
});

test("derivation: opencode derives each key's vendor host; a forwarded base URL reroutes its vendor default", () => {
  assert.deepEqual(
    providerEgressAllow([{ id: "opencode" }], { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", OPENROUTER_API_KEY: "r" }),
    ["api.anthropic.com:443", "api.openai.com:443", "openrouter.ai:443"],
  );
  // ANTHROPIC_BASE_URL is not on opencode's default forward list — it only
  // reaches the harness (and so only counts here) when SHIP_HARNESS_ENV
  // forwards it.
  assert.deepEqual(
    providerEgressAllow([{ id: "opencode" }], { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "https://proxy.internal/anthropic", SHIP_HARNESS_ENV: "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL" }),
    ["proxy.internal:443"],
  );
  assert.deepEqual(
    providerEgressAllow([{ id: "opencode" }], { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "https://proxy.internal/anthropic" }),
    ["api.anthropic.com:443"],
    "a base URL the harness never sees selects nothing",
  );
});

test("derivation: codex with a gateway derives the gateway host; with a key it derives OpenAI", () => {
  assert.deepEqual(
    providerEgressAllow([{ id: "codex" }], { AI_GATEWAY_URL: "https://gw.teploy.internal:8443/v1", AI_GATEWAY_KEY: "k", CODEX_API_KEY: "k2" }),
    ["gw.teploy.internal:8443"],
    "the gateway wins over the vendor default, and its own port is kept — the daemon admits 80/443 only when portless",
  );
  assert.deepEqual(providerEgressAllow([{ id: "codex" }], { CODEX_API_KEY: "k" }), ["api.openai.com:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "codex" }], { OPENAI_API_KEY: "k" }), ["api.openai.com:443"]);
  assert.deepEqual(providerEgressAllow([{ id: "codex" }], { CODEX_ACCESS_TOKEN: "chatgpt" }), [], "the subscription token names no host Ship can honestly derive");
});

test("derivation: a broken base URL derives nothing and still suppresses the vendor default it replaces", () => {
  assert.deepEqual(providerEgressAllow([{ id: "claude-code" }], { ANTHROPIC_BASE_URL: "not a url", ANTHROPIC_API_KEY: "k" }), []);
});

test("derivation: native derives nothing however the env is loaded; multi-harness derives the union", () => {
  const loaded = {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    OPENROUTER_API_KEY: "r",
    ZHIPU_API_KEY: "z",
    CODEX_API_KEY: "c",
    AI_GATEWAY_URL: "https://gw.internal",
    SHIP_HARNESS_MODEL_OPENCODE: "zai-coding-plan/glm-5.3",
  };
  assert.deepEqual(providerEgressAllow([{ id: "native" }], loaded), [], "the native loop calls the model from the worker, outside every sandbox");
  assert.deepEqual(providerEgressAllow([{ id: "native" }, { id: "claude-code" }, { id: "codex" }], loaded), [
    "api.z.ai:443",
    "gw.internal:443",
  ], "each attempt's harness contributes its provider host; the gateway replaces OpenAI for codex, the base URL replaces Anthropic for claude");
});

test("derivation: only variables the harness actually forwards count (SHIP_HARNESS_ENV narrows it)", () => {
  const env = { ANTHROPIC_API_KEY: "a", SHIP_HARNESS_ENV: "CLAUDE_CODE_OAUTH_TOKEN" };
  assert.deepEqual(providerEgressAllow([{ id: "claude-code" }], env), [], "a key the harness never sees selects nothing");
});

// ------------------------------------------------------------------ the merge

test("merge: project entries survive, a derived host:443 beside a hand-added bare host is skipped, exact dupes collapse", () => {
  const refs = [{ id: "claude-code" }];
  const env = () => ({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" });
  assert.deepEqual(withProviderEgress(undefined, refs, env), ["api.z.ai:443"]);
  assert.deepEqual(withProviderEgress(["rubygems.org"], refs, env), ["rubygems.org", "api.z.ai:443"]);
  assert.deepEqual(withProviderEgress(["api.z.ai"], refs, env), ["api.z.ai"], "the portless project entry already admits 443");
  assert.deepEqual(withProviderEgress(["api.z.ai:443"], refs, env), ["api.z.ai:443"], "normalised dedupe");
  assert.deepEqual(withProviderEgress(["rubygems.org"], [{ id: "native" }], env), ["rubygems.org"], "nothing derived: the explicit list returns unchanged");
  assert.equal(withProviderEgress(undefined, [{ id: "native" }], env), undefined);
});

// ------------------------------------------------- enqueue materialisation + fence

const CLAUDE_EXTERNAL = { SHIP_HARNESS: "claude-code", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_API_KEY: "sk-ant-x" } as const;

test("enqueue: a claude-code run records api.z.ai:443 in its input, merged after the project's own entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-egress-"));
  const projects = new FileProjectStore(dir);
  const TS_URL = "http://100.108.123.49:49152/Tyler/ship-ts";
  await projects.set({ repo: TS_URL, url: TS_URL, sandboxEgressAllow: ["rubygems.org", "api.z.ai"], autoMerge: false, autoDeploy: false });
  const json = await enqueueInputs({ ...CLAUDE_EXTERNAL }, [{ runId: "r1", repo: TS_URL }], projects);
  const input = inputOf(json[0]!) as { harness?: { id: string }; sandboxEgressAllow?: string[] };
  assert.equal(input.harness!.id, "claude-code");
  assert.deepEqual(input.sandboxEgressAllow, ["rubygems.org", "api.z.ai"], "explicit entries first; the derived host:443 dedupes against the bare host the project already carries");
});

test("enqueue: harness and derived hosts are both on the record; a scan derives too; a project without a list gets only the derived host", async () => {
  const json = await enqueueInputs(
    { ...CLAUDE_EXTERNAL },
    [
      { runId: "r1", repo: "https://git.example.com/tyler/a" },
      { runId: "r2", repo: "https://git.example.com/tyler/a", mode: "scan" },
    ],
  );
  const input = inputOf(json[0]!) as { harness?: { id: string }; sandboxEgressAllow?: string[] };
  assert.equal(input.harness!.id, "claude-code");
  assert.deepEqual(input.sandboxEgressAllow, ["api.z.ai:443"]);
  const scan = inputOf(json[1]!) as { sandboxEgressAllow?: string[] };
  assert.deepEqual(scan.sandboxEgressAllow, ["api.z.ai:443"], "a scan runs the harness in the sandbox the same way");
});

test("enqueue: native inputs stay byte-identical however the provider env is loaded", async () => {
  const clean = await enqueueInputs({}, [{ runId: "r1", repo: "https://git.example.com/tyler/a" }]);
  const loaded = await enqueueInputs(
    {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      ZHIPU_API_KEY: "z",
      CODEX_API_KEY: "c",
      AI_GATEWAY_URL: "https://gw.internal",
      SHIP_HARNESS_MODEL_OPENCODE: "zai-coding-plan/glm-5.3",
    },
    [{ runId: "r1", repo: "https://git.example.com/tyler/a" }],
  );
  assert.equal(loaded[0], clean[0], "no key the pre-change input did not carry: nothing is derived for native");
  assert.ok(!("sandboxEgressAllow" in inputOf(clean[0]!)));
});

test("enqueue: an external run with nothing derivable stays byte-identical to the same run on a clean env", async () => {
  const clean = await enqueueInputs({ SHIP_HARNESS: "claude-code" }, [{ runId: "r1", repo: "https://git.example.com/tyler/a" }]);
  const oauthOnly = await enqueueInputs(
    { SHIP_HARNESS: "claude-code", CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    [{ runId: "r1", repo: "https://git.example.com/tyler/a" }],
  );
  assert.equal(oauthOnly[0], clean[0], "an OAuth subscription names no host this derivation is allowed to guess");
  assert.ok(!("sandboxEgressAllow" in inputOf(oauthOnly[0]!)));
});

test("enqueue: the derived field admits no step — the fingerprint does not move", async () => {
  const json = await enqueueInputs({ ...CLAUDE_EXTERNAL }, [{ runId: "r1", repo: "https://git.example.com/tyler/a" }]);
  const input = inputOf(json[0]!) as Parameters<typeof stepFingerprint>[0];
  const without = { ...input } as Record<string, unknown>;
  delete without.sandboxEgressAllow;
  assert.equal(stepFingerprint(input), stepFingerprint(without as Parameters<typeof stepFingerprint>[0]));
});

test("enqueue: the derived host reaches the daemon's create body through the recorded input", async () => {
  const { sandboxOverridesOf, sandboxProvider } = await import("./durable.js");
  const json = await enqueueInputs({ ...CLAUDE_EXTERNAL }, [{ runId: "r1", repo: "https://git.example.com/tyler/a" }]);
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ runId: "sbx-1", id: "sbx-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "node:22", network: "allowlist", fetch: fetchImpl });
  await provider.create(sandboxOverridesOf(inputOf(json[0]!) as never));
  assert.equal(bodies[0]!.network, "egress");
  assert.deepEqual(bodies[0]!.egressAllow, ["api.z.ai:443"], "the derived provider host is on the wire the proxy allowlist reads");
});
