import type { AgentExecutor } from "@neutron-build/agents";

/**
 * The git verb's plumbing. Everything here is HARNESS-side: the token is
 * used only in commands this module executes directly, whose observations
 * are never added to the agent's conversation — the agent sees a cloned
 * repo on a work branch and nothing else. (On a sandbox executor commands
 * are argv-exec'd; on a local executor the push URL is briefly visible in
 * the process list — acceptable for the trusted-local path.)
 */

export interface RepoRef {
  kind: "forgejo" | "github";
  /** Origin without credentials, e.g. http://host:3000 or https://github.com */
  base: string;
  owner: string;
  repo: string;
  /** Credential-free clone URL. */
  cloneUrl: string;
}

/**
 * Parse an http(s) repo URL. Anything on github.com speaks the GitHub
 * API; every other host is assumed to be Forgejo/Gitea (Teploy's world —
 * self-hosted first).
 */
export function parseRepoUrl(url: string): RepoRef {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported repo URL protocol: ${parsed.protocol} (use http/https)`);
  }
  const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length < 2) throw new Error(`repo URL needs /owner/repo: ${url}`);
  const owner = segments[segments.length - 2]!;
  const repo = segments[segments.length - 1]!;
  const base = `${parsed.protocol}//${parsed.host}`;
  return {
    kind: parsed.hostname === "github.com" ? "github" : "forgejo",
    base,
    owner,
    repo,
    cloneUrl: `${base}/${owner}/${repo}.git`,
  };
}

/**
 * The clone URL with the token embedded, for clone/push only. An empty
 * token passes the URL through untouched (local/file remotes in tests
 * take no credentials).
 */
export function authenticatedUrl(ref: RepoRef, token: string): string {
  if (token === "") return ref.cloneUrl;
  const url = new URL(ref.cloneUrl);
  // Forgejo and GitHub both accept token-as-username basic auth.
  url.username = encodeURIComponent(token);
  return url.toString();
}

async function git(executor: AgentExecutor, command: string, timeoutMs = 120_000): Promise<string> {
  const result = await executor.exec(command, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`git step failed (exit ${result.exitCode}): ${command.replace(/\/\/[^@/]+@/g, "//***@")}\n${result.stderr.slice(0, 2000)}`);
  }
  return result.stdout.trim();
}

export interface RepoCheckout {
  /** The work branch the agent's changes will ride. */
  branch: string;
  /** The default branch PRs target. */
  base: string;
}

/**
 * Clone into the executor's workspace root and stand on a fresh work
 * branch. The remote is rewritten credential-free immediately after the
 * clone, so nothing the agent can read contains the token.
 */
export async function setupRepo(
  executor: AgentExecutor,
  options: { ref: RepoRef; token: string; runId: string },
): Promise<RepoCheckout> {
  const { ref, token, runId } = options;
  await git(executor, `git clone --depth 50 ${authenticatedUrl(ref, token)} . 2>&1`, 300_000);
  await git(executor, `git remote set-url origin ${ref.cloneUrl}`);
  await git(executor, 'git config user.name "Teploy Ship" && git config user.email "ship@teploy.dev"');
  const base = await git(executor, "git rev-parse --abbrev-ref HEAD");
  const branch = `ship/${runId}`;
  await git(executor, `git checkout -b ${branch}`);
  return { branch, base };
}

/**
 * Commit whatever the agent left in the tree and push the work branch.
 * Returns null when there is nothing to push (empty diff = no PR). The
 * commit happens harness-side so the agent never needs git etiquette —
 * its deliverable is the edited tree, exactly like the SWE-bench path.
 */
export async function commitAndPush(
  executor: AgentExecutor,
  options: { ref: RepoRef; token: string; checkout: RepoCheckout; message: string },
): Promise<{ sha: string } | null> {
  const { ref, token, checkout, message } = options;
  const status = await git(executor, "git status --porcelain");
  if (status !== "") {
    const safe = message.replace(/'/g, "'\\''");
    await git(executor, `git add -A && git commit -m '${safe}'`);
  }
  const ahead = await git(executor, `git rev-list --count origin/${checkout.base}..HEAD`);
  if (ahead === "0") return null;
  const sha = await git(executor, "git rev-parse HEAD");
  await git(executor, `git push ${authenticatedUrl(ref, token)} HEAD:refs/heads/${checkout.branch} 2>&1`, 300_000);
  return { sha };
}

export interface PullRequest {
  url: string;
  number: number;
}

/**
 * Open the PR over the host's API. Forgejo and GitHub use the same
 * payload shape for this endpoint; only the base path and auth header
 * differ.
 */
export async function openPullRequest(options: {
  ref: RepoRef;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<PullRequest> {
  const { ref, token } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint =
    ref.kind === "github"
      ? `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls`
      : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}/pulls`;
  const response = await doFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: ref.kind === "github" ? `Bearer ${token}` : `token ${token}`,
      ...(ref.kind === "github" ? { accept: "application/vnd.github+json" } : {}),
    },
    body: JSON.stringify({
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`PR creation failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const created = (await response.json()) as { number: number; html_url?: string; url?: string };
  return { number: created.number, url: created.html_url ?? created.url ?? "" };
}

/** The task prompt wrapper for repo work — repo-aware, token-free. */
export function fixPrompt(options: { task: string; branch: string; base: string }): string {
  return `You are working in a git repository, already cloned at your working directory and checked out on branch ${options.branch} (branched from ${options.base}).

${options.task}

Requirements:
- Find and run the repository's tests to verify your change (look for test scripts, pytest, go test, cargo test, npm test, etc.). Your change must not break passing tests.
- Your deliverable is the EDITED WORKING TREE. Do not commit, push, or touch git config — that is handled after you finish. Never revert your edits; if an approach fails, improve it rather than restoring the original.
- Keep the change minimal and in the style of the surrounding code.`;
}
