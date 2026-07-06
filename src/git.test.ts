import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { authenticatedUrl, commitAndPush, openPullRequest, parseRepoUrl, setupRepo } from "./git.js";

test("parseRepoUrl: forgejo and github, .git suffix, credentials URL", () => {
  const forgejo = parseRepoUrl("http://100.108.123.49:49152/Tyler/teploy-ship.git");
  assert.equal(forgejo.kind, "forgejo");
  assert.equal(forgejo.base, "http://100.108.123.49:49152");
  assert.equal(forgejo.owner, "Tyler");
  assert.equal(forgejo.repo, "teploy-ship");
  assert.equal(forgejo.cloneUrl, "http://100.108.123.49:49152/Tyler/teploy-ship.git");

  const github = parseRepoUrl("https://github.com/useteploy/teploy");
  assert.equal(github.kind, "github");
  assert.equal(github.cloneUrl, "https://github.com/useteploy/teploy.git");

  assert.equal(authenticatedUrl(forgejo, "s3cr3t"), "http://s3cr3t@100.108.123.49:49152/Tyler/teploy-ship.git");
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

  // no changes -> null (no PR)
  assert.equal(await commitAndPush(executor, { ref, token: "", checkout, message: "noop" }), null);

  // agent-style tree edit -> committed and pushed
  await executor.exec("echo fixed >> readme.md && echo new > lib.py");
  const pushed = await commitAndPush(executor, { ref, token: "", checkout, message: "fix: the thing\n\nrun-test1234" });
  assert.notEqual(pushed, null);

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
