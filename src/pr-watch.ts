/**
 * B1 — PR watch (S16, S09): Ship's own open pull requests, polled.
 *
 * What already existed (verified 2026-10-16): a failed GitHub/Forgejo Actions
 * `workflow_run` on a `ship/…` branch becomes a CI-fix task
 * (ciFixTaskFromWorkflowRun), and labelled PR comments/reviews become review
 * tasks. All of it is webhook-driven, so a forge with no webhook configured,
 * an external CI that reports commit statuses rather than workflow runs, and a
 * PR that went into conflict because its BASE moved produced nothing at all.
 *
 * This is the bounded polling half. Behind SHIP_PR_WATCH=on (anything else is
 * off, and off is a strict no-op: no store reads, no forge calls):
 *
 *  - Discovery reads run metas past a cursor, newest first, PAGING below the
 *    newest window (bounded pages per sweep) so a burst of runs between
 *    sweeps is not skipped, and watches every PR a run OPENED (a recorded
 *    `repo-pr` step). A run that reviewed or revised someone else's PR opened
 *    nothing, so it is never watched; the forge's head branch must also be
 *    `ship/…` at check time. A backlog deeper than the page bound is paged
 *    through across sweeps via a resume marker — the cursor itself advances
 *    only once everything above it is proven examined (see discover).
 *  - Each due watch costs forge reads only (readForgeState + one best-effort
 *    branch-protection read) — never a model call. Watches are capped per
 *    sweep, spaced by SHIP_PR_WATCH_INTERVAL_SEC, and back off exponentially
 *    on forge errors.
 *  - A conflict (mergeable=false) or a failing check on the head SHA proposes
 *    ONE revision task on the same PR through the ordinary intake path, so
 *    source/project policy, budgets and auto windows decide whether it waits
 *    in the Inbox or launches. Conflict wins when both hold: resolving it
 *    produces a new head whose checks are what matter. The dedupe key is
 *    PR + head SHA + reason; the failing-check key is the SAME key the CI
 *    webhook writes, so a webhook delivery and a poll collapse to one task.
 *    The watch record also remembers what it proposed, so a dismissed task is
 *    not re-proposed for the same head.
 *  - Merged or closed (or 30 days old) ends the watch.
 *
 * State lives in the runtime config KV (one small row per watched PR plus the
 * discovery cursor) — no second task database.
 */
import { createHash } from "node:crypto";

import type { RepoRef } from "./git.js";
import { forgeFetch } from "./forge-egress.js";
import { readForgeState, type ForgeState } from "./forge-state.js";
import type { IntakeStore, ProposeInput } from "./intake.js";
import type { ProjectStore } from "./projects.js";
import { assertRepoAllowed, credentialFor, policyFromEnv, RepoNotAllowedError, type RepoPolicyConfig } from "./repo-policy.js";
import type { RunMeta } from "./run-store.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { withProjects } from "./durable.js";

export const PR_WATCH_KEY_PREFIX = "SHIP_PR_WATCH_PR_";
export const PR_WATCH_CURSOR_KEY = "SHIP_PR_WATCH_CURSOR";
/**
 * A backlog deeper than the page bound, mid-examination: `{ top, at, offset }`
 * — how deep into the ranking the sweeps have examined so far. While this is
 * set, the cursor does NOT advance (see discover).
 */
export const PR_WATCH_DISCOVERY_RESUME_KEY = "SHIP_PR_WATCH_DISCOVERY_RESUME";
/** Runs examined per discovery page (newest updated first). */
export const PR_WATCH_DISCOVERY_LIMIT = 50;
/** Discovery reads at most this many pages per sweep, so a sweep stays bounded. */
export const PR_WATCH_DISCOVERY_MAX_PAGES = 10;
export const PR_WATCH_DEFAULT_INTERVAL_SEC = 300;
export const PR_WATCH_DEFAULT_MAX_PER_SWEEP = 20;
/** Error backoff ceiling. */
export const PR_WATCH_MAX_BACKOFF_SEC = 3600;
/** A watch older than this is dropped even if the PR is still open. */
export const PR_WATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HANDLED_KEEP = 20;

/** Only the exact value `on` enables the watch. */
export function prWatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHIP_PR_WATCH === "on";
}

export function prWatchIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SHIP_PR_WATCH_INTERVAL_SEC);
  return Number.isFinite(n) && n >= 30 ? Math.floor(n) : PR_WATCH_DEFAULT_INTERVAL_SEC;
}

export function prWatchMaxPerSweep(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SHIP_PR_WATCH_MAX_PER_SWEEP);
  return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.floor(n)) : PR_WATCH_DEFAULT_MAX_PER_SWEEP;
}

export interface PrWatch {
  repo: string;
  pr: number;
  /** The run that opened the PR. */
  runId: string;
  addedAt: string;
  /** Earliest time the next forge read may happen. */
  nextAt: string;
  failures: number;
  lastCheckedAt?: string;
  lastHead?: string;
  /** Dedupe keys this watch already proposed (bounded, newest last). */
  handled: string[];
}

export function prWatchKey(repo: string, pr: number): string {
  const id = createHash("sha256").update(`${repo.toLowerCase().replace(/\.git$/, "")}#${pr}`).digest("hex").slice(0, 24);
  return PR_WATCH_KEY_PREFIX + id;
}

export interface PrWatchDeps {
  config: RuntimeConfigStore;
  /** Newest-first run metas. `offset` pages below the newest window (see discover). */
  listMeta: (options?: { limit?: number; offset?: number }) => Promise<RunMeta[]>;
  store: { load: (runId: string) => Promise<WorkflowEvent[]> };
  intake: Pick<IntakeStore, "propose">;
  projects?: Pick<ProjectStore, "list">;
  /** Repo policy (allowlist + credentials). Defaults to the environment. */
  policy?: RepoPolicyConfig;
  /** Injected for tests; production uses the egress-checked forge fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PrWatchResult {
  enabled: boolean;
  discovered: number;
  checked: number;
  proposed: { repo: string; pr: number; reason: "conflict" | "check"; taskId: string; created: boolean }[];
  unwatched: { repo: string; pr: number; why: string }[];
  errors: string[];
}

/** One sweep. Strict no-op (no reads at all) unless SHIP_PR_WATCH=on. */
export async function sweepPrWatch(deps: PrWatchDeps): Promise<PrWatchResult> {
  const env = deps.env ?? process.env;
  const result: PrWatchResult = { enabled: false, discovered: 0, checked: 0, proposed: [], unwatched: [], errors: [] };
  if (!prWatchEnabled(env)) return result;
  result.enabled = true;
  const now = deps.now ?? (() => new Date());
  try {
    result.discovered = await discover(deps, now());
  } catch (e) {
    result.errors.push(`discovery: ${message(e)}`);
  }
  const keys = (await deps.config.list()).filter((k) => k.key.startsWith(PR_WATCH_KEY_PREFIX)).map((k) => k.key);
  const policy = await withProjects(deps.policy ?? policyFromEnv(env), deps.projects);
  const cap = prWatchMaxPerSweep(env);
  const interval = prWatchIntervalSec(env);
  // Least recently checked first, so the cap rotates through every watch.
  const due: { key: string; watch: PrWatch }[] = [];
  for (const key of keys) {
    // A transient read error (store hiccup, lock, timeout) is NOT a corrupt
    // row: deleting the watch here would throw away its `handled` history, and
    // a task an operator dismissed could be proposed again. Skip the key this
    // sweep; only a value that came back and fails to parse is removed.
    let raw: string | undefined;
    try {
      raw = await deps.config.get(key);
    } catch {
      continue;
    }
    const watch = parseWatch(raw);
    if (watch === null) {
      await deps.config.remove(key).catch(() => {});
      continue;
    }
    if (now().getTime() - Date.parse(watch.addedAt) > PR_WATCH_MAX_AGE_MS) {
      await deps.config.remove(key).catch(() => {});
      result.unwatched.push({ repo: watch.repo, pr: watch.pr, why: "watch expired (30 days)" });
      continue;
    }
    if (Date.parse(watch.nextAt) <= now().getTime()) due.push({ key, watch });
  }
  due.sort((a, b) => (a.watch.lastCheckedAt ?? "") < (b.watch.lastCheckedAt ?? "") ? -1 : 1);
  for (const { key, watch } of due.slice(0, cap)) {
    try {
      await checkOne(deps, policy, key, watch, interval, now, result);
    } catch (e) {
      result.errors.push(`${watch.repo}#${watch.pr}: ${message(e)}`);
    }
  }
  for (const line of result.errors) deps.log?.(`[worker] pr watch: ${line}`);
  return result;
}

/** The parked state of a backlog deeper than one sweep's page bound. */
interface DiscoveryResume {
  /** Newest meta stamp of the backlog (where the cursor may go once finished). */
  top: string;
  /** Stamp of the deepest meta examined so far (detects the ranking shifting). */
  at: string;
  /** Metas examined from the top (a multiple of PR_WATCH_DISCOVERY_LIMIT). */
  offset: number;
}

function parseResume(raw: string | undefined): DiscoveryResume | null {
  if (raw === undefined || raw === "") return null;
  let r: Partial<DiscoveryResume>;
  try {
    r = JSON.parse(raw) as Partial<DiscoveryResume>;
  } catch {
    return null;
  }
  const top = typeof r.top === "string" && r.top !== "" ? r.top : null;
  const at = typeof r.at === "string" ? r.at : null;
  const offset = typeof r.offset === "number" && Number.isSafeInteger(r.offset) && r.offset >= PR_WATCH_DISCOVERY_LIMIT ? r.offset : null;
  if (top === null || at === null || offset === null) return null;
  return { top, at, offset };
}

/**
 * Discovery: watch every PR a recently-updated run OPENED.
 *
 * Metas are read newest-first in PR_WATCH_DISCOVERY_LIMIT-wide pages past a
 * cursor stamp, at most PR_WATCH_DISCOVERY_MAX_PAGES pages per sweep. The
 * cursor means "every meta above this has been examined", so it may only
 * advance when the walk PROVED that: it crossed into metas at or below the
 * cursor, or it ran off the end of history. Reading only the newest window
 * while advancing the cursor to the newest meta — the reviewed bug — skipped
 * every run past the window forever whenever more than one window's worth of
 * runs updated between sweeps. Parking the cursor at the deepest meta
 * examined would be the same bug one window later: everything below the
 * cursor counts as seen, so the unexamined tail of a backlog deeper than the
 * page bound would be silently marked seen. Instead, a bound-stopped sweep
 * leaves the cursor alone and parks a resume marker (depth + boundary stamp);
 * the next sweep continues from that depth. Newer metas landing above the
 * boundary shift the ranking, which the boundary stamp detects — the walk
 * then restarts from the top (re-examining metas is harmless: watches dedupe
 * by key, and a run that opened nothing leaves no row to collide with).
 */
async function discover(deps: PrWatchDeps, now: Date): Promise<number> {
  const cursor = (await deps.config.get(PR_WATCH_CURSOR_KEY).catch(() => undefined)) ?? "";
  const resume = parseResume(await deps.config.get(PR_WATCH_DISCOVERY_RESUME_KEY).catch(() => undefined));
  const base = resume !== null ? Math.floor(resume.offset / PR_WATCH_DISCOVERY_LIMIT) * PR_WATCH_DISCOVERY_LIMIT : 0;
  let page = base / PR_WATCH_DISCOVERY_LIMIT;
  let pages = 0;
  let restarted = resume === null;
  let newest = resume !== null && resume.top > cursor ? resume.top : cursor;
  let boundary = resume?.at ?? "";
  let crossed = false;
  let ended = false;
  let added = 0;
  while (pages < PR_WATCH_DISCOVERY_MAX_PAGES) {
    const metas = await deps.listMeta({ limit: PR_WATCH_DISCOVERY_LIMIT, offset: page * PR_WATCH_DISCOVERY_LIMIT });
    if (!restarted && resume !== null && metas.length > 0 && metas[0]!.updatedAt > resume.at) {
      restarted = true;
      page = 0;
      pages = 0;
      continue;
    }
    pages += 1;
    if (metas.length === 0) {
      ended = true;
      break;
    }
    if (metas[0]!.updatedAt > newest) newest = metas[0]!.updatedAt;
    boundary = metas[metas.length - 1]!.updatedAt;
    for (const meta of metas) {
      // At or below the cursor = examined on the sweep that wrote it (that
      // sweep examined the meta whose stamp became the cursor). Deeper metas
      // are older still, so reaching one proves the walk is done.
      if (meta.updatedAt <= cursor) {
        crossed = true;
        break;
      }
      const opened = openedPr(await deps.store.load(meta.runId));
      if (opened === null) continue;
      const key = prWatchKey(opened.repo, opened.pr);
      let watched: boolean;
      try {
        watched = (await deps.config.get(key)) !== undefined;
      } catch {
        // Transient read error: assume it is watched rather than overwrite a
        // row that may hold handled history. Re-checked next sweep.
        watched = true;
      }
      if (watched) continue;
      const watch: PrWatch = { repo: opened.repo, pr: opened.pr, runId: meta.runId, addedAt: now.toISOString(), nextAt: now.toISOString(), failures: 0, handled: [] };
      await deps.config.set(key, JSON.stringify(watch), "pr-watch");
      added += 1;
    }
    if (crossed) break;
    if (metas.length < PR_WATCH_DISCOVERY_LIMIT) {
      ended = true;
      break;
    }
    page += 1;
  }
  if (crossed || ended) {
    // Proven: every meta above the cursor has been examined (this sweep or
    // the parked ones). The cursor may finally advance; the marker is spent.
    if (resume !== null) await deps.config.remove(PR_WATCH_DISCOVERY_RESUME_KEY).catch(() => {});
    if (newest !== cursor) await deps.config.set(PR_WATCH_CURSOR_KEY, newest, "pr-watch");
    return added;
  }
  // Out of page budget mid-backlog: park the depth reached. The cursor stays
  // where it is, so the unexamined tail below is NOT marked seen.
  const offset = (restarted ? 0 : base) + pages * PR_WATCH_DISCOVERY_LIMIT;
  await deps.config.set(PR_WATCH_DISCOVERY_RESUME_KEY, JSON.stringify({ top: newest, at: boundary, offset } satisfies DiscoveryResume), "pr-watch");
  return added;
}

/** The PR a run OPENED: a recorded `repo-pr` step on a repo run. Reviews/revisions of existing PRs open none. */
export function openedPr(events: WorkflowEvent[]): { repo: string; pr: number } | null {
  const input = (events.find((e) => e.type === "run-started")?.data as { input?: { repo?: unknown } } | undefined)?.input;
  if (typeof input?.repo !== "string" || input.repo === "") return null;
  for (const e of events) {
    if (e.type !== "step-completed" || e.name !== "repo-pr") continue;
    const r = (e.data as { result?: { number?: unknown; url?: unknown } } | undefined)?.result;
    const n = Number(r?.number);
    if (Number.isSafeInteger(n) && n > 0) return { repo: input.repo, pr: n };
  }
  return null;
}

const FAILING = new Set(["failure", "failed", "error", "timed_out", "action_required"]);

async function checkOne(
  deps: PrWatchDeps,
  policy: RepoPolicyConfig,
  key: string,
  watch: PrWatch,
  interval: number,
  now: () => Date,
  result: PrWatchResult,
): Promise<void> {
  const unwatch = async (why: string): Promise<void> => {
    await deps.config.remove(key);
    result.unwatched.push({ repo: watch.repo, pr: watch.pr, why });
  };
  let ref: RepoRef;
  let token: string;
  try {
    ref = assertRepoAllowed(watch.repo, { trust: "external", config: policy });
    token = credentialFor(ref, policy);
  } catch (e) {
    if (e instanceof RepoNotAllowedError) return unwatch(`repository no longer allowed: ${e.message.slice(0, 200)}`);
    throw e;
  }
  const fetchImpl = deps.fetchImpl ?? forgeFetch;
  let state: ForgeState;
  try {
    state = await readForgeState(ref, token, watch.pr, fetchImpl);
  } catch (e) {
    const failures = watch.failures + 1;
    const wait = Math.min(PR_WATCH_MAX_BACKOFF_SEC, interval * 2 ** Math.min(failures, 10));
    await save(deps, key, { ...watch, failures, lastCheckedAt: now().toISOString(), nextAt: new Date(now().getTime() + wait * 1000).toISOString() });
    throw new Error(`forge read failed (retry in ${wait}s): ${message(e)}`);
  }
  result.checked += 1;
  if (state.state !== "open") return unwatch(state.state);
  if (state.headRef !== undefined && !state.headRef.startsWith("ship/")) return unwatch(`head branch ${state.headRef} is not a Ship branch`);

  const next: PrWatch = { ...watch, failures: 0, lastCheckedAt: now().toISOString(), lastHead: state.head, nextAt: new Date(now().getTime() + interval * 1000).toISOString() };
  const fullName = `${ref.owner}/${ref.repo}`;
  let proposal: (ProposeInput & { reason: "conflict" | "check" }) | null = null;
  // `mergeable_state` is computed asynchronously (GitHub answers "unknown"
  // while it works) and is often transient ("blocked"/"unstable" mean a
  // failing check or a review is pending, not that the branches no longer
  // merge). Treating any of those as a conflict would propose revision tasks
  // on a guess, so only "dirty" — or a forge that does not answer the field
  // at all — counts. The cost of waiting out a transient state is one sweep;
  // the cost of a wrong conflict task is a human's attention, and a real
  // conflict persists and is caught on the next sweep anyway.
  const conflicted = state.mergeable === false && (state.mergeableState === undefined || state.mergeableState === "dirty");
  if (conflicted) {
    proposal = {
      reason: "conflict",
      source: "pr-watch",
      kind: "conflict",
      repo: watch.repo,
      pr: watch.pr,
      title: `PR #${watch.pr} has merge conflicts with ${state.base || "its base branch"}`,
      detail:
        `This pull request no longer merges cleanly into ${state.base || "its base branch"} (head ${state.head.slice(0, 10)}).` +
        ` Bring the base branch into the PR branch, resolve the conflicts so both sides' intent is preserved, run the repository's tests, and push to this pull request.`,
      dedupeKey: `pr-watch:${fullName}#${watch.pr}:${state.head}:conflict`,
    };
  } else {
    const failing = state.checks.filter((c) => FAILING.has(c.state.toLowerCase()));
    const required = failing.length > 0 ? await requiredContexts(ref, token, state.base, fetchImpl) : null;
    const counted = required === null ? failing : failing.filter((c) => required.some((r) => contextMatches(r, c.name)));
    if (counted.length > 0) {
      const names = counted.slice(0, 5).map((c) => `"${c.name}" (${c.state})${c.url !== undefined ? ` ${c.url}` : ""}`);
      proposal = {
        reason: "check",
        source: "ci",
        kind: "ci",
        repo: watch.repo,
        pr: watch.pr,
        title: `CI failed on PR #${watch.pr}: ${counted[0]!.name}`.slice(0, 200),
        detail:
          `A ${required === null ? "" : "required "}check FAILED on this pull request's head (${state.headRef ?? "branch"} @ ${state.head.slice(0, 10)}): ${names.join("; ")}.` +
          ` Reproduce the failure locally (run the repository's tests), fix it, and verify the tests pass.`,
        // The CI webhook's key (ciFixTaskFromWorkflowRun): a delivery and a poll of the same head are one task.
        dedupeKey: `ci:${fullName}#${watch.pr}:${state.head}`,
      };
    }
  }
  if (proposal !== null && !next.handled.includes(proposal.dedupeKey)) {
    const { reason, ...input } = proposal;
    const { created, task } = await deps.intake.propose(input);
    next.handled = [...next.handled, proposal.dedupeKey].slice(-HANDLED_KEEP);
    result.proposed.push({ repo: watch.repo, pr: watch.pr, reason, taskId: task.taskId, created });
  }
  await save(deps, key, next);
}

/**
 * The base branch's required status contexts, best effort. null = unknown
 * (no protection, no permission to read it, or an unreadable answer): then
 * every failing check counts, which is the honest reading of "a red check".
 */
export async function requiredContexts(ref: RepoRef, token: string, base: string, fetchImpl: typeof fetch): Promise<string[] | null> {
  if (base === "") return null;
  const github = ref.kind === "github";
  const url = github
    ? `https://api.github.com/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`
    : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}/branch_protections/${encodeURIComponent(base)}`;
  try {
    const r = await fetchImpl(url, {
      headers: { authorization: `${github ? "Bearer" : "token"} ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > 200_000) return null;
    const body = JSON.parse(text) as Record<string, unknown>;
    let contexts: unknown[] = [];
    if (github) {
      contexts = [
        ...(Array.isArray(body.contexts) ? body.contexts : []),
        ...(Array.isArray(body.checks) ? (body.checks as { context?: unknown }[]).map((c) => c?.context) : []),
      ];
    } else {
      if (body.enable_status_check !== true) return null;
      contexts = Array.isArray(body.status_check_contexts) ? body.status_check_contexts : [];
    }
    const names = contexts.filter((c): c is string => typeof c === "string" && c !== "");
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

/** Exact match, or a Forgejo-style glob with `*`. */
export function contextMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

function parseWatch(raw: string | undefined): PrWatch | null {
  if (raw === undefined || raw === "") return null;
  try {
    const w = JSON.parse(raw) as Partial<PrWatch>;
    if (typeof w.repo !== "string" || !Number.isSafeInteger(w.pr) || typeof w.addedAt !== "string" || typeof w.nextAt !== "string") return null;
    return {
      repo: w.repo,
      pr: w.pr!,
      runId: String(w.runId ?? ""),
      addedAt: w.addedAt,
      nextAt: w.nextAt,
      failures: Number.isFinite(w.failures) ? Number(w.failures) : 0,
      ...(typeof w.lastCheckedAt === "string" ? { lastCheckedAt: w.lastCheckedAt } : {}),
      ...(typeof w.lastHead === "string" ? { lastHead: w.lastHead } : {}),
      handled: Array.isArray(w.handled) ? w.handled.filter((h): h is string => typeof h === "string") : [],
    };
  } catch {
    return null;
  }
}

async function save(deps: PrWatchDeps, key: string, watch: PrWatch): Promise<void> {
  await deps.config.set(key, JSON.stringify(watch), "pr-watch");
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
