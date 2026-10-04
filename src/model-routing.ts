/**
 * Versioned model routing policy: which model a role runs on, and when it may
 * be replaced.
 *
 * `provider.ts` deliberately refuses to fall back to a different model: a
 * silent substitution breaks replay determinism and benchmark validity. S23
 * adds the missing half — a substitution that is NOT silent. A switch is
 * allowed only when an explicit, versioned policy lists the trigger, and every
 * choice is returned as a frozen {@link Segment} naming the policy version, the
 * model, the reason and every candidate that was skipped and why.
 *
 * Changing model also changes where project data travels, so the checks that
 * matter most are not about quality:
 *   - the candidate's data destination must be one the task permits (private
 *     work never reaches a provider that is merely the only one still up);
 *   - the candidate's retention must not exceed what the data class allows;
 *   - the candidate must not ask for tools/connections the task was not given
 *     (a fallback must not widen authority);
 *   - declared capabilities and context must cover the task (an undeclared
 *     capability is unsupported, not assumed);
 *   - the reserved budget must cover the candidate, unknown pricing priced at
 *     the highest known rate (the pricing.ts rule, reused, not copied);
 *   - an in-flight tool call with an uncertain side effect is never replayed
 *     on another model.
 *
 * Pure: no clock, no I/O, no environment unless the caller passes one. Same
 * inputs, same answer. Not wired into the runtime (see the PR for the points).
 */
import { costUSD, isLocalModel, isPricedModel, isQuotaModel } from "./pricing.js";

export type Effort = "low" | "medium" | "high" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"];

export type DataClass = "private" | "internal" | "public";
export type Retention = "none" | "short" | "long" | "unknown";
const RETENTION_RANK: Record<Retention, number> = { none: 0, short: 1, long: 2, unknown: 3 };
/** Longest retention each data class tolerates unless the task says otherwise. */
const DEFAULT_MAX_RETENTION: Record<DataClass, Retention> = { private: "none", internal: "short", public: "long" };

export type FallbackTrigger = "outage" | "rate-limit" | "budget" | "unsupported-tool" | "refusal";
export const FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  "outage",
  "rate-limit",
  "budget",
  "unsupported-tool",
  "refusal",
];

export interface Candidate {
  /** Full model id as the rest of Ship spells it, e.g. `zai/glm-5.3`. */
  model: string;
  effort: Effort;
  /** Declared before use: `tools`, `structured-output`, `streaming`, `cancellation`, `multimodal`, ... */
  capabilities: readonly string[];
  /** Where project data goes: provider host and its class (`hosted`, `local`, `vpc`, ...). */
  dataDestination: { host: string; class: string };
  retention: Retention;
  maxContext: number;
  /** What this configuration would need beyond a bare model call. Absent = nothing. */
  requestedAuthority?: { tools?: readonly string[]; connections?: readonly string[] };
}

export interface RoutingPolicy {
  version: string;
  roles: Readonly<Record<string, readonly Candidate[]>>;
  /** Triggers on which a switch is permitted. Empty/absent = never switch. */
  fallbackOn: readonly FallbackTrigger[];
}

export interface RouteTask {
  needs: readonly string[];
  contextTokens: number;
  /** Output tokens to reserve for; under-stating it under-reserves spend. */
  maxOutputTokens: number;
  dataClass: DataClass;
  /** Destination hosts, or `class:<name>` entries. Absent = any, for public data only. */
  allowedDestinations?: readonly string[];
  maxRetention?: Retention;
  /** USD still available to reserve for this segment. */
  reservedBudget: number;
  /** A tool call whose effect on the world is unknown has already been issued. */
  uncertainSideEffects: boolean;
  /** What the task was granted. A candidate may request no more. */
  authority?: { tools?: readonly string[]; connections?: readonly string[] };
}

export type SkipCode =
  | "destination-not-allowed"
  | "retention-exceeds"
  | "missing-capability"
  | "context-too-small"
  | "budget-insufficient"
  | "authority-expansion"
  | "already-tried";

export interface Skipped {
  candidate: string;
  code: SkipCode;
  why: string;
}

export interface Segment {
  policyVersion: string;
  role: string;
  model: string;
  effort: Effort;
  destination: { host: string; class: string };
  /** Why this candidate: `primary`, `first-eligible ...`, or `fallback:<trigger>`. */
  reason: string;
  /** USD reserved for this segment. `pricing` says how the figure was arrived at. */
  reservedUSD: number;
  pricing: "table" | "free" | "unknown-highest-rate";
  skipped: readonly Skipped[];
}

export type Route =
  | { ok: true; candidate: Candidate; segment: Segment }
  | { ok: false; reasons: readonly string[]; skipped: readonly Skipped[] };

export interface RouteOptions {
  /** Passed to pricing.ts. Defaults to `{}` so routing never depends on ambient env. */
  env?: NodeJS.ProcessEnv;
}

/** Why a policy cannot be used. Empty list = valid. */
export function validatePolicy(policy: RoutingPolicy): string[] {
  const errors: string[] = [];
  if (typeof policy.version !== "string" || policy.version.trim() === "") errors.push("policy has no version");
  for (const t of policy.fallbackOn ?? []) {
    if (!FALLBACK_TRIGGERS.includes(t)) errors.push(`unknown fallback trigger: ${String(t)}`);
  }
  const roles = Object.entries(policy.roles ?? {});
  if (roles.length === 0) errors.push("policy has no roles");
  for (const [role, cands] of roles) {
    if (cands.length === 0) errors.push(`role ${role} has no candidates`);
    const seen = new Set<string>();
    for (const c of cands) {
      if (typeof c.model !== "string" || c.model === "") errors.push(`role ${role}: candidate without a model`);
      if (seen.has(c.model)) errors.push(`role ${role}: duplicate candidate ${c.model}`);
      seen.add(c.model);
      if (!EFFORTS.includes(c.effort)) errors.push(`role ${role}: ${c.model} has invalid effort`);
      if (!Number.isFinite(c.maxContext) || c.maxContext <= 0) errors.push(`role ${role}: ${c.model} has invalid maxContext`);
      if (!(c.retention in RETENTION_RANK)) errors.push(`role ${role}: ${c.model} has invalid retention`);
      if (!c.dataDestination || !c.dataDestination.host || !c.dataDestination.class) {
        errors.push(`role ${role}: ${c.model} declares no data destination`);
      }
    }
  }
  return errors;
}

function destinationAllowed(c: Candidate, task: RouteTask): boolean {
  if (task.allowedDestinations === undefined) return task.dataClass === "public";
  return (
    task.allowedDestinations.includes(c.dataDestination.host) ||
    task.allowedDestinations.includes(`class:${c.dataDestination.class}`)
  );
}

function reserve(model: string, task: RouteTask, env: NodeJS.ProcessEnv): { usd: number; basis: Segment["pricing"] } {
  const usd = costUSD(model, { inputTokens: task.contextTokens, outputTokens: task.maxOutputTokens }, env);
  const free = isLocalModel(model, env) || isQuotaModel(model, env);
  const basis = free ? "free" : isPricedModel(model, env) ? "table" : "unknown-highest-rate";
  return { usd, basis };
}

/** First reason this candidate cannot take the task, or undefined if it can. */
function whyNot(c: Candidate, task: RouteTask, env: NodeJS.ProcessEnv): Skipped | undefined {
  const skip = (code: SkipCode, why: string): Skipped => ({ candidate: c.model, code, why });
  // Destination and retention first: they are the data-protection gates and
  // must be the reported reason even when other reasons also apply.
  if (!destinationAllowed(c, task)) {
    return skip(
      "destination-not-allowed",
      `${c.dataDestination.host} (${c.dataDestination.class}) is not a permitted destination for ${task.dataClass} data`,
    );
  }
  const maxRet = task.maxRetention ?? DEFAULT_MAX_RETENTION[task.dataClass];
  if (RETENTION_RANK[c.retention] > RETENTION_RANK[maxRet]) {
    return skip("retention-exceeds", `retention ${c.retention} exceeds ${maxRet}`);
  }
  const grantedTools = new Set(task.authority?.tools ?? []);
  const grantedConns = new Set(task.authority?.connections ?? []);
  const extraTools = (c.requestedAuthority?.tools ?? []).filter((t) => !grantedTools.has(t));
  const extraConns = (c.requestedAuthority?.connections ?? []).filter((t) => !grantedConns.has(t));
  if (extraTools.length > 0 || extraConns.length > 0) {
    return skip("authority-expansion", `requests beyond the task's grant: ${[...extraTools, ...extraConns].join(", ")}`);
  }
  const missing = task.needs.filter((n) => !c.capabilities.includes(n));
  if (missing.length > 0) return skip("missing-capability", `does not declare: ${missing.join(", ")}`);
  if (task.contextTokens + task.maxOutputTokens > c.maxContext) {
    return skip("context-too-small", `${task.contextTokens + task.maxOutputTokens} tokens exceeds ${c.maxContext}`);
  }
  const { usd, basis } = reserve(c.model, task, env);
  if (!(usd <= task.reservedBudget)) {
    return skip("budget-insufficient", `needs $${usd.toFixed(4)} (${basis}) but $${task.reservedBudget} is reserved`);
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function choose(
  policy: RoutingPolicy,
  role: string,
  candidates: readonly Candidate[],
  task: RouteTask,
  reasonFor: (index: number, skipped: number) => string,
  preSkipped: Skipped[],
  env: NodeJS.ProcessEnv,
): Route {
  const skipped: Skipped[] = [...preSkipped];
  for (const [i, c] of candidates.entries()) {
    const why = whyNot(c, task, env);
    if (why !== undefined) {
      skipped.push(why);
      continue;
    }
    const { usd, basis } = reserve(c.model, task, env);
    const segment: Segment = deepFreeze({
      policyVersion: policy.version,
      role,
      model: c.model,
      effort: c.effort,
      destination: { ...c.dataDestination },
      reason: reasonFor(i, skipped.length),
      reservedUSD: usd,
      pricing: basis,
      skipped: skipped.map((s) => ({ ...s })),
    });
    return { ok: true, candidate: c, segment };
  }
  return {
    ok: false,
    reasons: deepFreeze(skipped.length === 0 ? ["no candidates left"] : skipped.map((s) => `${s.candidate}: ${s.why}`)),
    skipped: deepFreeze(skipped),
  };
}

function refuse(reasons: string[]): Route {
  return { ok: false, reasons: deepFreeze(reasons), skipped: deepFreeze([]) };
}

/**
 * Pick the model for the start of a segment. Skipping an ineligible candidate
 * here is selection, not a switch, so it does not need a `fallbackOn` trigger;
 * it is still recorded in `skipped`.
 */
export function selectModel(
  policy: RoutingPolicy,
  role: string,
  task: RouteTask,
  options: RouteOptions = {},
): Route {
  const errors = validatePolicy(policy);
  if (errors.length > 0) return refuse(errors.map((e) => `invalid policy: ${e}`));
  const candidates = policy.roles[role];
  if (candidates === undefined) return refuse([`role ${role} is not in policy ${policy.version}`]);
  // Selecting afresh after an uncertain effect would replay it.
  if (task.uncertainSideEffects) {
    return refuse(["an earlier tool call has an uncertain side effect; a new model segment would replay it"]);
  }
  return choose(
    policy,
    role,
    candidates,
    task,
    (i, skipped) => (i === 0 ? "primary" : `first-eligible after skipping ${skipped}`),
    [],
    options.env ?? {},
  );
}

export interface CurrentAttempt {
  model: string;
  failure: FallbackTrigger;
  /** The tool call in flight when the failure happened, if any. */
  inFlight?: { tool: string; sideEffect: "none" | "idempotent" | "uncertain" };
}

/**
 * Choose a replacement after `current` failed. Refuses unless the policy lists
 * the failure, no uncertain side effect is in flight, and a LATER candidate
 * clears every gate `selectModel` applies. Never goes back up the list: the
 * order is the operator's preference, and the failed one is the one that failed.
 * The recorded attempt is untouched; the result is a new segment.
 */
export function nextFallback(
  policy: RoutingPolicy,
  role: string,
  task: RouteTask,
  current: CurrentAttempt,
  options: RouteOptions = {},
): Route {
  const errors = validatePolicy(policy);
  if (errors.length > 0) return refuse(errors.map((e) => `invalid policy: ${e}`));
  const candidates = policy.roles[role];
  if (candidates === undefined) return refuse([`role ${role} is not in policy ${policy.version}`]);
  if (!(policy.fallbackOn ?? []).includes(current.failure)) {
    return refuse([`policy ${policy.version} does not permit fallback on ${current.failure}`]);
  }
  if (task.uncertainSideEffects || current.inFlight?.sideEffect === "uncertain") {
    return refuse([
      `tool call ${current.inFlight?.tool ?? "(earlier)"} has an uncertain side effect; switching model would replay it`,
    ]);
  }
  const at = candidates.findIndex((c) => c.model === current.model);
  if (at < 0) return refuse([`${current.model} is not a candidate for role ${role}`]);
  const tried: Skipped[] = candidates
    .slice(0, at + 1)
    .map((c) => ({ candidate: c.model, code: "already-tried" as const, why: "current or earlier in the order" }));
  return choose(
    policy,
    role,
    candidates.slice(at + 1),
    task,
    () => `fallback:${current.failure}`,
    tried,
    options.env ?? {},
  );
}
