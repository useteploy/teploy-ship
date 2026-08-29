import { isAuthority, normalizeVerification, type Authority, type ProjectVerification } from "./ladder.js";
import type { RepoRef } from "./git.js";
import { parseRepoUrl } from "./git.js";
import { assertRepoAllowed, credentialFor } from "./repo-policy.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import type { Project } from "./projects.js";
import { normalizeProject } from "./projects.js";
import type { ManagedFields, ProjectStore } from "./projects.js";
import type { ProjectNotifier } from "./notify.js";
import { repoSlug } from "./observe.js";

/**
 * L8 contract 1, Ship's half: the `project` outbox row. Akiroo is the one
 * place a project is configured (C2); this turns its row into a local Project
 * record, a forge webhook, and an ack on the return leg.
 *
 * The seam this rides is S-C's: `verification` is validated and stored by
 * normalizeProject/normalizeVerification, and `authority` is CAPPED there too
 * — effectiveAuthority (ladder.ts) reads the record at enqueue, so whatever
 * authority Akiroo sends, the rungs the project declares decide how far it
 * actually goes. Nothing here re-derives the cap; storing the sent value and
 * letting the ladder read it IS the application.
 *
 * Drift is displayed, never silently reconciled: the fields Akiroo sent are
 * snapshotted in `managedBy.fields` (projects.ts), and an operator's later
 * edit shows as drift on the Projects page until the next row overwrites it.
 */

/** What a `project` row looks like once PARSED (the wire block is snake_case; `verification` here is the validated camelCase ladder declaration). */
export interface ProjectRow {
  project_ref: string;
  repo: string;
  slug: string;
  label?: string;
  verification?: ProjectVerification;
  authority: Authority;
  never_auto?: boolean;
  weekly_budget_usd?: number;
  sandbox_image?: string;
  settings_hash: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Parse and validate one row, or throw a sentence the sweep can log. */
export function parseProjectRow(payload: Record<string, unknown>): ProjectRow {
  const projectRef = str(payload.project_ref);
  const repo = str(payload.repo);
  const slug = str(payload.slug);
  const hash = str(payload.settings_hash);
  if (projectRef === undefined) throw new Error("project row names no project_ref");
  if (repo === undefined) throw new Error(`project ${projectRef} names no repo`);
  if (hash === undefined) throw new Error(`project ${projectRef} names no settings_hash`);
  if (parseRepoUrl(repo) === null) throw new Error(`project ${projectRef} repo is not a clone url: ${repo}`);
  // The slug is the record's key; a slug that disagrees with the repo URL
  // would file the project under one name and allow the repo under another.
  const derived = repoSlug(repo);
  if (slug === undefined) throw new Error(`project ${projectRef} names no slug`);
  if (derived !== null && derived !== slug) {
    throw new Error(`project ${projectRef} slug ${slug} does not match its repo url (${derived})`);
  }
  const authority = str(payload.authority);
  if (authority === undefined || !isAuthority(authority)) {
    throw new Error(`project ${projectRef} authority must be propose, send, auto_trivial or auto_normal`);
  }
  const verification =
    payload.verification !== undefined && payload.verification !== null && typeof payload.verification === "object"
      ? normalizeVerification(wireVerification(payload.verification as Record<string, unknown>, projectRef))
      : undefined;
  const budget = payload.weekly_budget_usd;
  if (budget !== undefined && budget !== null && !(typeof budget === "number" && Number.isFinite(budget) && budget >= 0)) {
    throw new Error(`project ${projectRef} weekly_budget_usd must be a number or null`);
  }
  const sandbox = payload.sandbox_image;
  if (sandbox !== undefined && sandbox !== null && typeof sandbox !== "string") {
    throw new Error(`project ${projectRef} sandbox_image must be a string or null`);
  }
  return {
    project_ref: projectRef,
    repo,
    slug,
    ...(str(payload.label) !== undefined ? { label: str(payload.label) } : {}),
    ...(verification !== undefined ? { verification } : {}),
    authority,
    ...(payload.never_auto === true ? { never_auto: true } : {}),
    ...(typeof budget === "number" ? { weekly_budget_usd: budget } : {}),
    ...(str(sandbox) !== undefined ? { sandbox_image: str(sandbox) } : {}),
    settings_hash: hash,
  };
}

/** The wire block is snake_case; ProjectVerification is camelCase (ladder.ts). */
function wireVerification(raw: Record<string, unknown>, projectRef: string): ProjectVerification {
  const preview = raw.preview;
  if (preview !== undefined && preview !== null && typeof preview === "object") {
    const p = preview as Record<string, unknown>;
    if (typeof p.app !== "string" || typeof p.smoke !== "string") {
      throw new Error(`project ${projectRef} verification.preview needs both app and smoke`);
    }
  }
  const window = raw.observe_window_min;
  if (window !== undefined && window !== null && !(typeof window === "number" && Number.isInteger(window) && window >= 0)) {
    throw new Error(`project ${projectRef} observe_window_min must be a whole number of minutes`);
  }
  return {
    ...(str(raw.build) !== undefined ? { build: str(raw.build) } : {}),
    ...(str(raw.tests) !== undefined ? { tests: str(raw.tests) } : {}),
    ...(typeof preview === "object" && preview !== null && str((preview as Record<string, unknown>).app) !== undefined
      ? {
          preview: {
            app: str((preview as Record<string, unknown>).app)!,
            smoke: str((preview as Record<string, unknown>).smoke) ?? "",
          },
        }
      : {}),
    ...(raw.visual === true ? { visual: true } : {}),
    ...(typeof window === "number" && window > 0 ? { observeWindowMin: window } : {}),
  };
}

/** The forge events Ship itself subscribes a repo to when it creates the hook. */
export const PROJECT_WEBHOOK_EVENTS: readonly string[] = [
  // The intake set the forgejo receiver documents (web/src/routes/hooks/forgejo.tsx):
  "issues",
  "issue_comment",
  // pull_request_comment is its own trigger on Forgejo even though the delivery
  // arrives as issue_comment — the registration gotcha that cost a live session.
  "pull_request_comment",
  // Contract 4: merge and revert detection read these.
  "pull_request",
  "push",
];

function forgeApiBase(ref: RepoRef): string {
  return ref.kind === "github" ? `https://api.github.com/repos/${ref.owner}/${ref.repo}` : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}`;
}

function forgeAuth(ref: RepoRef, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: ref.kind === "github" ? `Bearer ${token}` : `token ${token}`,
    ...(ref.kind === "github" ? { accept: "application/vnd.github+json" } : {}),
  };
}

/**
 * The webhook URL a hook for this repo should post to. The forgejo/github
 * split follows the repo, not Ship's preference: the receiver the payload
 * shape matches is the receiver that can read it.
 */
export function projectHookUrl(hookBase: string, ref: RepoRef): string {
  return `${hookBase.replace(/\/+$/, "")}/hooks/${ref.kind === "github" ? "github" : "forgejo"}`;
}

/**
 * Make sure the repo has a webhook pointed at this Ship, creating it if
 * missing. Ship holds the forge token (that is the whole reason this lives
 * here and not in Akiroo), and the secret it configures is
 * SHIP_WEBHOOK_SECRET — the same secret the receivers verify with, because a
 * hook created with any other value would sign deliveries nothing accepts.
 *
 * True when the hook exists (found or created); false when creation was
 * attempted and the forge refused. Never throws: a project whose hook could
 * not be created is still registered — its ack says `webhook: false` and the
 * operator sees the run of dashes on the Projects page instead of a silent
 * gap in intake.
 */
export async function ensureProjectWebhook(options: {
  ref: RepoRef;
  token: string;
  hookBase: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { ref, token } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const url = projectHookUrl(options.hookBase, ref);
  const base = forgeApiBase(ref);
  const headers = forgeAuth(ref, token);

  const listed = await doFetch(`${base}/hooks?limit=50`, { headers }).catch(() => null);
  if (listed?.ok === true) {
    const hooks = (await listed.json().catch(() => [])) as Array<{ config?: { url?: string } }>;
    if (hooks.some((h) => h.config?.url === url)) return true;
  }

  const created = await doFetch(`${base}/hooks`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      ref.kind === "github"
        ? {
            config: { url, content_type: "json", secret: options.secret },
            events: PROJECT_WEBHOOK_EVENTS,
            active: true,
          }
        : {
            type: "gitea",
            config: { url, content_type: "json", secret: options.secret },
            events: PROJECT_WEBHOOK_EVENTS,
            active: true,
          },
    ),
  });
  return created.ok;
}

export interface RegisterProjectDeps {
  projects: Pick<ProjectStore, "forRepo" | "set">;
  /**
   * The credential source for the forge webhook call, the same config the
   * task handler uses (assertRepoAllowed/credentialFor). A repo Akiroo names
   * that this policy refuses was never this Ship's to manage — the row throws
   * and the ack says failed.
   */
  repoPolicy: RepoPolicyConfig;
  /** hookBase: SHIP_PUBLIC_URL; secret: SHIP_WEBHOOK_SECRET. Empty means "cannot". */
  hookBase: string;
  hookSecret: string;
  notify: Pick<ProjectNotifier, "project">;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
  now?: () => string;
}

export interface RegisterProjectResult {
  status: "registered" | "failed";
  webhook: boolean;
  error?: string;
}

/**
 * One `project` row end to end: upsert the record by slug (joining the
 * allowlist, which IS the project list), snapshot what was applied, create
 * the forge webhook if missing, ack on the return leg.
 *
 * The ack is sent for BOTH outcomes — a failed registration the sender never
 * hears about is a project that looks managed on Akiroo's side and is not on
 * ours, which is exactly the drift C2 says must never be silent.
 */
export async function registerProject(deps: RegisterProjectDeps, payload: Record<string, unknown>): Promise<RegisterProjectResult> {
  let row: ProjectRow;
  try {
    row = parseProjectRow(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[worker] akiroo: project row refused: ${message}`);
    await deps.notify.project({
      kind: "project",
      status: "failed",
      project_ref: str(payload.project_ref) ?? "unknown",
      settings_hash: str(payload.settings_hash) ?? "",
      webhook: false,
      error: message,
    });
    return { status: "failed", webhook: false, error: message };
  }

  try {
    const existing = await deps.projects.forRepo(row.repo);
    const sandboxImage = row.sandbox_image ?? undefined;
    const weeklyBudgetUSD = typeof row.weekly_budget_usd === "number" ? row.weekly_budget_usd : undefined;
    const applied: ManagedFields = {
      url: row.repo,
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(sandboxImage !== undefined ? { sandboxImage } : {}),
      authority: row.authority,
      ...(row.never_auto === true ? { neverAuto: true } : {}),
      ...(weeklyBudgetUSD !== undefined ? { weeklyBudgetUSD } : {}),
      ...(row.verification !== undefined ? { verification: row.verification } : {}),
    };
    // The seven managed fields are OWNED by the row: an absent one clears the
    // record's, so the live record and `applied` agree exactly until an
    // operator edits here (which is the drift the page then shows). Spreading
    // `existing` under the overrides instead would leave a stale label or
    // budget reading as permanent drift.
    const { label: _l, sandboxImage: _si, authority: _a, neverAuto: _na, weeklyBudgetUSD: _wb, verification: _v, managedBy: _m, ...rest } =
      existing ?? { repo: row.slug, autoMerge: false, autoDeploy: false };
    const next: Project = {
      ...rest,
      repo: row.slug,
      ...applied,
      managedBy: {
        source: "akiroo",
        ref: row.project_ref,
        hash: row.settings_hash,
        appliedAt: (deps.now ?? (() => new Date().toISOString()))(),
        fields: applied,
      },
    };
    // normalizeProject IS S-C's ingestion validation: the ladder shape, the
    // authority enum, the tests fold. A row that survives it is a record.
    await deps.projects.set(normalizeProject(next));

    // The forge half. The repo was validated against the same policy a task
    // row is (external trust) inside the try, so the credential lookup below
    // cannot hand a token for a repo the allowlist refuses.
    const allowed = assertRepoAllowed(row.repo, { trust: "external", config: deps.repoPolicy });
    let webhook = false;
    if (deps.hookBase === "" || deps.hookSecret === "") {
      deps.log(`[worker] akiroo: ${row.slug} registered without a forge webhook — SHIP_PUBLIC_URL/SHIP_WEBHOOK_SECRET unset`);
    } else {
      webhook = await ensureProjectWebhook({
        ref: allowed,
        token: credentialFor(allowed, deps.repoPolicy),
        hookBase: deps.hookBase,
        secret: deps.hookSecret,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
    }

    await deps.notify.project({
      kind: "project",
      status: "registered",
      project_ref: row.project_ref,
      settings_hash: row.settings_hash,
      webhook,
    });
    deps.log(`[worker] akiroo: registered ${row.slug} for ${row.project_ref} (hash ${row.settings_hash.slice(0, 8)}, webhook ${webhook ? "yes" : "no"})`);
    return { status: "registered", webhook };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[worker] akiroo: project registration failed for ${row.project_ref}: ${message}`);
    await deps.notify.project({
      kind: "project",
      status: "failed",
      project_ref: row.project_ref,
      settings_hash: row.settings_hash,
      webhook: false,
      error: message,
    });
    return { status: "failed", webhook: false, error: message };
  }
}
