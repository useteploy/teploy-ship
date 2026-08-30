import { parseRepoUrl } from "./git.js";

/**
 * The warm per-repo volume cache (SB-A), Ship's half.
 *
 * Clone + install dominates the fixed cost of every run, and the sandbox
 * daemon now keeps a per-repo template — a ready clone with its dependency
 * tree — that a run can boot a private COPY of (teploy-sandbox
 * `README.md`, "Warm repo cache"). This module is the client for that
 * surface plus the one naming rule both sides have to agree on.
 *
 * REPLAY. Nothing here may decide a step's presence: the cache is live
 * host state, and a run that replays on a box whose cache has since been
 * evicted must walk the same step sequence it walked the first time. So
 * the run input carries `warm` (materialised at enqueue, exactly like
 * `index` and `guard`), the daemon-facing calls all live INSIDE recorded
 * steps, and every failure degrades to the cold path rather than failing
 * the run.
 */

/** The daemon's view of one run's warm volume, plus its repo's template. */
export interface WarmState {
  /** Normalised `owner/name`-shaped slug the daemon keyed the volume on. */
  repo: string;
  /** Was this run's volume seeded from an existing template? */
  booted: boolean;
  /** The volume's lockfile hash as it stands now. */
  lockHash: string;
  /** Where in the volume the lockfiles were found (`.` at the root). */
  repoDir: string;
  /** The repo's PUBLISHED template hash, null when the repo has no template. */
  templateHash: string | null;
}

/**
 * The cache key for a repository: `<origin>/<owner>/<name>`, lowercased,
 * with anything outside the daemon's slug alphabet folded to `-` (a port
 * separator, mainly — `100.64.0.1:3000` becomes `100.64.0.1-3000`).
 *
 * The origin is part of the key on purpose: two forges can both hold an
 * `owner/name`, and a cache collision between them would hand a run
 * somebody else's clone.
 *
 * Returns null for anything the daemon would refuse, which is the signal
 * to run without a warm volume — `file://` remotes (local mirrors and
 * tests) included, since there is nothing to save there.
 */
export function warmSlugOf(repoUrl: string): string | null {
  let base: string;
  let owner: string;
  let repo: string;
  try {
    const ref = parseRepoUrl(repoUrl);
    if (ref.base === "file://") return null;
    ({ base, owner, repo } = ref);
  } catch {
    return null;
  }
  const origin = base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const segments = `${origin}/${owner}/${repo}`
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/[^a-z0-9_.-]/g, "-"));
  if (segments.length < 2) return null;
  // The daemon's own shape check (run.NormalizeSlug): each segment starts
  // alphanumeric, is at most 63 characters, and never begins or ends with a
  // dot. Refusing here keeps a bad name out of the create call entirely
  // rather than turning it into a 400 that costs the run its sandbox.
  if (segments.some((segment) => !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(segment) || segment.endsWith("."))) return null;
  return segments.join("/");
}

/** Is the warm cache on for this deployment? On unless switched off. */
export function warmCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHIP_WARM_CACHE ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

interface WarmHttp {
  baseURL: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

interface DaemonWarm {
  repo?: unknown;
  booted?: unknown;
  lockHash?: unknown;
  repoDir?: unknown;
}

function stateOf(warm: DaemonWarm, templateHash: string | null): WarmState {
  return {
    repo: typeof warm.repo === "string" ? warm.repo : "",
    booted: warm.booted === true,
    lockHash: typeof warm.lockHash === "string" ? warm.lockHash : "",
    repoDir: typeof warm.repoDir === "string" ? warm.repoDir : "",
    templateHash,
  };
}

async function call(http: WarmHttp, method: "GET" | "POST", path: string, body?: string): Promise<Response> {
  const doFetch = http.fetch ?? globalThis.fetch;
  return await doFetch(`${http.baseURL.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${http.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

async function warmOf(response: Response): Promise<DaemonWarm | null> {
  if (!response.ok) return null;
  const parsed = (await response.json().catch(() => null)) as { warm?: DaemonWarm } | null;
  return parsed?.warm ?? null;
}

/**
 * The daemon's warm endpoints, as the two questions Ship actually asks.
 *
 * Every method answers null rather than throwing on a daemon that has no
 * cache store (`serve --cache-root` unset — a 400), on a run that has no
 * warm volume, and on a repo with no template yet (a 404). All three are
 * ordinary states of a working deployment, not faults.
 */
export function warmClient(http: WarmHttp): {
  info: (runId: string) => Promise<WarmState | null>;
  commit: (runId: string) => Promise<WarmState | null>;
} {
  const template = async (slug: string): Promise<string | null> => {
    if (slug === "") return null;
    const warm = await warmOf(await call(http, "GET", `/v1/warmcache/${slug}`));
    return warm !== null && typeof warm.lockHash === "string" ? warm.lockHash : null;
  };
  return {
    async info(runId: string): Promise<WarmState | null> {
      const warm = await warmOf(await call(http, "GET", `/v1/runs/${encodeURIComponent(runId)}/warm`));
      if (warm === null) return null;
      const state = stateOf(warm, null);
      return { ...state, templateHash: await template(state.repo) };
    },
    async commit(runId: string): Promise<WarmState | null> {
      const warm = await warmOf(await call(http, "POST", `/v1/runs/${encodeURIComponent(runId)}/warm-commit`, "{}"));
      return warm === null ? null : stateOf(warm, typeof warm.lockHash === "string" ? warm.lockHash : null);
    },
  };
}

/** A lock hash as it appears on a run's timeline. */
export function shortHash(hash: string): string {
  return hash === "" ? "none" : hash.slice(0, 12);
}
