import assert from "node:assert/strict";
import { test } from "node:test";

import { harnessRef } from "./harness.js";
import { clearTestDetectCache, probeRepoTree, resolveTestTarget } from "./test-detect.js";

const FORGEJO = "http://forge.example:3000/tyler/thing";
const ALLOWED = { allowlist: "http://forge.example:3000/tyler", gitToken: "tok" };

/** A fetch that answers the two contents-API shapes and records what was asked. */
function fakeForge(files: Record<string, string>, names?: string[]) {
  const calls: string[] = [];
  const auth: (string | null)[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    auth.push(((init?.headers ?? {}) as Record<string, string>).authorization ?? null);
    const path = href.split("/contents")[1] ?? "";
    if (path === "") {
      const entries = (names ?? Object.keys(files)).map((name) => ({ name, type: "file" }));
      return new Response(JSON.stringify(entries), { status: 200, headers: { "content-type": "application/json" } });
    }
    const file = files[path.replace(/^\//, "")];
    if (file === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(file).toString("base64") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls, auth };
}

test("probeRepoTree reads the root listing plus only the files detection needs", async () => {
  clearTestDetectCache();
  const forge = fakeForge({ "package.json": '{"scripts":{"test":"vitest"}}', "Makefile": "test:\n\tx\n" }, [
    "package.json",
    "Makefile",
    "src",
    "README.md",
  ]);
  const tree = await probeRepoTree(FORGEJO, { fetchImpl: forge.impl, config: ALLOWED });
  assert.deepEqual(tree?.names, ["package.json", "Makefile", "src", "README.md"]);
  assert.equal(tree?.packageJson, '{"scripts":{"test":"vitest"}}');
  assert.equal(tree?.makefile, "test:\n\tx\n");
  // pyproject.toml is not in the listing, so it is never fetched: four
  // requests is the ceiling that sits in front of an enqueue.
  assert.equal(forge.calls.length, 3);
  assert.ok(!forge.calls.some((c) => c.includes("pyproject")));
  // Forgejo takes `token <t>`; the credential is chosen by repo-policy.
  assert.deepEqual(new Set(forge.auth), new Set(["token tok"]));
});

test("probeRepoTree refuses an origin the allowlist does not name — no unauthenticated read either", async () => {
  clearTestDetectCache();
  const forge = fakeForge({});
  const tree = await probeRepoTree("http://evil.example/a/b", { fetchImpl: forge.impl, config: ALLOWED });
  assert.equal(tree, null);
  // The URL on this path comes from a webhook or an issue body. "We only READ
  // from the attacker's host" is still an outbound request nobody authorised.
  assert.equal(forge.calls.length, 0);
});

test("probeRepoTree returns null rather than throwing for unusable remotes and dead forges", async () => {
  clearTestDetectCache();
  const dead = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal(await probeRepoTree("not a url", { fetchImpl: dead, config: ALLOWED }), null);
  assert.equal(await probeRepoTree("file:///srv/git/a/b.git", { fetchImpl: dead, config: ALLOWED }), null);
  assert.equal(await probeRepoTree(FORGEJO, { fetchImpl: dead, config: ALLOWED }), null);
});

test("resolveTestTarget: an explicit per-repo command always wins and costs no request", async () => {
  clearTestDetectCache();
  const forge = fakeForge({ "go.mod": "module x\n" });
  const got = await resolveTestTarget(FORGEJO, { testCommand: "go test -race ./...", testTimeoutMs: 60_000 }, {
    fetchImpl: forge.impl,
    config: ALLOWED,
  });
  assert.deepEqual(got, { command: "go test -race ./...", timeoutMs: 60_000, source: "project" });
  assert.equal(forge.calls.length, 0);
});

test("resolveTestTarget: with no entry it detects from the tree and keeps the operator's timeout", async () => {
  clearTestDetectCache();
  const forge = fakeForge({}, ["go.mod", "main.go"]);
  const got = await resolveTestTarget(FORGEJO, { testTimeoutMs: 300_000 }, { fetchImpl: forge.impl, config: ALLOWED });
  assert.deepEqual(got, { command: "go test ./...", timeoutMs: 300_000, source: "detected" });
});

test("resolveTestTarget: nothing recognisable, no repo, or SHIP_TEST_DETECT=0 leaves the worker default in charge", async () => {
  clearTestDetectCache();
  const forge = fakeForge({}, ["README.md"]);
  assert.equal(await resolveTestTarget(FORGEJO, null, { fetchImpl: forge.impl, config: ALLOWED }), undefined);
  assert.equal(await resolveTestTarget(undefined, null, { fetchImpl: forge.impl, config: ALLOWED }), undefined);

  clearTestDetectCache();
  const off = fakeForge({}, ["go.mod"]);
  assert.equal(
    await resolveTestTarget(FORGEJO, null, { fetchImpl: off.impl, config: ALLOWED, env: { SHIP_TEST_DETECT: "0" } }),
    undefined,
  );
  assert.equal(off.calls.length, 0);
});

test("resolveTestTarget memoises per repo, hits and misses alike, and expires", async () => {
  clearTestDetectCache();
  const forge = fakeForge({}, ["go.mod"]);
  let clock = 1_000;
  const opts = { fetchImpl: forge.impl, config: ALLOWED, now: () => clock };

  await resolveTestTarget(FORGEJO, null, opts);
  await resolveTestTarget(FORGEJO, null, opts);
  // A webhook burst against one repo must not be four forge round trips each.
  assert.equal(forge.calls.length, 1);

  clock += 11 * 60_000;
  await resolveTestTarget(FORGEJO, null, opts);
  assert.equal(forge.calls.length, 2);
});

test("resolveTestTarget: a github repo speaks the github API with a bearer token", async () => {
  clearTestDetectCache();
  const forge = fakeForge({}, ["Cargo.toml"]);
  const got = await resolveTestTarget("https://github.com/im-tyler/thing", null, {
    fetchImpl: forge.impl,
    config: { githubToken: "ghp_x" },
  });
  assert.deepEqual(got, { command: "cargo test", source: "detected" });
  assert.ok(forge.calls[0]!.startsWith("https://api.github.com/repos/im-tyler/thing/contents"));
  assert.deepEqual(forge.auth, ["Bearer ghp_x"]);
});

test("resolveTestTarget: a project record's clone URL is enough to allow the read", async () => {
  clearTestDetectCache();
  const forge = fakeForge({}, ["go.mod"]);
  // An install whose only allowlist entry is the Projects page must still
  // detect; policy widening is the same rule enqueue itself uses.
  const got = await resolveTestTarget(FORGEJO, null, {
    fetchImpl: forge.impl,
    config: {},
    projects: { async list() { return [{ repo: "tyler/thing", url: FORGEJO, autoMerge: false, autoDeploy: false }]; } },
  });
  assert.deepEqual(got, { command: "go test ./...", source: "detected" });
});

/**
 * The composition `enqueueRun` performs, asserted here because `src/runtime.ts`
 * is the one file this change could not edit (see
 * `_internal/B5_RUNTIME_WIRING.md`). If the four-line patch there is applied and
 * this test passes, the enqueue path behaves as designed.
 */
test("enqueue wiring: harness precedence and the testCommand that lands in the run input", async () => {
  const forge = fakeForge({}, ["go.mod"]);
  const wire = async (
    options: { harness?: string; tests: boolean },
    project: { harness?: string } | null,
    evidence: { testCommand?: string; testTimeoutMs?: number } | null,
    env: NodeJS.ProcessEnv,
  ) => {
    // src/runtime.ts:658, patched.
    const harness = harnessRef(options.harness ?? project?.harness ?? env.SHIP_HARNESS);
    // src/runtime.ts, new call after :646.
    const testTarget =
      options.tests ? await resolveTestTarget(FORGEJO, evidence, { fetchImpl: forge.impl, config: ALLOWED }) : undefined;
    // src/runtime.ts:696-697, patched.
    return {
      harness,
      ...(testTarget !== undefined ? { testCommand: testTarget.command } : {}),
      ...(testTarget?.timeoutMs !== undefined ? { testTimeoutMs: testTarget.timeoutMs } : {}),
    };
  };

  clearTestDetectCache();
  // A repo that declares its harness beats the worker's env.
  assert.deepEqual(
    await wire({ tests: false }, { harness: "opencode" }, null, { SHIP_HARNESS: "claude-code" }),
    { harness: { id: "opencode", version: "1" } },
  );
  // No declaration: the worker's env, then native.
  assert.deepEqual(await wire({ tests: false }, null, null, { SHIP_HARNESS: "claude-code" }), {
    harness: { id: "claude-code", version: "1" },
  });
  assert.deepEqual(await wire({ tests: false }, null, null, {}), { harness: { id: "native", version: "1" } });
  // An explicit per-run choice beats both.
  assert.deepEqual(await wire({ harness: "native", tests: false }, { harness: "opencode" }, null, {}), {
    harness: { id: "native", version: "1" },
  });

  clearTestDetectCache();
  // tests off: nothing is probed, and the input carries no command.
  const before = forge.calls.length;
  assert.deepEqual(await wire({ tests: false }, null, null, {}), { harness: { id: "native", version: "1" } });
  assert.equal(forge.calls.length, before);

  // tests on, no entry: the detected command lands in the input.
  assert.deepEqual(await wire({ tests: true }, null, null, {}), {
    harness: { id: "native", version: "1" },
    testCommand: "go test ./...",
  });
  // tests on, explicit entry: unchanged from before detection existed.
  clearTestDetectCache();
  assert.deepEqual(await wire({ tests: true }, null, { testCommand: "make check", testTimeoutMs: 60_000 }, {}), {
    harness: { id: "native", version: "1" },
    testCommand: "make check",
    testTimeoutMs: 60_000,
  });
});
