import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * H2 web-side negative controls: the Projects route's sealed-credential
 * actions. A principal without the `policies` grant cannot set or clear a
 * credential (the same grant every other project setting answers to), an
 * admin can, and the value never rides a redirect — the only responses the
 * action produces are locations and error text, none of which see it.
 */
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-h2-web-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "h2-web-tests";
process.env.SHIP_HARNESS_CRED = "on";
process.env.SHIP_CONFIG_KEY = "h2-web-test-key";

const { shipRuntime } = await import("./store.server.js");
const projectsRoute = await import("../routes/projects.js");

const REPO_URL = "https://git.example.com/team/creds";
const STORED = "sk-ant-WEBSTORED-4242424242";

function request(path: string, fields: Record<string, string>, auth = true) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: auth ? { authorization: "Bearer h2-web-tests" } : {},
    body: new URLSearchParams(fields),
  });
}

async function presenceOf(repo: string) {
  const runtime = await shipRuntime();
  const project = await runtime.projects.forRepo(repo);
  assert.ok(project !== null);
  return runtime.harnessCredentials?.presence(project.repo) ?? [];
}

test("an admin stores and clears a sealed harness credential through the project page", async () => {
  const runtime = await shipRuntime();
  await runtime.projects.set({ repo: REPO_URL, url: REPO_URL, autoMerge: false, autoDeploy: false });
  const set = await projectsRoute.action({
    request: request("/projects", { repo: REPO_URL, intent: "credential-set", credProfile: "claude-code", credEnvName: "ANTHROPIC_API_KEY", credValue: STORED }),
  });
  assert.equal(set.status, 302);
  const location = set.headers.get("location") ?? "";
  assert.ok(!location.includes(STORED), "the value never rides the redirect");
  const rows = await presenceOf(REPO_URL);
  assert.deepEqual(rows.map((r) => [r.profile, r.envName, r.version]), [["claude-code", "ANTHROPIC_API_KEY", 1]]);
  assert.equal(rows[0]!.setBy, "token", "presence names who stored it — and nothing else about the value");

  // The loader shows presence to a reader, never a value.
  const page = (await projectsRoute.loader({ request: new Request(`http://localhost/projects?repo=${encodeURIComponent(REPO_URL)}`) })) as { credentials: { presence: unknown[] } | null };
  assert.ok(page.credentials !== null);
  assert.ok(!JSON.stringify(page).includes(STORED), "no page payload carries the value");

  const clear = await projectsRoute.action({
    request: request("/projects", { repo: REPO_URL, intent: "credential-clear", credProfile: "claude-code", credEnvName: "ANTHROPIC_API_KEY" }),
  });
  assert.equal(clear.status, 302);
  assert.deepEqual(await presenceOf(REPO_URL), []);
});

test("NEGATIVE CONTROL — a principal without the policies grant can neither store nor clear", async () => {
  const runtime = await shipRuntime();
  await runtime.projects.set({ repo: REPO_URL, url: REPO_URL, autoMerge: false, autoDeploy: false });
  await projectsRoute.action({
    request: request("/projects", { repo: REPO_URL, intent: "credential-set", credProfile: "claude-code", credEnvName: "ANTHROPIC_API_KEY", credValue: STORED }),
  });
  const before = await presenceOf(REPO_URL);
  assert.equal(before.length, 1);

  const deniedSet = await projectsRoute.action({
    request: request("/projects", { repo: REPO_URL, intent: "credential-set", credProfile: "opencode", credEnvName: "OPENAI_API_KEY", credValue: "sk-other" }, false),
  });
  assert.match(deniedSet.headers.get("location") ?? "", /denied=policies/);
  const deniedClear = await projectsRoute.action({
    request: request("/projects", { repo: REPO_URL, intent: "credential-clear", credProfile: "claude-code", credEnvName: "ANTHROPIC_API_KEY" }, false),
  });
  assert.match(deniedClear.headers.get("location") ?? "", /denied=policies/);
  const after = await presenceOf(REPO_URL);
  assert.deepEqual(after, before, "an unauthenticated action changed nothing — presence included");
});
