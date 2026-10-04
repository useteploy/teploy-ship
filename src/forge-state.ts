import type { RepoRef } from "./git.js";
import { forgeFetch } from "./forge-egress.js";
import { safeForDisplay } from "./redact.js";
export interface ForgeState {
  checkedAt: string;
  number: number;
  state: "open" | "closed" | "merged";
  head: string;
  base: string;
  url: string;
  title: string;
  draft: boolean;
  checks: { name: string; state: string; url?: string }[];
  reviews: { author: string; state: string; body: string }[];
  /**
   * Inline review comments, present only when the caller asked for them
   * (S09 finding continuity). Additive: `reviews` keeps its shape and caps.
   * `resolved` is set only when the forge says so: GitHub's REST API does not
   * expose thread resolution (GraphQL does), so there it stays undefined,
   * meaning "unknown", never "unresolved".
   */
  reviewComments?: ForgeReviewComment[];
  warnings: string[];
}
export interface ForgeReviewComment {
  author: string;
  path?: string;
  line?: number;
  body: string;
  /** True when a later push left the comment with no current anchor (GitHub). */
  outdated?: boolean;
  resolved?: boolean;
}
const MAX_INLINE_COMMENTS = 100;
const FORGEJO_REVIEWS_WALKED = 10;
/** Read only, bounded, never follows a forge redirect with credentials. */
export async function readForgeState(
  ref: RepoRef,
  token: string,
  pr: number,
  fetchImpl: typeof fetch = forgeFetch,
  options: { inlineComments?: boolean } = {},
): Promise<ForgeState> {
  if (!Number.isSafeInteger(pr) || pr < 1)
    throw new Error("Invalid pull request number");
  const github = ref.kind === "github";
  const base = github
    ? `https://api.github.com/repos/${ref.owner}/${ref.repo}`
    : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}`;
  async function read(path: string): Promise<any> {
    const r = await fetchImpl(base + path, {
      headers: {
        authorization: `${github ? "Bearer" : "token"} ${token}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Forge returned HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 2_000_000)
      throw new Error("Forge response exceeded the size limit");
    return JSON.parse(text);
  }
  const p = await read(`/pulls/${pr}`);
  if (
    !["open", "closed"].includes(p.state) ||
    typeof p.head?.sha !== "string" ||
    !/^[a-f0-9]{7,64}$/i.test(p.head.sha)
  )
    throw new Error("Forge returned an incomplete pull request");
  const result: ForgeState = {
    checkedAt: new Date().toISOString(),
    number: pr,
    state: p.merged === true || p.merged_at ? "merged" : p.state,
    head: p.head.sha,
    base: String(p.base?.ref ?? "").slice(0, 255),
    url: `${ref.base}/${ref.owner}/${ref.repo}/${github ? "pull" : "pulls"}/${pr}`,
    title: safeForDisplay(String(p.title ?? ""), 300),
    draft: p.draft === true || /^(WIP|\[WIP\]):?\s/i.test(p.title ?? ""),
    checks: [],
    reviews: [],
    warnings: [],
  };
  const paths = [
    `/commits/${p.head.sha}/status`,
    `/pulls/${pr}/reviews?per_page=100&limit=100`,
    ...(github ? [`/commits/${p.head.sha}/check-runs?per_page=100`] : []),
  ];
  const parts = await Promise.allSettled(paths.map(read));
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.status === "rejected") {
      result.warnings.push(
        `${["Commit statuses", "Reviews", "Check runs"][i]} unavailable`,
      );
      continue;
    }
    const raw = part.value;
    if (i === 1)
      result.reviews = (Array.isArray(raw) ? raw : [])
        .slice(-100)
        .map((r: any) => ({
          author: String(r.user?.login ?? "Reviewer").slice(0, 100),
          state: String(r.state ?? "unknown").slice(0, 60),
          body: safeForDisplay(String(r.body ?? ""), 500),
        }));
    else {
      const checks = i === 0 ? raw.statuses : raw.check_runs;
      for (const c of Array.isArray(checks) ? checks.slice(0, 100) : [])
        result.checks.push({
          name: String(c.context ?? c.name ?? "Check").slice(0, 120),
          state: String(c.conclusion ?? c.state ?? c.status ?? "unknown").slice(
            0,
            60,
          ),
          ...(typeof (c.target_url ?? c.html_url) === "string"
            ? { url: String(c.target_url ?? c.html_url).slice(0, 500) }
            : {}),
        });
      if ((raw.total_count ?? 0) > 100)
        result.warnings.push("Only the first 100 checks are shown");
    }
  }
  if (options.inlineComments === true) {
    try {
      result.reviewComments = await readInlineComments(read, github, pr, parts[1]!);
    } catch {
      result.warnings.push("Inline review comments unavailable");
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 10000)
    result.warnings.push(
      "Some reviews or checks omitted; open the forge for the full list",
    );
  while (
    Buffer.byteLength(JSON.stringify(result)) > 10000 &&
    (result.reviews.length || result.checks.length || result.reviewComments?.length)
  ) {
    if (result.reviewComments?.length) result.reviewComments.pop();
    else if (result.reviews.length) result.reviews.pop();
    else result.checks.pop();
  }
  return result;
}

/**
 * GitHub lists every inline comment flat at /pulls/N/comments. Forgejo hangs
 * them off each review (/pulls/N/reviews/ID/comments), so that walk is bounded
 * to the newest reviews; its comments carry a `resolver`, the one place either
 * forge's REST API says a thread is resolved.
 */
async function readInlineComments(
  read: (path: string) => Promise<any>,
  github: boolean,
  pr: number,
  reviewsPart: PromiseSettledResult<any>,
): Promise<ForgeReviewComment[]> {
  const out: ForgeReviewComment[] = [];
  const push = (c: any): void => {
    if (out.length >= MAX_INLINE_COMMENTS) return;
    const line = c.line ?? c.original_line ?? c.position ?? c.original_position;
    out.push({
      author: String(c.user?.login ?? "Reviewer").slice(0, 100),
      ...(typeof c.path === "string" ? { path: c.path.slice(0, 300) } : {}),
      ...(typeof line === "number" && line >= 1 ? { line } : {}),
      body: safeForDisplay(String(c.body ?? ""), 500),
      ...(github && c.position === null ? { outdated: true } : {}),
      ...(!github && "resolver" in c ? { resolved: c.resolver !== null && c.resolver !== undefined } : {}),
    });
  };
  if (github) {
    const raw = await read(`/pulls/${pr}/comments?per_page=100`);
    for (const c of Array.isArray(raw) ? raw : []) push(c);
    return out;
  }
  const list = reviewsPart.status === "fulfilled" && Array.isArray(reviewsPart.value) ? reviewsPart.value : [];
  for (const r of list.slice(-FORGEJO_REVIEWS_WALKED)) {
    if (typeof r?.id !== "number") continue;
    const raw = await read(`/pulls/${pr}/reviews/${r.id}/comments`).catch(() => []);
    for (const c of Array.isArray(raw) ? raw : []) push(c);
  }
  return out;
}
