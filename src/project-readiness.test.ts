import assert from "node:assert/strict";
import { test } from "node:test";
import { projectReadinessKey } from "./project-readiness.js";
test("readiness survives cosmetic edits but expires when execution configuration changes", () => {
  const project = { repo: "team/site", autoMerge: false, autoDeploy: false, testCommand: "pnpm test" };
  const key = projectReadinessKey(project);
  assert.equal(key, projectReadinessKey({ ...project, label: "New display name" }));
  assert.notEqual(key, projectReadinessKey({ ...project, testCommand: "pnpm test:integration" }));
  assert.notEqual(key, projectReadinessKey({ ...project, sandboxImage: "new-image" }));
  assert.notEqual(key, projectReadinessKey({ ...project, preparation: { command: "pnpm install", timeoutMs: 300000 } }));
  assert.notEqual(key, projectReadinessKey({ ...project, sandboxUser: "root" }), "a suite can pass as root and fail as the sandbox user");
  assert.equal(key, projectReadinessKey({ ...project, sandboxUser: undefined }), "no opt-in leaves every existing key as it was");
});
