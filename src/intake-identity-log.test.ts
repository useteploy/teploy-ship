import assert from "node:assert/strict";
import test from "node:test";

import { LocalAdmission } from "./admission.js";
import type { IntakeTask } from "./intake.js";
import type { Project } from "./projects.js";
import type { SpendStore } from "./spend.js";
import { sweepIntake, type IntakeSweepDeps } from "./worker.js";

const spend: SpendStore = {
  async record() {},
  async totalForDay() { return 0; },
  async list() { return []; },
} as unknown as SpendStore;

test("an unresolvable project identity is logged once per task, with the repo and the reason", async () => {
  const task: IntakeTask = {
    taskId: "t-legacy", source: "pr-watch", kind: "conflict", repo: "http://forge.example/Tyler/legacy.git",
    title: "PR #1 has merge conflicts with main", dedupeKey: "d1", state: "proposed",
    createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
  };
  // A url-less legacy record with the same slug: resolveProject refuses to guess.
  const legacy: Project = { repo: "tyler/legacy", autoMerge: false, autoDeploy: false };
  const logs: string[] = [];
  const deps: IntakeSweepDeps = {
    intake: { async list() { return [task]; }, async setState() {}, async claim() { return false; } },
    spend,
    admission: new LocalAdmission(),
    policies: { forgejo: "auto" },
    dailyAutoLimit: 10,
    maxConcurrentRuns: 10,
    budgetFor: () => 10,
    estimatedRunCostUSD: 0.5,
    projects: { async list() { return [legacy]; } } as unknown as NonNullable<IntakeSweepDeps["projects"]>,
    inFlight: new Map(),
    outcomeOf: async () => ({ terminal: false }),
    newRunId: () => "run-x",
    launch: async () => { assert.fail("must not launch"); },
    now: () => new Date("2026-10-18T12:00:00Z"),
    log: (line) => logs.push(line),
  };
  await sweepIntake(deps);
  await sweepIntake(deps);
  await sweepIntake(deps);
  const lines = logs.filter((l) => l.includes("identity unresolved"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /http:\/\/forge\.example\/Tyler\/legacy\.git/);
  assert.match(lines[0]!, /conflicts with project tyler\/legacy/);
});
