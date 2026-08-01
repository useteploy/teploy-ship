import assert from "node:assert/strict";
import test from "node:test";

import {
  RepoNotAllowedError,
  assertRepoAllowed,
  credentialFor,
  isAllowed,
  parseAllowlist,
  parseOriginTokens,
} from "./repo-policy.js";
import { parseRepoUrl } from "./git.js";

const ATTACKER = "https://attacker.example/org/repo";
const OURS = "https://github.com/useteploy/teploy-cli";
const FORGEJO = "http://100.108.123.49:49152/tyler/teploy-ship";

test("parseAllowlist reads origin, origin+owner and exact-repo entries", () => {
  const entries = parseAllowlist(
    "https://github.com/useteploy, http://100.108.123.49:49152/tyler/teploy-ship\nhttps://git.example.com/",
  );
  assert.deepEqual(entries, [
    { origin: "https://github.com", owner: "useteploy" },
    { origin: "http://100.108.123.49:49152", owner: "tyler", repo: "teploy-ship" },
    { origin: "https://git.example.com" },
  ]);
});

test("parseAllowlist drops malformed entries instead of widening the list", () => {
  assert.deepEqual(parseAllowlist("not-a-url, ftp://x/y, ,"), []);
  assert.deepEqual(parseAllowlist(undefined), []);
  assert.deepEqual(parseAllowlist("   "), []);
});

test("isAllowed matches at the configured precision, case-insensitively", () => {
  const owner = parseAllowlist("https://github.com/useteploy");
  assert.equal(isAllowed(parseRepoUrl("https://github.com/useteploy/anything"), owner), true);
  assert.equal(isAllowed(parseRepoUrl("https://GITHUB.com/UseTeploy/Anything"), owner), true);
  assert.equal(isAllowed(parseRepoUrl("https://github.com/someone-else/repo"), owner), false);

  const exact = parseAllowlist("https://github.com/useteploy/teploy-cli");
  assert.equal(isAllowed(parseRepoUrl(OURS), exact), true);
  assert.equal(isAllowed(parseRepoUrl("https://github.com/useteploy/other"), exact), false);

  // Host must match exactly — a lookalike origin is not the allowlisted one.
  assert.equal(isAllowed(parseRepoUrl("https://github.com.evil.test/useteploy/x"), owner), false);
});

test("TS-001: an external repo is refused outright when no allowlist is configured", () => {
  assert.throws(
    () => assertRepoAllowed(ATTACKER, { trust: "external", config: {} }),
    (e: unknown) => e instanceof RepoNotAllowedError && /SHIP_REPO_ALLOWLIST/.test((e as Error).message),
  );
});

test("an operator-typed repo still works with no allowlist (deployments keep running)", () => {
  const ref = assertRepoAllowed(FORGEJO, { trust: "operator", config: {} });
  assert.equal(ref.owner, "tyler");
  assert.equal(ref.repo, "teploy-ship");
});

test("with an allowlist, BOTH trust levels are bound by it", () => {
  const config = { allowlist: "https://github.com/useteploy" };
  assert.equal(assertRepoAllowed(OURS, { trust: "external", config }).repo, "teploy-cli");
  for (const trust of ["operator", "external"] as const) {
    assert.throws(
      () => assertRepoAllowed(ATTACKER, { trust, config }),
      RepoNotAllowedError,
      `${trust} must not reach a non-allowlisted origin`,
    );
  }
});

test("file:// remotes need no allowlist and take no credential", () => {
  const ref = assertRepoAllowed("file:///tmp/bare/owner/repo.git", { trust: "external", config: {} });
  assert.equal(ref.base, "file://");
  assert.equal(credentialFor(ref, { gitToken: "secret" }), "");
});

test("TS-001: credentialFor refuses to hand a token to a non-allowlisted origin", () => {
  const config = { allowlist: "https://github.com/useteploy", gitToken: "deploy-token" };
  assert.throws(() => credentialFor(parseRepoUrl(ATTACKER), config), RepoNotAllowedError);
  assert.equal(credentialFor(parseRepoUrl(OURS), config), "deploy-token");
});

test("credentialFor prefers an exact per-origin token, then github, then the generic one", () => {
  const config = {
    originTokens: JSON.stringify({
      "http://100.108.123.49:49152": "forgejo-token",
      "https://github.com": "gh-origin-token",
    }),
    gitToken: "generic",
    githubToken: "gh-fallback",
  };
  assert.equal(credentialFor(parseRepoUrl(FORGEJO), config), "forgejo-token");
  assert.equal(credentialFor(parseRepoUrl(OURS), config), "gh-origin-token");
  assert.equal(credentialFor(parseRepoUrl("https://other.example/a/b"), config), "generic");

  const noOrigins = { gitToken: "generic", githubToken: "gh-fallback" };
  assert.equal(credentialFor(parseRepoUrl(OURS), noOrigins), "gh-fallback");
  assert.equal(credentialFor(parseRepoUrl(FORGEJO), noOrigins), "generic");
});

test("parseOriginTokens tolerates junk without throwing at config time", () => {
  assert.deepEqual(parseOriginTokens("{not json"), {});
  assert.deepEqual(parseOriginTokens("[1,2]"), {});
  assert.deepEqual(parseOriginTokens(undefined), {});
  assert.deepEqual(parseOriginTokens('{"https://x.test/":"t","https://y.test":""}'), { "https://x.test": "t" });
});

test("an unparseable repo URL is refused, not passed through", () => {
  assert.throws(() => assertRepoAllowed("https://github.com/onlyowner", { trust: "operator" }), RepoNotAllowedError);
  assert.throws(() => assertRepoAllowed("ssh://git@github.com/a/b", { trust: "operator" }), RepoNotAllowedError);
});
