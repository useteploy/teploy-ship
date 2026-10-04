import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createForgeFetch, decideEgress, egressConfig, EgressDenied, parseAllowList, pinnedFetch, resetShadowLog, type EgressConfig } from "./forge-egress.js";
import { retrieveUntrusted } from "./safe-fetch.js";
import { findOpenPullRequest, parseRepoUrl } from "./git.js";

const enforce = (allow = ""): EgressConfig => ({ mode: "enforce", allow: parseAllowList(allow) });
const noResolve = async (): Promise<string[]> => {
  throw new Error("resolver must not be called");
};

describe("forge-egress config", () => {
  it("defaults to shadow; on enforces; off disables", () => {
    assert.equal(egressConfig({}).mode, "shadow");
    assert.equal(egressConfig({ SHIP_SAFE_FETCH: "on" }).mode, "enforce");
    assert.equal(egressConfig({ SHIP_SAFE_FETCH: "off" }).mode, "off");
    assert.equal(egressConfig({ SHIP_SAFE_FETCH: "banana" }).mode, "shadow");
  });
  it("parses the allow-list with optional ports and brackets", () => {
    assert.deepEqual(parseAllowList(" Forgejo , git.lan:3000,[::1]:8080,,"), [
      { host: "forgejo" },
      { host: "git.lan", port: 3000 },
      { host: "::1", port: 8080 },
    ]);
  });
});

describe("decideEgress", () => {
  it("refuses private and metadata literals by default", async () => {
    for (const u of ["https://169.254.169.254/x", "https://10.0.0.5/x", "https://127.0.0.1/x", "https://localhost/x", "http://forge.example.com/x"]) {
      assert.equal((await decideEgress(u, enforce(), async () => ["93.184.216.34"])).allowed, false, u);
    }
  });
  it("allows a public https forge and pins its address", async () => {
    const d = await decideEgress("https://git.example.com/a/b", enforce(), async () => ["93.184.216.34"]);
    assert.equal(d.allowed, true);
    if (d.allowed) assert.equal(d.pin.address, "93.184.216.34");
  });
  it("allow-list admits a private single-label http forge by name", async () => {
    const d = await decideEgress("http://forgejo:3000/a/b", enforce("forgejo:3000"), async () => ["10.0.0.7"]);
    assert.equal(d.allowed, true);
    const wrongPort = await decideEgress("http://forgejo:9999/a/b", enforce("forgejo:3000"), async () => ["10.0.0.7"]);
    assert.equal(wrongPort.allowed, false);
  });
  it("allow-list never admits metadata or link-local answers", async () => {
    const d = await decideEgress("https://git.lan/a/b", enforce("git.lan"), async () => ["169.254.169.254"]);
    assert.equal(d.allowed, false);
    assert.equal((await decideEgress("http://169.254.169.254/", enforce("169.254.169.254"), noResolve)).allowed, false);
  });
});

describe("forge fetch on a real local socket", () => {
  let server: Server;
  let port: number;
  const seen: Array<{ host: string | undefined; auth: string | undefined; url: string | undefined }> = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization, url: req.url });
      if (req.url === "/redirect-away") {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        return res.end();
      }
      if (req.url === "/redirect-self") {
        res.writeHead(302, { location: "/final" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses the loopback server under the default policy and never connects", async () => {
    seen.length = 0;
    const f = createForgeFetch({ config: () => enforce() });
    await assert.rejects(f(`http://127.0.0.1:${port}/api/v1/x`, { headers: { authorization: "token secret" } }), EgressDenied);
    assert.equal(seen.length, 0);
  });

  it("reaches it when the operator allows it explicitly (real pinned undici connection)", async () => {
    seen.length = 0;
    const f = createForgeFetch({ config: () => enforce(`127.0.0.1:${port}`) });
    const r = await f(`http://127.0.0.1:${port}/api/v1/x`, { headers: { authorization: "token secret" } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(seen[0]?.auth, "token secret");
  });

  it("pins the connection: a name that resolves differently later still reaches the validated address, with the name as Host", async () => {
    seen.length = 0;
    let calls = 0;
    // First answer is the loopback server; a rebinding resolver would answer 10.0.0.1 next. The pin means it is asked once.
    const resolve = async () => (calls++ === 0 ? ["127.0.0.1"] : ["10.255.255.1"]);
    const f = createForgeFetch({ config: () => enforce(`forge.test:${port}`), resolve });
    const r = await f(`http://forge.test:${port}/api/v1/x`);
    assert.equal(r.status, 200);
    assert.equal(calls, 1);
    assert.equal(seen[0]?.host, `forge.test:${port}`);
  });

  it("pinnedFetch ignores the system resolver for an unresolvable name", async () => {
    const r = await pinnedFetch(`http://does-not-resolve.invalid:${port}/p`, {}, { address: "127.0.0.1", family: 4, hostname: "does-not-resolve.invalid" });
    assert.equal(r.status, 200);
    await r.text();
  });

  it("validates a redirect hop and strips credentials off-origin", async () => {
    seen.length = 0;
    const f = createForgeFetch({ config: () => enforce(`127.0.0.1:${port}`) });
    await assert.rejects(f(`http://127.0.0.1:${port}/redirect-away`, { headers: { authorization: "token secret" } }), EgressDenied);
    assert.equal(seen.length, 1, "the second hop was never connected");
    const ok = await f(`http://127.0.0.1:${port}/redirect-self`, { headers: { authorization: "token secret" } });
    assert.equal(ok.status, 200);
    assert.equal(seen.at(-1)?.url, "/final");
  });

  it("redirect:'error' still errors on a redirect", async () => {
    const f = createForgeFetch({ config: () => enforce(`127.0.0.1:${port}`) });
    await assert.rejects(f(`http://127.0.0.1:${port}/redirect-self`, { redirect: "error" }), /redirect/);
  });

  it("retrieveUntrusted uses the production fetch against the real socket", async () => {
    const deps = { resolve: async () => ["127.0.0.1"], fetch: pinnedFetch };
    const refused = await retrieveUntrusted(`https://127.0.0.1:${port}/x`, deps);
    assert.equal(refused.ok, false);
    const allowed = await retrieveUntrusted(`http://127.0.0.1:${port}/x`, { ...deps, allowPrivate: true, allowHttp: true, allowPorts: [port] });
    assert.equal(allowed.ok, true);
  });

  it("the git.ts call path goes through the guard when enforcing, using the default fetch", async () => {
    const real = globalThis.fetch;
    let reached = false;
    globalThis.fetch = (async () => {
      reached = true;
      return new Response("[]");
    }) as typeof fetch;
    const prev = { on: process.env.SHIP_SAFE_FETCH, allow: process.env.SHIP_SAFE_FETCH_ALLOW };
    try {
      process.env.SHIP_SAFE_FETCH = "on";
      delete process.env.SHIP_SAFE_FETCH_ALLOW;
      const ref = parseRepoUrl("http://169.254.169.254/owner/repo");
      await assert.rejects(findOpenPullRequest({ ref, token: "t", head: "h", owner: "o" }), EgressDenied);
      assert.equal(reached, false);
    } finally {
      globalThis.fetch = real;
      for (const [k, v] of [["SHIP_SAFE_FETCH", prev.on], ["SHIP_SAFE_FETCH_ALLOW", prev.allow]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("shadow and off modes leave the request untouched", () => {
  it("shadow: same call reaches the passthrough with identical arguments, and logs what it would refuse once", async () => {
    resetShadowLog();
    const logs: string[] = [];
    const calls: unknown[][] = [];
    const f = createForgeFetch({
      config: () => ({ mode: "shadow", allow: [] }),
      resolve: async () => ["10.0.0.9"],
      passthrough: (async (...a: unknown[]) => {
        calls.push(a);
        return new Response("x");
      }) as typeof fetch,
      log: (l) => logs.push(l),
    });
    const init = { headers: { authorization: "token t" } };
    const r1 = await f("https://forgejo.corp.example/api/v1/a", init);
    await f("https://forgejo.corp.example/api/v1/b", init);
    assert.equal(await r1.text(), "x");
    assert.deepEqual(calls[0], ["https://forgejo.corp.example/api/v1/a", init]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /would refuse.*forgejo\.corp\.example.*private_address/);
  });

  it("off: no resolver call, no log", async () => {
    const f = createForgeFetch({
      config: () => ({ mode: "off", allow: [] }),
      resolve: noResolve,
      passthrough: (async () => new Response("y")) as typeof fetch,
      log: () => assert.fail("logged"),
    });
    assert.equal(await (await f("http://169.254.169.254/")).text(), "y");
  });

  it("default env (no flag) uses the replaced global fetch unchanged", async () => {
    const real = globalThis.fetch;
    let got: unknown;
    globalThis.fetch = (async (u: unknown) => {
      got = u;
      return new Response("[]");
    }) as typeof fetch;
    const prev = process.env.SHIP_SAFE_FETCH;
    delete process.env.SHIP_SAFE_FETCH;
    try {
      const ref = parseRepoUrl("http://127.0.0.1:1/owner/repo");
      assert.equal(await findOpenPullRequest({ ref, token: "t", head: "h", owner: "o" }), null);
      assert.match(String(got), /^http:\/\/127\.0\.0\.1:1\/api\/v1\/repos\/owner\/repo\/pulls/);
    } finally {
      globalThis.fetch = real;
      if (prev !== undefined) process.env.SHIP_SAFE_FETCH = prev;
    }
  });
});
