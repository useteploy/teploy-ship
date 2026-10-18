import { DELEGATE_TARGET_ID } from "./actions.js";
import { HARNESS_VERSIONS, NATIVE_HARNESS_ID } from "./harness.js";
import { refusalFor } from "./harness-capabilities.js";
import { externalHarnessConfig, providerEgressAllow } from "./harness-external.js";
import { checkCandidate } from "./model-routing.js";
import type { Segment } from "./model-routing.js";
import { loadRoutingPolicy, routingMode } from "./model-routing-policy.js";
import type { RoutingMode } from "./model-routing-policy.js";
import { routingTaskFromEnv } from "./model-routing-wire.js";

/**
 * Delegate targets (DT2): WHERE a delegated child runs, chosen by the parent
 * with ```delegate target=<id>.
 *
 * The id names an entry in an allowlist, never a free-form model string. Two
 * levels, intersected (DECISIONS_OPEN_2026-10-04, 2026-10-17 entries):
 *
 *   - the deployment ceiling, SHIP_DELEGATE_TARGETS — JSON
 *     `[{"id","harness","model"}]` (or an `{id: {harness, model}}` object), or
 *     the simple list `id=harness:model,id=harness:model`;
 *   - the project's optional `delegateTargets` (projects.ts), a subset of ids.
 *     Absent = no narrowing; an empty list = none.
 *
 * A target is a NEW destination for the task's data, so every targeted spawn
 * runs the routing policy's data-class gate (`checkCandidate`, i.e. `whyNot`:
 * destination and retention first) whatever SHIP_MODEL_ROUTING says — the
 * gate is a floor, the routing mode is about the parent's own model. Fail
 * closed at every step, each refusal named:
 *
 *   targets-invalid         SHIP_DELEGATE_TARGETS does not parse: nothing is a target
 *   target-not-allowed      the id is not in the set this run was offered at enqueue,
 *                           or no longer in deployment ∩ project
 *   harness-refused         the harness cannot run a read-only investigation
 *   no-routing-policy       no policy file is loaded: no destination is declared, so
 *                           no non-inherited target can be judged
 *   routing-policy-invalid  the policy file does not load
 *   not-in-policy           the model is not a candidate anywhere in the policy
 *   destination-not-allowed / retention-exceeds / budget-insufficient / ...
 *                           the policy's own skip codes, with its text
 *   harness-model-mismatch  an external harness runs the model THIS deployment
 *                           configures for it; a target naming another is a promise
 *                           Ship cannot keep
 *   harness-host-mismatch   an external harness dials its provider from inside the
 *                           sandbox; that host must be the policy entry's destination,
 *                           or the entry describes a different wire
 *
 * A delegation WITHOUT a target inherits the parent's harness and model
 * exactly as before: no new destination, no new gate.
 */

export interface DelegateTarget {
  id: string;
  harness: string;
  model: string;
}

/** What a targeted child records in its input: the target plus the decision that admitted it. */
export interface RecordedDelegateTarget extends DelegateTarget {
  policyVersion: string;
  policyDigest: string;
  destination: { host: string; class: string };
}

/** Is this a well-formed target id? The fence (actions.ts) and the project record use the same rule. */
export function isDelegateTargetId(id: string): boolean {
  return DELEGATE_TARGET_ID.test(id);
}

export type TargetsParse = { ok: true; targets: DelegateTarget[] } | { ok: false; error: string };

/**
 * Parse SHIP_DELEGATE_TARGETS. Unset or blank is an empty list. Anything
 * malformed — a bad id, an unknown harness, a blank model, a duplicate id —
 * refuses the WHOLE value: a half-read allowlist is a different allowlist.
 */
export function parseDelegateTargets(raw: string | undefined): TargetsParse {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, targets: [] };
  let entries: Array<{ id: unknown; harness: unknown; model: unknown }>;
  if (text.startsWith("[") || text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `SHIP_DELEGATE_TARGETS is not JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (Array.isArray(json)) {
      if (!json.every((e) => e !== null && typeof e === "object" && !Array.isArray(e))) return { ok: false, error: "SHIP_DELEGATE_TARGETS entries must be objects {id, harness, model}" };
      entries = json as Array<{ id: unknown; harness: unknown; model: unknown }>;
    } else if (json !== null && typeof json === "object") {
      entries = [];
      for (const [id, value] of Object.entries(json as Record<string, unknown>)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `SHIP_DELEGATE_TARGETS.${id} must be an object {harness, model}` };
        entries.push({ id, ...(value as { harness?: unknown; model?: unknown }) } as { id: unknown; harness: unknown; model: unknown });
      }
    } else {
      return { ok: false, error: "SHIP_DELEGATE_TARGETS must be a JSON array or object" };
    }
  } else {
    entries = [];
    for (const part of text.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      const eq = part.indexOf("=");
      const colon = eq < 0 ? -1 : part.indexOf(":", eq + 1);
      if (eq < 0 || colon < 0) return { ok: false, error: `SHIP_DELEGATE_TARGETS entry "${part}" must be id=harness:model` };
      entries.push({ id: part.slice(0, eq).trim(), harness: part.slice(eq + 1, colon).trim(), model: part.slice(colon + 1).trim() });
    }
  }
  const targets: DelegateTarget[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!isDelegateTargetId(id)) return { ok: false, error: `SHIP_DELEGATE_TARGETS has an invalid id ${JSON.stringify(e.id)} (lowercase letters, digits, . _ -)` };
    if (seen.has(id)) return { ok: false, error: `SHIP_DELEGATE_TARGETS lists ${id} twice` };
    seen.add(id);
    const harness = typeof e.harness === "string" ? e.harness.trim() : "";
    if (HARNESS_VERSIONS[harness] === undefined) return { ok: false, error: `SHIP_DELEGATE_TARGETS.${id}: unknown harness ${JSON.stringify(e.harness)}; known: ${Object.keys(HARNESS_VERSIONS).join(", ")}` };
    const model = typeof e.model === "string" ? e.model.trim() : "";
    if (model === "" || /\s/.test(model)) return { ok: false, error: `SHIP_DELEGATE_TARGETS.${id}: model must be a non-empty id without spaces` };
    targets.push({ id, harness, model });
  }
  return { ok: true, targets };
}

/** Deployment ∩ project. `projectIds` absent = no narrowing; deployment order is kept. */
export function effectiveDelegateTargets(deployment: readonly DelegateTarget[], projectIds: readonly string[] | undefined): DelegateTarget[] {
  if (projectIds === undefined) return [...deployment];
  const allowed = new Set(projectIds);
  return deployment.filter((t) => allowed.has(t.id));
}

/**
 * The project record's list, normalised at save: trimmed, de-duplicated,
 * every id well-formed (a typo refuses the save rather than silently allowing
 * nothing). Absent stays absent (inherit the deployment's list); an empty list
 * is kept, and means no target at all.
 */
export function normalizeDelegateTargetIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error("delegateTargets must be a list of target ids");
  const out: string[] = [];
  for (const raw of value as string[]) {
    const id = raw.trim();
    if (id === "") continue;
    if (!isDelegateTargetId(id)) throw new Error(`delegateTargets: invalid target id ${JSON.stringify(raw)} (lowercase letters, digits, . _ -)`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type DelegateTargetRefusal =
  | "targets-invalid"
  | "target-not-allowed"
  | "harness-refused"
  | "no-routing-policy"
  | "routing-policy-invalid"
  | "not-in-policy"
  | "harness-model-mismatch"
  | "harness-host-mismatch"
  | string;

export type DelegateTargetGate =
  | { ok: true; target: RecordedDelegateTarget; segment: Segment; mode: RoutingMode }
  | { ok: false; code: DelegateTargetRefusal; reason: string };

/** The refusal the parent's model reads: the code first, so it is named, then the reason. */
export function delegateTargetRefusal(code: string, id: string, why: string): string {
  return `delegation refused (${code}): target ${id} ${why}. Leave target= off to run the child on this run's own model, or pick another target.`;
}

/**
 * Admit or refuse one targeted spawn. Pure over its arguments plus the policy
 * file the env names (read through `loadRoutingPolicy`, which never throws);
 * the caller runs it INSIDE the parent's recorded spawn step, so a replay
 * reads the recorded outcome and never re-judges.
 *
 * `offered` is what the parent's input recorded at enqueue; `projectIds` is
 * the project's CURRENT list. Both must still hold the id — a target the
 * operator removed since the parent started is not a target any more.
 * `reservedBudgetUSD` is the child's cost cap when one applies (DT3); the
 * policy's budget check then answers `budget-insufficient` for a target the
 * child could not afford.
 */
export function gateDelegateTarget(args: {
  id: string;
  offered: readonly DelegateTarget[] | undefined;
  projectIds: readonly string[] | undefined;
  env: NodeJS.ProcessEnv;
  reservedBudgetUSD?: number;
}): DelegateTargetGate {
  const { id, env } = args;
  const refuse = (code: DelegateTargetRefusal, why: string): DelegateTargetGate => ({ ok: false, code, reason: delegateTargetRefusal(code, id, why) });
  const parsed = parseDelegateTargets(env.SHIP_DELEGATE_TARGETS);
  if (!parsed.ok) return refuse("targets-invalid", `cannot be checked: ${parsed.error}`);
  const offered = (args.offered ?? []).find((t) => t.id === id);
  const current = effectiveDelegateTargets(parsed.targets, args.projectIds).find((t) => t.id === id);
  if (offered === undefined || current === undefined) return refuse("target-not-allowed", "is not allowed for this project");
  // The recorded offer and today's allowlist must describe the same target:
  // an id re-pointed at another harness or model since the parent started is
  // not the target this run was offered.
  if (offered.harness !== current.harness || offered.model !== current.model) {
    return refuse("target-not-allowed", "has changed since this run started");
  }
  const harnessRefusal = refusalFor(current.harness, "investigate");
  if (harnessRefusal !== undefined) return refuse("harness-refused", `runs on ${current.harness}, which cannot run a read-only child: ${harnessRefusal}`);
  const loaded = loadRoutingPolicy(env);
  if (loaded === undefined) return refuse("no-routing-policy", "cannot be checked: no routing policy is loaded (SHIP_MODEL_ROUTING_POLICY), so no destination is declared for its model");
  if (!loaded.ok) return refuse("routing-policy-invalid", `cannot be checked: the routing policy does not load (${loaded.errors.join("; ")})`);
  const task = {
    ...routingTaskFromEnv(env),
    uncertainSideEffects: false,
    ...(args.reservedBudgetUSD !== undefined ? { reservedBudget: args.reservedBudgetUSD } : {}),
  };
  const check = checkCandidate(loaded.policy, current.model, task, { env });
  if (!check.ok) return refuse(check.code, `(${current.model}): ${check.why}`);
  const destination = check.segment.destination;
  if (current.harness !== NATIVE_HARNESS_ID) {
    // An external harness takes its model from the deployment's own
    // SHIP_HARNESS_MODEL[_<ID>], not from the target.
    const configured = externalHarnessConfig(current.harness, env).model;
    if (configured !== current.model) {
      return refuse("harness-model-mismatch", `names ${current.model}, but this deployment runs ${current.harness} on ${configured ?? "its own default model"}`);
    }
    // ...and dials its provider from inside the sandbox, at the hosts its
    // forwarded env selects (the same derivation the egress allowlist uses).
    // Every one of them must be the destination the policy judged.
    const hosts = [...new Set(providerEgressAllow([{ id: current.harness }], env).map((entry) => entry.split(":")[0]!.toLowerCase()))];
    const want = destination.host.toLowerCase();
    if (hosts.length === 0 || hosts.some((h) => h !== want)) {
      return refuse("harness-host-mismatch", `runs ${current.harness}, which would call ${hosts.length === 0 ? "a provider host Ship cannot derive" : hosts.join(", ")}, but the policy entry for ${current.model} declares ${destination.host}`);
    }
  }
  return {
    ok: true,
    target: { ...current, policyVersion: loaded.policy.version, policyDigest: loaded.digest, destination: { ...destination } },
    segment: check.segment,
    mode: routingMode(env),
  };
}
