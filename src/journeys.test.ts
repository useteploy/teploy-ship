import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueRun, type ShipRuntime } from "./runtime.js";
import { intakeJourney } from "./journeys.js";
import { scanPrompt } from "./prompt.js";

test("non-change journeys force non-publishing scan inputs even when caller asks for fix/merge", async () => {
  const inputs: any[] = [];
  const runtime = {
    kind: "file",
    projects: { forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: { append: async (_: string, e: any) => { if (e.type === "run-started") inputs.push(e.data.input); } },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  for (const journey of ["investigate", "plan", "review"] as const) {
    await enqueueRun(runtime, { runId: journey, task: "Explain signup", model: "test", journey, mode: "fix", plan: true, autoMerge: true });
    const input = inputs.at(-1);
    assert.equal(input.mode, "scan");
    assert.equal(input.journey, journey);
    assert.equal(input.userMessage, "Explain signup");
    assert.notEqual(input.plan, true);
    assert.notEqual(input.autoMerge, true);
    assert.notEqual(input.autoDeploy, true);
    assert.notEqual(input.requireEdit, true);
  }
});
test("approved requests retain intent and legacy workflow plans still mean plan approval", () => {
  assert.deepEqual(intakeJourney("request-plan"), { journey: "plan", mode: "scan" });
  assert.deepEqual(intakeJourney("workflow-plan"), { plan: true });
  assert.throws(() => intakeJourney("request-unknown"));
  const prompt = scanPrompt({ task: "Explain signup", journey: "investigate" });
  assert.match(prompt, /Answer the request/);
  assert.doesNotMatch(prompt, /What to scan for/);
});

test("project plan approval cannot be bypassed by source, small wording or per-run false", async () => {
  const inputs: any[] = [];
  let required = true;
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { forRepo: async () => ({ repo: "team/app", requirePlanReview: required, harness: "native", autoMerge: false, autoDeploy: false }) },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: { append: async (_: string, e: any) => { if (e.type === "run-started") inputs.push(e.data.input); } },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  for (const source of ["manual", "team-request", "github", "workflow"]) {
    await enqueueRun(runtime, { runId: `floor-${source}`, task: "Just change the price to $1", model: "test", repo: "https://github.com/team/app", source, plan: false, journey: "change" });
    assert.equal(inputs.at(-1).plan, true);
    assert.notEqual(inputs.at(-1).autoMerge, true);
    assert.notEqual(inputs.at(-1).autoDeploy, true);
  }
  for (const journey of ["plan", "investigate", "review"] as const) {
    await enqueueRun(runtime, { runId: `read-${journey}`, task: "Explain prices", model: "test", repo: "https://github.com/team/app", journey });
    assert.equal(inputs.at(-1).mode, "scan");
    assert.notEqual(inputs.at(-1).plan, true, "read-only result does not wait for permission to implement");
  }
  const count = inputs.length;
  await assert.rejects(enqueueRun(runtime, { runId: "unsupported", task: "Change wording", model: "test", repo: "https://github.com/team/app", harness: "claude-code", plan: false }), /required project checkpoint/);
  assert.equal(inputs.length, count, "unsupported executor never receives a launch event");
  required = false;
  await enqueueRun(runtime, { runId: "unchanged-default", task: "Change wording", model: "test", repo: "https://github.com/team/app", plan: false });
  assert.notEqual(inputs.at(-1).plan, true, "existing opt-in default is preserved");
  assert.equal(inputs[0].plan, true, "policy change cannot rewrite recorded input");
});
