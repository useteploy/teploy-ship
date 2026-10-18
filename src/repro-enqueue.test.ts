/**
 * EV6 (SHIP_INCIDENT_FIX): the enqueue-side materialisation. runtime.ts owns
 * the flag read (incidents.ts never touches env), so these tests pin the
 * three behaviours the programme row names:
 *
 *   - flag on: a remediation enqueue records `requireReproTest`, and the
 *     gates that hold its outcome (changeClass, mergeGate) come with it;
 *   - flag off: the option is DROPPED — no input field, and the recorded
 *     input's JSON carries no repro vocabulary at all (byte-identical);
 *   - the task text says the reproducing test is the deliverable, because a
 *     gate the agent does not know about is a gate that holds everything.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { enqueueRun, fileRuntime } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { admittedSteps } from "./step-fingerprint.js";

async function runtimeIn(env: Record<string, string | undefined>): Promise<{ runtime: ShipRuntime; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "ship-repro-enqueue-"));
  const saved = { ...process.env } as Record<string, string | undefined>;
  process.env.TEPLOY_SHIP_STATE = dir;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    runtime: fileRuntime(),
    restore: () => {
      for (const key of Object.keys({ ...env, TEPLOY_SHIP_STATE: "" })) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}

async function recordedInput(runtime: ShipRuntime, runId: string): Promise<Record<string, unknown>> {
  const started = (await runtime.store.load(runId)).find((e) => e.type === "run-started");
  return ((started?.data as { input?: Record<string, unknown> })?.input ?? {}) as Record<string, unknown>;
}

test("SHIP_INCIDENT_FIX=on: a remediation enqueue records requireReproTest and the gates that hold it", async () => {
  const { runtime, restore } = await runtimeIn({ SHIP_INCIDENT_FIX: "on" });
  try {
    await enqueueRun(runtime, { runId: "run-rem-on", task: "remediate the incident", model: "m", repo: "https://git.example.com/tyler/web.git", requireReproTest: true });
    const input = await recordedInput(runtime, "run-rem-on");
    assert.equal(input.requireReproTest, true);
    assert.equal(input.changeClass, true, "the class gate is implied — the boundary park needs a verdict");
    assert.equal(input.mergeGate, true, "and the boundary park itself: the outcome has to hold somewhere");
    assert.match(String(input.task), /gated on a reproducing test/, "the agent is told the deliverable");
    assert.ok(admittedSteps(input as never).includes("step:repro-test"), "the recorded input admits the step");

    // A plain enqueue under the same flag is untouched: the gate rides the
    // remediation option, not the deployment.
    await enqueueRun(runtime, { runId: "run-plain-on", task: "t", model: "m" });
    const plain = await recordedInput(runtime, "run-plain-on");
    assert.equal("requireReproTest" in plain, false);
    assert.ok(!admittedSteps(plain as never).includes("step:repro-test"));
  } finally {
    restore();
  }
});

test("SHIP_INCIDENT_FIX off: the option is dropped — no field, no step, no task note", async () => {
  const { runtime, restore } = await runtimeIn({ SHIP_INCIDENT_FIX: undefined });
  try {
    await enqueueRun(runtime, { runId: "run-rem-off", task: "remediate the incident", model: "m", repo: "https://git.example.com/tyler/web.git", requireReproTest: true });
    const started = (await runtime.store.load("run-rem-off")).find((e) => e.type === "run-started");
    const raw = JSON.stringify((started?.data as { input?: unknown })?.input);
    assert.ok(!raw.includes("requireReproTest"), "no field");
    assert.ok(!raw.includes("reproducing test"), "no prompt vocabulary either — byte-identical to pre-EV6");
    assert.ok(!admittedSteps((await recordedInput(runtime, "run-rem-off")) as never).includes("step:repro-test"));
  } finally {
    restore();
  }
});

test("a remediation cannot opt out of the gates it needs to hold its outcome", async () => {
  const { runtime, restore } = await runtimeIn({ SHIP_INCIDENT_FIX: "on" });
  try {
    await assert.rejects(
      () => enqueueRun(runtime, { runId: "run-rem-gates", task: "t", model: "m", requireReproTest: true, mergeGate: false }),
      /cannot be enqueued with the change-class or merge gate disabled/,
    );
  } finally {
    restore();
  }
});
