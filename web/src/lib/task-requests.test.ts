import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.SHIP_WEB_TOKEN = "request-test-token";
process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-requests-"));
const { action } = await import("../routes/index.js");
const { shipRuntime } = await import("./store.server.js");
const { signSession, SESSION_COOKIE } = await import("./session.server.js");
const runtime = await shipRuntime();
await runtime.governance.setAuthority("approve", { roles: ["admin"], users: [] });
const url = "https://git.example.com/team/site";
await runtime.projects.set({ repo: url, url, autoMerge: false, autoDeploy: false });
function request(role: "editor" | "viewer", fields: Record<string, string>) {
  return new Request("http://ship.test/", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}` }, body: new URLSearchParams(fields) });
}
test("teammate can submit a deduplicated plan request without launching; viewer cannot submit", async () => {
  const fields = { intent: "submit-request", task: "Plan simpler wording", journey: "plan", repo: url, requestId: randomUUID() };
  const first = await action({ request: request("editor", fields) });
  const again = await action({ request: request("editor", fields) });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), again.headers.get("location"));
  const tasks = await runtime.intake.list("proposed");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "request-plan");
  assert.equal(tasks[0].source, "team-request");
  assert.equal(tasks[0].requestedBy, "editor");
  assert.equal((await runtime.listMeta()).length, 0);
  const refused = await action({ request: request("editor", { ...fields, intent: "new-run" }) });
  assert.match(refused.headers.get("location") ?? "", /denied=approve/);
  assert.equal((await action({ request: request("viewer", { ...fields, requestId: randomUUID() }) })).status, 403);
});
test("unregistered project and invalid journey do not create a proposal", async () => {
  for (const overrides of [{ repo: "https://other.test/x/y" }, { journey: "deploy" }]) {
    const result = await action({ request: request("editor", { intent: "submit-request", task: "Help", journey: "change", repo: url, requestId: randomUUID(), ...overrides }) });
    assert.match(result.headers.get("location") ?? "", /error=/);
  }
  assert.equal((await runtime.intake.list()).length, 1);
});
