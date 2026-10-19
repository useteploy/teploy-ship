// The thread route and its flag, exercised against the real file runtime the
// way steer-refusal.test.ts drives the run route: real enqueueRun calls build
// a genuine follow-up chain (runtime.ts records taskRootRunId and
// input.parentRunId at enqueue), then the loader answers through the same
// shipRuntime the web app uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-thread-view-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "thread-tests";
delete process.env.SHIP_THREAD_VIEW;
const { shipRuntime } = await import("./store.server.js");
const threadRoute = await import("../routes/api/runs/[id]/thread.js");
const runRoute = await import("../routes/runs/[id].js");
const { enqueueRun } = await import("./ship.server.js");

const get = (id: string): Request => new Request(`http://localhost/api/runs/${id}/thread`, {
  headers: { authorization: "Bearer thread-tests" },
});

async function launch(runId: string, parentRunId?: string): Promise<void> {
  const runtime = await shipRuntime();
  await enqueueRun(runtime, {
    runId,
    repo: "https://github.com/team/repo",
    task: `Request ${runId}`,
    model: "test",
    source: "manual",
    trust: "operator",
    ...(parentRunId !== undefined ? { parentRunId } : {}),
  });
}


/** LoaderArgs carries a context the runtime fills; tests have none to give. */
const loaderArgsFrom = (get: (id: string) => Request, id: string) =>
  ({ request: get(id), params: { id }, context: undefined }) as unknown as Parameters<typeof threadRoute.loader>[0];

const loaderArgs = (url: string, id: string) =>
  ({ request: new Request(url), params: { id }, context: undefined }) as unknown as Parameters<typeof threadRoute.loader>[0];

test("unauthenticated reads are refused before anything else", async () => {
  const res = await threadRoute.loader(loaderArgs("http://localhost/api/runs/x/thread", "x"));
  assert.equal(res.status, 401);
});

test("flag off (the explicit off value): the API says it is disabled, and the run page payload is unchanged", async () => {
  process.env.SHIP_THREAD_VIEW = "off";
  try {
    await launch("tv-root");
    const res = await threadRoute.loader(loaderArgsFrom(get, "tv-root"));
    assert.equal(res.status, 503);
    assert.match(String((await res.json()).error), /SHIP_THREAD_VIEW/);
    // Equivalence: flag off, the run page loader carries no thread key at all —
    // the page renders exactly what it rendered before this view existed.
    const off = await runRoute.loader(({ request: new Request("http://localhost/runs/tv-root"), params: { id: "tv-root" }, context: undefined }) as unknown as Parameters<typeof runRoute.loader>[0]);
    assert.equal("threadView" in off, false);
  } finally {
    delete process.env.SHIP_THREAD_VIEW;
  }
});

test("flag on: the API returns the whole chain for any member, root first", async () => {
  process.env.SHIP_THREAD_VIEW = "on";
  try {
    await launch("tv-a");
    await launch("tv-b", "tv-a");
    await launch("tv-c", "tv-b");
    await launch("tv-unrelated");
    const res = await threadRoute.loader(loaderArgsFrom(get, "tv-b"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.run, "tv-b");
    assert.equal(body.root, "tv-a");
    assert.equal(body.truncated, false);
    assert.deepEqual(body.runs.map((r: { runId: string }) => r.runId), ["tv-a", "tv-b", "tv-c"]);
    assert.ok(body.runs.every((r: { runId: string }) => typeof r.runId === "string"));
    // The contract fields the pass-through clients read.
    for (const run of body.runs) {
      assert.equal(typeof run.status, "string");
      assert.equal(typeof run.createdAt, "string");
      assert.equal(typeof run.model, "string");
      assert.equal(typeof run.harness, "string");
      assert.ok("summary" in run && "parentRunId" in run && Array.isArray(run.steers) && Array.isArray(run.asks));
    }
    assert.equal(body.runs[0].parentRunId, null);
    assert.equal(body.runs[1].parentRunId, "tv-a");
    assert.equal(body.runs[2].parentRunId, "tv-b");
    assert.equal(body.runs[0].harness, "native");
    // The unrelated run is not a member.
    assert.ok(!body.runs.some((r: { runId: string }) => r.runId === "tv-unrelated"));
  } finally {
    delete process.env.SHIP_THREAD_VIEW;
  }
});

test("flag on: an unknown run id is a 404, not an empty chain", async () => {
  process.env.SHIP_THREAD_VIEW = "on";
  try {
    const res = await threadRoute.loader(loaderArgsFrom(get, "tv-missing"));
    assert.equal(res.status, 404);
    assert.match(String((await res.json()).error), /no such run/);
  } finally {
    delete process.env.SHIP_THREAD_VIEW;
  }
});

test("flag on: the run page payload gains exactly one key — nothing else moves", async () => {
  process.env.SHIP_THREAD_VIEW = "on";
  const on = await runRoute.loader({ params: { id: "tv-a" }, request: new Request("http://localhost/runs/tv-a") });
  process.env.SHIP_THREAD_VIEW = "off";
  const off = await runRoute.loader({ params: { id: "tv-a" }, request: new Request("http://localhost/runs/tv-a") });
  assert.equal(on.threadView, true);
  assert.equal("threadView" in off, false);
  // followUpRequestId is a fresh UUID on every load, before and after this
  // change alike — the one field expected to differ between two loads.
  const { threadView, followUpRequestId, ...rest } = on;
  void threadView;
  void followUpRequestId;
  const { followUpRequestId: offId, ...offRest } = off;
  void offId;
  assert.deepEqual(rest, offRest);
});
