import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { MemoryRuntimeConfig } from "../../../dist/runtime-config.js";
import { liveDiffKey, liveOutputKey, liveWatchKey } from "../../../dist/live-view.js";
import { liveViewResponse } from "./live-view.server.js";
import { LIVE_POLL_MS, diffLineTone, diffView, terminalView, type LiveBody } from "./live-view.js";
import { requiredRole, type Principal } from "./session.server.js";

const NOW = Date.parse("2026-10-16T12:00:10Z");

function deps(options: { principal: Principal | null; enabled?: boolean; status?: string | null; config?: MemoryRuntimeConfig }) {
  const config = options.config ?? new MemoryRuntimeConfig();
  return {
    config,
    deps: {
      principal: async () => options.principal,
      runtime: async () => ({
        config,
        loadMeta: async () => (options.status === null ? null : ({ status: options.status ?? "running" } as never)),
      }) as never,
      enabled: () => options.enabled ?? true,
    },
  };
}

const req = new Request("http://ship.test/api/runs/run-1/live");

test("live endpoint access: refused without a signed-in principal (negative control)", async () => {
  const { deps: d, config } = deps({ principal: null });
  await config.set(liveOutputKey("run-1"), JSON.stringify({ output: "private build log" }));
  const response = await liveViewResponse(req, "run-1", d);
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("private build log"));
  assert.equal(await config.get(liveWatchKey("run-1")), undefined, "a refused caller causes no write");
  // The production resolver (currentUser), with a forged bearer and a forged cookie.
  const prior = process.env.SHIP_WEB_TOKEN;
  process.env.SHIP_WEB_TOKEN = "the-real-web-token-for-this-test";
  try {
    const forged = new Request("http://ship.test/api/runs/run-1/live", { headers: { authorization: "Bearer not-the-token", cookie: "ship_session=forged.value" } });
    assert.equal((await liveViewResponse(forged, "run-1")).status, 401);
  } finally {
    if (prior === undefined) delete process.env.SHIP_WEB_TOKEN;
    else process.env.SHIP_WEB_TOKEN = prior;
  }
});

test("live endpoint access: the same gate as the run page — every role that can open /runs/<id> can read it, nothing wider", async () => {
  // The layout gates /runs/<id> and /api/runs/<id>/live with the same rule.
  assert.equal(requiredRole("GET", "/api/runs/run-1/live"), requiredRole("GET", "/runs/run-1"));
  for (const role of ["viewer", "editor", "admin"] as const) {
    const d = deps({ principal: { user: role, role } });
    assert.equal((await liveViewResponse(req, "run-1", d.deps)).status, 200, role);
  }
});

test("live endpoint: flag off is a 503 with the reason, unknown or malformed runs are 404", async () => {
  const off = deps({ principal: { user: "a", role: "admin" }, enabled: false });
  const r = await liveViewResponse(req, "run-1", off.deps);
  assert.equal(r.status, 503);
  assert.match(await r.text(), /SHIP_LIVE_VIEW/);
  const missing = deps({ principal: { user: "a", role: "admin" }, status: null });
  assert.equal((await liveViewResponse(req, "run-1", missing.deps)).status, 404);
  assert.equal((await liveViewResponse(req, "../x", missing.deps)).status, 404);
});

test("live endpoint: returns the redacted terminal and diff, and heartbeats only an active run", async () => {
  const secret = "web-side-secret-value-98765";
  process.env.SHIP_LIVE_WEB_TOKEN = secret;
  try {
    const { deps: d, config } = deps({ principal: { user: "vic", role: "viewer" } });
    await config.set(liveOutputKey("run-1"), JSON.stringify({ runId: "run-1", command: "make", startedAt: "", lastChunkAt: "", at: "", running: true, output: `ok ${secret}`, truncated: false }));
    await config.set(liveDiffKey("run-1"), JSON.stringify({ runId: "run-1", at: "2026-10-16T12:00:00Z", output: `+x ${secret}\n` }));
    const response = await liveViewResponse(req, "run-1", d);
    const text = await response.text();
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!text.includes(secret), "redaction negative control");
    const body = JSON.parse(text) as LiveBody;
    assert.equal(body.active, true);
    assert.equal(body.output?.command, "make");
    assert.ok(await config.get(liveWatchKey("run-1")), "an active run is watched");

    const settled = deps({ principal: { user: "vic", role: "viewer" }, status: "completed" });
    await liveViewResponse(req, "run-1", settled.deps);
    assert.equal(await settled.config.get(liveWatchKey("run-1")), undefined, "a settled run is not");
  } finally {
    delete process.env.SHIP_LIVE_WEB_TOKEN;
  }
});

test("live route is read-only: it exports a loader and no action", async () => {
  const source = await readFile(new URL("../routes/api/runs/[id]/live.tsx", import.meta.url), "utf8");
  assert.match(source, /export async function loader/);
  assert.doesNotMatch(source, /export (async )?function action|export const action/);
  const page = await readFile(new URL("../routes/runs/[id].tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("function LiveViewPanel"), page.indexOf("function PlanGroundingNotice"));
  assert.ok(panel.length > 0);
  assert.doesNotMatch(panel, /<form|<input|<textarea|<button|method: "POST"|method:"POST"/, "the panel can submit nothing");
});

test("terminal view: running and finished wording, empty output, truncation note", () => {
  const base = { command: "pnpm test", startedAt: "2026-10-16T12:00:00Z", lastChunkAt: "2026-10-16T12:00:07Z", at: "2026-10-16T12:00:08Z", output: "ok 1\n", truncated: false };
  assert.deepEqual(terminalView({ ...base, turn: 4, running: true }, NOW), { header: "$ pnpm test", status: "turn 4 · running · output 3s ago", text: "ok 1\n" });
  assert.deepEqual(terminalView({ ...base, running: false, exitCode: 1, timedOut: true, truncated: true }, NOW), {
    header: "$ pnpm test",
    status: "exit 1 (timed out) · ended 2s ago",
    text: "ok 1\n",
    note: "Only the tail is kept.",
  });
  assert.equal(terminalView({ ...base, running: true, output: "" }, NOW)?.text, "(no output yet)");
  assert.equal(terminalView(null, NOW), null);
});

test("diff view: the instant line names the sandbox clock, HEAD, base and digest", () => {
  const view = diffView({
    at: "2026-10-16T12:00:05Z",
    sandboxAt: "2026-10-16T12:00:04Z",
    head: "a".repeat(40),
    base: "b".repeat(40),
    baseLabel: "the merge-base of HEAD with origin/main",
    digest: "0123456789abcdef",
    output: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n",
    truncated: true,
  })!;
  assert.equal(
    view.instant,
    "Snapshot 2026-10-16T12:00:04Z (sandbox clock) · HEAD aaaaaaaaaa · vs bbbbbbbbbb (the merge-base of HEAD with origin/main) · sha256:0123456789abcdef",
  );
  assert.deepEqual(view.lines.map((l) => l.tone), ["file", "file", "file", "hunk", "del", "add", ""]);
  assert.equal(view.partial, true);
  assert.equal(view.empty, false);
  const empty = diffView({ at: "2026-10-16T12:00:05Z", output: "" })!;
  assert.equal(empty.empty, true);
  const failed = diffView({ at: "2026-10-16T12:00:05Z", error: "A person holds this workspace; the running diff resumes after handback." })!;
  assert.equal(failed.empty, false);
  assert.match(failed.error!, /handback/);
  assert.equal(diffLineTone("+++ b/x"), "file");
  assert.equal(LIVE_POLL_MS, 2000);
});
