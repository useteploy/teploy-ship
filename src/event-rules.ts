import type { ProposeInput } from "./intake.js";
import type { EventEnvelope } from "./tool-manifest.js";
import { safeForDisplay } from "./redact.js";

/**
 * E7 EV2 — the generic event-rule layer: a thin matching/ordering/policy
 * stage that sits IN FRONT of the existing intake (intake.propose), not a
 * second task system. A rule's whole output is ONE ProposeInput with a
 * deterministic dedupe key; dedupe itself stays where it already lives —
 * the durable delivery-id claim, the intake dedupe key, and the atomic
 * proposed-to-launched claim. Auto is a policy MARKER only: launching stays
 * with the source policy the operator set and the worker's count,
 * concurrency, spend and plan-park gates, none of which a rule can widen.
 *
 * This module is pure: no store, no clock reads. The stateful half (subject
 * watermarks, rate counters, the seen-events ring) is event-subjects.ts.
 */

/** The flag's three states. Off is the default; off answers 503 at the route. */
export type EventRulesMode = "off" | "shadow" | "on";

export function eventRulesMode(env: NodeJS.ProcessEnv = process.env): EventRulesMode {
  const v = (env.SHIP_EVENT_RULES ?? "").trim().toLowerCase();
  return v === "shadow" ? "shadow" : v === "on" ? "on" : "off";
}

// ------------------------------------------------------------------ event

/**
 * One normalized inbound event, whatever vendor shape it arrived in. The
 * source is the CHANNEL identity (the `sourceId` of the hook URL the
 * delivery hit), never a name the payload asserts: a signed source that
 * claims to be "observe" must not match observe's rules.
 */
export interface ShipEvent {
  /** The receiving channel's id (the URL segment). */
  source: string;
  /** Normalized dotted type: "issue.new", "incident.resolved", … */
  type: string;
  /** Vendor event id; stable across delivery retries. */
  eventId: string;
  /** Ordering/dedupe scope: "observe:site/fp", "pagerduty:incident/PXXXX". */
  subject: string;
  /** Vendor time, not receipt time. */
  occurredAt: string;
  /** Vendor monotonic counter when the stream has one. */
  seq?: number;
  /** Service/project key for attribution; resolved through projects, never cloned from. */
  repoHint?: string;
  /** Clamped and redacted by the adapter before anything stores them. */
  title: string;
  detail: string;
  /** Flat, typed fields conditions and templates may read. */
  attrs: Record<string, string | number | boolean>;
}

// ------------------------------------------------------------------ rule

/** AND-ed; no code evaluation, ever. */
export interface Condition {
  /** An event attr name, or the pseudo-attrs "type" / "subject". */
  attr: string;
  op: "eq" | "ne" | "in" | "gte" | "lte" | "matches";
  value: string | number | boolean | Array<string | number | boolean>;
}

/**
 * The kinds a rule may propose. Deliberately not a free string: at launch
 * the worker derives mode/journey/plan from the kind (intakeJourney,
 * journeys.ts), so a kind outside this set would silently mean "fix mode,
 * no plan park" whatever the rule author intended. "event" is that plain
 * fix-mode task; the others reuse the schedule encodings verbatim.
 */
export const EVENT_TASK_KINDS = [
  "event",
  "workflow-scan",
  "workflow-plan",
  "request-change",
  "request-investigate",
  "request-plan",
  "request-review",
] as const;
export type EventTaskKind = (typeof EVENT_TASK_KINDS)[number];

export interface EventTaskTemplate {
  kind: EventTaskKind;
  repoFrom: "attribution" | "fixed";
  /** Required when repoFrom is "fixed". A clone URL, allowlist-checked at propose. */
  repo?: string;
  /** {{token}} substitution only; values clamped. Must render non-empty. */
  titleTemplate: string;
  detailTemplate: string;
}

export type EventRulePolicy = "dry-run" | "propose" | "auto";

export interface EventRule {
  id: string;
  name: string;
  enabled: boolean;
  match: { source: string; types: string[] };
  when?: Condition[];
  task: EventTaskTemplate;
  /** Template, e.g. "rule:{{rule.id}}:{{subject}}". Episode suffix added when closeOn is set. */
  dedupeKey: string;
  /** Collapse a burst: the episode's first event proposes, later ones are absorbed. */
  debounceSeconds?: number;
  /** Closes the dismissed-key reopening intake otherwise allows (intake.ts). */
  cooldownAfterDismissSeconds?: number;
  /** Types that end an episode without proposing anything. */
  closeOn?: string[];
  /**
   * dry-run evaluates and records but never proposes. auto additionally
   * asserts the tasks MAY be auto-launched — launch still requires the
   * source's stored policy to say auto, plus every worker cap and park.
   * Refused at save for shared-secret sources (Decision 12, 2026-10-17);
   * that is a floor, not a setting.
   */
  policy: EventRulePolicy;
  /** Per rule, fleet-wide; excess deliveries are parked and logged. */
  ratePerHour?: number;
  by: string;
  createdAt: string;
}

/**
 * A registered event source. No secret in here on purpose: the secret is
 * deployment config (`SHIP_EVENT_SECRET_<ID>`), the same place every other
 * Ship webhook secret lives, so no ring buffer, snapshot or config listing
 * can ever contain it.
 */
export interface EventSourceRecord {
  id: string;
  /** hmac = real signature over ts.body. shared-secret = bearer token only (no real signature). */
  auth: "hmac" | "shared-secret";
  enabled: boolean;
  /** hmac freshness window seconds (default 300). */
  replayWindowSeconds?: number;
  /** shared-secret soft freshness for the body timestamp (default 86400). */
  maxAgeSeconds?: number;
  createdAt: string;
  by: string;
}

/** The env var holding this source's secret (hmac key or shared token). */
export function eventSourceSecret(sourceId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = `SHIP_EVENT_SECRET_${sourceId.toUpperCase().replace(/-/g, "_")}`;
  const value = env[name];
  // Trimmed-blank is unset: a whitespace secret would otherwise verify
  // against a whitespace signature and look configured.
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

// ------------------------------------------------------- subject records

/**
 * Ordering state for one (rule, subject): the watermark the ordering check
 * compares against, the episode counter the dedupe key embeds, and the
 * debounce/dismissal bookkeeping. Stored per rule, because two rules over
 * one subject have independent episodes — a spike rule firing must not make
 * the older event of a new-issue rule "stale".
 */
export interface EventSubjectRecord {
  ruleId: string;
  subject: string;
  lastOccurredAt: string;
  lastSeq?: number;
  /** 0 until something opens the first episode. */
  episode: number;
  state: "open" | "closed";
  /** When the current episode opened (its first event's occurredAt). */
  episodeStartedAt?: string;
  /** Whether the current episode already produced its task. */
  episodeFired?: boolean;
  /** Events absorbed by debounce inside the current episode. */
  absorbed?: number;
  lastTaskId?: string;
  /** Set when the episode's task was dismissed and a cooldown applies. */
  dismissedUntil?: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ clamps

const TITLE_MAX = 140;
const DETAIL_MAX = 4_000;
const SUBST_MAX = 300;

/** Collapse whitespace and mark the cut, so a template cannot smuggle a blob. */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Length clamp that keeps newlines, for the multi-line detail template. */
export function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function scalar(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

// ------------------------------------------------------------- validation

const ID_RE = /^[a-z0-9-]{1,70}$/;
const SOURCE_ID_RE = /^[a-z0-9-]{1,40}$/;
const TYPE_RE = /^[a-z0-9][a-z0-9.-]{0,59}$/;
const ATTR_RE = /^[a-z][a-z0-9_-]{0,59}$/;
const TOKEN_RE = /\{\{([a-z0-9._-]+)\}\}/g;

function problem(why: string): { ok: false; problem: string } {
  return { ok: false, problem: why };
}

function validTemplateTokens(template: string, label: string): string | null {
  for (const match of template.matchAll(TOKEN_RE)) {
    const token = match[1] ?? "";
    if (
      token === "rule.id" || token === "source" || token === "type" || token === "subject" || token === "eventId"
      || token === "title" || token === "detail" || token.startsWith("attr.")
    ) {
      continue;
    }
    return `${label} uses unknown template token {{${token}}}`;
  }
  return null;
}

/**
 * Structural validation of a stored rule (the validSchedule pattern): what
 * the loader checks so one damaged row cannot take the others down. The
 * save-time checks (registered source, Decision 12) are in validateEventRule.
 */
export function validEventRuleShape(rule: unknown): { ok: true } | { ok: false; problem: string } {
  if (rule === null || typeof rule !== "object") return problem("rule must be an object");
  const r = rule as Partial<EventRule>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return problem("id must match [a-z0-9-]{1,70}");
  if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 100) return problem("name must be 1-100 characters");
  if (typeof r.enabled !== "boolean") return problem("enabled must be a boolean");
  const match = r.match;
  if (match === null || typeof match !== "object") return problem("match must be an object");
  if (typeof match.source !== "string" || !SOURCE_ID_RE.test(match.source)) return problem("match.source must be a registered source id");
  if (!Array.isArray(match.types) || match.types.length === 0 || match.types.length > 20) return problem("match.types must be a non-empty array (max 20)");
  for (const t of match.types) if (typeof t !== "string" || !TYPE_RE.test(t)) return problem(`match.types entry not a normalized type: ${String(t)}`);
  if (r.when !== undefined) {
    if (!Array.isArray(r.when) || r.when.length > 20) return problem("when must be an array (max 20 conditions)");
    for (const c of r.when) {
      if (c === null || typeof c !== "object") return problem("when entries must be condition objects");
      if (typeof c.attr !== "string" || !(ATTR_RE.test(c.attr) || c.attr === "type" || c.attr === "subject")) return problem(`condition attr not a name: ${String(c.attr)}`);
      if (c.op !== "eq" && c.op !== "ne" && c.op !== "in" && c.op !== "gte" && c.op !== "lte" && c.op !== "matches") return problem(`condition op not supported: ${String(c.op)}`);
      if (c.op === "in" && (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > 20 || c.value.some((v) => scalar(v) === undefined))) {
        return problem("condition op 'in' needs a non-empty array of scalars");
      }
      if (c.op !== "in" && scalar(c.value) === undefined) return problem("condition value must be a scalar");
      if (c.op === "matches") {
        if (typeof c.value !== "string" || c.value.length > 200) return problem("condition op 'matches' needs a pattern of at most 200 characters");
        try {
          new RegExp(c.value);
        } catch {
          return problem("condition op 'matches' pattern does not compile");
        }
      }
    }
  }
  const task = r.task;
  if (task === null || typeof task !== "object") return problem("task must be an object");
  if (!EVENT_TASK_KINDS.includes(task.kind as EventTaskKind)) return problem(`task.kind must be one of ${EVENT_TASK_KINDS.join(", ")}`);
  if (task.repoFrom !== "attribution" && task.repoFrom !== "fixed") return problem('task.repoFrom must be "attribution" or "fixed"');
  if (task.repoFrom === "fixed" && (typeof task.repo !== "string" || task.repo === "" || task.repo.length > 500)) return problem('task.repo is required when repoFrom is "fixed"');
  if (typeof task.titleTemplate !== "string" || task.titleTemplate.length < 1 || task.titleTemplate.length > 500) return problem("task.titleTemplate must be 1-500 characters");
  if (typeof task.detailTemplate !== "string" || task.detailTemplate.length > 8_000) return problem("task.detailTemplate must be at most 8000 characters");
  for (const [label, tpl] of [["task.titleTemplate", task.titleTemplate], ["task.detailTemplate", task.detailTemplate], ["dedupeKey", r.dedupeKey]] as const) {
    if (typeof tpl !== "string") return problem(`${label} must be a string`);
    const bad = validTemplateTokens(tpl, label);
    if (bad !== null) return problem(bad);
  }
  if (typeof r.dedupeKey !== "string" || r.dedupeKey.length < 1 || r.dedupeKey.length > 200) return problem("dedupeKey must be 1-200 characters");
  for (const [label, value] of [["debounceSeconds", r.debounceSeconds], ["cooldownAfterDismissSeconds", r.cooldownAfterDismissSeconds]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 86_400)) return problem(`${label} must be an integer between 1 and 86400`);
  }
  if (r.closeOn !== undefined) {
    if (!Array.isArray(r.closeOn) || r.closeOn.length === 0 || r.closeOn.length > 10) return problem("closeOn must be a non-empty array (max 10)");
    for (const t of r.closeOn) if (typeof t !== "string" || !TYPE_RE.test(t)) return problem(`closeOn entry not a normalized type: ${String(t)}`);
  }
  if (r.policy !== "dry-run" && r.policy !== "propose" && r.policy !== "auto") return problem('policy must be "dry-run", "propose" or "auto"');
  if (r.ratePerHour !== undefined && (!Number.isInteger(r.ratePerHour) || r.ratePerHour < 1 || r.ratePerHour > 3_600)) return problem("ratePerHour must be an integer between 1 and 3600");
  if (typeof r.by !== "string" || r.by.length < 1 || r.by.length > 100) return problem("by must be 1-100 characters");
  if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) return problem("createdAt must be an ISO timestamp");
  return { ok: true };
}

/**
 * Validate a rule for save. `sources` is the registered source list; the
 * Decision 12 refusal is here so every save path (API today, CLI later)
 * gets it for free: a rule with policy "auto" on a source without a real
 * signature is refused, full stop — not a setting anywhere.
 */
export function validateEventRule(rule: unknown, sources: readonly EventSourceRecord[]): { ok: true } | { ok: false; problem: string } {
  const shape = validEventRuleShape(rule);
  if (!shape.ok) return shape;
  const r = rule as EventRule;
  const source = sources.find((s) => s.id === r.match.source);
  if (source === undefined) return problem(`source "${r.match.source}" is not registered; register it first`);
  // Decision 12 (2026-10-17): sources without a real signature may propose
  // but never auto-launch. A floor, not a setting — no override exists.
  if (r.policy === "auto" && source.auth !== "hmac") {
    return problem('policy "auto" is refused on shared-secret sources: a source without a real signature must not launch unattended (Decision 12, 2026-10-17)');
  }
  return { ok: true };
}

export function validateEventSource(source: unknown): { ok: true } | { ok: false; problem: string } {
  if (source === null || typeof source !== "object") return problem("source must be an object");
  const s = source as Partial<EventSourceRecord>;
  if (typeof s.id !== "string" || !SOURCE_ID_RE.test(s.id)) return problem("id must match [a-z0-9-]{1,40}");
  if (s.auth !== "hmac" && s.auth !== "shared-secret") return problem('auth must be "hmac" or "shared-secret"');
  if (typeof s.enabled !== "boolean") return problem("enabled must be a boolean");
  if (s.replayWindowSeconds !== undefined && (!Number.isInteger(s.replayWindowSeconds) || s.replayWindowSeconds < 60 || s.replayWindowSeconds > 3_600)) {
    return problem("replayWindowSeconds must be an integer between 60 and 3600");
  }
  if (s.maxAgeSeconds !== undefined && (!Number.isInteger(s.maxAgeSeconds) || s.maxAgeSeconds < 60 || s.maxAgeSeconds > 604_800)) {
    return problem("maxAgeSeconds must be an integer between 60 and 604800");
  }
  if (typeof s.createdAt !== "string" || !Number.isFinite(Date.parse(s.createdAt))) return problem("createdAt must be an ISO timestamp");
  if (typeof s.by !== "string" || s.by.length < 1 || s.by.length > 100) return problem("by must be 1-100 characters");
  return { ok: true };
}

// ------------------------------------------------------------ conditions

function attrValue(event: ShipEvent, attr: string): string | number | boolean | undefined {
  if (attr === "type") return event.type;
  if (attr === "subject") return event.subject;
  return event.attrs[attr];
}

/** One condition against one event. A missing attr is "not equal", never an error. */
export function conditionMatches(event: ShipEvent, condition: Condition): boolean {
  const actual = attrValue(event, condition.attr);
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "ne":
      return actual !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.some((v) => v === actual);
    case "gte":
    case "lte": {
      if (actual === undefined) return false;
      if (typeof actual === "number" && typeof condition.value === "number") {
        return condition.op === "gte" ? actual >= condition.value : actual <= condition.value;
      }
      if (typeof actual === "string" && typeof condition.value === "string") {
        return condition.op === "gte" ? actual >= condition.value : actual <= condition.value;
      }
      return false;
    }
    case "matches": {
      if (actual === undefined || typeof condition.value !== "string") return false;
      const text = String(actual).slice(0, 500);
      try {
        return new RegExp(condition.value).test(text);
      } catch {
        return false;
      }
    }
  }
}

export function conditionsMatch(event: ShipEvent, when: Condition[] | undefined): boolean {
  return (when ?? []).every((c) => conditionMatches(event, c));
}

// ------------------------------------------------------------- templates

export function eventAttr(event: ShipEvent, attr: string): string {
  const value = attrValue(event, attr);
  return value === undefined ? "" : oneLine(String(value), SUBST_MAX);
}

/**
 * {{token}} substitution, nothing more — no expressions, no code. Values are
 * clamped per substitution, so a template cannot smuggle a payload-sized
 * blob into a title or a key.
 */
export function renderEventTemplate(template: string, rule: Pick<EventRule, "id">, event: ShipEvent): string {
  return template.replace(TOKEN_RE, (_m, token: string) => {
    if (token === "rule.id") return rule.id;
    if (token === "source") return event.source;
    if (token === "type") return event.type;
    if (token === "subject") return oneLine(event.subject, SUBST_MAX);
    if (token === "eventId") return oneLine(event.eventId, SUBST_MAX);
    // title/detail were clamped and redacted by the adapter; detail keeps
    // its full budget so a template cannot silently halve the report.
    if (token === "title") return oneLine(event.title, TITLE_MAX);
    if (token === "detail") return event.detail.slice(0, DETAIL_MAX);
    if (token.startsWith("attr.")) return eventAttr(event, token.slice(5));
    return "";
  });
}

/**
 * The final intake dedupe key. Episodic rules (closeOn set) append the
 * episode counter, so a regression after a close is a NEW task while every
 * re-delivery inside one episode still collapses onto the same one.
 */
export function episodeDedupeKey(rendered: string, rule: Pick<EventRule, "closeOn">, episode: number): string {
  const episodic = (rule.closeOn?.length ?? 0) > 0;
  return episodic ? `${rendered}:e${episode}` : rendered;
}

// --------------------------------------------------------------- adapter

export type EnvelopeParse =
  | { ok: true; envelope: EventEnvelope }
  | { ok: false; reason: string };

/**
 * Structural envelope check for the paths that do not use verifyEvent
 * (the shared-secret leg has no MAC to check first). Mirrors the field
 * checks verifyEvent performs after its MAC, so both legs accept the same
 * bodies.
 */
export function parseEventEnvelope(body: string): EnvelopeParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "malformed-body" };
  }
  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "malformed-envelope" };
  const e = parsed as Partial<EventEnvelope>;
  if (typeof e.eventId !== "string" || e.eventId === "") return { ok: false, reason: "malformed-envelope" };
  if (typeof e.type !== "string" || e.type === "") return { ok: false, reason: "malformed-envelope" };
  if (typeof e.schemaVersion !== "string" || !/^\d+\.\d+$/.test(e.schemaVersion)) return { ok: false, reason: "malformed-envelope" };
  if (!Number.isInteger(e.cursor) || (e.cursor as number) < 0) return { ok: false, reason: "malformed-envelope" };
  if (typeof e.occurredAt !== "string" || !Number.isFinite(Date.parse(e.occurredAt))) return { ok: false, reason: "malformed-envelope" };
  return { ok: true, envelope: parsed as EventEnvelope };
}

/**
 * The generic signed source's adapter: the verified envelope IS the event.
 * Everything vendor-specific (Sentry, PagerDuty, …) is EV4; this maps the
 * envelope's `data` to a ShipEvent with every free-text field clamped and
 * redacted HERE, so nothing downstream has to remember to.
 */
export function shipEventFromEnvelope(
  source: string,
  envelope: EventEnvelope,
): { ok: true; event: ShipEvent } | { ok: false; problem: string } {
  const type = oneLine(envelope.type, 60);
  if (!TYPE_RE.test(type)) return { ok: false, problem: `event type is not normalized: ${type}` };
  const data = envelope.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, problem: "envelope data must be an object" };
  const d = data as Record<string, unknown>;
  if (typeof d.subject !== "string" || d.subject.trim() === "") return { ok: false, problem: "envelope data.subject is required" };
  if (typeof d.title !== "string" || d.title.trim() === "") return { ok: false, problem: "envelope data.title is required" };
  const attrs: Record<string, string | number | boolean> = {};
  if (d.attrs !== undefined) {
    if (data === null || typeof d.attrs !== "object" || Array.isArray(d.attrs)) return { ok: false, problem: "envelope data.attrs must be an object" };
    for (const [key, value] of Object.entries(d.attrs as Record<string, unknown>).slice(0, 40)) {
      const v = scalar(value);
      if (v === undefined) continue;
      attrs[oneLine(key, 60)] = typeof v === "string" ? safeForDisplay(v, SUBST_MAX) : v;
    }
  }
  let seq: number | undefined;
  if (Number.isInteger(d.seq) && (d.seq as number) >= 0) seq = d.seq as number;
  else if (envelope.cursor > 0) seq = envelope.cursor;
  let repoHint: string | undefined;
  if (typeof d.repoHint === "string" && d.repoHint !== "") {
    // A repoHint is a service/project KEY resolved through the project
    // records, never a clone URL the payload gets to pick.
    const hint = oneLine(d.repoHint, 200);
    repoHint = hint.includes("://") ? undefined : hint;
  }
  return {
    ok: true,
    event: {
      source,
      type,
      eventId: oneLine(envelope.eventId, 200),
      subject: safeForDisplay(oneLine(d.subject, 200), 200),
      occurredAt: new Date(Date.parse(envelope.occurredAt)).toISOString(),
      ...(seq !== undefined ? { seq } : {}),
      ...(repoHint !== undefined ? { repoHint } : {}),
      title: safeForDisplay(oneLine(d.title, TITLE_MAX + 60), TITLE_MAX),
      detail: safeForDisplay(typeof d.detail === "string" ? d.detail.replace(/\s+/g, " ").trim() : "", DETAIL_MAX),
      attrs,
    },
  };
}

// ------------------------------------------------------------- decision

export type EventRuleDecision =
  | { action: "skip"; reason: "condition-failed" }
  | { action: "stale"; watermark: string }
  | { action: "close"; record: EventSubjectRecord }
  | { action: "tie-open" }
  | { action: "absorb"; record: EventSubjectRecord }
  | { action: "task"; record: EventSubjectRecord; episode: number; newEpisode: boolean; input: ProposeInput; dedupeKey: string };

export function freshSubjectRecord(ruleId: string, subject: string, nowIso: string): EventSubjectRecord {
  // episode 0 + closed: nothing has opened an episode yet, and a closeOn
  // event arriving before any trigger starts from exactly this state.
  return { ruleId, subject, lastOccurredAt: new Date(0).toISOString(), episode: 0, state: "closed", updatedAt: nowIso };
}

/**
 * The pure heart of the engine: what one rule does with one event against
 * its subject record. Ordering first (an event older than the watermark is
 * recorded, never acted on), then close/open, then debounce. Rate limiting
 * and the dismissal cooldown need I/O and live one layer up. `resolvedRepo`
 * is the attribution lookup's answer (repoFrom "attribution"); a fixed repo
 * is taken from the rule itself so no caller can widen it.
 *
 * Ties: with no seq, an exact-timestamp tie resolves FOR the trigger — a
 * close beats an open only when strictly later, so the system errs toward a
 * human seeing the event (E7 EV2).
 */
export function decideEvent(
  rule: EventRule,
  event: ShipEvent,
  record: EventSubjectRecord | null,
  nowIso: string,
  resolvedRepo?: string,
): EventRuleDecision {
  if (!conditionsMatch(event, rule.when)) return { action: "skip", reason: "condition-failed" };
  const rec = record ?? freshSubjectRecord(rule.id, event.subject, nowIso);
  const ts = Date.parse(event.occurredAt);
  const lastTs = Date.parse(rec.lastOccurredAt);
  const older = ts < lastTs
    || (ts === lastTs && event.seq !== undefined && rec.lastSeq !== undefined && event.seq <= rec.lastSeq);
  if (older) return { action: "stale", watermark: rec.lastOccurredAt };

  const isClose = (rule.closeOn ?? []).includes(event.type);
  const seq = event.seq;

  if (isClose && !rule.match.types.includes(event.type)) {
    // A close applies only when strictly newer than the open it closes; at
    // an exact tie the open wins and the episode stays open.
    const strictlyNewer = ts > lastTs || (ts === lastTs && seq !== undefined && rec.lastSeq !== undefined && seq > rec.lastSeq);
    if (rec.state === "open" && !strictlyNewer) return { action: "tie-open" };
    return {
      action: "close",
      record: {
        ...rec,
        state: "closed",
        lastOccurredAt: event.occurredAt,
        ...(seq !== undefined ? { lastSeq: seq } : {}),
        updatedAt: nowIso,
      },
    };
  }

  let episode = rec.episode;
  let newEpisode = false;
  let next: EventSubjectRecord = { ...rec, lastOccurredAt: event.occurredAt, ...(seq !== undefined ? { lastSeq: seq } : {}), updatedAt: nowIso };
  if (rec.state === "closed") {
    episode = rec.episode + 1;
    newEpisode = true;
    next = {
      ...next,
      episode,
      state: "open",
      episodeStartedAt: event.occurredAt,
      episodeFired: false,
      absorbed: 0,
      dismissedUntil: undefined,
    };
  } else if (
    rec.episodeFired === true &&
    rule.debounceSeconds !== undefined &&
    rec.episodeStartedAt !== undefined &&
    ts - Date.parse(rec.episodeStartedAt) < rule.debounceSeconds * 1000
  ) {
    return {
      action: "absorb",
      record: { ...next, absorbed: (rec.absorbed ?? 0) + 1 },
    };
  }

  const base = renderEventTemplate(rule.dedupeKey, rule, event);
  const dedupeKey = episodeDedupeKey(base, rule, episode);
  const title = oneLine(renderEventTemplate(rule.task.titleTemplate, rule, event), TITLE_MAX);
  const repo = rule.task.repoFrom === "fixed" ? rule.task.repo : resolvedRepo;
  const input: ProposeInput = {
    // The "events:" prefix is the policy namespace: an operator turns a
    // channel's launches on or off through the SAME source-policy store the
    // built-ins use, and can never collide with "observe" or "github".
    source: `events:${event.source}`,
    kind: rule.task.kind,
    ...(repo !== undefined && repo !== "" ? { repo } : {}),
    title,
    // Detail keeps its newlines (every substituted value was clamped and
    // redacted individually); only the total is bounded here.
    detail: clipText(renderEventTemplate(rule.task.detailTemplate, rule, event), DETAIL_MAX),
    dedupeKey,
  };
  return {
    action: "task",
    record: { ...next, episodeFired: true },
    episode,
    newEpisode,
    input,
    dedupeKey,
  };
}

/** Whether the dismissal cooldown currently suppresses proposing (pure). */
export function cooldownActive(rec: EventSubjectRecord | null, nowMs: number): boolean {
  if (rec?.dismissedUntil === undefined) return false;
  return nowMs < Date.parse(rec.dismissedUntil);
}

export function ruleSeesEvent(rule: EventRule, event: ShipEvent): boolean {
  if (!rule.enabled || rule.match.source !== event.source) return false;
  return rule.match.types.includes(event.type) || (rule.closeOn ?? []).includes(event.type);
}
