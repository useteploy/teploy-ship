import assert from "node:assert/strict";
import { test } from "node:test";

import { sandboxOverridesOf, sandboxProvider } from "./durable.js";
import { shortHash, warmCacheEnabled, warmClient, warmSlugOf } from "./warm.js";

test("warmSlugOf keys on origin + owner + name, folded to the daemon's alphabet", () => {
  // A port separator is not in the daemon's slug alphabet; folding it keeps
  // the origin in the key rather than dropping it.
  assert.equal(warmSlugOf("http://100.108.123.49:49152/Tyler/akiroo.git"), "100.108.123.49-49152/tyler/akiroo");
  assert.equal(warmSlugOf("https://github.com/useteploy/teploy"), "github.com/useteploy/teploy");
  // Two forges holding the same owner/name must not collide.
  assert.notEqual(warmSlugOf("https://github.com/tyler/x"), warmSlugOf("https://codeberg.org/tyler/x"));
});

test("warmSlugOf refuses what the daemon would refuse, so a bad name never costs a run its sandbox", () => {
  assert.equal(warmSlugOf("file:///tmp/bare/repo.git"), null, "local mirrors have nothing to cache");
  assert.equal(warmSlugOf("not a url"), null);
  assert.equal(warmSlugOf("https://example.com/only-one-segment"), null);
});

/** A daemon that answers exactly what the routes are documented to answer. */
function daemon(routes: Record<string, { status: number; body?: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer t0ken");
    const route = routes[path];
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("warmClient.info reports the volume's hash beside its repo's published template hash", async () => {
  const { fetch, calls } = daemon({
    "/v1/runs/run-1/warm": { status: 200, body: { warm: { repo: "forge/tyler/akiroo", booted: true, lockHash: "aaaa1111", repoDir: "." } } },
    "/v1/warmcache/forge/tyler/akiroo": { status: 200, body: { warm: { repo: "forge/tyler/akiroo", lockHash: "aaaa1111" } } },
  });
  const state = await warmClient({ baseURL: "http://sbx:8080", token: "t0ken", fetch }).info("run-1");
  assert.deepEqual(state, { repo: "forge/tyler/akiroo", booted: true, lockHash: "aaaa1111", repoDir: ".", templateHash: "aaaa1111" });
  assert.deepEqual(calls, ["GET /v1/runs/run-1/warm", "GET /v1/warmcache/forge/tyler/akiroo"]);
});

test("warmClient.info: a repo with no template yet reports templateHash null, not a failure", async () => {
  const { fetch } = daemon({
    "/v1/runs/run-1/warm": { status: 200, body: { warm: { repo: "forge/tyler/new", booted: false, lockHash: "bbbb2222", repoDir: "." } } },
  });
  const state = await warmClient({ baseURL: "http://sbx:8080", token: "t0ken", fetch }).info("run-1");
  assert.equal(state?.booted, false);
  assert.equal(state?.templateHash, null, "a 404 from /v1/warmcache is 'no template', an ordinary state");
});

test("warmClient answers null on a daemon with no cache store — the caller degrades to the cold path", async () => {
  const { fetch } = daemon({
    "/v1/runs/run-1/warm": { status: 400, body: { title: "this daemon has no cache store (serve --cache-root)" } },
    "/v1/runs/run-1/warm-commit": { status: 400 },
  });
  const client = warmClient({ baseURL: "http://sbx:8080", token: "t0ken", fetch });
  assert.equal(await client.info("run-1"), null);
  assert.equal(await client.commit("run-1"), null);
});

test("warmClient.commit publishes the volume and reports the hash it published", async () => {
  const { fetch, calls } = daemon({
    "/v1/runs/run-1/warm-commit": { status: 201, body: { warm: { repo: "forge/tyler/akiroo", booted: false, lockHash: "cccc3333", repoDir: "." } } },
  });
  const state = await warmClient({ baseURL: "http://sbx:8080", token: "t0ken", fetch }).commit("run-1");
  assert.equal(state?.lockHash, "cccc3333");
  assert.equal(state?.templateHash, "cccc3333", "what was just committed IS the template");
  assert.deepEqual(calls, ["POST /v1/runs/run-1/warm-commit"]);
});

test("the kill switch is off-by-value: anything but a falsey word leaves the cache on", () => {
  assert.equal(warmCacheEnabled({}), true);
  assert.equal(warmCacheEnabled({ SHIP_WARM_CACHE: "1" }), true);
  for (const off of ["0", "false", "off", "no", "OFF"]) {
    assert.equal(warmCacheEnabled({ SHIP_WARM_CACHE: off }), false, off);
  }
});

test("shortHash names the empty hash rather than printing nothing", () => {
  assert.equal(shortHash(""), "none");
  assert.equal(shortHash("0123456789abcdef0123"), "0123456789ab");
});

// ---------------------------------------------------------------------------
// The provider seam: what actually reaches POST /v1/runs
// ---------------------------------------------------------------------------

test("sandboxOverridesOf asks for the warm volume only on a run that recorded `warm`", () => {
  const repo = "http://forge:3000/Tyler/akiroo.git";
  assert.deepEqual(sandboxOverridesOf({ task: "t", repo, warm: true } as never)?.warm, { repo: "forge-3000/tyler/akiroo" });
  assert.equal(sandboxOverridesOf({ task: "t", repo } as never), undefined, "a pre-cache log asks for nothing");
  assert.equal(sandboxOverridesOf({ task: "t", warm: true } as never), undefined, "a workspace run has no repo to key on");
  // Unchanged input, unchanged request: the slug is a function of the recorded
  // URL, so a replay asks for exactly what the original asked for.
  assert.deepEqual(sandboxOverridesOf({ task: "t", repo, warm: true } as never), sandboxOverridesOf({ task: "t", repo, warm: true } as never));
});

/** A daemon that refuses the warm option the way one without --cache-root does. */
function createDaemon(options: { refuseWarm?: boolean }): { fetch: typeof globalThis.fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (options.refuseWarm === true && body.warm !== undefined) {
      return new Response(JSON.stringify({ title: "this daemon has no cache store (serve --cache-root)" }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: "sbx-1" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

test("the warm option rides on the create call", async () => {
  const { fetch, bodies } = createDaemon({});
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "python:3.12-slim", fetch });
  await provider.create({ warm: { repo: "forge/tyler/akiroo" } });
  assert.deepEqual(bodies[0]!.warm, { repo: "forge/tyler/akiroo" });
  assert.equal(bodies[0]!.image, "python:3.12-slim", "the worker's defaults are untouched");
});

test("a daemon with no cache store gets the run anyway: create retries cold", async () => {
  const { fetch, bodies } = createDaemon({ refuseWarm: true });
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "python:3.12-slim", fetch });
  const created = await provider.create({ warm: { repo: "forge/tyler/akiroo" } });
  assert.equal(created.handle, "sbx-1", "the run gets its sandbox — a cache is never worth a run");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.warm, undefined, "the retry drops the option the daemon refused");
});

test("a restore never mounts a warm volume over the snapshot it just restored", async () => {
  const { fetch, bodies } = createDaemon({});
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "python:3.12-slim", fetch });
  await provider.createFrom!("snap:run-1", { warm: { repo: "forge/tyler/akiroo" }, network: "egress" });
  assert.equal(bodies[0]!.image, "snap:run-1");
  assert.equal(bodies[0]!.network, "egress", "the other overrides still apply");
  assert.equal(bodies[0]!.warm, undefined, "the snapshot IS the workspace; a volume at /work would hide it");
});
