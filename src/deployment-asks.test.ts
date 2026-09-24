import assert from "node:assert/strict";
import { test } from "node:test";

import { DEPLOYMENT_ASKS_KEY, askEnv, asksFromEnv, enqueueTestsLine, publishDeploymentAsks, readDeploymentAsks } from "./deployment-asks.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

function captureRuntime(config: MemoryRuntimeConfig | undefined): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    ...(config !== undefined ? { config } : {}),
    evidence: { forRepo: async () => null },
    projects: { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") inputs.push(event.data!.input!);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  return { runtime, inputs };
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const QUIET = { SHIP_TESTS: undefined, SHIP_TELEMETRY: undefined, SHIP_PREVIEW: undefined, SHIP_TEST_DETECT: "0" };

test("asks: only the three evidence asks are published, empty values dropped", () => {
  assert.deepEqual(asksFromEnv({ SHIP_TESTS: "1", SHIP_TELEMETRY: "", SHIP_GIT_TOKEN: "secret", SHIP_PREVIEW: " 0 " }), {
    SHIP_TESTS: "1",
    SHIP_PREVIEW: "0",
  });
});

test("asks: publish writes the worker's values, and an env with none removes the record", async () => {
  const config = new MemoryRuntimeConfig();
  await publishDeploymentAsks(config, { SHIP_TESTS: "1" });
  assert.deepEqual(await readDeploymentAsks(config), { SHIP_TESTS: "1" });
  // Unsetting SHIP_TESTS and redeploying must stop the inheritance.
  await publishDeploymentAsks(config, {});
  assert.equal(await config.get(DEPLOYMENT_ASKS_KEY), undefined);
  assert.deepEqual(await readDeploymentAsks(config), {});
});

test("asks: a damaged or foreign record reads as no record, never throws", async () => {
  const config = new MemoryRuntimeConfig();
  await config.set(DEPLOYMENT_ASKS_KEY, "{not json");
  assert.deepEqual(await readDeploymentAsks(config), {});
  await config.set(DEPLOYMENT_ASKS_KEY, JSON.stringify({ SHIP_TESTS: 1, SHIP_GIT_TOKEN: "x", SHIP_TELEMETRY: "1" }));
  assert.deepEqual(await readDeploymentAsks(config), { SHIP_TELEMETRY: "1" });
  assert.deepEqual(await readDeploymentAsks(undefined), {});
});

test("asks: the enqueueing shell's own value wins over the published one, including an explicit off", () => {
  assert.equal(askEnv({ SHIP_TESTS: "1" }, {}).SHIP_TESTS, "1");
  assert.equal(askEnv({ SHIP_TESTS: "1" }, { SHIP_TESTS: "0" }).SHIP_TESTS, "0");
  assert.equal(askEnv({}, { SHIP_TESTS: "1" }).SHIP_TESTS, "1");
});

// F9 pin (fresh-machine pass, run-b986b39b): `teploy secret set SHIP_TESTS=1`
// reaches the containers only, so a CLI enqueue from an operator's shell used
// to record no ask and the PR carried no Verification section, silently.
test("F9: a CLI enqueue with no SHIP_TESTS in its shell inherits the deployment's published ask", async () => {
  await withEnv(QUIET, async () => {
    const config = new MemoryRuntimeConfig();
    await publishDeploymentAsks(config, { SHIP_TESTS: "1", SHIP_TELEMETRY: "1" });
    const { runtime, inputs } = captureRuntime(config);
    const report = await enqueueRun(runtime, { runId: "run-f9a", task: "t", model: "m", repo: "tyler/a" });
    assert.equal(inputs[0]!.tests, true, "the deployment's SHIP_TESTS=1 reached the recorded input");
    assert.equal(inputs[0]!.telemetry, true);
    assert.equal(inputs[0]!.testsFeedback, true, "the baseline + finish gate follow the ask as they do for env");
    assert.deepEqual(report, { tests: true });
  });
});

test("F9: an explicit SHIP_TESTS=0 in the enqueueing shell still opts out", async () => {
  await withEnv({ ...QUIET, SHIP_TESTS: "0" }, async () => {
    const config = new MemoryRuntimeConfig();
    await publishDeploymentAsks(config, { SHIP_TESTS: "1" });
    const { runtime, inputs } = captureRuntime(config);
    await enqueueRun(runtime, { runId: "run-f9b", task: "t", model: "m", repo: "tyler/a" });
    assert.equal(inputs[0]!.tests, undefined);
  });
});

test("F9: nothing published and nothing in the shell stays exactly as before (no ask)", async () => {
  await withEnv(QUIET, async () => {
    const { runtime, inputs } = captureRuntime(new MemoryRuntimeConfig());
    const report = await enqueueRun(runtime, { runId: "run-f9c", task: "t", model: "m", repo: "tyler/a" });
    assert.equal(inputs[0]!.tests, undefined);
    assert.deepEqual(report, { tests: false });
    // A runtime with no config store at all (older capture mocks) behaves the same.
    const bare = captureRuntime(undefined);
    await enqueueRun(bare.runtime, { runId: "run-f9d", task: "t", model: "m", repo: "tyler/a" });
    assert.equal(bare.inputs[0]!.tests, undefined);
  });
});

test("F9: the enqueue line says out loud when no suite will run, and what will run otherwise", () => {
  assert.match(enqueueTestsLine({ tests: false }), /NOT asked/);
  assert.match(enqueueTestsLine({ tests: false }), /--tests/);
  assert.match(enqueueTestsLine({ tests: true, testCommand: "npm ci && npm test", testCommandSource: "detected" }), /npm ci && npm test.*detected/);
  assert.match(enqueueTestsLine({ tests: true }), /worker detects one from its checkout/);
});
