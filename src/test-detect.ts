import { withProjects } from "./durable.js";
import { parseRepoUrl } from "./git.js";
import type { RepoRef } from "./git.js";
import { credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import type { ProjectStore } from "./projects.js";
import { testTargetFromTree } from "./tests.js";
import type { RepoTree, TestTarget } from "./tests.js";

/**
 * Where a repository's test command comes from when nobody typed one (B5-d).
 *
 * The chore this removes: every repo owed Ship a
 * `teploy-ship evidence set <repo> --test-command "…"` before a single pull
 * request could carry a suite result, and the worker-wide SHIP_TEST_COMMAND is
 * by construction wrong for every repo but the one it was written for. A
 * stranger installing Ship had to know that before their first PR looked like
 * the product.
 *
 * WHY THIS RUNS AT ENQUEUE, NOT AT EXECUTION. Evidence is materialised into the
 * run input at enqueue (runtime.ts, `enqueueRun`) precisely so a replay runs the
 * command the log was written under — the store is editable, and a step that
 * re-derives its own inputs at execution time is how a replay diverges from its
 * log. A detected command is evidence config like any other, so it is resolved
 * here, once, and copied into the input. Detection MUST NOT move into the
 * worker: a repo whose package.json changed between enqueue and replay would
 * then run a different suite than the one recorded.
 *
 * WHY THE FORGE API AND NOT THE CLONE. At enqueue there is no checkout — the
 * clone happens inside the run's sandbox, minutes later, on another machine.
 * Four cheap reads against an API Ship already talks to (git.ts opens pull
 * requests over the same endpoints) beat both a speculative clone and moving
 * the decision to a place that breaks replay.
 *
 * Every failure here is silent and returns undefined. Detection is a
 * convenience; a forge that is slow, down, or refuses the token must never stop
 * a run being queued.
 */

/** Root entries worth reading in full. Everything else is decided by name. */
const CONTENT_FILES = [
  { path: "package.json", key: "packageJson" },
  { path: "Makefile", key: "makefile" },
  { path: "pyproject.toml", key: "pyproject" },
] as const;

/** Per-request ceiling. Four of these sit in front of an enqueue. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Detection is a hint about a repository, and repositories change slowly. */
const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map<string, { at: number; target: TestTarget | undefined }>();

/** Drop the memoised detections. Tests only. */
export function clearTestDetectCache(): void {
  cache.clear();
}

function apiBase(ref: RepoRef): string {
  return ref.kind === "github"
    ? `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents`
    : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}/contents`;
}

function headers(ref: RepoRef, token: string): Record<string, string> {
  return {
    ...(token === "" ? {} : { authorization: ref.kind === "github" ? `Bearer ${token}` : `token ${token}` }),
    ...(ref.kind === "github" ? { accept: "application/vnd.github+json" } : {}),
  };
}

async function get(url: string, init: RequestInit, doFetch: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // unref: a pending 5s timer must not hold a CLI process open after the
  // enqueue it was created for has already answered.
  timer.unref?.();
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Decode a contents-API file entry. Both forges answer base64. */
function decodeContent(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const entry = body as Record<string, unknown>;
  if (entry.type !== "file" || typeof entry.content !== "string") return undefined;
  if (entry.encoding !== undefined && entry.encoding !== "base64") return undefined;
  try {
    // A test suite declaration is small; anything over 256 KB is not one, and
    // decoding it would be the only unbounded allocation on the enqueue path.
    if (entry.content.length > 350_000) return undefined;
    return Buffer.from(entry.content, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  /** Credentials + allowlist. Defaults to the worker's environment. */
  config?: RepoPolicyConfig;
  /** Project records widen the allowlist by exact repo (durable.ts:withProjects). */
  projects?: Pick<ProjectStore, "list">;
}

/**
 * Read the handful of root files `testTargetFromTree` decides from.
 *
 * Returns null when the repository could not be read at all — an unparseable
 * URL, a `file://` remote (no API), a forge that refused. Never throws.
 */
export async function probeRepoTree(repo: string, options: ProbeOptions = {}): Promise<RepoTree | null> {
  let ref: RepoRef;
  try {
    ref = parseRepoUrl(repo);
  } catch {
    return null;
  }
  // Local bare repos (tests, air-gapped mirrors) have no HTTP API to ask.
  if (ref.base === "file://") return null;

  const doFetch = options.fetchImpl ?? fetch;
  const config = await withProjects(options.config ?? policyFromEnv(), options.projects);
  let token: string;
  try {
    token = credentialFor(ref, config);
  } catch {
    // The origin is not allowlisted. Ship does not make an unauthenticated
    // request to it either: the URL on this path arrives from a webhook, a
    // Slack message or an issue body, and "we only READ from the attacker's
    // host" is still an outbound request the operator never authorised.
    return null;
  }
  const init = { headers: headers(ref, token) };
  const base = apiBase(ref);

  const root = await get(base, init, doFetch);
  if (!Array.isArray(root)) return null;
  const names = root
    .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).name : undefined))
    .filter((n): n is string => typeof n === "string");

  const tree: RepoTree = { names };
  await Promise.all(
    CONTENT_FILES.filter((f) => names.includes(f.path)).map(async (f) => {
      const text = decodeContent(await get(`${base}/${f.path}`, init, doFetch));
      if (text !== undefined) tree[f.key] = text;
    }),
  );
  return tree;
}

/** What a repo's suite is, and whether a human said so. */
export interface ResolvedTestTarget extends TestTarget {
  /** "project" = an explicit per-repo entry; "detected" = read off the tree. */
  source: "project" | "detected";
}

export interface ResolveOptions extends ProbeOptions {
  /** Skip the network and the cache. Set SHIP_TEST_DETECT=0 to turn detection off. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * The test command a run should be enqueued with.
 *
 * Precedence, and this order is the whole contract:
 *   1. the repo's explicit entry (project record / `evidence set`) — an
 *      operator's statement always wins, including a deliberately empty one;
 *   2. what the tree says, detected here;
 *   3. nothing, which leaves the worker's SHIP_TEST_COMMAND in charge exactly
 *      as it was before detection existed.
 *
 * `enqueueRun` copies the result into the recorded run input, so a replay runs
 * this command and not whatever the repository looks like on the day of the
 * replay.
 */
export async function resolveTestTarget(
  repo: string | undefined,
  evidence: { testCommand?: string; testTimeoutMs?: number } | null | undefined,
  options: ResolveOptions = {},
): Promise<ResolvedTestTarget | undefined> {
  const explicit = evidence?.testCommand?.trim();
  if (explicit !== undefined && explicit !== "") {
    return {
      command: explicit,
      ...(evidence?.testTimeoutMs !== undefined ? { timeoutMs: evidence.testTimeoutMs } : {}),
      source: "project",
    };
  }
  if (repo === undefined || repo.trim() === "") return undefined;
  const env = options.env ?? process.env;
  if (/^(0|false|no|off)$/i.test((env.SHIP_TEST_DETECT ?? "").trim())) return undefined;

  const now = options.now ?? Date.now;
  const key = repo.trim().toLowerCase();
  const hit = cache.get(key);
  let target: TestTarget | undefined;
  if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) {
    target = hit.target;
  } else {
    const tree = await probeRepoTree(repo, options);
    target = tree === null ? undefined : testTargetFromTree(tree);
    // A miss is cached too: a repo with no recognisable suite must not cost
    // four forge round trips on every webhook that mentions it.
    cache.set(key, { at: now(), target });
  }
  if (target === undefined) return undefined;
  return {
    ...target,
    // The operator's timeout applies to a detected command as well — they may
    // have set only that half.
    ...(evidence?.testTimeoutMs !== undefined ? { timeoutMs: evidence.testTimeoutMs } : {}),
    source: "detected",
  };
}
