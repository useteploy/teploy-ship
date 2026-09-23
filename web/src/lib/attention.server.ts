/**
 * S16: the attention queue — one row per thing that needs a HUMAN, phrased as
 * outcome / blocker / next action.
 *
 * This is deliberately NOT an activity feed. Nothing appears here for merely
 * happening: a run that executes, a schedule that fires, a delivery that
 * confirms — all of that lives on the page that owns it. A row exists only
 * when someone's next move is required (a decision, a failure, a hold, stale
 * or lapsed automation) or when waiting itself has gone stale (>72h). That
 * rule is the product: a wall of activity is how unattended automation hides.
 *
 * Reads only. Every judgement here is derived from state other pages already
 * own, so a row never contradicts the page it links to.
 */
import {
  workflowSchedules,
  scheduleDigestHistory,
  scheduleSlot,
  scheduleReceiptKey,
} from "./schedules.server.js";
import type { ScheduleDigestEntry } from "./schedules.server.js";
import type { RuntimeConfigStore } from "../../../dist/runtime-config.js";
import type { DeliveryRecord } from "../../../dist/delivery.js";
import { takeoverHistoryKey } from "../../../dist/takeover.js";
import type { TakeoverSession } from "../../../dist/takeover.js";
import { isAskEvent } from "teploy-ship/ask";
import { MERGE_EVENT } from "teploy-ship/plan";
import { UPGRADE_HOLD_EVENT } from "teploy-ship/fence";
import type { RunMeta, IntakeTask } from "teploy-ship/runtime";

/** The kinds of attention, in the order the page shows them. */
export type AttentionKind = "decision" | "failure" | "delivery" | "schedule" | "takeover" | "aging";

export interface AttentionRow {
  id: string;
  kind: AttentionKind;
  /** What the thing is, in the operator's terms (task, schedule, repo). */
  title: string;
  /** The outcome or blocker, one line. */
  detail: string;
  /** The human's move. */
  nextAction: string;
  /** Where to make it. */
  href: string;
  /** When the blocking state landed / began, for the age column. */
  at?: string;
  /** Waiting longer than 72h — age is now itself the blocker. */
  aging?: boolean;
}

/** Hard ceiling on rows: bounded by design, and honest about cutting off. */
export const ATTENTION_CAP = 50;

/** What this reads — structural so the loader and tests share one shape. */
export interface AttentionDeps {
  listMeta(options?: { limit?: number }): Promise<RunMeta[]>;
  store: { load(runId: string): Promise<unknown[]> };
  intake: { list(state?: string): Promise<IntakeTask[]> };
  config: RuntimeConfigStore;
  deliveryRecords?: { list(limit?: number): Promise<DeliveryRecord[]> };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Compact age for a timestamp: "4h", "3d". Never negative. */
export function ageBrief(at: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(at));
  if (ms < HOUR_MS) return `${Math.floor(ms / 60000)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

const oneLine = (text: string, max = 140): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The decision a parked run waits on, named for a person. */
function decisionBlocker(eventName: string): { blocker: string; nextAction: string } {
  if (isAskEvent(eventName)) {
    return { blocker: "waiting on a question from the agent", nextAction: "Answer the question to resume the run" };
  }
  if (eventName === MERGE_EVENT) {
    return { blocker: "waiting on merge review", nextAction: "Approve or reject the merge" };
  }
  if (eventName === UPGRADE_HOLD_EVENT) {
    return {
      blocker: "held by the upgrade fence — this build will not replay it",
      nextAction: "Roll the deployment back, or cancel the run",
    };
  }
  return { blocker: `waiting on ${eventName}`, nextAction: "Deliver the decision to resume the run" };
}

/** A run's failure in one line, from its own log (never a guess). */
function failureReason(events: unknown[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; name?: string; data?: { error?: unknown } };
    if (e.type === "run-failed") {
      const error = e.data?.error;
      if (typeof error === "string" && error !== "") return oneLine(error);
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; name?: string; data?: { error?: unknown } };
    if (e.type === "step-failed") {
      const error = e.data?.error;
      if (typeof error === "string" && error !== "") return oneLine(`${e.name ?? "a step"}: ${error}`);
    }
  }
  return "no recorded reason";
}

const isTerminalScheduleOutcome = (e: ScheduleDigestEntry): boolean =>
  e.outcome === "completed" || e.outcome === "failed" || e.outcome === "cancelled";

/**
 * Every row that needs a human right now, plus whether the cap cut some off.
 * Order is priority-shaped: what blocks a run first, then fresh failures,
 * then holds, then stale automation, then anything merely old.
 */
export async function attentionRows(
  deps: AttentionDeps,
  now = Date.now(),
): Promise<{ rows: AttentionRow[]; truncated: boolean }> {
  const rows: AttentionRow[] = [];
  const push = (row: AttentionRow): void => {
    rows.push(row);
  };

  // (a) Runs parked on a decision. Every waiting run blocks on someone, and a
  // waiting run that ages past 72h is flagged — age is then the blocker.
  // (b) uses the same list: one read, two disjoint filters by status.
  const metas = await deps.listMeta();
  const waiting = metas.filter((m) => m.status === "waiting" && m.eventName !== undefined);
  for (const m of waiting) {
    const { blocker, nextAction } = decisionBlocker(m.eventName!);
    const age = ageBrief(m.updatedAt, now);
    push({
      id: `decision:${m.runId}`,
      kind: "decision",
      title: oneLine(m.task),
      detail: `${blocker} (for ${age})`,
      nextAction,
      href: `/runs/${m.runId}`,
      at: m.updatedAt,
      aging: now - Date.parse(m.updatedAt) > 72 * HOUR_MS,
    });
  }

  // (b) Failures in the last 24h, with the reason off the run's own log.
  // Parked and failed are disjoint by status; a crashed park is a failure.
  const failed = metas.filter((m) => m.status === "failed" && now - Date.parse(m.updatedAt) < DAY_MS);
  for (const m of failed) {
    let reason = "no readable log";
    try {
      reason = failureReason(await deps.store.load(m.runId));
    } catch {
      // an unreadable log keeps the row; the run page is where to dig
    }
    push({
      id: `failure:${m.runId}`,
      kind: "failure",
      title: oneLine(m.task),
      detail: `failed ${ageBrief(m.updatedAt, now)} ago: ${reason}`,
      nextAction: "Read the run's evidence, then retry or drop the task",
      href: `/runs/${m.runId}`,
      at: m.updatedAt,
    });
  }

  // (c) Held or failed delivery records: promotions that need a person to
  // decide whether to re-approve. Confirmed deliveries never appear.
  const deliveries = (await deps.deliveryRecords?.list(500).catch(() => [])) ?? [];
  for (const d of deliveries) {
    if (d.state !== "held" && d.state !== "failed") continue;
    push({
      id: `delivery:${d.id}`,
      kind: "delivery",
      title: `Delivery of ${d.repo}`,
      detail: `${d.state}: ${d.reason !== undefined && d.reason !== "" ? oneLine(d.reason) : "no recorded reason"}`,
      nextAction: d.state === "held"
        ? "Fix the precondition and re-approve the promotion"
        : "Read the target back and re-approve, or roll back",
      href: `/runs/${d.runId}?view=verification`,
      at: d.updatedAt,
    });
  }

  // (d) Schedules that are stale automation: paused while their interval is
  // due (the work silently stopped), or whose last occurrence failed.
  for (const s of await workflowSchedules({ config: deps.config })) {
    const slot = scheduleSlot(s, now);
    if (!s.enabled && slot >= 1 && (await deps.config.get(scheduleReceiptKey(s.id))) !== String(slot)) {
      push({
        id: `schedule:paused-due:${s.id}`,
        kind: "schedule",
        title: s.name,
        detail: `paused while occurrence ${slot} is due (every ${s.everyMinutes / 60}h) — the work has stopped`,
        nextAction: "Resume the schedule, or delete it if the work is over",
        href: "/workflows#schedules",
        at: undefined,
      });
    }
    const digest = (await scheduleDigestHistory({ config: deps.config }, s.id)).filter(isTerminalScheduleOutcome);
    const last = digest.at(-1);
    if (last !== undefined && last.outcome === "failed") {
      push({
        id: `schedule:last-failed:${s.id}`,
        kind: "schedule",
        title: s.name,
        detail: `last occurrence failed ${ageBrief(last.at, now)} ago: ${last.summary}`,
        nextAction: "Check the failed run before the next occurrence fires",
        href: `/runs/${last.runId}`,
        at: last.at,
      });
    }
  }

  // (e) Lapsed workspace takeovers: a human held the workspace and the lease
  // expired under them — whatever they edited may be sitting uncommitted.
  // Only the LAST session of each run counts, and only within 24h.
  for (const entry of await deps.config.list()) {
    if (!entry.key.startsWith("SHIP_TAKEOVER_HISTORY_")) continue;
    const raw = await deps.config.get(entry.key);
    if (raw === undefined) continue;
    let sessions: TakeoverSession[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) sessions = parsed.filter((s): s is TakeoverSession => typeof s?.holder === "string");
    } catch {
      continue;
    }
    const last = sessions.at(-1);
    if (last === undefined || last.outcome !== "lapsed") continue;
    if (now - Date.parse(last.releasedAt) >= DAY_MS) continue;
    const runId = entry.key.slice(takeoverHistoryKey("").length);
    push({
      id: `takeover:${runId}`,
      kind: "takeover",
      title: `Workspace takeover of ${runId}`,
      detail: `lease lapsed ${ageBrief(last.releasedAt, now)} ago (holder ${last.holder}) — edits may be uncommitted`,
      nextAction: "Review the run's workspace, then resume or hand it back",
      href: `/runs/${runId}`,
      at: last.releasedAt,
    });
  }

  // (f) Aging: work whose state is not an error but whose AGE is the problem.
  // Waiting runs are already rows above (flagged aging), so this covers the
  // queues nothing else surfaces: proposals nobody decided on, and delivery
  // records parked mid-pipeline for days.
  for (const t of await deps.intake.list()) {
    if (t.state !== "proposed") continue;
    if (now - Date.parse(t.createdAt) <= 72 * HOUR_MS) continue;
    push({
      id: `aging:intake:${t.taskId}`,
      kind: "aging",
      title: oneLine(t.title),
      detail: `sitting proposed in the Inbox for ${ageBrief(t.createdAt, now)}`,
      nextAction: "Launch it or dismiss it",
      href: "/",
      at: t.createdAt,
      aging: true,
    });
  }
  for (const d of deliveries) {
    if (d.state !== "proposed" && d.state !== "approved" && d.state !== "unknown") continue;
    if (now - Date.parse(d.updatedAt) <= 72 * HOUR_MS) continue;
    push({
      id: `aging:delivery:${d.id}`,
      kind: "aging",
      title: `Delivery of ${d.repo}`,
      detail: `${d.state} for ${ageBrief(d.updatedAt, now)} with no progress`,
      nextAction: d.state === "unknown"
        ? "Verify the target by reading it back"
        : "Approve it, or drop the promotion",
      href: `/runs/${d.runId}?view=verification`,
      at: d.updatedAt,
      aging: true,
    });
  }

  const truncated = rows.length > ATTENTION_CAP;
  return { rows: rows.slice(0, ATTENTION_CAP), truncated };
}
