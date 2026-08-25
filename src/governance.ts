import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { upsertByKey } from "./upsert.js";
import { stateDir } from "./run-store.js";
import { repoSlug } from "./observe.js";
import { normalizeRole } from "./users.js";
import type { Role } from "./users.js";

/**
 * The buyer half of P2-3: who may do what, when auto is allowed to run
 * unattended, and who has to review what Ship opens.
 *
 * Three rules, one store, because they are edited together and read together:
 *
 *   authority  — which ROLES and which named USERS may approve a parked run,
 *                set a source to `auto`, steer/cancel a run, or change these
 *                policies at all. Deny by default: a role not named in a grant
 *                is refused, and `normalizeRole` already maps every unknown
 *                role string to viewer, which no default grant includes.
 *   windows    — a wall-clock window per source (or `*` for all) outside which
 *                an `auto` source behaves as `propose`: the task waits in the
 *                Inbox for a human instead of launching unattended at 03:00.
 *   reviewers  — per repository (owner/name slug, the same key evidence.ts
 *                uses), the reviewers and teams every PR Ship opens there must
 *                request. Materialised into the run input at ENQUEUE because
 *                it adds a recorded step; see enqueueRun.
 *
 * The CLI is deliberately NOT gated by `authority`. A CLI actor is `user@host`
 * attested by the OS, holds the state directory or the Nucleus credentials
 * directly, and has no role to check — a shell on the worker already IS
 * every authority. The gates live where identity is a role: the dashboard
 * and its API.
 */

export type AuthorityAction = "approve" | "auto" | "steer" | "policies";

export const AUTHORITY_ACTIONS: readonly AuthorityAction[] = ["approve", "auto", "steer", "policies"];

export interface Grant {
  roles: Role[];
  /** Named users allowed regardless of role. Stable ids (see actor.ts). */
  users: string[];
}

export type Authority = Record<AuthorityAction, Grant>;

/** Today's behaviour, spelled out: editor approves/steers, admin sets auto and edits policy. */
export const DEFAULT_AUTHORITY: Authority = {
  approve: { roles: ["admin", "editor"], users: [] },
  auto: { roles: ["admin"], users: [] },
  steer: { roles: ["admin", "editor"], users: [] },
  policies: { roles: ["admin"], users: [] },
};

export interface AutoWindow {
  /** Days of the week, 0 = Sunday .. 6 = Saturday, in the window's tz. */
  days: number[];
  /** "HH:MM" wall clock in `tz`. */
  start: string;
  /** "HH:MM" wall clock in `tz`. `end` before `start` wraps past midnight. */
  end: string;
  /** IANA zone, e.g. "Europe/Berlin". */
  tz: string;
}

/** Windows keyed by source; "*" is the global default a source may override. */
export type Windows = Record<string, AutoWindow>;

export const GLOBAL_WINDOW = "*";

export interface ReviewerRule {
  /** Repo slug owner/name. */
  repo: string;
  users: string[];
  teams: string[];
}

export interface Governance {
  authority: Authority;
  windows: Windows;
  reviewers: ReviewerRule[];
}

export interface GovernanceStore {
  get(): Promise<Governance>;
  setAuthority(action: AuthorityAction, grant: Grant): Promise<void>;
  setWindow(source: string, window: AutoWindow | null): Promise<void>;
  setReviewers(rule: { repo: string; users?: string[]; teams?: string[] }): Promise<void>;
}

// ── Authority ─────────────────────────────────────────────────────────────

/**
 * May this principal perform `action`? Deny by default: an unknown action,
 * an unknown role, and an absent principal are all refused.
 */
export function mayDo(
  governance: Pick<Governance, "authority">,
  action: AuthorityAction,
  principal: { user: string; role: string } | null | undefined,
): boolean {
  if (principal === null || principal === undefined) return false;
  const grant = governance.authority[action];
  if (grant === undefined) return false;
  const role = normalizeRole(principal.role);
  if (grant.roles.includes(role)) return true;
  return grant.users.includes(principal.user);
}

export function normalizeGrant(raw: unknown): Grant {
  const g = (raw ?? {}) as { roles?: unknown; users?: unknown };
  const roles = Array.isArray(g.roles)
    ? [...new Set(g.roles.filter((r): r is string => typeof r === "string" && ["admin", "editor", "viewer"].includes(r)).map((r) => r as Role))]
    : [];
  const users = Array.isArray(g.users)
    ? [...new Set(g.users.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter((u) => u !== ""))]
    : [];
  return { roles, users };
}

// ── Windows ───────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (m === null) throw new Error(`time must be HH:MM, got: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Throws with an operator-readable message on any invalid field. */
export function validateWindow(raw: unknown): AutoWindow {
  const w = (raw ?? {}) as Partial<AutoWindow>;
  if (!Array.isArray(w.days) || w.days.length === 0) throw new Error("window needs at least one day");
  const days = [...new Set(w.days.map((d) => Number(d)))].sort((a, b) => a - b);
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("days must be 0 (Sun) to 6 (Sat)");
  if (typeof w.start !== "string" || !HHMM.test(w.start)) throw new Error("start must be HH:MM");
  if (typeof w.end !== "string" || !HHMM.test(w.end)) throw new Error("end must be HH:MM");
  if (w.start === w.end) throw new Error("start and end must differ");
  if (typeof w.tz !== "string" || w.tz.trim() === "") throw new Error("tz is required (an IANA zone such as Europe/Berlin)");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: w.tz });
  } catch {
    throw new Error(`unknown time zone: ${w.tz}`);
  }
  return { days, start: w.start, end: w.end, tz: w.tz };
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall clock in `tz` at `now`: weekday and minutes since midnight. DST is the zone's problem, not ours. */
export function wallClock(now: Date, tz: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds print midnight as "24" in hour12:false mode.
  const hour = Number(get("hour")) % 24;
  return { day: DAY_INDEX[get("weekday")] ?? 0, minute: hour * 60 + Number(get("minute")) };
}

/**
 * Is `now` inside the window? An overnight window (22:00-06:00) belongs to
 * the day it STARTS on: Friday 22:00-06:00 covers Saturday 02:00.
 */
export function insideWindow(window: AutoWindow, now: Date): boolean {
  const { day, minute } = wallClock(now, window.tz);
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start < end) return window.days.includes(day) && minute >= start && minute < end;
  // Wraps midnight.
  if (minute >= start) return window.days.includes(day);
  if (minute < end) return window.days.includes((day + 6) % 7);
  return false;
}

/** The window governing `source`: its own, else the global one, else none. */
export function windowFor(windows: Windows, source: string): AutoWindow | undefined {
  return windows[source] ?? windows[GLOBAL_WINDOW];
}

/**
 * Is an `auto` source allowed to launch unattended right now? No window means
 * always. Called by the intake sweep: outside the window an auto task parks as
 * propose and waits in the Inbox.
 */
export function autoAllowedNow(windows: Windows, source: string, now: Date): boolean {
  const w = windowFor(windows, source);
  return w === undefined ? true : insideWindow(w, now);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatWindow(w: AutoWindow): string {
  return `${w.days.map((d) => DAY_NAMES[d]).join(",")} ${w.start}-${w.end} ${w.tz}`;
}

/**
 * Parse an operator's day list: "mon-fri", "sat,sun", "1-5", "mon,wed,fri".
 */
export function parseDays(text: string): number[] {
  const out = new Set<number>();
  const nameOf = (s: string): number => {
    const t = s.trim().toLowerCase();
    if (/^\d$/.test(t)) return Number(t);
    const i = DAY_NAMES.findIndex((n) => n.toLowerCase() === t.slice(0, 3));
    if (i < 0) throw new Error(`unknown day: ${s}`);
    return i;
  };
  for (const part of text.split(",")) {
    if (part.trim() === "") continue;
    const range = part.split("-");
    if (range.length === 2) {
      const a = nameOf(range[0]!);
      const b = nameOf(range[1]!);
      for (let d = a; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === b) break;
      }
    } else {
      out.add(nameOf(part));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ── Reviewers ─────────────────────────────────────────────────────────────

export function normalizeReviewerRule(raw: { repo: string; users?: unknown; teams?: unknown }): ReviewerRule {
  const key = repoSlug(raw.repo) ?? raw.repo.trim().toLowerCase();
  if (key === "") throw new Error("a repo is required");
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== ""))] : [];
  return { repo: key, users: list(raw.users), teams: list(raw.teams) };
}

/** The rule for a repo URL or slug, or null when none (or the rule is empty). */
export function reviewersFor(reviewers: ReviewerRule[], repo: string): ReviewerRule | null {
  const key = repoSlug(repo);
  if (key === null) return null;
  const rule = reviewers.find((r) => r.repo === key);
  if (rule === undefined || (rule.users.length === 0 && rule.teams.length === 0)) return null;
  return rule;
}

// ── Normalisation of a stored document ────────────────────────────────────

export function normalizeGovernance(raw: unknown): Governance {
  const g = (raw ?? {}) as Partial<{ authority: Record<string, unknown>; windows: Record<string, unknown>; reviewers: unknown[] }>;
  const authority = { ...DEFAULT_AUTHORITY };
  for (const action of AUTHORITY_ACTIONS) {
    const stored = g.authority?.[action];
    if (stored !== undefined) authority[action] = normalizeGrant(stored);
  }
  const windows: Windows = {};
  for (const [source, w] of Object.entries(g.windows ?? {})) {
    try {
      windows[source] = validateWindow(w);
    } catch {
      // A malformed stored window is dropped — the result is "no window",
      // which for an auto source means always. Fail-open is wrong here, so
      // validateWindow runs on every write and a bad row can only arrive by
      // hand-editing the store.
    }
  }
  const reviewers: ReviewerRule[] = [];
  for (const r of g.reviewers ?? []) {
    if (r !== null && typeof r === "object" && typeof (r as { repo?: unknown }).repo === "string") {
      const rule = normalizeReviewerRule(r as { repo: string; users?: unknown; teams?: unknown });
      if (rule.users.length > 0 || rule.teams.length > 0) reviewers.push(rule);
    }
  }
  return { authority, windows, reviewers };
}

function applyAuthority(g: Governance, action: AuthorityAction, grant: Grant): Governance {
  return { ...g, authority: { ...g.authority, [action]: normalizeGrant(grant) } };
}

function applyWindow(g: Governance, source: string, window: AutoWindow | null): Governance {
  const key = source.trim() === "" ? GLOBAL_WINDOW : source.trim();
  const windows = { ...g.windows };
  if (window === null) delete windows[key];
  else windows[key] = validateWindow(window);
  return { ...g, windows };
}

function applyReviewers(g: Governance, input: { repo: string; users?: unknown; teams?: unknown }): Governance {
  const rule = normalizeReviewerRule(input);
  const rest = g.reviewers.filter((r) => r.repo !== rule.repo);
  return { ...g, reviewers: rule.users.length === 0 && rule.teams.length === 0 ? rest : [...rest, rule].sort((a, b) => (a.repo < b.repo ? -1 : 1)) };
}

/** File-backed: one JSON document under the state dir. */
export class FileGovernanceStore implements GovernanceStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "governance.json");
  }

  // Corruption throws rather than reading as defaults: defaults are WIDER than
  // a configured window and narrower than a configured user grant, and either
  // direction silently changes who may do what.
  async get(): Promise<Governance> {
    return normalizeGovernance(await readJsonFile<unknown>(this.#path, {}));
  }

  #update(fn: (g: Governance) => Governance): Promise<void> {
    return updateJsonFile<unknown>(this.#path, {}, (current) => fn(normalizeGovernance(current)));
  }

  setAuthority(action: AuthorityAction, grant: Grant): Promise<void> {
    if (!AUTHORITY_ACTIONS.includes(action)) throw new Error(`unknown authority action: ${action}`);
    return this.#update((g) => applyAuthority(g, action, grant));
  }

  setWindow(source: string, window: AutoWindow | null): Promise<void> {
    return this.#update((g) => applyWindow(g, source, window));
  }

  setReviewers(rule: { repo: string; users?: unknown; teams?: unknown }): Promise<void> {
    return this.#update((g) => applyReviewers(g, rule));
  }
}

/**
 * Nucleus-backed: one row, the whole document as JSON text. The document is
 * small, edited by a person, and read once per sweep — a row per rule would
 * buy nothing but three more hand-written column maps.
 */
export class NucleusGovernanceStore implements GovernanceStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_governance (
          key TEXT,
          value TEXT
        )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async get(): Promise<Governance> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT value FROM ship_governance WHERE key = $1", ["governance"]);
    const raw = rows[0]?.value;
    if (raw === null || raw === undefined || raw === "") return normalizeGovernance({});
    // A row that does not parse throws, for the same reason the file store does.
    return normalizeGovernance(JSON.parse(String(raw)));
  }

  async #update(fn: (g: Governance) => Governance): Promise<void> {
    const next = JSON.stringify(fn(await this.get()));
    await upsertByKey(this.#db, {
      table: "ship_governance",
      keyColumn: "key",
      key: "governance",
      update: () => this.#db.query("UPDATE ship_governance SET value = $1 WHERE key = $2", [next, "governance"]),
      insert: () => this.#db.query("INSERT INTO ship_governance (key, value) VALUES ($1, $2)", ["governance", next]),
    });
  }

  setAuthority(action: AuthorityAction, grant: Grant): Promise<void> {
    if (!AUTHORITY_ACTIONS.includes(action)) throw new Error(`unknown authority action: ${action}`);
    return this.#update((g) => applyAuthority(g, action, grant));
  }

  setWindow(source: string, window: AutoWindow | null): Promise<void> {
    return this.#update((g) => applyWindow(g, source, window));
  }

  setReviewers(rule: { repo: string; users?: unknown; teams?: unknown }): Promise<void> {
    return this.#update((g) => applyReviewers(g, rule));
  }
}
