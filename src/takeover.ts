/**
 * Package C, Ship side: writable workspace takeover on the sandbox's lease
 * primitives (teploy-sandbox 01bd420).
 *
 * WHO OWNS WHAT. The sandbox owns the fence: while a lease is held, execs and
 * file writes without the holder's exact owner+generation are refused (409),
 * and a grant is refused while exec work is in flight. Ship owns authority,
 * workflow and UI. The dashboard never talks to the daemon — every takeover
 * operation is a workspace request the worker mediates, exactly like the
 * read-only file/changes inspections, so the lease credential never leaves
 * the worker process.
 *
 * THE PAUSE. Takeover is offered only on a run parked at a decision boundary
 * (status `waiting` with an eventName the resumed agent will consume): the
 * agent loop is not running, so acquisition happens at a proven quiet
 * boundary — and the daemon still refuses the grant if a straggler exec is
 * in flight. While the record is live, driveOne holds the run: a decision
 * delivered mid-takeover makes the run due, the worker sees the takeover,
 * and execution waits for handback instead of racing the human's writes.
 * The daemon fence is the backstop for every interleaving Ship misses.
 *
 * THE HANDBACK. Release records what the human did — paths written, commands
 * run, a bounded diff excerpt with its digest — appends it to the run's
 * takeover history, and leaves a steer note describing the edits. The
 * resumed run drains that note at the top of its next turn, so the agent
 * commits the human's work rather than unknowingly building on top of it.
 * Old approvals cannot certify a changed tree: the note is the record that
 * the workspace moved under the reviewed revision.
 */
import { createHash } from "node:crypto";

import { safeForDisplay } from "./redact.js";
import { UPGRADE_HOLD_EVENT } from "./fence.js";
import { MERGE_EVENT } from "./plan.js";

/** Config key holding the LIVE takeover record for a run. */
export const takeoverKey = (runId: string): string => `SHIP_TAKEOVER_${runId}`;
/** Config key holding the last takeover reply (the mediated operation's result). */
export const takeoverReplyKey = (runId: string): string => `SHIP_TAKEOVER_REPLY_${runId}`;
/** Config key holding the bounded takeover session history (most recent last). */
export const takeoverHistoryKey = (runId: string): string => `SHIP_TAKEOVER_HISTORY_${runId}`;

/** The live lease as Ship recorded it at acquisition. Expires with the daemon's TTL. */
export interface TakeoverRecord {
  runId: string;
  holder: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  ttlSec: number;
  pathsWritten: string[];
  execsRun: string[];
}

/** A completed session, kept bounded — the evidence trail of who intervened and what changed. */
export interface TakeoverSession {
  holder: string;
  acquiredAt: string;
  releasedAt: string;
  outcome: "released" | "lapsed";
  pathsWritten: string[];
  execsRun: string[];
  diffDigest?: string;
  diffExcerpt?: string;
  note?: string;
}

export const TAKEOVER_HISTORY_LIMIT = 5;
/** Default lease TTL. Any mediated operation renews, so an active editor keeps the lease; a stale one revokes itself. */
export const TAKEOVER_TTL_SEC = 1800;

/** The config surface this module needs: values by key. */
export type TakeoverConfig = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, updatedBy?: string): Promise<void>;
};

/**
 * The live record, or null when none is held. An expired record answers null:
 * the daemon's lease died with its TTL, so the honest state is "not held"
 * (the expiry sweep moves it to history with outcome `lapsed`).
 */
export async function loadTakeover(
  config: { config: TakeoverConfig } | TakeoverConfig,
  runId: string,
  now = Date.now,
): Promise<TakeoverRecord | null> {
  const store: TakeoverConfig = "get" in config ? (config as TakeoverConfig) : config.config;
  const raw = await store.get(takeoverKey(runId));
  if (raw === undefined || raw === null || raw === "") return null;
  let record: TakeoverRecord;
  try {
    record = JSON.parse(raw) as TakeoverRecord;
  } catch {
    return null;
  }
  if (typeof record.holder !== "string" || typeof record.generation !== "number") return null;
  if (Date.parse(record.expiresAt) <= now()) return null;
  return record;
}

export async function saveTakeover(config: TakeoverConfig, record: TakeoverRecord): Promise<void> {
  await config.set(takeoverKey(record.runId), JSON.stringify(record), record.holder);
}

export async function appendTakeoverHistory(
  config: TakeoverConfig,
  runId: string,
  session: TakeoverSession,
): Promise<void> {
  const raw = await config.get(takeoverHistoryKey(runId));
  let history: TakeoverSession[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) history = parsed.filter((s): s is TakeoverSession => typeof s?.holder === "string");
    } catch {
      // unreadable history is replaced, not fatal — the live record is the authority
    }
  }
  history.push(session);
  await config.set(takeoverHistoryKey(runId), JSON.stringify(history.slice(-TAKEOVER_HISTORY_LIMIT)), "takeover");
}

/**
 * May this run's workspace be taken over right now?
 *
 * Only at a park the resumed agent will consume (ask, plan, an approval
 * park): handing back works precisely because a drained steer note reaches
 * the next turn. A merge review is a DECISION about bytes already on the
 * forge — human edits in the workspace cannot join the PR before the merge,
 * so writable takeover there would be a lost-changes trap; read-only
 * inspection stays available. The upgrade hold is not a decision at all.
 */
export function mayAcquireTakeover(meta: {
  status: string;
  eventName?: string;
} | null): { ok: true } | { ok: false; reason: string } {
  if (meta === null) return { ok: false, reason: "Unknown run." };
  if (meta.status !== "waiting" || meta.eventName === undefined) {
    return {
      ok: false,
      reason: "Takeover needs the run parked at a decision (a question, plan or approval). While it executes, steer it instead.",
    };
  }
  if (meta.eventName === UPGRADE_HOLD_EVENT) {
    return { ok: false, reason: "This run is held by the upgrade fence, not waiting for a decision." };
  }
  if (meta.eventName === MERGE_EVENT) {
    return {
      ok: false,
      reason: "This run is reviewing a merge. Request changes instead — a follow-up run can carry edits into the pull request.",
    };
  }
  return { ok: true };
}

/** Same path rules as the read-only file view: relative, inside the work tree, no control characters. */
export function takeoverPathValid(path: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (
    path === undefined ||
    path === "" ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.split("/").some((p) => p === ".." || p === ".git") ||
    /[\x00-\x1f]/.test(path)
  ) {
    return { ok: false, reason: "Choose a relative repository path (no .. or .git)." };
  }
  return { ok: true };
}

/** The workspace handle the takeover operates on: the latest recorded sandbox/restore creation. */
export function latestSandboxHandle(events: { type: string; name?: string; data?: unknown }[]): string | undefined {
  const handles = events.filter(
    (e) => e.type === "step-completed" && (e.name === "sandbox" || /-restore$/.test(e.name ?? "")),
  );
  const recorded = (handles.at(-1)?.data as { result?: unknown } | undefined)?.result;
  const handle = typeof recorded === "string" ? recorded : (recorded as { handle?: unknown } | undefined)?.handle;
  return typeof handle === "string" ? handle : undefined;
}

export const TAKEOVER_CONTENT_LIMIT = 200_000;
export const TAKEOVER_OUTPUT_LIMIT = 12_000;

/** Digest + bounded excerpt of the working-tree diff at handback. */
export function diffEvidence(diff: string): { digest: string; excerpt: string } {
  const clean = safeForDisplay(diff, TAKEOVER_OUTPUT_LIMIT);
  return {
    digest: createHash("sha256").update(diff).digest("hex").slice(0, 16),
    excerpt: clean.slice(0, TAKEOVER_OUTPUT_LIMIT),
  };
}

/**
 * The steer note left at handback. The resumed run drains it at the top of
 * its next turn, so the agent knows the workspace moved under the reviewed
 * revision and commits the human's work rather than building over it.
 */
export function handbackNote(session: TakeoverSession): string {
  const parts = [
    `Human takeover session ended (holder ${session.holder}).`,
    "Edits were made directly in this workspace and are NOT committed.",
  ];
  if (session.pathsWritten.length > 0) parts.push(`Files written: ${session.pathsWritten.join(", ")}.`);
  if (session.execsRun.length > 0) parts.push(`Commands run: ${session.execsRun.join("; ")}.`);
  if (session.diffDigest !== undefined) parts.push(`Working-tree diff digest: ${session.diffDigest}.`);
  if (session.note !== undefined && session.note !== "") parts.push(`Holder's note: ${session.note}`);
  if (session.diffExcerpt !== undefined && session.diffExcerpt !== "") {
    parts.push(`Diff excerpt (bounded):\n${session.diffExcerpt.slice(0, 4000)}`);
  }
  parts.push("Review these edits, commit and push what should land, and mention them in your summary.");
  return parts.join("\n").slice(0, 12_000);
}
