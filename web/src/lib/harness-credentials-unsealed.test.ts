import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * H2 web-side fail-closed control: with SHIP_CONFIG_KEY unset the route's
 * store action is refused with the fix in the message, and nothing lands in
 * the state file. A separate file because the web runtime captures the
 * process env at import time (its own process per test file).
 */
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-h2-web-unsealed-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "h2-web-tests-unsealed";
process.env.SHIP_HARNESS_CRED = "on";
delete process.env.SHIP_CONFIG_KEY;

const { shipRuntime } = await import("./store.server.js");
const projectsRoute = await import("../routes/projects.js");

const REPO_URL = "https://git.example.com/team/unsealed";
const VALUE = "sk-ant-UNSEALEDCANARY";

test("NEGATIVE CONTROL — storing through the UI is refused while encryption is not configured", async () => {
  const runtime = await shipRuntime();
  const url = REPO_URL;
  await runtime.projects.set({ repo: url, url, autoMerge: false, autoDeploy: false });
  const refused = await projectsRoute.action({
    request: new Request("http://localhost/projects", {
      method: "POST",
      headers: { authorization: "Bearer h2-web-tests-unsealed" },
      body: new URLSearchParams({ repo: url, intent: "credential-set", credProfile: "claude-code", credEnvName: "ANTHROPIC_API_KEY", credValue: VALUE }),
    }),
  });
  const location = decodeURIComponent(refused.headers.get("location") ?? "");
  assert.match(location, /SHIP_CONFIG_KEY/, "the refusal names the fix");
  assert.ok(!location.includes(VALUE), "and never echoes the value");
  const project = await runtime.projects.forRepo(url);
  assert.ok(project !== null);
  assert.deepEqual(await runtime.harnessCredentials?.presence(project.repo) ?? [], [], "nothing was stored");
});
