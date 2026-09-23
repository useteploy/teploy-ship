import { JOURNEYS, type Journey } from "./journeys.js";
import type { ShipRuntime } from "./runtime.js";
import type { RunMeta } from "./run-store.js";
import type { WorkflowEvent } from "@neutron-build/workflow";
// readOutcome is imported FROM worker.ts while worker.ts imports this module —
// a deliberate cycle that is safe because both sides expose hoisted function
// declarations only (no module-scope evaluation of the other's bindings). The
// alternative, summing usage again here, would be a second hand-copy of the
// cost reconstruction the settle path owns; one definition beats two.
import { readOutcome } from "./worker.js";
import { costUSD } from "./pricing.js";
export interface WorkflowSchedule {
  id: string;
  name: string;
  repo: string;
  task: string;
  mode: "fix" | "scan";
  journey?: Journey;
  plan: boolean;
  everyMinutes: number;
  enabled: boolean;
  createdAt: string;
  by: string;
}
export const scheduleKey = (id: string) => "SHIP_SCHEDULE_DEF_" + id;
/** Config key holding the slot receipt the sweep compares against (below). */
export const scheduleReceiptKey = (id: string) => "SHIP_SCHEDULE_RECEIPT_" + id;
/** The occurrence slot a schedule is in at `now` (missed intervals coalesce). */
export function scheduleSlot(s: Pick<WorkflowSchedule, "createdAt" | "everyMinutes">, now: number): number {
  return Math.floor((now - Date.parse(s.createdAt)) / (s.everyMinutes * 60000));
}
export function validSchedule(v: any): v is WorkflowSchedule {
  return (
    v &&
    /^[a-z0-9-]{1,70}$/.test(v.id) &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= 100 &&
    typeof v.repo === "string" &&
    typeof v.task === "string" &&
    v.task.length > 0 &&
    v.task.length <= 12000 &&
    ["fix", "scan"].includes(v.mode) &&
    (v.journey === undefined || JOURNEYS.some(j => j.id === v.journey)) &&
    typeof v.plan === "boolean" &&
    typeof v.enabled === "boolean" &&
    Number.isInteger(v.everyMinutes) &&
    v.everyMinutes >= 60 &&
    v.everyMinutes <= 44640 &&
    Number.isFinite(Date.parse(v.createdAt))
  );
}
export async function workflowSchedules(
  runtime: Pick<ShipRuntime, "config">,
): Promise<WorkflowSchedule[]> {
  const entries = (await runtime.config.list()).filter((k) =>
    k.key.startsWith("SHIP_SCHEDULE_DEF_"),
  );
  const out: WorkflowSchedule[] = [];
  for (const e of entries) {
    const raw = await runtime.config.get(e.key);
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (validSchedule(v)) out.push(v);
      } catch {}
    }
  }
  return out;
}
/** Missed intervals coalesce to the current one; no catch-up storm after downtime. */
export async function sweepWorkflowSchedules(
  runtime: Pick<ShipRuntime, "config" | "intake" | "projects">,
  now = Date.now(),
): Promise<void> {
  for (const s of await workflowSchedules(runtime)) {
    if (!s.enabled) continue;
    const project = await runtime.projects.forRepo(s.repo);
    if (!project?.url) continue;
    const slot = scheduleSlot(s, now);
    if (slot < 1) continue;
    const receipt = scheduleReceiptKey(s.id);
    if ((await runtime.config.get(receipt)) === String(slot)) continue;
    await runtime.intake.propose({
      source: "workflow",
      kind: s.journey ? `request-${s.journey}` :
        s.mode === "scan"
          ? "workflow-scan"
          : s.plan
            ? "workflow-plan"
            : "workflow-fix",
      repo: project.url,
      title: s.name,
      detail: s.task,
      dedupeKey: `workflow:${s.id}:${slot}`,
      requestedBy: s.by,
    });
    await runtime.config.set(receipt, String(slot));
  }
}

/**
 * S16: the delivered digest. One bounded entry per SETTLED schedule occurrence,
 * so a schedule's owner can read what their recurring work actually produced
 * (outcome, one-line summary, cost) without opening the run.
 *
 * One config key per run (`SHIP_SCHEDULE_DIGEST_<runId>`), never one array per
 * schedule. That choice IS the interruption safety: the entry's bytes are a
 * pure function of the run's recorded log (the `at` is the terminal event's
 * own timestamp, not the sweep's clock), so a restart that re-derives it
 * rewrites identical bytes over identical bytes — and there is no key that
 * could hold a second copy. An array-per-schedule design would need a
 * read-modify-write whose races have to be reasoned about; this one has none.
 */
export interface ScheduleDigestEntry {
  runId: string;
  scheduleId: string;
  outcome: "completed" | "failed" | "cancelled";
  /** One line: the run's own final summary, or the error that failed it. */
  summary: string;
  /** Settled cost in USD, present only when the run priced above zero. */
  costUSD?: number;
  /** When the run settled — the terminal event's recorded timestamp. */
  at: string;
}

/** Entries the digest surfaces per schedule (the stored set is slightly larger). */
export const DIGEST_LIMIT = 10;
/** Stored entries per schedule before the sweep prunes the oldest. Slack over
 *  DIGEST_LIMIT so a race between two recorders cannot oscillate the cap. */
const DIGEST_STORE_LIMIT = 20;

export const scheduleDigestKey = (runId: string) => "SHIP_SCHEDULE_DIGEST_" + runId;

export function validDigestEntry(v: any): v is ScheduleDigestEntry {
  return (
    v &&
    typeof v.runId === "string" &&
    v.runId.length > 0 &&
    v.runId.length <= 100 &&
    typeof v.scheduleId === "string" &&
    /^[a-z0-9-]{1,70}$/.test(v.scheduleId) &&
    ["completed", "failed", "cancelled"].includes(v.outcome) &&
    typeof v.summary === "string" &&
    v.summary.length <= 500 &&
    (v.costUSD === undefined || (typeof v.costUSD === "number" && Number.isFinite(v.costUSD) && v.costUSD >= 0)) &&
    Number.isFinite(Date.parse(v.at))
  );
}

/** Flatten to one line without lying about what was cut. */
const oneLine = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const TERMINAL_EVENT_TYPES = ["run-completed", "run-failed", "run-cancelled"] as const;

/**
 * The digest entry a settled run contributes, or null when the run is not a
 * schedule occurrence (source "workflow" whose dedupe key names the schedule
 * and slot), has not settled, or its log disagrees with its meta about being
 * terminal — a log that cannot support the entry is not evidence of an outcome.
 * Pure: same run, same bytes, every time.
 */
export function digestEntryFromRun(meta: RunMeta, events: WorkflowEvent[]): ScheduleDigestEntry | null {
  if (meta.source !== "workflow") return null;
  if (meta.status !== "completed" && meta.status !== "failed" && meta.status !== "cancelled") return null;
  const started = events.find((e) => e.type === "run-started");
  const origin = (started as { data?: { input?: { origin?: { source?: string; dedupeKey?: string } } } } | undefined)
    ?.data?.input?.origin;
  if (origin?.source !== "workflow" || typeof origin.dedupeKey !== "string") return null;
  const scheduleId = /^workflow:([a-z0-9-]{1,70}):\d+$/.exec(origin.dedupeKey)?.[1];
  if (scheduleId === undefined) return null;
  const terminal = events.find((e) => TERMINAL_EVENT_TYPES.includes(e.type as (typeof TERMINAL_EVENT_TYPES)[number]));
  if (terminal === undefined) return null;
  const output = (terminal.type === "run-completed"
    ? (terminal.data as { output?: { summary?: string; status?: string } } | undefined)?.output
    : undefined);
  let summary: string;
  if (terminal.type === "run-completed") {
    summary = output?.summary !== undefined && output.summary !== ""
      ? output.summary
      : output?.status !== undefined && output.status !== ""
        ? output.status
        : "Completed";
  } else if (terminal.type === "run-failed") {
    const error = terminal.data as { error?: unknown } | undefined;
    const failedStep = events.find((e) => e.type === "step-failed");
    const stepError = (failedStep?.data as { error?: unknown } | undefined)?.error;
    summary =
      typeof error?.error === "string" && error.error !== ""
        ? error.error
        : typeof stepError === "string" && stepError !== ""
          ? `${failedStep?.name ?? "a step"}: ${stepError}`
          : "Failed";
  } else {
    summary = "Cancelled";
  }
  // Cost follows the settle path's own reconstruction (readOutcome), so the
  // digest can never quote a number the ledger would disagree with.
  const usage = readOutcome(events).usage;
  const cost = usage === undefined ? undefined : costUSD(meta.model, usage);
  return {
    runId: meta.runId,
    scheduleId,
    outcome: meta.status,
    summary: oneLine(summary),
    ...(cost !== undefined && cost > 0 ? { costUSD: cost } : {}),
    at: terminal.at,
  };
}

/** Every stored digest entry (oldest first), optionally one schedule's. */
export async function scheduleDigestHistory(
  runtime: Pick<ShipRuntime, "config">,
  scheduleId?: string,
): Promise<ScheduleDigestEntry[]> {
  const out: ScheduleDigestEntry[] = [];
  for (const e of await runtime.config.list()) {
    if (!e.key.startsWith("SHIP_SCHEDULE_DIGEST_")) continue;
    const raw = await runtime.config.get(e.key);
    if (raw === undefined) continue;
    try {
      const v = JSON.parse(raw);
      if (validDigestEntry(v) && (scheduleId === undefined || v.scheduleId === scheduleId)) out.push(v);
    } catch {}
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Drop the oldest stored entries beyond the store cap. Never throws: pruning
 *  is housekeeping, and a remove that fails is retried by the next recording. */
async function pruneScheduleDigest(runtime: Pick<ShipRuntime, "config">, scheduleId: string): Promise<void> {
  const entries = (await scheduleDigestHistory(runtime, scheduleId));
  for (const old of entries.slice(0, Math.max(0, entries.length - DIGEST_STORE_LIMIT))) {
    await runtime.config.remove(scheduleDigestKey(old.runId)).catch(() => {});
  }
}

/**
 * Record a digest entry for every settled schedule occurrence the store knows
 * about and no digest exists for yet. Rides the worker's sweep chain, so a
 * run whose settle happened while no worker was watching (or whose digest
 * write was interrupted) is picked up on the next pass — the config-key check
 * is the "already recorded" answer, which is what makes a restart a no-op
 * rather than a duplicate. Returns how many entries were written.
 */
export async function sweepScheduleDigests(
  runtime: Pick<ShipRuntime, "config" | "listMeta" | "store">,
  opts?: { log?: (line: string) => void },
): Promise<number> {
  const log = opts?.log ?? (() => {});
  let recorded = 0;
  for (const meta of await runtime.listMeta({ limit: 200 })) {
    if (meta.source !== "workflow") continue;
    if (meta.status !== "completed" && meta.status !== "failed" && meta.status !== "cancelled") continue;
    if ((await runtime.config.get(scheduleDigestKey(meta.runId))) !== undefined) continue;
    let events: WorkflowEvent[];
    try {
      events = await runtime.store.load(meta.runId);
    } catch {
      log(`[worker] schedule digest: ${meta.runId} log unreadable; retrying next sweep`);
      continue;
    }
    const entry = digestEntryFromRun(meta, events);
    if (entry === null) continue;
    try {
      await runtime.config.set(scheduleDigestKey(entry.runId), JSON.stringify(entry), "worker");
      recorded += 1;
      await pruneScheduleDigest(runtime, entry.scheduleId);
      log(`[worker] schedule digest: ${entry.scheduleId} occurrence settled ${entry.outcome} (${entry.runId})`);
    } catch (error) {
      log(`[worker] schedule digest: ${meta.runId} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return recorded;
}
