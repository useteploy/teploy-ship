import { createHash } from "node:crypto";

import type { IntakePolicy, ProposeInput } from "./intake.js";
import { decideEvent, eventRulesMode, ruleSeesEvent, validEventRuleShape, type EventRule, type ShipEvent } from "./event-rules.js";
import { withKeyLock } from "./event-subjects.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import {
  ciFixTaskFromWorkflowRun,
  incidentTaskFromObserveAlert,
  linearTaskFromIssue,
  observeAlertIds,
  reviewRound,
  reviewTaskFromReviewEvent,
  slackTaskFromMention,
  type ReviewEventPayload,
} from "./intake-sources.js";
import type { WorkflowSchedule } from "./workflow-schedules.js";

/**
 * E7 EV3 — the built-in intake sources (Slack, Linear, CI failure, PR review,
 * Observe, schedules) expressed as a DEFAULT rule set over the EV2 engine, and
 * run in SHADOW beside the real paths.
 *
 * What that means mechanically, and why each piece is shaped the way it is:
 *
 * — Each built-in payload is mapped to a ShipEvent by an adapter that WRAPS the
 *   existing builder in intake-sources.ts. The builder stays the single source
 *   of truth for title/detail/repo/requested_by (so the two paths cannot drift
 *   on text the builder already clamps and composes), and the event carries the
 *   builder's OUTPUT plus the attrs each source's dedupe key is built from.
 *
 * — Each source has a rule IN CODE (never the config KV, never operator
 *   configuration): a match, optional conditions, a task kind, and — the part
 *   that matters — the dedupe-key TEMPLATE. The evaluation renders the key
 *   through the engine's own template renderer, so the collapse contract
 *   (`slack:<ch>:<ts>`, `linear:<id>`, `ci:<repo>#<pr>:<sha>`,
 *   `<src>:<repo>#review-<round>`, `observe:<alert_id>`,
 *   `observe:rule:<rule_id>:<incident_id>`, `workflow:<id>:<slot>`) is
 *   reproduced by the RULE, not copied from the builder.
 *
 * — shadowBuiltinIntake compares the rule path's ProposeInput with what the
 *   built-in path actually proposed (kind, repo, pr, title, detail hash,
 *   dedupe key, requested_by, launch policy), logs a structured diff line, and
 *   keeps a bounded match/diff counter in the config KV readable from
 *   `teploy-ship doctor`. The built-in path ALWAYS wins: the shadow never
 *   proposes, never writes intake state, and every step is wrapped so a shadow
 *   bug cannot break a real delivery.
 *
 * — Mode is the EV2 flag: `SHIP_EVENT_RULES=shadow` runs this; `off` runs
 *   nothing at all (the gate is the first statement, before any store is
 *   touched). `on` is the LATER slice that flips the built-ins to the engine;
 *   until it exists, `on` leaves the built-in paths alone too.
 */

/** The built-in intake channels that have a default rule. */
export type BuiltinSourceId = "slack" | "linear" | "ci" | "github" | "forgejo" | "observe" | "schedule";

/** Fixed on purpose: the counters' per-source map never grows beyond these. */
export const BUILTIN_SHADOW_SOURCES: readonly BuiltinSourceId[] = ["slack", "linear", "ci", "github", "forgejo", "observe", "schedule"];

/**
 * The ProposeInput.source each built-in channel proposes under today. The
 * shadow's rule compose uses the same string, because the launch policy the
 * worker applies is keyed by it (sweepIntake reads policies[task.source]) — a
 * rule path that namespaced the source ("events:slack") would silently drop
 * every operator's per-source policy, which is exactly what the policy field
 * of the compare guards.
 */
export function builtinTaskSource(source: BuiltinSourceId): string {
  // Schedules propose under "workflow" and always have (workflow-schedules.ts).
  return source === "schedule" ? "workflow" : source;
}

/** Cheap gate for callers that would otherwise construct a runtime first. */
export function builtinShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return eventRulesMode(env) === "shadow";
}

// ------------------------------------------------------------------ adapters

export interface BuiltinShadowContext {
  /** Observe: the repo the receiver resolved for this alert (observeRepoFor). */
  repo?: string;
  /** Receipt time, for payloads that carry no timestamp of their own. */
  nowIso?: string;
}

/** The schedule payload the sweep hands the shadow: the def, the slot, the resolved repo URL. */
export interface ScheduleSlotPayload {
  schedule: Pick<WorkflowSchedule, "id" | "name" | "task" | "mode" | "journey" | "plan" | "by">;
  slot: { id: string; at: number };
  repo: string;
}

function attr(input: ProposeInput, name: "repo" | "requestedBy", attrName: string): Record<string, string> {
  const value = input[name];
  return value !== undefined && value !== "" ? { [attrName]: value } : {};
}

/**
 * One built-in payload → one typed event (or null when the builder itself
 * produced nothing — both paths then agree on "no task", which the compare
 * counts as a match). Pure: it re-runs the builder, so the event's title and
 * detail ARE the builder's output bytes.
 */
export function builtinShadowEvent(
  source: BuiltinSourceId,
  payload: unknown,
  ctx: BuiltinShadowContext = {},
): ShipEvent | null {
  const nowIso = ctx.nowIso ?? new Date().toISOString();
  switch (source) {
    case "slack": {
      const event = payload as Parameters<typeof slackTaskFromMention>[0];
      const input = slackTaskFromMention(event);
      if (input === null || event.channel === undefined || event.ts === undefined) return null;
      return {
        source: "slack",
        type: "chat.mention",
        // Slack retries re-deliver the same channel+ts — the same identity the
        // delivery claim and the intake key use.
        eventId: `${event.channel}:${event.ts}`,
        subject: `slack:${event.channel}`,
        occurredAt: new Date(Number(event.ts) * 1000).toISOString(),
        title: input.title,
        detail: input.detail ?? "",
        attrs: { channel: event.channel, ts: event.ts, ...attr(input, "repo", "repo"), ...attr(input, "requestedBy", "requested_by") },
      };
    }
    case "linear": {
      const input = linearTaskFromIssue(payload as Parameters<typeof linearTaskFromIssue>[0]);
      if (input === null) return null;
      const issue_id = (payload as { data?: { id?: string } }).data?.id;
      if (issue_id === undefined) return null;
      return {
        source: "linear",
        type: "ticket.labelled",
        eventId: issue_id,
        subject: `linear:${issue_id}`,
        occurredAt: nowIso,
        title: input.title,
        detail: input.detail ?? "",
        attrs: { issue_id, ...attr(input, "repo", "repo"), ...attr(input, "requestedBy", "requested_by") },
      };
    }
    case "ci": {
      const input = ciFixTaskFromWorkflowRun(payload as Parameters<typeof ciFixTaskFromWorkflowRun>[0]);
      if (input === null || input.pr === undefined) return null;
      const full_name = (payload as { repository?: { full_name?: string } }).repository?.full_name;
      const sha = (payload as { workflow_run?: { head_sha?: string } }).workflow_run?.head_sha;
      if (full_name === undefined || sha === undefined) return null;
      return {
        source: "ci",
        type: "pipeline.failed",
        eventId: `${full_name}#${input.pr}:${sha}`,
        subject: `ci:${full_name}#${input.pr}`,
        occurredAt: nowIso,
        title: input.title,
        detail: input.detail ?? "",
        attrs: { full_name, pr: input.pr, sha, ...attr(input, "repo", "repo") },
      };
    }
    case "github":
    case "forgejo": {
      const input = reviewTaskFromReviewEvent(payload as ReviewEventPayload, source);
      if (input === null || input.pr === undefined) return null;
      const full_name = (payload as { repository?: { full_name?: string } }).repository?.full_name;
      const round = reviewRound(payload as ReviewEventPayload);
      if (full_name === undefined || round === undefined) return null;
      return {
        source,
        type: "review.requested",
        eventId: `${full_name}#review-${round}`,
        subject: `${source}:${full_name}#${input.pr}`,
        occurredAt: nowIso,
        title: input.title,
        detail: input.detail ?? "",
        attrs: { full_name, round, pr: input.pr, ...attr(input, "repo", "repo"), ...attr(input, "requestedBy", "requested_by") },
      };
    }
    case "observe": {
      const input = incidentTaskFromObserveAlert(payload as Parameters<typeof incidentTaskFromObserveAlert>[0], ctx.repo !== undefined ? { repo: ctx.repo } : {});
      if (input === null) return null;
      const ids = observeAlertIds(payload as Parameters<typeof observeAlertIds>[0]);
      const at = Date.parse((payload as { timestamp?: string; evaluated_at?: string }).timestamp ?? (payload as { evaluated_at?: string }).evaluated_at ?? "");
      return {
        source: "observe",
        type: "alert.triggered",
        eventId: input.dedupeKey,
        subject: `observe:${ids.alertId ?? `${ids.ruleId ?? "rule"}:${ids.incidentId ?? "incident"}`}`,
        occurredAt: Number.isFinite(at) ? new Date(at).toISOString() : nowIso,
        title: input.title,
        detail: input.detail ?? "",
        attrs: {
          ...(ids.alertId !== undefined ? { alert_id: ids.alertId } : {}),
          ...(ids.ruleId !== undefined ? { rule_id: ids.ruleId } : {}),
          ...(ids.incidentId !== undefined ? { incident_id: ids.incidentId } : {}),
          ...(ctx.repo !== undefined && ctx.repo !== "" ? { repo: ctx.repo } : {}),
        },
      };
    }
    case "schedule": {
      const { schedule: s, slot, repo } = payload as ScheduleSlotPayload;
      return {
        source: builtinTaskSource("schedule"),
        type: "schedule.slot",
        eventId: `workflow:${s.id}:${slot.id}`,
        subject: `workflow:${s.id}`,
        occurredAt: new Date(slot.at).toISOString(),
        title: s.name,
        detail: s.task,
        attrs: {
          schedule_id: s.id,
          slot_id: slot.id,
          repo,
          mode: s.mode,
          plan: s.plan,
          // The kind a schedule proposes is decided by journey/mode/plan (the
          // sweep's own ternary); the rules reproduce that decision through
          // conditions, so a new journey value without a rule shows up as a
          // shadow diff instead of a silent behaviour change.
          ...(s.journey !== undefined ? { journey: s.journey } : {}),
          ...(typeof s.by === "string" && s.by !== "" ? { requested_by: s.by } : {}),
        },
      };
    }
  }
}

// ----------------------------------------------------------------- rule set

const RULE_META = { enabled: true, policy: "propose" as const, by: "system", createdAt: "2026-10-17T00:00:00.000Z" };
const EVENT_TEXT_TEMPLATES = { repoFrom: "attribution" as const, titleTemplate: "{{title}}", detailTemplate: "{{detail}}" };

/**
 * The built-ins' default rule set. Evaluated as an ORDERED list, first match
 * wins — the built-in paths propose at most ONE task per delivery, and the
 * observe pair needs the legacy alert_id shape to win over the outbox shape
 * exactly as observeAlertDedupeKey does.
 *
 * The title/detail templates name where the text comes from (the event the
 * adapter built from the builder's output); the evaluation does NOT render
 * through the generic compose, because each source's builder clamps text its
 * own way (slack titles may run to 141 chars, observe titles carry a
 * multi-line truncation marker, review details exceed 4000 chars) and the
 * shadow's whole point is byte-identity with today's ProposeInput.
 */
export function builtinEventRules(): EventRule[] {
  const noJourney = ["change", "investigate", "plan", "review"].map((j) => ({ attr: "journey", op: "ne" as const, value: j }));
  return [
    {
      id: "builtin-slack-mention",
      name: "Slack app mention → mention task",
      ...RULE_META,
      match: { source: "slack", types: ["chat.mention"] },
      task: { kind: "mention", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "slack:{{attr.channel}}:{{attr.ts}}",
    },
    {
      id: "builtin-linear-issue",
      name: "Linear issue labeled ship → issue task",
      ...RULE_META,
      match: { source: "linear", types: ["ticket.labelled"] },
      task: { kind: "issue", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "linear:{{attr.issue_id}}",
    },
    {
      id: "builtin-ci-failure",
      name: "Failed CI run on a ship PR → ci task",
      ...RULE_META,
      match: { source: "ci", types: ["pipeline.failed"] },
      task: { kind: "ci", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "ci:{{attr.full_name}}#{{attr.pr}}:{{attr.sha}}",
    },
    {
      id: "builtin-github-review",
      name: "GitHub PR review round → review task",
      ...RULE_META,
      match: { source: "github", types: ["review.requested"] },
      task: { kind: "review", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "{{source}}:{{attr.full_name}}#review-{{attr.round}}",
    },
    {
      id: "builtin-forgejo-review",
      name: "Forgejo PR review round → review task",
      ...RULE_META,
      match: { source: "forgejo", types: ["review.requested"] },
      task: { kind: "review", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "{{source}}:{{attr.full_name}}#review-{{attr.round}}",
    },
    {
      // Legacy AlertPayload: alert_id present wins, as observeAlertDedupeKey does.
      id: "builtin-observe-alert",
      name: "Observe alert (alert_id) → incident task",
      ...RULE_META,
      match: { source: "observe", types: ["alert.triggered"] },
      when: [{ attr: "alert_id", op: "matches", value: ".+" }],
      task: { kind: "incident", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "observe:{{attr.alert_id}}",
    },
    {
      // Notification outbox: rule_id + incident_id, one task per episode.
      id: "builtin-observe-incident",
      name: "Observe incident (rule_id + incident_id) → incident task",
      ...RULE_META,
      match: { source: "observe", types: ["alert.triggered"] },
      when: [
        { attr: "rule_id", op: "matches", value: ".+" },
        { attr: "incident_id", op: "matches", value: ".+" },
      ],
      task: { kind: "incident", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "observe:rule:{{attr.rule_id}}:{{attr.incident_id}}",
    },
    ...(
      [
        { id: "builtin-schedule-change", journey: "change", kind: "request-change" },
        { id: "builtin-schedule-investigate", journey: "investigate", kind: "request-investigate" },
        { id: "builtin-schedule-plan", journey: "plan", kind: "request-plan" },
        { id: "builtin-schedule-review", journey: "review", kind: "request-review" },
      ] as const
    ).map((j) => ({
      id: j.id,
      name: `Schedule slot (journey ${j.journey}) → ${j.kind} task`,
      ...RULE_META,
      match: { source: "workflow", types: ["schedule.slot"] },
      when: [{ attr: "journey", op: "eq" as const, value: j.journey }],
      task: { kind: j.kind, ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "workflow:{{attr.schedule_id}}:{{attr.slot_id}}",
    })),
    {
      id: "builtin-schedule-scan",
      name: "Schedule slot (no journey, scan) → workflow-scan task",
      ...RULE_META,
      match: { source: "workflow", types: ["schedule.slot"] },
      when: [...noJourney, { attr: "mode", op: "eq", value: "scan" }],
      task: { kind: "workflow-scan", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "workflow:{{attr.schedule_id}}:{{attr.slot_id}}",
    },
    {
      id: "builtin-schedule-plan-deferred",
      name: "Schedule slot (no journey, plan) → workflow-plan task",
      ...RULE_META,
      match: { source: "workflow", types: ["schedule.slot"] },
      when: [...noJourney, { attr: "plan", op: "eq", value: true }],
      task: { kind: "workflow-plan", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "workflow:{{attr.schedule_id}}:{{attr.slot_id}}",
    },
    {
      id: "builtin-schedule-fix",
      name: "Schedule slot (no journey, no plan) → workflow-fix task",
      ...RULE_META,
      match: { source: "workflow", types: ["schedule.slot"] },
      when: [...noJourney, { attr: "plan", op: "eq", value: false }],
      task: { kind: "workflow-fix", ...EVENT_TEXT_TEMPLATES },
      dedupeKey: "workflow:{{attr.schedule_id}}:{{attr.slot_id}}",
    },
  ];
}

// --------------------------------------------------------------- evaluation

function optionalFields(event: ShipEvent): Pick<ProposeInput, "repo" | "pr" | "requestedBy"> {
  const out: Pick<ProposeInput, "repo" | "pr" | "requestedBy"> = {};
  const repo = event.attrs.repo;
  if (typeof repo === "string" && repo !== "") out.repo = repo;
  const pr = event.attrs.pr;
  if (typeof pr === "number" && Number.isInteger(pr)) out.pr = pr;
  const requestedBy = event.attrs.requested_by;
  if (typeof requestedBy === "string" && requestedBy !== "") out.requestedBy = requestedBy;
  return out;
}

/**
 * The rule path: first rule that sees the event and whose conditions hold
 * proposes, through the engine's own matching and key rendering (decideEvent
 * over a null subject record — the built-ins keep no watermarks today; dedupe
 * is the delivery claim plus the intake key — so the only reachable verdicts
 * are "skip" and "task"). The ProposeInput is then composed with the
 * built-ins' field semantics: the channel's own source string (so per-source
 * launch policies keep applying), and title/detail verbatim from the adapter
 * (see builtinEventRules for why the generic compose's clamps are not used).
 */
export function evaluateBuiltinRules(
  rules: readonly EventRule[],
  event: ShipEvent,
  nowIso: string,
): { input: ProposeInput; rule: EventRule } | null {
  for (const rule of rules) {
    if (!ruleSeesEvent(rule, event)) continue;
    const decided = decideEvent(rule, event, null, nowIso);
    if (decided.action !== "task") continue;
    return {
      rule,
      input: {
        source: event.source,
        kind: rule.task.kind,
        ...optionalFields(event),
        title: event.title,
        ...(event.detail !== "" ? { detail: event.detail } : {}),
        dedupeKey: decided.dedupeKey,
      },
    };
  }
  return null;
}

// ----------------------------------------------------------------- compare

/** What the shadow compares: the fields that make the two paths the same task. */
export interface BuiltinShadowComparable {
  kind: string;
  repo?: string;
  pr?: number;
  requestedBy?: string;
  title: string;
  detailHash: string;
  dedupeKey: string;
  policy: IntakePolicy;
}

/** sha256 of the detail, truncated. Raw detail never reaches a log line. */
export function detailHashOf(detail: string | undefined): string {
  return createHash("sha256").update(detail ?? "", "utf8").digest("hex").slice(0, 12);
}

export function builtinShadowComparable(input: ProposeInput | null, policy: IntakePolicy): BuiltinShadowComparable | null {
  if (input === null) return null;
  return {
    kind: input.kind,
    ...(input.repo !== undefined && input.repo !== "" ? { repo: input.repo } : {}),
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(input.requestedBy !== undefined && input.requestedBy !== "" ? { requestedBy: input.requestedBy } : {}),
    title: input.title,
    detailHash: detailHashOf(input.detail),
    dedupeKey: input.dedupeKey,
    policy,
  };
}

/**
 * The diff field names, in a stable order. "proposal" means one path would
 * propose and the other would not — the worst divergence there is.
 */
export function builtinDiffFields(builtin: BuiltinShadowComparable | null, rule: BuiltinShadowComparable | null): string[] {
  if (builtin === null || rule === null) return builtin === rule ? [] : ["proposal"];
  const fields: string[] = [];
  if (builtin.kind !== rule.kind) fields.push("kind");
  if (builtin.repo !== rule.repo) fields.push("repo");
  if (builtin.pr !== rule.pr) fields.push("pr");
  if (builtin.title !== rule.title) fields.push("title");
  if (builtin.detailHash !== rule.detailHash) fields.push("detail");
  if (builtin.dedupeKey !== rule.dedupeKey) fields.push("dedupeKey");
  if (builtin.requestedBy !== rule.requestedBy) fields.push("requestedBy");
  if (builtin.policy !== rule.policy) fields.push("policy");
  return fields;
}

// ---------------------------------------------------------------- counters

export const BUILTIN_SHADOW_COUNTER_KEY = "SHIP_EVENT_SHADOW_COUNTERS";
/** Counters saturate rather than grow without bound. */
const COUNTER_CAP = 1_000_000_000;

export interface BuiltinShadowCounters {
  /** When counting started (the first shadowed delivery). */
  since: string;
  updated: string;
  deliveries: number;
  matched: number;
  diffed: number;
  sources: Record<string, { matched: number; diffed: number }>;
}

const cap = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), COUNTER_CAP) : 0);

/**
 * Parse and bound one stored counter document. Unknown per-source keys are
 * dropped (the map is fixed to BUILTIN_SHADOW_SOURCES), and every number is
 * clamped, so a damaged row cannot make the surface grow or drift.
 */
export function parseBuiltinShadowCounters(value: unknown): BuiltinShadowCounters | null {
  if (value === null || typeof value !== "object") return null;
  const c = value as Partial<BuiltinShadowCounters>;
  if (typeof c.since !== "string" || !Number.isFinite(Date.parse(c.since))) return null;
  if (typeof c.updated !== "string" || !Number.isFinite(Date.parse(c.updated))) return null;
  const sources: Record<string, { matched: number; diffed: number }> = {};
  if (c.sources !== null && typeof c.sources === "object") {
    for (const s of BUILTIN_SHADOW_SOURCES) {
      const row = (c.sources as Record<string, unknown>)[s];
      if (row === null || typeof row !== "object") continue;
      sources[s] = { matched: cap((row as { matched?: unknown }).matched), diffed: cap((row as { diffed?: unknown }).diffed) };
    }
  }
  return { since: c.since, updated: c.updated, deliveries: cap(c.deliveries), matched: cap(c.matched), diffed: cap(c.diffed), sources };
}

export async function readBuiltinShadowCounters(config: Pick<RuntimeConfigStore, "get">): Promise<BuiltinShadowCounters | null> {
  const raw = await config.get(BUILTIN_SHADOW_COUNTER_KEY);
  if (raw === undefined) return null;
  try {
    return parseBuiltinShadowCounters(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function bumpShadowCounters(
  config: Pick<RuntimeConfigStore, "get" | "set">,
  source: BuiltinSourceId,
  diffed: boolean,
  nowIso: string,
): Promise<void> {
  await withKeyLock(BUILTIN_SHADOW_COUNTER_KEY, async () => {
    const current = await readBuiltinShadowCounters(config);
    const sources: Record<string, { matched: number; diffed: number }> = {};
    for (const s of BUILTIN_SHADOW_SOURCES) {
      sources[s] = { matched: current?.sources[s]?.matched ?? 0, diffed: current?.sources[s]?.diffed ?? 0 };
    }
    sources[source] = {
      matched: (sources[source]?.matched ?? 0) + (diffed ? 0 : 1),
      diffed: (sources[source]?.diffed ?? 0) + (diffed ? 1 : 0),
    };
    await config.set(
      BUILTIN_SHADOW_COUNTER_KEY,
      JSON.stringify({
        since: current?.since ?? nowIso,
        updated: nowIso,
        deliveries: (current?.deliveries ?? 0) + 1,
        matched: (current?.matched ?? 0) + (diffed ? 0 : 1),
        diffed: (current?.diffed ?? 0) + (diffed ? 1 : 0),
        sources,
      } satisfies BuiltinShadowCounters),
      "event-rules",
    );
  });
}

// ------------------------------------------------------------------ runner

export interface BuiltinShadowDeps {
  /** Present → the counters persist; absent → the shadow logs only. */
  config?: Pick<RuntimeConfigStore, "get" | "set">;
  /**
   * The stored per-source intake policy. What the launch sweep would do with
   * each side's task; compared so a rule path that changed the task's SOURCE
   * (and with it the policy namespace) shows up as a diff.
   */
  policyOf?: (source: string) => Promise<IntakePolicy | undefined>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Tests only: an injected (e.g. mutated) rule set to force a divergence. */
  rules?: readonly EventRule[];
}

export interface BuiltinShadowIntake {
  source: BuiltinSourceId;
  payload: unknown;
  /** What the real built-in path produced for this delivery (null = skipped). */
  builtin: ProposeInput | null;
  /** Observe: the repo the receiver resolved. */
  repo?: string;
}

/**
 * The shadow itself. Called beside every real built-in intake; in `shadow`
 * mode it evaluates the equivalent rule(s), compares, logs and counts, and in
 * every other mode it returns before touching anything. It has NO way to
 * propose and no intake dependency at all — the only store it can write is
 * the one counter key.
 */
export async function shadowBuiltinIntake(deps: BuiltinShadowDeps, intake: BuiltinShadowIntake): Promise<void> {
  const mode = eventRulesMode(deps.env ?? process.env);
  if (mode !== "shadow") return;
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  try {
    const event = builtinShadowEvent(intake.source, intake.payload, {
      nowIso,
      ...(intake.repo !== undefined ? { repo: intake.repo } : {}),
    });
    const rules = deps.rules ?? builtinEventRules();
    const decided = event === null ? null : evaluateBuiltinRules(rules, event, nowIso);
    const ruleInput = decided?.input ?? null;

    // Policy resolution is best-effort on purpose: a store hiccup must not
    // manufacture a diff, so an unreadable policy reads as the "propose"
    // default on BOTH sides and the field simply stops discriminating.
    const resolve = async (source: string | undefined): Promise<IntakePolicy> => {
      if (source === undefined || deps.policyOf === undefined) return "propose";
      try {
        return (await deps.policyOf(source)) ?? "propose";
      } catch {
        return "propose";
      }
    };
    const fields = builtinDiffFields(
      builtinShadowComparable(intake.builtin, await resolve(intake.builtin?.source)),
      builtinShadowComparable(ruleInput, await resolve(ruleInput?.source)),
    );
    // A rule that asserts more authority than the source's stored policy
    // allows is a divergence even when every other field matches.
    if (fields.length === 0 && decided !== null && decided.rule.policy === "auto") {
      const stored = await resolve(decided.input.source);
      if (stored !== "auto") fields.push("policy");
    }

    if (fields.length > 0) {
      log(`[event-rules shadow] diff source=${intake.source} key=${intake.builtin?.dedupeKey ?? ruleInput?.dedupeKey ?? "-"} fields=${fields.join(",")}`);
    }
    if (deps.config !== undefined) {
      await bumpShadowCounters(deps.config, intake.source, fields.length > 0, nowIso);
    }
  } catch (error) {
    // The real path is unaffected whatever happens in here; say so and move on.
    log(`[event-rules shadow] error source=${intake.source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Self-check: every default rule must pass the EV2 shape validation. */
export function builtinEventRulesValid(): string | null {
  for (const rule of builtinEventRules()) {
    const checked = validEventRuleShape(rule);
    if (!checked.ok) return `${rule.id}: ${checked.problem}`;
  }
  return null;
}
