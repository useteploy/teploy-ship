import assert from "node:assert/strict";
import { test } from "node:test";

import { HARNESS_PACKAGES } from "./harness.js";
import { HARNESS_RECORD_FLAG, harnessIdentity, harnessRecordEnabled } from "./harness-identity.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

type Started = { type: string; at?: string; data: Record<string, unknown> };

function captureRuntime(): { runtime: ShipRuntime; started: Started[] } {
  const started: Started[] = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (_runId: string, event: Started) => {
        if (event.type === "run-started") started.push(event);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  return { runtime, started };
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const QUIET = { SHIP_TESTS: undefined, SHIP_TELEMETRY: undefined, SHIP_PREVIEW: undefined, SHIP_TEST_DETECT: "0", SHIP_HARNESS_ATTEMPTS: undefined };

async function enqueue(env: Record<string, string | undefined>, runId = "run-id") {
  return withEnv({ ...QUIET, ...env }, async () => {
    const { runtime, started } = captureRuntime();
    await enqueueRun(runtime, { runId, task: "t", model: "ship-model", repo: "tyler/a" });
    const event = started[0]!;
    delete event.at; // wall clock
    return event;
  });
}

test("the flag is on only for an explicit on/1/true", () => {
  assert.equal(harnessRecordEnabled({}), false);
  for (const v of ["", "0", "off", "no", "yes", "enabled"]) assert.equal(harnessRecordEnabled({ [HARNESS_RECORD_FLAG]: v }), false, v);
  for (const v of ["on", "ON", "1", "true", " on "]) assert.equal(harnessRecordEnabled({ [HARNESS_RECORD_FLAG]: v }), true, v);
});

test("identity: native records Ship's model and no vendor revision", () => {
  const id = harnessIdentity({ harness: { id: "native", version: "1" }, shipModel: "ship-model", env: {} });
  assert.deepEqual(id.harness, { id: "native", adapterVersion: "1" });
  assert.deepEqual(id.model, { ship: "ship-model", harness: null });
  assert.equal(id.expectedRevision, null);
  assert.deepEqual(id.configuration.forwardedEnvNames, []);
});

test("identity: an external harness records the harness model, expected revision and configuration, names only", () => {
  const env = { SHIP_HARNESS_MODEL: "sonnet", SHIP_HARNESS_TIMEOUT_MS: "60000", ANTHROPIC_API_KEY: "sk-ant-never-recorded" };
  const id = harnessIdentity({ harness: { id: "claude-code", version: "1" }, shipModel: "ship-model", env });
  assert.equal(id.model.harness, "sonnet");
  assert.deepEqual(id.expectedRevision, { npm: HARNESS_PACKAGES["claude-code"]!.npm, version: HARNESS_PACKAGES["claude-code"]!.version });
  assert.equal(id.configuration.timeoutMs, 60000);
  assert.ok(id.configuration.forwardedEnvNames.includes("ANTHROPIC_API_KEY"));
  assert.ok(!JSON.stringify(id).includes("sk-ant-never-recorded"), "a credential value is never part of the identity");
  // The digest moves with the configuration and with nothing else.
  const same = harnessIdentity({ harness: { id: "claude-code", version: "1" }, shipModel: "other-ship-model", env: { ...env, ANTHROPIC_API_KEY: "different" } });
  assert.equal(same.configuration.digest, id.configuration.digest);
  assert.notEqual(harnessIdentity({ harness: { id: "claude-code", version: "1" }, shipModel: "m", env: { ...env, SHIP_HARNESS_MODEL: "opus" } }).configuration.digest, id.configuration.digest);
  assert.notEqual(harnessIdentity({ harness: { id: "claude-code", version: "1" }, shipModel: "m", env: { ...env, SHIP_CLAUDE_BARE: "1" } }).configuration.digest, id.configuration.digest);
});

test("identity: multi-attempt runs record every harness they may execute under", () => {
  const id = harnessIdentity({
    harness: { id: "native", version: "1" },
    attempts: [{ id: "claude-code", version: "1" }, { id: "opencode", version: "1" }],
    shipModel: "m",
    env: {},
  });
  assert.deepEqual(id.attempts?.map((a) => a.id), ["claude-code", "opencode"]);
});

test("enqueue, flag off: the recorded run-started event carries no identity (default behaviour unchanged)", async () => {
  const off = await enqueue({ [HARNESS_RECORD_FLAG]: undefined });
  assert.ok(!("harnessIdentity" in off.data));
  assert.deepEqual(Object.keys(off.data).sort(), ["input", "stepFingerprint", "taskRootRunId", "workflow"]);
  for (const v of ["off", "0", ""]) assert.equal(JSON.stringify(await enqueue({ [HARNESS_RECORD_FLAG]: v })), JSON.stringify(off), `flag=${v}`);
});

test("enqueue, flag on: identity is added beside the input and nothing else in the event changes", async () => {
  const off = await enqueue({ [HARNESS_RECORD_FLAG]: undefined, SHIP_HARNESS: "claude-code", SHIP_HARNESS_MODEL: "sonnet" });
  const on = await enqueue({ [HARNESS_RECORD_FLAG]: "on", SHIP_HARNESS: "claude-code", SHIP_HARNESS_MODEL: "sonnet" });
  const { harnessIdentity: recorded, ...rest } = on.data as { harnessIdentity: ReturnType<typeof harnessIdentity> } & Record<string, unknown>;
  // Byte-identical once the one additive key is set aside: same input, same
  // fingerprint, so no step sequence and no stored shape moved.
  assert.equal(JSON.stringify({ ...on, data: rest }), JSON.stringify(off));
  assert.equal(recorded.harness.id, "claude-code");
  assert.equal(recorded.model.ship, "ship-model");
  assert.equal(recorded.model.harness, "sonnet");
  assert.equal(recorded.expectedRevision?.version, HARNESS_PACKAGES["claude-code"]!.version);
});
