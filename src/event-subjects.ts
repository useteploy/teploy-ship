import { createHash } from "node:crypto";

import type { RuntimeConfigStore } from "./runtime-config.js";
import type { IntakeStore, IntakeTask, ProposeInput } from "./intake.js";
import {
  cooldownActive,
  decideEvent,
  ruleSeesEvent,
  validEventRuleShape,
  validateEventRule,
  validateEventSource,
  type EventRule,
  type EventRulesMode,
  type ShipEvent,
  type EventSourceRecord,
  type EventSubjectRecord,
} from "./event-rules.js";

/**
 * E7 EV2 — the stateful half of the event-rule engine: rule/source records,
 * subject watermarks, rate counters and the seen-events ring, all in the
 * runtime config KV following the schedule pattern (one key per record, no
 * array-per-anything, see workflow-schedules.ts). Nothing here touches the
 * durable run loop: a rule's output is one intake.propose, and the run input
 * is materialised from the task at enqueue as it already is everywhere else.
 */

export const eventRuleKey = (id: string) => `SHIP_EVENT_RULE_${id}`;
export const eventSourceKey = (id: string) => `SHIP_EVENT_SOURCE_${id}`;
/** Subjects hash the (rule, subject) pair: two rules over one subject keep independent episodes. */
export function eventSubjectKey(ruleId: string, subject: string): string {
  const hash = createHash("sha256").update(`${ruleId}\n${subject}`).digest("hex").slice(0, 24);
  return `SHIP_EVENT_SUBJECT_${hash}`;
}
export const rateKey = (ruleId: string, hourUtc: string) => `SHIP_EVENT_RATE_${ruleId}_${hourUtc}`;
export const seenKey = (sourceId: string) => `SHIP_EVENT_SEEN_${sourceId}`;

/** Recorded inbound events kept per source so a dry run can replay real traffic. */
export const SEEN_LIMIT = 50;

export interface SeenEventEntry {
  receivedAt: string;
  deliveryId: string | null;
  eventId: string;
  type: string;
  subject: string;
  occurredAt: string;
  title: string;
  attrs?: Record<string, string | number | boolean>;
  outcomes: Array<{ ruleId: string; outcome: string }>;
}

/**
 * Read-modify-write over the config KV, serialized per key within this
 * process (the FileDeliveryLog pattern). Multi-process deployments race
 * exactly like the file delivery log did before Nucleus; the honest fix is
 * a conditional KV write comparing the watermark, noted as a follow-up for
 * the Nucleus store rather than papered over here.
 *
 * Exported for event-builtin.ts's shadow counters, which are the same shape
 * of bounded read-modify-write over one config key.
 */
const keyLocks = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const release = keyLocks.get(key) ?? Promise.resolve();
  let settle: () => void = () => {};
  const gate = new Promise<void>((resolve) => (settle = resolve));
  keyLocks.set(key, gate);
  await release;
  try {
    return await fn();
  } finally {
    settle();
    if (keyLocks.get(key) === gate) keyLocks.delete(key);
  }
}

type ConfigLike = Pick<RuntimeConfigStore, "get" | "set" | "list">;

// ------------------------------------------------------------------ records

/** Stored rules, invalid entries skipped (the workflowSchedules pattern). */
export async function listEventRules(config: ConfigLike): Promise<EventRule[]> {
  const out: EventRule[] = [];
  for (const entry of await config.list()) {
    if (!entry.key.startsWith("SHIP_EVENT_RULE_")) continue;
    const raw = await config.get(entry.key);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (validEventRuleShape(parsed).ok) out.push(parsed as EventRule);
    } catch {
      // A damaged rule row is skipped, not fatal: one bad record must not
      // stop every other rule's deliveries.
    }
  }
  return out;
}

export async function getEventRule(config: ConfigLike, id: string): Promise<EventRule | null> {
  const raw = await config.get(eventRuleKey(id));
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as EventRule;
  } catch {
    return null;
  }
}

export type SaveResult = { ok: true } | { ok: false; problem: string };

export async function saveEventRule(config: ConfigLike, rule: unknown, sources: readonly EventSourceRecord[]): Promise<SaveResult> {
  const checked = validateEventRule(rule, sources);
  if (!checked.ok) return checked;
  await config.set(eventRuleKey((rule as EventRule).id), JSON.stringify(rule), "event-rules");
  return { ok: true };
}

export async function deleteEventRule(config: ConfigLike, id: string): Promise<void> {
  await config.set(eventRuleKey(id), "", "event-rules");
}

export async function listEventSources(config: ConfigLike): Promise<EventSourceRecord[]> {
  const out: EventSourceRecord[] = [];
  for (const entry of await config.list()) {
    if (!entry.key.startsWith("SHIP_EVENT_SOURCE_")) continue;
    const raw = await config.get(entry.key);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (validateEventSource(parsed).ok) out.push(parsed as EventSourceRecord);
    } catch {}
  }
  return out;
}

export async function getEventSource(config: ConfigLike, id: string): Promise<EventSourceRecord | null> {
  const raw = await config.get(eventSourceKey(id));
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateEventSource(parsed).ok ? (parsed as EventSourceRecord) : null;
  } catch {
    return null;
  }
}

export async function saveEventSource(config: ConfigLike, source: unknown): Promise<SaveResult> {
  const checked = validateEventSource(source);
  if (!checked.ok) return checked;
  await config.set(eventSourceKey((source as EventSourceRecord).id), JSON.stringify(source), "event-rules");
  return { ok: true };
}

// ------------------------------------------------------------------ subjects

async function loadSubject(config: ConfigLike, ruleId: string, subject: string): Promise<EventSubjectRecord | null> {
  const raw = await config.get(eventSubjectKey(ruleId, subject));
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EventSubjectRecord>;
    if (
      typeof parsed.lastOccurredAt === "string" && Number.isFinite(Date.parse(parsed.lastOccurredAt)) &&
      typeof parsed.episode === "number" && Number.isInteger(parsed.episode) && parsed.episode >= 0 &&
      (parsed.state === "open" || parsed.state === "closed")
    ) {
      return { ...(parsed as EventSubjectRecord), ruleId, subject };
    }
  } catch {}
  // A damaged subject row is treated as absent: re-deriving an episode from
  // the next event is safe (worst case one extra task), unlike acting on a
  // record nobody can interpret.
  return null;
}

async function saveSubject(config: ConfigLike, record: EventSubjectRecord): Promise<void> {
  await config.set(eventSubjectKey(record.ruleId, record.subject), JSON.stringify(record), "event-rules");
}

export async function readSubject(config: ConfigLike, ruleId: string, subject: string): Promise<EventSubjectRecord | null> {
  return loadSubject(config, ruleId, subject);
}

// -------------------------------------------------------------- rate limit

/**
 * One KV counter per rule per UTC hour. Counted only for events that reach
 * the propose stage, so a storm the rules do not match cannot eat a rule's
 * task budget. T3's equivalent (ScheduledTaskService.ts) keeps its windows
 * in process memory; Ship has several workers, so the counter lives here.
 */
export async function takeRateSlot(config: ConfigLike, ruleId: string, ratePerHour: number, nowMs: number): Promise<boolean> {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  const key = rateKey(ruleId, hour);
  return withKeyLock(key, async () => {
    const current = Number(await config.get(key)) || 0;
    if (current >= ratePerHour) return false;
    await config.set(key, String(current + 1), "event-rules");
    return true;
  });
}

// ------------------------------------------------------------------- ring

export async function recordSeenEvent(config: ConfigLike, sourceId: string, entry: SeenEventEntry): Promise<void> {
  const key = seenKey(sourceId);
  await withKeyLock(key, async () => {
    const prior = await listSeenEvents(config, sourceId);
    const next = [...prior, entry].slice(-SEEN_LIMIT);
    await config.set(key, JSON.stringify(next), "event-rules");
  });
}

export async function listSeenEvents(config: ConfigLike, sourceId: string): Promise<SeenEventEntry[]> {
  const raw = await config.get(seenKey(sourceId));
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SeenEventEntry[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- pipeline

export interface EventProcessDeps {
  config: ConfigLike;
  /** proposeExternal at the boundary, so the repo allowlist still binds. */
  propose: (input: ProposeInput) => Promise<{ created: boolean; task: IntakeTask }>;
  /** Intake read-back for the dismissal cooldown; only used when a rule sets one. */
  getTask?: (taskId: string) => Promise<IntakeTask | null>;
  /** repoHint -> clone URL through the project records; undefined leaves the task unbound. */
  resolveRepo?: (repoHint: string) => Promise<string | undefined>;
  log?: (line: string) => void;
}

export type RuleOutcome =
  | { ruleId: string; outcome: "condition-failed" }
  | { ruleId: string; outcome: "stale"; watermark: string }
  | { ruleId: string; outcome: "closed"; episode: number }
  | { ruleId: string; outcome: "tie-open"; episode: number }
  | { ruleId: string; outcome: "absorbed"; episode: number }
  | { ruleId: string; outcome: "cooldown"; until: string }
  | { ruleId: string; outcome: "rate-limited"; ratePerHour: number }
  | { ruleId: string; outcome: "dry-run"; wouldPropose: ProposeInput }
  | { ruleId: string; outcome: "proposed"; taskId: string; input: ProposeInput }
  | { ruleId: string; outcome: "existing"; taskId: string; input: ProposeInput };

export interface ProcessEventResult {
  outcomes: RuleOutcome[];
  seen: SeenEventEntry;
}

/**
 * One verified delivery through every rule that sees it. Layer order is the
 * whole design: the delivery claim happened before this is called, each
 * rule orders its subject, and the only write to intake is the same
 * propose every other source makes — never a launch.
 *
 * shadow mode evaluates everything and writes only the seen-event ring; a
 * flip to `on` therefore starts from a clean subject state, and shadow can
 * never have spent a rate slot or half-advanced a watermark.
 */
export async function processEvent(
  deps: EventProcessDeps,
  params: { sourceId: string; event: ShipEvent; deliveryId: string | null; mode: Extract<EventRulesMode, "shadow" | "on">; nowMs: number },
): Promise<ProcessEventResult> {
  const rules = (await listEventRules(deps.config)).filter((r) => ruleSeesEvent(r, params.event));
  const nowIso = new Date(params.nowMs).toISOString();
  const outcomes: RuleOutcome[] = [];

  for (const rule of rules) {
    const subjectKey = eventSubjectKey(rule.id, params.event.subject);
    const run = await withKeyLock(subjectKey, async () => {
      const record = await loadSubject(deps.config, rule.id, params.event.subject);
      const attribution = params.event.repoHint !== undefined ? await deps.resolveRepo?.(params.event.repoHint) : undefined;
      const decided = decideEvent(rule, params.event, record, nowIso, attribution);
      // Every write for this subject happens inside the lock, so an open,
      // a close and a burst inside one episode cannot interleave.
      if ((decided.action === "close" || decided.action === "absorb") && params.mode === "on" && rule.policy !== "dry-run") {
        await saveSubject(deps.config, decided.record);
      }
      if (decided.action !== "task" || rule.policy === "dry-run" || params.mode === "shadow") {
        return { decided, record, proposed: null } as const;
      }

      // The dismissal cooldown is the one check that needs a read back from
      // intake: a dismissed task frees its dedupe key, so without this a
      // re-delivery inside the window would quietly reopen it.
      if (rule.cooldownAfterDismissSeconds !== undefined && record !== null) {
        let dismissedUntil = record.dismissedUntil;
        if (!cooldownActive(record, params.nowMs) && record.lastTaskId !== undefined && deps.getTask !== undefined) {
          const task = await deps.getTask(record.lastTaskId);
          if (task !== null && task.state === "dismissed") {
            dismissedUntil = new Date(Date.parse(task.updatedAt) + rule.cooldownAfterDismissSeconds * 1000).toISOString();
          }
        }
        if (dismissedUntil !== undefined && params.nowMs < Date.parse(dismissedUntil)) {
          await saveSubject(deps.config, { ...decided.record, lastTaskId: record.lastTaskId, dismissedUntil });
          return { decided: { action: "cooldown" as const, until: dismissedUntil }, record, proposed: null } as const;
        }
      }

      if (rule.ratePerHour !== undefined && !(await takeRateSlot(deps.config, rule.id, rule.ratePerHour, params.nowMs))) {
        // Parked: the ordering watermark still advances (the event genuinely
        // happened), but the episode stays unfired so the next in-budget
        // event can still propose this episode's task.
        await saveSubject(deps.config, { ...decided.record, episodeFired: false });
        return { decided: { action: "rate-limited" as const, ratePerHour: rule.ratePerHour }, record, proposed: null } as const;
      }

      const { created, task } = await deps.propose(decided.input);
      await saveSubject(deps.config, { ...decided.record, lastTaskId: task.taskId });
      return { decided, record, proposed: { task, created } } as const;
    });

    if (params.mode === "shadow") {
      deps.log?.(`[event-rules] shadow ${rule.id}: ${run.decided.action === "task" ? "would-propose" : run.decided.action}`);
    }

    switch (run.decided.action) {
      case "skip":
        outcomes.push({ ruleId: rule.id, outcome: "condition-failed" });
        break;
      case "stale":
        outcomes.push({ ruleId: rule.id, outcome: "stale", watermark: run.decided.watermark });
        break;
      case "close":
        outcomes.push({ ruleId: rule.id, outcome: "closed", episode: run.record?.episode ?? 0 });
        break;
      case "tie-open":
        outcomes.push({ ruleId: rule.id, outcome: "tie-open", episode: run.record?.episode ?? 0 });
        break;
      case "absorb":
        outcomes.push({ ruleId: rule.id, outcome: "absorbed", episode: run.decided.record.episode });
        break;
      case "cooldown":
        outcomes.push({ ruleId: rule.id, outcome: "cooldown", until: run.decided.until });
        break;
      case "rate-limited":
        outcomes.push({ ruleId: rule.id, outcome: "rate-limited", ratePerHour: run.decided.ratePerHour });
        break;
      case "task":
        if (run.proposed === null) {
          outcomes.push({ ruleId: rule.id, outcome: "dry-run", wouldPropose: run.decided.input });
        } else {
          outcomes.push({
            ruleId: rule.id,
            outcome: run.proposed.created ? "proposed" : "existing",
            taskId: run.proposed.task.taskId,
            input: run.decided.input,
          });
        }
        break;
    }
  }

  const seen: SeenEventEntry = {
    receivedAt: nowIso,
    deliveryId: params.deliveryId,
    eventId: params.event.eventId,
    type: params.event.type,
    subject: params.event.subject,
    occurredAt: params.event.occurredAt,
    title: params.event.title,
    ...(Object.keys(params.event.attrs).length > 0 ? { attrs: params.event.attrs } : {}),
    outcomes: outcomes.map((o) => ({ ruleId: o.ruleId, outcome: o.outcome })),
  };
  await recordSeenEvent(deps.config, params.sourceId, seen);
  return { outcomes, seen };
}
