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
