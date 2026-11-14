import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOT_FOR_A_WORKER,
  allowlistOrigins,
  formatChecks,
  isContainerAlias,
  joinReady,
  looksSecret,
  normaliseController,
  parseEnvFile,
  planJoin,
  redact,
  redactUrlPassword,
  renderEnvFile,
  runJoinChecks,
  summarisePlan,
} from "./join.js";
import type { CheckDeps, JoinCheck, JoinPlan } from "./join.js";

// A bundle shaped exactly like the one `install.sh --export-secrets` writes off
// deploy-test, values shortened. NUCLEUS_URL is the real docker alias, which is
// the whole point of the store check.
const BUNDLE = `# Teploy Ship secrets exported from 100.76.150.126 on 2026-08-26T00:00:00Z.
# REAL VALUES. chmod 600. Delete once the new host is up.
SHIP_WEB_TOKEN=IZpaDQZyRgJ0NXBgso0NxUhiXHe
SHIP_SESSION_SECRET=aaaabbbbccccdddd
SHIP_WEBHOOK_SECRET=eeeeffff00001111
SHIP_BOOTSTRAP_ADMIN_USER=tyler
SHIP_BOOTSTRAP_ADMIN_PASSWORD=bootstrapped-long-password
SHIP_GIT_TOKEN=00b9493c485b7feff809be4f95461831e8b5fc8f
SHIP_GITHUB_TOKEN=gho_830KHBJszRPep0yuAxGi5QZP3r85oa
ANTHROPIC_API_KEY=sk-ant-abcdef0123456789
NUCLEUS_URL=postgres://nucleus@ship-nucleus:5432/nucleus
SHIP_REPO_ALLOWLIST=http://100.108.123.49:49152/tyler,https://github.com/im-tyler
SHIP_SANDBOX_URL=http://172.18.0.1:7439
SHIP_SANDBOX_TOKEN=01KX06ATPNGKXR07Z1C9GGJ9ZY
SHIP_MODEL=zai/glm-5.3
`;

const plan = (over?: Partial<Parameters<typeof planJoin>[0]>): JoinPlan =>
  planJoin({ controller: "http://100.76.150.126:7460", bundle: parseEnvFile(BUNDLE), ...over });

// ---------------------------------------------------------------------------
// The bundle format
// ---------------------------------------------------------------------------

test("the bundle parses the way install.sh writes it, comments and all", () => {
  const env = parseEnvFile(BUNDLE);
  assert.equal(env.SHIP_GIT_TOKEN, "00b9493c485b7feff809be4f95461831e8b5fc8f");
  assert.equal(env.NUCLEUS_URL, "postgres://nucleus@ship-nucleus:5432/nucleus");
  assert.equal(Object.keys(env).length, 13, "and no comment or blank became a setting");
});

test("a value containing '=' survives — a base64 secret ends in padding", () => {
  const env = parseEnvFile("SHIP_WEB_TOKEN=abc==\nOTHER=x=y=z\n");
  assert.equal(env.SHIP_WEB_TOKEN, "abc==");
  assert.equal(env.OTHER, "x=y=z");
});

test("junk lines are dropped rather than becoming settings", () => {
  const env = parseEnvFile("not a setting\n=novalue\n1BAD=x\n  # spaced comment\nGOOD=1\n");
  assert.deepEqual(env, { GOOD: "1" });
});

test("render and parse round-trip", () => {
  const env = parseEnvFile(BUNDLE);
  assert.deepEqual(parseEnvFile(renderEnvFile(env, ["a header line"])), env);
  assert.match(renderEnvFile(env, ["a header line"]), /^# a header line\n/);
});

// ---------------------------------------------------------------------------
// Redaction — join prints its whole plan back, so this is load-bearing
// ---------------------------------------------------------------------------

test("everything credential-shaped is redacted, including keys nobody listed", () => {
  for (const key of ["SHIP_GIT_TOKEN", "ANTHROPIC_API_KEY", "SHIP_WEBHOOK_SECRET", "DB_PASSWORD", "NUCLEUS_URL", "SOME_FUTURE_TOKEN"]) {
    assert.equal(looksSecret(key), true, key);
  }
  for (const key of ["SHIP_MODEL", "SHIP_REPO_ALLOWLIST", "SHIP_SANDBOX_URL", "OBSERVE_SERVICE"]) {
    assert.equal(looksSecret(key), false, key);
  }
});

test("a redacted secret is recognisable and unusable", () => {
  const redacted = redact("SHIP_GIT_TOKEN", "00b9493c485b7feff809be4f95461831e8b5fc8f");
  assert.match(redacted, /^00b9…/);
  assert.doesNotMatch(redacted, /495461831e8b5fc8f/);
  assert.equal(redact("SHIP_MODEL", "zai/glm-5.3"), "zai/glm-5.3", "and a non-secret is shown in full");
  assert.equal(redact("SHIP_GIT_TOKEN", "short"), "…", "a short value gives away nothing at all");
});

test("a postgres password never reaches the terminal, but the address still does", () => {
  assert.equal(
    redactUrlPassword("postgres://nucleus:hunter2@100.76.150.126:5432/nucleus"),
    "postgres://nucleus:…@100.76.150.126:5432/nucleus",
  );
  assert.equal(redactUrlPassword("postgres://nucleus@ship-nucleus:5432/nucleus"), "postgres://nucleus@ship-nucleus:5432/nucleus");
});

test("the plan summary redacts every credential in it", () => {
  const text = summarisePlan(plan());
  assert.doesNotMatch(text, /sk-ant-abcdef0123456789/);
  assert.doesNotMatch(text, /00b9493c485b7feff809be4f95461831e8b5fc8f/);
  assert.doesNotMatch(text, /bootstrapped-long-password/, "the bootstrap password never reaches a worker, so never a summary");
  assert.match(text, /SHIP_MODEL=zai\/glm-5\.3/, "and shows what is safe to show");
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test("per-install secrets are dropped on the way in, not left to the operator", () => {
  const result = plan();
  for (const key of NOT_FOR_A_WORKER) {
    assert.equal(result.env[key], undefined, `${key} must never reach a worker`);
  }
  assert.match(result.notes.join(" "), /per-install secrets/);
  assert.equal(result.webToken, "IZpaDQZyRgJ0NXBgso0NxUhiXHe", "but join itself keeps the web token to authenticate with");
});

test("--sandbox ADDS to the pool rather than replacing it (B2)", () => {
  const result = plan({ addSandbox: "http://172.19.0.1:7439, http://100.64.1.9:7439/" });
  assert.deepEqual(result.sandboxUrls, ["http://172.18.0.1:7439", "http://172.19.0.1:7439", "http://100.64.1.9:7439"]);
  assert.equal(result.env.SHIP_SANDBOX_URL, "http://172.18.0.1:7439,http://172.19.0.1:7439,http://100.64.1.9:7439");
});

test("a sandbox host joined twice is listed once", () => {
  const result = plan({ addSandbox: "http://172.18.0.1:7439" });
  assert.deepEqual(result.sandboxUrls, ["http://172.18.0.1:7439"]);
});

test("a sandbox pool defaults to egress, because a run has to clone and push", () => {
  assert.equal(plan().env.SHIP_SANDBOX_NETWORK, "egress");
  const explicit = planJoin({ controller: "http://c:7460", bundle: { ...parseEnvFile(BUNDLE), SHIP_SANDBOX_NETWORK: "none" } });
  assert.equal(explicit.env.SHIP_SANDBOX_NETWORK, "none", "an explicit choice is never overwritten");
});

test("flags win over the bundle", () => {
  const result = plan({ overrides: { NUCLEUS_URL: "postgres://n:pw@100.76.150.126:5432/nucleus", SHIP_MODEL: "anthropic/claude-sonnet-5" } });
  assert.equal(result.env.NUCLEUS_URL, "postgres://n:pw@100.76.150.126:5432/nucleus");
  assert.equal(result.env.SHIP_MODEL, "anthropic/claude-sonnet-5");
});

// SHIP-03: join used to hard-code SHIP_STORE=nucleus and `worker --store
// nucleus`, so against a PostgreSQL controller every KV and stream call failed
// (`function kv_setnx … does not exist`). The store is now stated or asked.
test("the store is the one stated: --store over the bundle's SHIP_STORE, never a hard-coded nucleus", () => {
  const fromBundle = planJoin({ controller: "http://c:7460", bundle: { ...parseEnvFile(BUNDLE), SHIP_STORE: "postgres" } });
  assert.equal(fromBundle.store, "postgres");
  assert.equal(fromBundle.env.SHIP_STORE, "postgres");
  const flagWins = planJoin({ controller: "http://c:7460", bundle: { ...parseEnvFile(BUNDLE), SHIP_STORE: "postgres" }, store: "nucleus" });
  assert.equal(flagWins.store, "nucleus");
  assert.equal(flagWins.env.SHIP_STORE, "nucleus");
});

test("an unstated store is left unstated by the plan, not guessed", () => {
  const result = plan();
  assert.equal(result.store, undefined);
  assert.equal(result.env.SHIP_STORE, undefined);
});

test("a trailing slash on the controller URL never doubles up", () => {
  assert.equal(normaliseController("http://c:7460///"), "http://c:7460");
  assert.equal(normaliseController("  http://c:7460 "), "http://c:7460");
});

test("the allowlist is reduced to the origins a token authenticates against", () => {
  assert.deepEqual(allowlistOrigins("http://100.108.123.49:49152/tyler,https://github.com/im-tyler"), [
    "http://100.108.123.49:49152",
    "https://github.com",
  ]);
  assert.deepEqual(allowlistOrigins("http://f:1/a http://f:1/b"), ["http://f:1"], "one origin, listed once");
  assert.deepEqual(allowlistOrigins(undefined), []);
  assert.deepEqual(allowlistOrigins("not a url"), [], "and a malformed entry is the policy's problem, not join's");
});

// ---------------------------------------------------------------------------
// The store check — the one thing that actually breaks a second box
// ---------------------------------------------------------------------------

test("a docker network alias is recognised as one, and a real address is not", () => {
  assert.equal(isContainerAlias("postgres://nucleus@ship-nucleus:5432/nucleus"), "ship-nucleus");
  assert.equal(isContainerAlias("postgres://n@100.76.150.126:5432/nucleus"), null);
  assert.equal(isContainerAlias("postgres://n@nucleus.internal:5432/n"), null, "a dotted name is resolvable somewhere");
  assert.equal(isContainerAlias("postgres://n@localhost:5432/n"), null);
  assert.equal(isContainerAlias("garbage"), null);
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** A fetch that answers from a table of URL prefixes. Anything unlisted throws. */
function fakeFetch(routes: Record<string, { status: number; body?: string }>): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (key === undefined) throw Object.assign(new Error(`connect ECONNREFUSED ${url}`), { cause: { code: "ECONNREFUSED" } });
    const route = routes[key]!;
    return new Response(route.body ?? "{}", { status: route.status });
  }) as typeof globalThis.fetch;
}

const HEALTHY = {
  "http://100.76.150.126:7460/health": { status: 200, body: JSON.stringify({ status: "ok", nucleus: "ok", worker: "ok (1)", version: "dev" }) },
  "http://100.76.150.126:7460/api/policies": { status: 200 },
  "http://172.18.0.1:7439/health": { status: 200, body: JSON.stringify({ status: "ok", version: "dev" }) },
  "http://172.18.0.1:7439/v1/runs": { status: 200, body: JSON.stringify({ runs: [], server: "new-box" }) },
  "http://100.108.123.49:49152/api/v1/user": { status: 200, body: JSON.stringify({ login: "tyler" }) },
  "https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "im-tyler" }) },
};

const POSTGRES_VERSION = "PostgreSQL 17.6 (Debian 17.6-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc";
const NUCLEUS_VERSION = "PostgreSQL 16.0 (Nucleus 1.1.1)";

const deps = (over: Partial<CheckDeps> & { planOver?: Partial<Parameters<typeof planJoin>[0]> } = {}): CheckDeps => ({
  plan: plan({
    ...over.planOver,
    overrides: { NUCLEUS_URL: "postgres://nucleus:pw@100.76.150.126:5432/nucleus", ...over.planOver?.overrides },
  }),
  fetch: fakeFetch(HEALTHY),
  pingStore: async () => POSTGRES_VERSION,
  detect: async () => ({ colocated: [], unknown: [] }),
  env: {},
  ...over,
});

const by = (checks: JoinCheck[], name: string): JoinCheck => {
  const found = checks.find((c) => c.name === name);
  assert.ok(found !== undefined, `no check named ${name} in [${checks.map((c) => c.name).join(", ")}]`);
  return found;
};

test("a box with everything in place passes every check and is ready", async () => {
  const checks = await runJoinChecks(deps());
  assert.equal(joinReady(checks), true, formatChecks(checks));
  assert.equal(by(checks, "bundle").status, "ok");
  assert.equal(by(checks, "controller").status, "ok");
  assert.match(by(checks, "controller").detail, /workers ok \(1\)/);
  assert.equal(by(checks, "controller-token").status, "ok");
  assert.equal(by(checks, "store").status, "ok");
  assert.match(by(checks, "sandbox:http://172.18.0.1:7439").detail, /new-box/);
  assert.equal(by(checks, "forge:http://100.108.123.49:49152").status, "ok");
  assert.equal(by(checks, "forge:https://github.com").status, "ok");
  assert.equal(by(checks, "colocation").status, "ok");
});

test("the bundled docker-alias NUCLEUS_URL fails with the reason, not a DNS error", async () => {
  // No override: the bundle's own postgres://nucleus@ship-nucleus URL, which is
  // exactly what an operator gets from --export-secrets. Proved live 2026-08-26
  // by running join from a laptop against deploy-test.
  const checks = await runJoinChecks({
    ...deps(),
    plan: plan(),
    pingStore: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND ship-nucleus"), { cause: { code: "ENOTFOUND" } });
    },
  });
  const store = by(checks, "store");
  assert.equal(store.status, "fail");
  assert.match(store.detail, /ship-nucleus/);
  assert.match(store.detail, /docker network alias/);
  assert.match(store.fix ?? "", /tailnet/, "and the fix is the plan's PRE-DECIDED answer, spelled out");
  assert.equal(joinReady(checks), false, "and the box is not joined");
});

test("an alias that DOES resolve is not refused — it is called what it is", async () => {
  // A box already on the controller's docker network resolves ship-nucleus
  // fine. Refusing something that demonstrably works teaches an operator that
  // the tool guesses; the honest answer is that it works and buys nothing.
  const checks = await runJoinChecks({ ...deps(), plan: plan(), pingStore: async () => POSTGRES_VERSION });
  const store = by(checks, "store");
  assert.equal(store.status, "warn");
  assert.match(store.detail, /no redundancy|buys no redundancy/);
  assert.equal(joinReady(checks), true);
});

test("an unstated store is settled by the engine's own answer — PostgreSQL", async () => {
  const d = deps();
  const checks = await runJoinChecks(d);
  assert.equal(by(checks, "store-kind").status, "ok");
  assert.match(by(checks, "store-kind").detail, /identifies as postgres/);
  assert.equal(d.plan.store, "postgres", "the worker will be started with --store postgres");
  assert.equal(d.plan.env.SHIP_STORE, "postgres");
});

test("an unstated store is settled by the engine's own answer — Nucleus stays a working opt-in", async () => {
  const d = deps({ pingStore: async () => NUCLEUS_VERSION });
  const checks = await runJoinChecks(d);
  assert.equal(joinReady(checks), true, formatChecks(checks));
  assert.equal(d.plan.store, "nucleus");
});

test("a bundle that says nucleus against a PostgreSQL engine fails HERE, not as kv_setnx on every call", async () => {
  const d = deps({ planOver: { bundle: { ...parseEnvFile(BUNDLE), SHIP_STORE: "nucleus" } } });
  const checks = await runJoinChecks(d);
  const kind = by(checks, "store-kind");
  assert.equal(kind.status, "fail");
  assert.match(kind.detail, /store nucleus selected but the engine identifies as postgres/);
  assert.match(kind.fix ?? "", /--store postgres/);
  assert.equal(joinReady(checks), false);
});

test("a stated store that matches the engine passes", async () => {
  const checks = await runJoinChecks(deps({ planOver: { store: "postgres" } }));
  assert.equal(by(checks, "store-kind").status, "ok");
  assert.equal(joinReady(checks), true, formatChecks(checks));
});

test("a file store in the bundle is refused: a worker needs a shared store", async () => {
  const checks = await runJoinChecks(deps({ planOver: { bundle: { ...parseEnvFile(BUNDLE), SHIP_STORE: "file" } } }));
  assert.equal(by(checks, "store-kind").status, "fail");
  assert.equal(joinReady(checks), false);
});

test("an unstated store whose engine will not say what it is fails rather than guessing", async () => {
  const checks = await runJoinChecks(deps({ pingStore: async () => {} }));
  const kind = by(checks, "store-kind");
  assert.equal(kind.status, "fail");
  assert.match(kind.fix ?? "", /--store postgres/);
});

test("a store that is addressable but unreachable fails without leaking the password", async () => {
  const checks = await runJoinChecks(
    deps({
      pingStore: async () => {
        throw Object.assign(new Error("connect ETIMEDOUT 100.76.150.126:5432"), { cause: { code: "ETIMEDOUT" } });
      },
    }),
  );
  const store = by(checks, "store");
  assert.equal(store.status, "fail");
  assert.match(store.detail, /ETIMEDOUT/);
  assert.doesNotMatch(store.detail, /:pw@/, "the connection string is redacted even in the failure");
});

test("a wrong controller token fails HERE, not on the Fleet page", async () => {
  const checks = await runJoinChecks(deps({ fetch: fakeFetch({ ...HEALTHY, "http://100.76.150.126:7460/api/policies": { status: 401 } }) }));
  const token = by(checks, "controller-token");
  assert.equal(token.status, "fail");
  assert.match(token.detail, /401/);
  assert.equal(joinReady(checks), false);
});

test("a token that authenticates but is not admin still counts as a token", async () => {
  const checks = await runJoinChecks(deps({ fetch: fakeFetch({ ...HEALTHY, "http://100.76.150.126:7460/api/policies": { status: 403 } }) }));
  assert.equal(by(checks, "controller-token").status, "ok");
});

test("an unreachable controller names the URL and the network error", async () => {
  const checks = await runJoinChecks(deps({ fetch: fakeFetch({}) }));
  const controller = by(checks, "controller");
  assert.equal(controller.status, "fail");
  assert.match(controller.detail, /ECONNREFUSED/);
  assert.match(controller.fix ?? "", /tailnet/);
});

test("a forge that rejects the deploy token fails, because 'set' is not 'works'", async () => {
  const checks = await runJoinChecks(
    deps({ fetch: fakeFetch({ ...HEALTHY, "http://100.108.123.49:49152/api/v1/user": { status: 401 } }) }),
  );
  const forge = by(checks, "forge:http://100.108.123.49:49152");
  assert.equal(forge.status, "fail");
  assert.match(forge.fix ?? "", /mint a new one/);
});

test("EVERY sandbox host in the pool is checked, not just the first", async () => {
  const checks = await runJoinChecks(
    deps({
      planOver: { addSandbox: "http://172.19.0.1:7439" },
      fetch: fakeFetch({ ...HEALTHY, "http://172.19.0.1:7439/health": { status: 200 } }),
    }),
  );
  // The second host answers /health but its /v1/runs is not in the table, so
  // the token check on it fails — which is precisely the point: a half-working
  // pool member must not be joined silently.
  assert.equal(by(checks, "sandbox:http://172.18.0.1:7439").status, "ok");
  assert.equal(by(checks, "sandbox:http://172.19.0.1:7439").status, "fail");
  assert.equal(joinReady(checks), false);
});

test("a sandbox host that rejects the token says WHY a pool needs one token", async () => {
  const checks = await runJoinChecks(deps({ fetch: fakeFetch({ ...HEALTHY, "http://172.18.0.1:7439/v1/runs": { status: 401 } }) }));
  const sandbox = by(checks, "sandbox:http://172.18.0.1:7439");
  assert.equal(sandbox.status, "fail");
  assert.match(sandbox.fix ?? "", /its OWN token/);
});

test("no sandbox is a WARNING, not a refusal — and says what is lost", async () => {
  const bundle = parseEnvFile(BUNDLE);
  delete bundle.SHIP_SANDBOX_URL;
  const checks = await runJoinChecks({
    ...deps(),
    plan: planJoin({ controller: "http://100.76.150.126:7460", bundle, overrides: { NUCLEUS_URL: "postgres://n:pw@1.2.3.4:5432/n" } }),
  });
  const sandbox = by(checks, "sandbox");
  assert.equal(sandbox.status, "warn");
  assert.match(sandbox.detail, /REFUSED/, "operator-typed runs still work; webhook tasks do not");
  assert.equal(joinReady(checks), true, "and a warning never blocks the join");
});

test("a bundle missing what a worker cannot start without fails first, and lists all of it", async () => {
  const checks = await runJoinChecks({
    ...deps(),
    plan: planJoin({ controller: "http://100.76.150.126:7460", bundle: { SHIP_REPO_ALLOWLIST: "http://f:1/x" } }),
  });
  const bundle = by(checks, "bundle");
  assert.equal(bundle.status, "fail");
  assert.match(bundle.detail, /NUCLEUS_URL/);
  assert.match(bundle.detail, /SHIP_GIT_TOKEN/);
  assert.match(bundle.detail, /ANTHROPIC_API_KEY or AI_GATEWAY_KEY/);
  assert.match(bundle.fix ?? "", /--export-secrets/);
});

test("EVERY check runs even after one fails — one round trip, one fix cycle", async () => {
  const checks = await runJoinChecks({ ...deps(), fetch: fakeFetch({}), pingStore: async () => { throw new Error("nope"); } });
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  assert.ok(failed.includes("controller"), failed.join(","));
  assert.ok(failed.includes("controller-token"));
  assert.ok(failed.includes("store"));
  assert.ok(failed.some((n) => n.startsWith("sandbox:")));
  assert.ok(failed.some((n) => n.startsWith("forge:")));
});

test("the forge co-location refusal reaches the operator IN FULL, from join", async () => {
  const checks = await runJoinChecks(
    deps({
      detect: async () => ({
        colocated: [{ origin: "http://100.108.123.49:49152", how: "worker-gateway", detail: "the forge's port 49152 answers on 172.18.0.1, which is this worker's own default gateway" }],
        unknown: [],
      }),
    }),
  );
  const colocation = by(checks, "colocation");
  assert.equal(colocation.status, "fail");
  assert.match(colocation.detail, /worker-gateway/);
  assert.match(colocation.fix ?? "", /refusing to run sandboxes on the same machine as the forge/);
  assert.match(colocation.fix ?? "", /SHIP_ALLOW_FORGE_COLOCATION=1/);
  assert.equal(joinReady(checks), false, "and the box is NOT joined — this is the B4 gate, surfaced early");
});

test("the co-location override downgrades the refusal to a warning, loudly", async () => {
  const checks = await runJoinChecks(
    deps({
      env: { SHIP_ALLOW_FORGE_COLOCATION: "1" },
      detect: async () => ({ colocated: [{ origin: "http://f:1", how: "loopback", detail: "it is this machine" }], unknown: [] }),
    }),
  );
  assert.equal(by(checks, "colocation").status, "warn");
  assert.match(by(checks, "colocation").detail, /SHIP_ALLOW_FORGE_COLOCATION=1/);
  assert.equal(joinReady(checks), true);
});

test("a co-location check that could not run is a warning, never a silent pass", async () => {
  const checks = await runJoinChecks(deps({ detect: async () => ({ colocated: [], unknown: ["the sandbox has no default route"] }) }));
  assert.equal(by(checks, "colocation").status, "warn");
  assert.match(by(checks, "colocation").detail, /no default route/);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("the report shows the fix under the failure, and a paragraph keeps its shape", () => {
  const text = formatChecks([
    { name: "a", what: "the store answers", status: "ok", detail: "connected" },
    { name: "b", what: "this box is not the forge's box", status: "fail", detail: "it is", fix: "line one\n\nline two" },
  ]);
  assert.match(text, /\[ok {2}] the store answers/);
  assert.match(text, /\[FAIL] this box is not the forge's box/);
  assert.match(text, /fix: line one/);
  assert.match(text, /\n {14}line two/, "continuation lines are indented under the label, not relabelled");
});

test("joinReady ignores warnings and stops on any failure", () => {
  const base: JoinCheck[] = [{ name: "a", what: "w", status: "ok", detail: "d" }];
  assert.equal(joinReady(base), true);
  assert.equal(joinReady([...base, { name: "b", what: "w", status: "warn", detail: "d" }]), true);
  assert.equal(joinReady([...base, { name: "c", what: "w", status: "fail", detail: "d" }]), false);
});
