// The steer route must refuse a note no executor will read. Only the native
// loop drains steering notes (src/harness-capabilities.ts); an external
// harness reads nothing but its prompt, so accepting a note there stored it,
// said "sent", and dropped it. AUDIT_OPEN S13 listed this refusal as untested.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-steer-refusal-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "steer-tests";
const { shipRuntime } = await import("./store.server.js");
const run = await import("../routes/runs/[id].js");
const { enqueueRun } = await import("./ship.server.js");
const { STEER_UNSUPPORTED_MESSAGE } = await import("teploy-ship/harness-capabilities");

function steer(id: string, text: string): Request {
  return new Request("http://localhost/runs/" + id, {
    method: "POST",
    headers: { authorization: "Bearer steer-tests" },
    body: new URLSearchParams({ intent: "steer", steer: text }),
  });
}

async function start(runId: string, harness?: string): Promise<void> {
  const runtime = await shipRuntime();
  await enqueueRun(runtime, {
    runId,
    repo: "https://github.com/team/repo",
    task: "Fix it",
    model: "test",
    source: "manual",
    trust: "operator",
    ...(harness ? { harness } : {}),
  });
}

test("steering a run on an external harness is refused and nothing is stored", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-external", "claude-code");
  const res = await run.action({ params: { id: "run-steer-external" }, request: steer("run-steer-external", "also do X") });
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("messageError=" + encodeURIComponent(STEER_UNSUPPORTED_MESSAGE)), location);
  assert.doesNotMatch(location, /sent=1/);
  assert.deepEqual(await runtime.steer.pending("run-steer-external"), []);
});

test("steering a native run is accepted and queued (negative control for the refusal)", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-native");
  const res = await run.action({ params: { id: "run-steer-native" }, request: steer("run-steer-native", "also do X") });
  assert.match(res.headers.get("location") ?? "", /sent=1/);
  assert.deepEqual((await runtime.steer.pending("run-steer-native")).map((n) => n.text), ["also do X"]);
});

test("the run page does not offer a steer box for an external-harness run", async () => {
  await start("run-steer-offer-external", "claude-code");
  await start("run-steer-offer-native");
  const external = await run.loader({ params: { id: "run-steer-offer-external" }, request: steer("run-steer-offer-external", "") });
  const native = await run.loader({ params: { id: "run-steer-offer-native" }, request: steer("run-steer-offer-native", "") });
  assert.equal(external.steerable, false);
  assert.equal(native.steerable, true);
});
