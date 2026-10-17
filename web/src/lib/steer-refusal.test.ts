// The steer route gates a note on whether the run's harness can read it
// (src/harness-capabilities.ts). Before D6/D7 only the native loop drained
// notes, so every external-harness note was refused; now the contract-2
// external harnesses steer by session resume, so a CURRENT claude-code or
// opencode run is offered the box and its note is queued. The refusal still
// stands for inputs recorded under the 1-contract external adapters — that
// arm is `harnessSupports`' own test (src/harness-capabilities.test.ts); a
// route-level fixture for it would mean hand-writing a run-started event the
// enqueue path never produces, so the gate is asserted where it lives.
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
const { STEER_CLOSED_MESSAGE, STEER_NOT_ENABLED_MESSAGE, STEER_UNSUPPORTED_MESSAGE } = await import("teploy-ship/harness-capabilities");
const { enqueueRun } = await import("./ship.server.js");

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

test("steering a run on a current external harness is accepted and queued (D6/D7)", async () => {
  const runtime = await shipRuntime();
  for (const harness of ["claude-code", "opencode"]) {
    const runId = `run-steer-external-${harness}`;
    await start(runId, harness);
    const res = await run.action({ params: { id: runId }, request: steer(runId, "also do X") });
    assert.match(res.headers.get("location") ?? "", /sent=1/, harness);
    assert.deepEqual((await runtime.steer.pending(runId)).map((n) => n.text), ["also do X"], harness);
  }
});

test("steering a native run is accepted and queued (the unchanged case)", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-native");
  const res = await run.action({ params: { id: "run-steer-native" }, request: steer("run-steer-native", "also do X") });
  assert.match(res.headers.get("location") ?? "", /sent=1/);
  assert.deepEqual((await runtime.steer.pending("run-steer-native")).map((n) => n.text), ["also do X"]);
});

test("the run page offers a steer box for a current external-harness run", async () => {
  await start("run-steer-offer-external", "claude-code");
  await start("run-steer-offer-native");
  const external = await run.loader({ params: { id: "run-steer-offer-external" }, request: steer("run-steer-offer-external", "") });
  const native = await run.loader({ params: { id: "run-steer-offer-native" }, request: steer("run-steer-offer-native", "") });
  assert.equal(external.steerable, true, "an external contract-2 run steers by session resume");
  assert.equal(native.steerable, true);
});

// A run recorded under the 1-contract external adapter (enqueued before the
// steer contract) cannot be hand-built through enqueueRun, which always
// records the current version — so the recorded run-started input is
// rewritten at the store read, which is the one place the route sees it.
async function asRecorded(runId: string, patch: (input: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const runtime = await shipRuntime();
  const original = runtime.store.load.bind(runtime.store);
  runtime.store.load = async (id: string) => {
    const events = await original(id);
    if (id !== runId) return events;
    return events.map((e) =>
      e.type === "run-started"
        ? { ...e, data: { ...(e.data as Record<string, unknown>), input: patch(((e.data as { input: Record<string, unknown> }).input)) } }
        : e,
    );
  };
}

test("steering a run recorded under the 1-contract external adapter is refused and nothing is stored", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-v1", "claude-code");
  await asRecorded("run-steer-v1", (input) => ({ ...input, harness: { id: "claude-code", version: "1" } }));
  const res = await run.action({ params: { id: "run-steer-v1" }, request: steer("run-steer-v1", "also do X") });
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("messageError=" + encodeURIComponent(STEER_UNSUPPORTED_MESSAGE)), location);
  assert.doesNotMatch(location, /sent=1/);
  assert.deepEqual(await runtime.steer.pending("run-steer-v1"), []);
});

test("steering an external run enqueued without input.steer is refused: its adapter records no steer steps", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-noflag", "claude-code");
  await asRecorded("run-steer-noflag", (input) => {
    const { steer: _drop, ...rest } = input;
    return rest;
  });
  const res = await run.action({ params: { id: "run-steer-noflag" }, request: steer("run-steer-noflag", "also do X") });
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("messageError=" + encodeURIComponent(STEER_NOT_ENABLED_MESSAGE)), location);
  assert.deepEqual(await runtime.steer.pending("run-steer-noflag"), []);
});

test("steering an external run whose steer loop already exited is refused instead of answering sent", async () => {
  const runtime = await shipRuntime();
  await start("run-steer-closed", "opencode");
  const original = runtime.store.load.bind(runtime.store);
  runtime.store.load = async (id: string) => {
    const events = await original(id);
    if (id !== "run-steer-closed") return events;
    return [...events, { type: "step-completed", name: "harness-steer-undelivered", at: new Date().toISOString(), data: { result: [] } } as never];
  };
  const res = await run.action({ params: { id: "run-steer-closed" }, request: steer("run-steer-closed", "also do X") });
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("messageError=" + encodeURIComponent(STEER_CLOSED_MESSAGE)), location);
  assert.deepEqual(await runtime.steer.pending("run-steer-closed"), []);
});
