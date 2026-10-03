import { AUTHORITIES, effectiveAuthority, minAuthority, type Authority, type ProjectVerification } from "./ladder.js";
import { AUTHORITY_ACTIONS, normalizeGrant, type AuthorityAction, type Grant } from "./governance.js";
import { DEFAULT_NETWORK_TIER, NETWORK_TIERS, type NetworkTier } from "./egress.js";
import { normalizeRole } from "./users.js";

/**
 * Effective policy: organisation -> project -> user / service account.
 *
 * WHY this exists. Ship's limits live in separate places (governance grants,
 * per-project authority and budget, the network tier, per-source budgets) and
 * each entry point reads the one it knows about. Nothing says what happens when
 * the layers disagree, so the answer is whatever each caller happens to do. S25
 * wants one rule: the organisation sets MANDATORY limits, and every lower layer
 * can only tighten them.
 *
 * THE RULE is intersection, never union. Spend takes the minimum, allow-lists
 * the intersection, authority the lowest, the network tier the most
 * restrictive, retention the shortest. A union/max merge looks natural ("combine
 * the settings") and is exactly the leak: a user layer that lists a tool the
 * organisation forbids would add it. The test file keeps a union merge around
 * to show that.
 *
 * Other rules, all fail-closed:
 *  - A layer that is revoked, expired or not yet valid contributes nothing. If
 *    it was the principal's own layer (user / service account) the principal is
 *    out of the organisation and everything is denied.
 *  - Nothing is cached. `resolvePolicy(layers, now)` is a pure function the
 *    caller runs per request, so a revocation takes effect on the next call
 *    (including inside an active session that re-resolves per step).
 *  - No organisation layer: everything denied. No project or principal layer:
 *    authority is denied; other dimensions fall back to the organisation limit.
 *  - A dimension the organisation never declared is closed (no models, no tools,
 *    network none, spend 0, authority none, action grants empty), except
 *    retention, where "closed" would mean deleting data nobody asked to delete:
 *    that stays unset and is reported as such.
 *  - Two layers of the same level that disagree resolve to the stricter and the
 *    disagreement is reported in `conflicts`.
 *  - A service account must have every authority-bearing dimension declared in
 *    its OWN layer. Silence in a human's layer means "inherit"; silence in a
 *    service account's layer means "none", and role-based action grants never
 *    match it (only its explicit id does).
 *
 * Vocabulary reused: `AuthorityAction`/`Grant` (governance.ts), ladder
 * `Authority`, `authorityCap`, `effectiveAuthority`, `minAuthority`
 * (ladder.ts), `NetworkTier` (egress.ts), the egress entry grammar
 * (host, .suffix, host:port), `normalizeRole` (users.ts), and the
 * `dailyBudgetUSD`/`weeklyBudgetUSD` names (projects.ts). Provisioning and
 * workspace access had no existing vocabulary; they are small ordered ladders
 * defined here. Not wired into anything yet.
 */

export type LayerKind = "org" | "project" | "user" | "service_account";

/** Lower rank = higher in the hierarchy. user and service_account are peers. */
const RANK: Record<LayerKind, number> = { org: 0, project: 1, user: 2, service_account: 2 };

export const PROVISIONING_LEVELS = ["none", "propose", "apply"] as const;
export type ProvisioningLevel = (typeof PROVISIONING_LEVELS)[number];
export const WORKSPACE_LEVELS = ["none", "read", "write"] as const;
export type WorkspaceLevel = (typeof WORKSPACE_LEVELS)[number];

/** `"*"` = anything. Only an organisation (or a layer under one) may say so; it is still intersected. */
export type AllowList = "*" | string[];

export interface PolicyLimits {
  models?: AllowList;
  tools?: AllowList;
  network?: NetworkTier;
  /** Egress allowlist entries (egress.ts grammar). Only meaningful on the `allowlist` tier. */
  egressAllow?: AllowList;
  /** Days to keep run data. Shortest wins. */
  retentionDays?: number;
  dailyBudgetUSD?: number | "unlimited";
  weeklyBudgetUSD?: number | "unlimited";
  /** Run/delivery authority (ladder). Capped by `verification` and `neverAuto` like a project record. */
  authority?: Authority;
  neverAuto?: boolean;
  verification?: ProjectVerification;
  provisioning?: ProvisioningLevel;
  workspace?: WorkspaceLevel;
  /** Governance actions. Every declaring layer must allow the principal (AND, not OR). */
  actions?: Partial<Record<AuthorityAction, Grant>>;
}

export interface PolicyLayer {
  kind: LayerKind;
  id: string;
  /** ISO timestamps. Invalid timestamps make the layer inactive. */
  notBefore?: string;
  expiresAt?: string;
  revokedAt?: string;
  limits: PolicyLimits;
}

export type DimensionName =
  | "models"
  | "tools"
  | "network"
  | "egressAllow"
  | "retentionDays"
  | "dailyBudgetUSD"
  | "weeklyBudgetUSD"
  | "authority"
  | "provisioning"
  | "workspace"
  | `actions.${AuthorityAction}`;

export const DIMENSIONS: readonly DimensionName[] = [
  "models",
  "tools",
  "network",
  "egressAllow",
  "retentionDays",
  "dailyBudgetUSD",
  "weeklyBudgetUSD",
  "authority",
  "provisioning",
  "workspace",
  ...AUTHORITY_ACTIONS.map((a) => `actions.${a}` as const),
];

export type LayerRef = string; // "kind:id", or "default" for a fail-closed default

export interface DroppedLayer {
  layer: LayerRef;
  reason: "revoked" | "expired" | "not-yet-valid" | "invalid-time";
}

export interface IgnoredLoosening {
  layer: LayerRef;
  dimension: DimensionName;
  asked: string;
  kept: string;
}

export interface LayerConflict {
  dimension: DimensionName;
  layers: LayerRef[];
  kept: string;
}

export interface Explanation {
  dimension: DimensionName;
  /** Printable effective value. */
  value: string;
  /** The layers that narrowed the value to what it is (or the first declarer if none narrowed it). */
  decidedBy: LayerRef[];
  /** Lower-layer requests that were looser than the limit above them and so had no effect. */
  ignored: IgnoredLoosening[];
  note?: string;
}

export interface ActionRule {
  layer: LayerRef;
  grant: Grant;
}

export interface EffectivePolicy {
  /** Everything is refused: no organisation layer, or the principal's layer is revoked/expired. */
  denyAll: { reason: string; layer?: LayerRef } | null;
  principal: { kind: "user" | "service_account"; id: string } | null;
  models: string[];
  /** True when every model is allowed (organisation said "*" and nobody narrowed). */
  modelsAny: boolean;
  tools: string[];
  toolsAny: boolean;
  network: NetworkTier;
  egressAllow: string[];
  egressAny: boolean;
  /** null = no layer declared a retention; the caller keeps its own default. */
  retentionDays: number | null;
  /** number of USD, or "unlimited" */
  dailyBudgetUSD: number | "unlimited";
  weeklyBudgetUSD: number | "unlimited";
  authority: Authority | "none";
  provisioning: ProvisioningLevel;
  workspace: WorkspaceLevel;
  /** One rule per declaring layer; the principal must satisfy all of them. Empty = denied. */
  actions: Record<AuthorityAction, ActionRule[]>;
  explanations: Record<DimensionName, Explanation>;
  dropped: DroppedLayer[];
  conflicts: LayerConflict[];
  ignored: IgnoredLoosening[];
}

export const ref = (l: Pick<PolicyLayer, "kind" | "id">): LayerRef => `${l.kind}:${l.id}`;

// ── layer validity ────────────────────────────────────────────────────────

function inactiveReason(l: PolicyLayer, now: Date): DroppedLayer["reason"] | null {
  const t = now.getTime();
  const at = (s: string | undefined): number | null | undefined => {
    if (s === undefined) return undefined;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  };
  const revoked = at(l.revokedAt);
  const expires = at(l.expiresAt);
  const from = at(l.notBefore);
  if (revoked === null || expires === null || from === null) return "invalid-time"; // fail closed
  if (revoked !== undefined && revoked <= t) return "revoked";
  if (expires !== undefined && expires <= t) return "expired";
  if (from !== undefined && from > t) return "not-yet-valid";
  return null;
}

// ── dimension helpers ─────────────────────────────────────────────────────

interface Step<T> {
  layer: PolicyLayer;
  value: T;
}

interface Folded<T> {
  value: T;
  decidedBy: LayerRef[];
  ignored: IgnoredLoosening[];
  conflicts: LayerConflict[];
}

/** Is `entry` (host, .suffix or host:port) admitted by `upper`? Suffix entries match subdomains only, ports must agree. */
export function egressCovered(entry: string, upper: string): boolean {
  const split = (s: string): [string, string] => {
    const i = s.indexOf(":");
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i)];
  };
  const [eh, ep] = split(entry.trim().toLowerCase());
  const [uh, up] = split(upper.trim().toLowerCase());
  if (ep !== up) return false;
  if (eh === uh) return true;
  return uh.startsWith(".") && eh.endsWith(uh); // ".a.x" and "b.a.x" are inside ".x"
}

function narrowList(a: AllowList, b: AllowList, covered: (e: string, u: string) => boolean): AllowList {
  if (a === "*") return b;
  if (b === "*") return a;
  return b.filter((e) => a.some((u) => covered(e, u)));
}

const same = (e: string, u: string): boolean => e === u;

function listText(v: AllowList): string {
  return v === "*" ? "*" : `[${v.join(", ")}]`;
}

function listEq(a: AllowList, b: AllowList): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Generic fold: `closed` is the fail-closed start when the organisation said nothing,
 * `narrow(acc, v)` returns the tightened value, `eq` and `show` compare/print.
 * A step is "ignored" when it asked for something looser than `acc` (narrowing did not change `acc`
 * and the value was not already equal/tighter). `looser(acc, v)` decides that.
 */
function fold<T>(
  dim: DimensionName,
  steps: Step<T>[],
  closed: T,
  narrow: (acc: T, v: T) => T,
  eq: (a: T, b: T) => boolean,
  show: (v: T) => string,
  looser: (acc: T, v: T) => boolean,
): Folded<T> {
  const ignored: IgnoredLoosening[] = [];
  const conflicts: LayerConflict[] = [];
  const decidedBy: LayerRef[] = [];
  if (steps.length === 0 || steps[0]!.layer.kind !== "org") {
    // The organisation did not declare this dimension: closed, whatever lower layers ask.
    let acc = closed;
    for (const s of steps) {
      const next = narrow(acc, s.value);
      if (looser(acc, s.value)) ignored.push({ layer: ref(s.layer), dimension: dim, asked: show(s.value), kept: show(acc) });
      acc = next;
    }
    return { value: acc, decidedBy: ["default"], ignored, conflicts };
  }
  let acc = steps[0]!.value;
  decidedBy.push(ref(steps[0]!.layer));
  for (const s of steps.slice(1)) {
    const next = narrow(acc, s.value);
    if (looser(acc, s.value)) ignored.push({ layer: ref(s.layer), dimension: dim, asked: show(s.value), kept: show(acc) });
    if (!eq(next, acc)) decidedBy.push(ref(s.layer));
    acc = next;
  }
  // Same-level disagreement.
  const byKind = new Map<number, Step<T>[]>();
  for (const s of steps) byKind.set(RANK[s.layer.kind], [...(byKind.get(RANK[s.layer.kind]) ?? []), s]);
  for (const group of byKind.values()) {
    if (group.length > 1 && group.some((g) => !eq(g.value, group[0]!.value))) {
      conflicts.push({ dimension: dim, layers: group.map((g) => ref(g.layer)), kept: show(acc) });
    }
  }
  return { value: acc, decidedBy, ignored, conflicts };
}

const numShow = (v: number | "unlimited"): string => (v === "unlimited" ? "unlimited" : String(v));
const numMin = (a: number | "unlimited", b: number | "unlimited"): number | "unlimited" =>
  a === "unlimited" ? b : b === "unlimited" ? a : Math.min(a, b);
const numLooser = (acc: number | "unlimited", v: number | "unlimited"): boolean =>
  acc === "unlimited" ? false : v === "unlimited" ? true : v > acc;
const validBudget = (v: unknown): v is number | "unlimited" =>
  v === "unlimited" || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function ordered<T extends string>(order: readonly T[]) {
  const idx = (v: T): number => order.indexOf(v);
  return {
    narrow: (a: T, b: T): T => (idx(b) < idx(a) ? b : a),
    looser: (a: T, b: T): boolean => idx(b) > idx(a),
  };
}

function inSteps<T>(layers: PolicyLayer[], pick: (l: PolicyLimits) => T | undefined, ok: (v: T) => boolean = () => true): Step<T>[] {
  const out: Step<T>[] = [];
  for (const layer of layers) {
    const v = pick(layer.limits);
    if (v !== undefined && ok(v)) out.push({ layer, value: v });
    // An invalid declared value (negative budget, unknown tier) is skipped here and
    // surfaced by `validateLayer`; for a tightening layer that only reverts to the limit above.
  }
  return out;
}

/** Structural problems a layer author should hear about. Resolution itself never throws. */
export function validateLayer(l: PolicyLayer): string[] {
  const errs: string[] = [];
  const lim = l.limits;
  if (lim.network !== undefined && !NETWORK_TIERS.includes(lim.network)) errs.push(`network: unknown tier ${String(lim.network)}`);
  for (const k of ["dailyBudgetUSD", "weeklyBudgetUSD"] as const) {
    if (lim[k] !== undefined && !validBudget(lim[k])) errs.push(`${k}: must be a non-negative number or "unlimited"`);
  }
  if (lim.retentionDays !== undefined && !(Number.isInteger(lim.retentionDays) && lim.retentionDays >= 0)) errs.push("retentionDays: must be a whole number of days");
  if (lim.authority !== undefined && !AUTHORITIES.includes(lim.authority)) errs.push(`authority: unknown level ${String(lim.authority)}`);
  if (lim.provisioning !== undefined && !PROVISIONING_LEVELS.includes(lim.provisioning)) errs.push(`provisioning: unknown level`);
  if (lim.workspace !== undefined && !WORKSPACE_LEVELS.includes(lim.workspace)) errs.push(`workspace: unknown level`);
  return errs;
}

// ── resolution ────────────────────────────────────────────────────────────

const CLOSED_EXPLANATION = (dimension: DimensionName, value: string, note: string): Explanation => ({
  dimension,
  value,
  decidedBy: ["default"],
  ignored: [],
  note,
});

function emptyActions(): Record<AuthorityAction, ActionRule[]> {
  return { approve: [], auto: [], steer: [], policies: [] };
}

function denyAllPolicy(reason: string, layer: LayerRef | undefined, dropped: DroppedLayer[], principal: EffectivePolicy["principal"]): EffectivePolicy {
  const why = layer === undefined ? reason : `${reason} (${layer})`;
  const explanations = {} as Record<DimensionName, Explanation>;
  const values: Record<string, string> = {
    models: "[]",
    tools: "[]",
    network: "none",
    egressAllow: "[]",
    retentionDays: "unset",
    dailyBudgetUSD: "0",
    weeklyBudgetUSD: "0",
    authority: "none",
    provisioning: "none",
    workspace: "none",
  };
  for (const d of DIMENSIONS) {
    explanations[d] = { dimension: d, value: values[d] ?? "denied", decidedBy: layer === undefined ? ["default"] : [layer], ignored: [], note: why };
  }
  return {
    denyAll: { reason, ...(layer !== undefined ? { layer } : {}) },
    principal,
    models: [],
    modelsAny: false,
    tools: [],
    toolsAny: false,
    network: "none",
    egressAllow: [],
    egressAny: false,
    retentionDays: null,
    dailyBudgetUSD: 0,
    weeklyBudgetUSD: 0,
    authority: "none",
    provisioning: "none",
    workspace: "none",
    actions: emptyActions(),
    explanations,
    dropped,
    conflicts: [],
    ignored: [],
  };
}

/**
 * Resolve the effective policy for one request at time `now`. Pure and
 * deterministic: layers are ordered by rank then id, so input order never
 * changes the answer. Inactive layers are dropped first.
 */
export function resolvePolicy(allLayers: readonly PolicyLayer[], now: Date): EffectivePolicy {
  const dropped: DroppedLayer[] = [];
  const active: PolicyLayer[] = [];
  for (const l of allLayers) {
    const reason = inactiveReason(l, now);
    if (reason === null) active.push(l);
    else dropped.push({ layer: ref(l), reason });
  }
  active.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.id.localeCompare(b.id));

  // A principal layer that ended (revoked member, expired service account) takes everything with it,
  // unless another active layer of the principal's kind is still there.
  const droppedPrincipal = allLayers.find(
    (l) => (l.kind === "user" || l.kind === "service_account") && dropped.some((d) => d.layer === ref(l)),
  );
  const principalLayers = active.filter((l) => l.kind === "user" || l.kind === "service_account");
  const principalLayer = principalLayers[0];
  const principal: EffectivePolicy["principal"] =
    principalLayer !== undefined
      ? { kind: principalLayer.kind as "user" | "service_account", id: principalLayer.id }
      : null;

  if (!active.some((l) => l.kind === "org")) {
    const orgDrop = dropped.find((d) => d.layer.startsWith("org:"));
    return denyAllPolicy(orgDrop !== undefined ? `organisation layer ${orgDrop.reason}` : "no organisation layer", orgDrop?.layer, dropped, principal);
  }
  if (droppedPrincipal !== undefined && principalLayer === undefined) {
    const d = dropped.find((x) => x.layer === ref(droppedPrincipal))!;
    return denyAllPolicy(`principal ${d.reason}`, d.layer, dropped, null);
  }

  const isSA = principalLayer?.kind === "service_account";
  const ignored: IgnoredLoosening[] = [];
  const conflicts: LayerConflict[] = [];
  const explanations = {} as Record<DimensionName, Explanation>;
  const take = <T>(dim: DimensionName, f: Folded<T>, note?: string): T => {
    ignored.push(...f.ignored);
    conflicts.push(...f.conflicts);
    explanations[dim] = { dimension: dim, value: "", decidedBy: f.decidedBy, ignored: f.ignored, ...(note !== undefined ? { note } : {}) };
    return f.value;
  };
  const setValue = (dim: DimensionName, v: string): void => {
    explanations[dim]!.value = v;
  };

  // allow-lists
  const listDim = (dim: "models" | "tools" | "egressAllow", covered: (e: string, u: string) => boolean): AllowList => {
    const steps = inSteps<AllowList>(active, (l) => l[dim], (v) => v === "*" || Array.isArray(v));
    const f = fold<AllowList>(dim, steps, [], (a, b) => narrowList(a, b, covered), listEq, listText, (acc, v) => {
      const kept = narrowList(acc, v, covered);
      return !listEq(kept, v);
    });
    const v = take(dim, f);
    setValue(dim, listText(v));
    return v;
  };
  const models = listDim("models", same);
  const tools = listDim("tools", same);
  const egress = listDim("egressAllow", egressCovered);

  // network
  const tierOrder = ordered<NetworkTier>(NETWORK_TIERS);
  const net = take(
    "network",
    fold<NetworkTier>(
      "network",
      inSteps<NetworkTier>(active, (l) => l.network, (v) => NETWORK_TIERS.includes(v)),
      "none",
      tierOrder.narrow,
      (a, b) => a === b,
      (v) => v,
      tierOrder.looser,
    ),
    `default for an unconfigured install is ${DEFAULT_NETWORK_TIER}; an organisation layer must say so explicitly here`,
  );
  setValue("network", net);

  // retention (no closed default: unset stays unset)
  const retSteps = inSteps<number>(active, (l) => l.retentionDays, (v) => Number.isInteger(v) && v >= 0);
  let retention: number | null = null;
  {
    const f = fold<number>("retentionDays", retSteps, Infinity, Math.min, (a, b) => a === b, String, (acc, v) => v > acc);
    retention = Number.isFinite(f.value) ? f.value : null;
    take("retentionDays", { ...f, decidedBy: retention === null ? ["default"] : f.decidedBy });
    setValue("retentionDays", retention === null ? "unset" : String(retention));
    if (retention === null) explanations.retentionDays.note = "no layer set a retention; caller keeps its own default";
  }

  // spend
  const budgetDim = (dim: "dailyBudgetUSD" | "weeklyBudgetUSD"): number | "unlimited" => {
    const v = take(dim, fold<number | "unlimited">(dim, inSteps(active, (l) => l[dim], validBudget), 0, numMin, (a, b) => a === b, numShow, numLooser));
    setValue(dim, numShow(v));
    return v;
  };
  const daily = budgetDim("dailyBudgetUSD");
  const weekly = budgetDim("weeklyBudgetUSD");

  // authority: layers must be present, and a service account must declare its own.
  const needsAuthorityFrom: LayerKind[] = ["project", isSA ? "service_account" : "user"];
  const missingKinds = needsAuthorityFrom.filter((k) => !active.some((l) => l.kind === k));
  const authSteps: Step<Authority>[] = [];
  for (const l of active) {
    const declared = l.limits.authority !== undefined || l.limits.verification !== undefined || l.limits.neverAuto === true;
    if (!declared) continue;
    const asked = l.limits.authority !== undefined && AUTHORITIES.includes(l.limits.authority) ? l.limits.authority : undefined;
    if (l.limits.authority !== undefined && asked === undefined) continue;
    // A project layer goes through effectiveAuthority: the ladder cap (its verification rungs) and neverAuto,
    // exactly as for a project record. Rungs belong to projects, so org/user/service-account layers are plain
    // ceilings, floored by neverAuto only.
    const base = asked ?? "auto_normal";
    const value =
      l.kind === "project"
        ? effectiveAuthority({ authority: base, neverAuto: l.limits.neverAuto, verification: l.limits.verification })
        : l.limits.neverAuto === true ? minAuthority(base, "send") : base;
    authSteps.push({ layer: l, value });
  }
  const authOrder = ordered<Authority>(AUTHORITIES);
  let authority: Authority | "none";
  {
    const f = fold<Authority | "none">(
      "authority",
      authSteps as Step<Authority | "none">[],
      "none",
      (a, b) => (a === "none" || b === "none" ? "none" : authOrder.narrow(a, b)),
      (a, b) => a === b,
      (v) => v,
      (a, b) => a !== "none" && b !== "none" && authOrder.looser(a, b),
    );
    authority = take("authority", f);
    if (missingKinds.length > 0) {
      authority = "none";
      explanations.authority.decidedBy = ["default"];
      explanations.authority.note = `no active ${missingKinds.join(" or ")} layer: authority is denied`;
    } else if (isSA && !principalLayer!.limits.authority && !principalLayer!.limits.verification) {
      authority = "none";
      explanations.authority.decidedBy = [ref(principalLayer!)];
      explanations.authority.note = "service account has no authority scoped to it; it does not inherit a human's";
    }
    setValue("authority", authority);
  }

  // provisioning, workspace (ordered ladders, same shape as the network tier)
  const ladderDim = <T extends string>(dim: "provisioning" | "workspace", order: readonly T[], pick: (l: PolicyLimits) => T | undefined): T => {
    const o = ordered<T>(order);
    let v = take(
      dim,
      fold<T>(dim, inSteps<T>(active, pick, (x) => order.includes(x)), order[0]!, o.narrow, (a, b) => a === b, (x) => x, o.looser),
    );
    if (isSA) {
      const own = pick(principalLayer!.limits);
      if (own === undefined) {
        v = order[0]!;
        explanations[dim].decidedBy = [ref(principalLayer!)];
        explanations[dim].note = "service account has no scope for this; it does not inherit a human's";
      }
    }
    setValue(dim, v);
    return v;
  };
  const provisioning = ladderDim("provisioning", PROVISIONING_LEVELS, (l) => l.provisioning);
  const workspace = ladderDim("workspace", WORKSPACE_LEVELS, (l) => l.workspace);

  // governance actions: every declaring layer must allow the principal
  const actions = emptyActions();
  for (const action of AUTHORITY_ACTIONS) {
    const dim = `actions.${action}` as DimensionName;
    const rules: ActionRule[] = [];
    const ign: IgnoredLoosening[] = [];
    const orgDeclared = active.some((l) => l.kind === "org" && l.limits.actions?.[action] !== undefined);
    for (const l of active) {
      const g = l.limits.actions?.[action];
      if (g === undefined) continue;
      const grant = normalizeGrant(g);
      if (orgDeclared) {
        // Anything a lower layer names that the layers above would not admit is dead weight; report it.
        if (l.kind !== "org") {
          const upper = rules.filter((r) => RANK[r.layer.split(":")[0] as LayerKind] < RANK[l.kind]);
          // A user named here but not above may still be admitted by a role above; the AND at request time decides.
          for (const u of grant.users) {
            if (upper.some((r) => !r.grant.users.includes(u))) ign.push({ layer: ref(l), dimension: dim, asked: `user ${u}`, kept: "needs admission by the layers above" });
          }
          for (const role of grant.roles) {
            if (upper.some((r) => !r.grant.roles.includes(role))) ign.push({ layer: ref(l), dimension: dim, asked: `role ${role}`, kept: "not granted above" });
          }
        }
        rules.push({ layer: ref(l), grant });
      }
    }
    actions[action] = orgDeclared ? rules : [];
    ignored.push(...ign);
    explanations[dim] = {
      dimension: dim,
      value: orgDeclared ? rules.map((r) => `${r.layer}{roles:${r.grant.roles.join("|") || "-"} users:${r.grant.users.join("|") || "-"}}`).join(" AND ") : "denied",
      decidedBy: orgDeclared ? rules.map((r) => r.layer) : ["default"],
      ignored: ign,
      ...(orgDeclared ? {} : { note: "organisation declares no grant for this action: denied" }),
    };
    // Same-level disagreement on an action.
    const sameKind = rules.filter((r) => r.layer.split(":")[0] === "project" || r.layer.split(":")[0] === "org");
    for (const kind of ["org", "project"]) {
      const group = sameKind.filter((r) => r.layer.startsWith(`${kind}:`));
      if (group.length > 1 && group.some((r) => JSON.stringify(r.grant) !== JSON.stringify(group[0]!.grant))) {
        conflicts.push({ dimension: dim, layers: group.map((r) => r.layer), kept: "all must allow" });
      }
    }
  }

  return {
    denyAll: null,
    principal,
    models: models === "*" ? [] : models,
    modelsAny: models === "*",
    tools: tools === "*" ? [] : tools,
    toolsAny: tools === "*",
    network: net,
    egressAllow: egress === "*" ? [] : egress,
    egressAny: egress === "*",
    retentionDays: retention,
    dailyBudgetUSD: daily,
    weeklyBudgetUSD: weekly,
    authority,
    provisioning,
    workspace,
    actions,
    explanations,
    dropped,
    conflicts,
    ignored,
  };
}

// ── enforcement ───────────────────────────────────────────────────────────

export type PolicyRequest =
  | { kind: "model"; model: string }
  | { kind: "tool"; tool: string }
  | { kind: "network"; tier: NetworkTier }
  | { kind: "egress"; destination: string }
  | { kind: "spend"; scope: "daily" | "weekly"; spentUSD: number; costUSD: number }
  | { kind: "retention"; days: number }
  | { kind: "authority"; level: Authority }
  | { kind: "provisioning"; level: ProvisioningLevel }
  | { kind: "workspace"; level: WorkspaceLevel }
  | { kind: "action"; action: AuthorityAction; principal: { user: string; role: string } };

export interface Refusal {
  dimension: DimensionName | "policy";
  /** The layer whose rule refused (or "default" for a fail-closed default). */
  layer: LayerRef;
  /** All layers that jointly set the limit. */
  layers: LayerRef[];
  rule: string;
  message: string;
}

function refuse(policy: EffectivePolicy, dimension: DimensionName, rule: string, layerOverride?: LayerRef): Refusal {
  const layers = policy.explanations[dimension].decidedBy;
  const layer = layerOverride ?? layers[layers.length - 1] ?? "default";
  return { dimension, layer, layers, rule, message: `refused by ${layer}: ${rule}` };
}

/** Does `principal` satisfy one rule? Service accounts match by explicit id only, never by role. */
function grantAllows(grant: Grant, principal: { user: string; role: string }, serviceAccount: boolean): boolean {
  if (grant.users.includes(principal.user)) return true;
  if (serviceAccount) return false;
  return grant.roles.includes(normalizeRole(principal.role));
}

/**
 * Which layer and rule refused `request`, or null when policy allows it. The
 * layer named is the one that narrowed the limit last (the one a person would
 * edit to change the outcome); `layers` lists every layer that took part.
 */
export function explainRefusal(policy: EffectivePolicy, request: PolicyRequest): Refusal | null {
  if (policy.denyAll !== null) {
    const layer = policy.denyAll.layer ?? "default";
    return { dimension: "policy", layer, layers: [layer], rule: policy.denyAll.reason, message: `refused by ${layer}: ${policy.denyAll.reason}` };
  }
  switch (request.kind) {
    case "model":
      return policy.modelsAny || policy.models.includes(request.model) ? null : refuse(policy, "models", `model ${request.model} is not in the allowed set ${listText(policy.models)}`);
    case "tool":
      return policy.toolsAny || policy.tools.includes(request.tool) ? null : refuse(policy, "tools", `tool ${request.tool} is not in the allowed set ${listText(policy.tools)}`);
    case "network":
      return NETWORK_TIERS.indexOf(request.tier) <= NETWORK_TIERS.indexOf(policy.network)
        ? null
        : refuse(policy, "network", `tier ${request.tier} exceeds the most restrictive tier ${policy.network}`);
    case "egress": {
      if (policy.network === "none") return refuse(policy, "network", "network tier is none");
      if (policy.network === "open") return null;
      const dest = request.destination.trim().toLowerCase();
      if (policy.egressAny || policy.egressAllow.some((u) => egressCovered(dest, u))) return null;
      return refuse(policy, "egressAllow", `destination ${dest} is not in the allowed set ${listText(policy.egressAllow)}`);
    }
    case "spend": {
      const cap = request.scope === "daily" ? policy.dailyBudgetUSD : policy.weeklyBudgetUSD;
      const dim = request.scope === "daily" ? "dailyBudgetUSD" : "weeklyBudgetUSD";
      if (cap === "unlimited") return null;
      if (!Number.isFinite(request.spentUSD) || !Number.isFinite(request.costUSD)) return refuse(policy, dim, "spend figures are not numbers; refused");
      return request.spentUSD + request.costUSD <= cap
        ? null
        : refuse(policy, dim, `${request.scope} spend ${request.spentUSD + request.costUSD} would exceed the cap ${cap}`);
    }
    case "retention":
      return policy.retentionDays === null || request.days <= policy.retentionDays
        ? null
        : refuse(policy, "retentionDays", `keeping data ${request.days} days exceeds the retention limit ${policy.retentionDays}`);
    case "authority":
      return policy.authority !== "none" && AUTHORITIES.indexOf(request.level) <= AUTHORITIES.indexOf(policy.authority)
        ? null
        : refuse(policy, "authority", `authority ${request.level} exceeds the effective authority ${policy.authority}`);
    case "provisioning":
      return PROVISIONING_LEVELS.indexOf(request.level) <= PROVISIONING_LEVELS.indexOf(policy.provisioning)
        ? null
        : refuse(policy, "provisioning", `provisioning ${request.level} exceeds ${policy.provisioning}`);
    case "workspace":
      return WORKSPACE_LEVELS.indexOf(request.level) <= WORKSPACE_LEVELS.indexOf(policy.workspace)
        ? null
        : refuse(policy, "workspace", `workspace ${request.level} exceeds ${policy.workspace}`);
    case "action": {
      const dim = `actions.${request.action}` as DimensionName;
      const rules = policy.actions[request.action];
      if (rules.length === 0) return refuse(policy, dim, "no organisation grant for this action", "default");
      const sa = policy.principal?.kind === "service_account";
      // A principal must also be the principal the layers were resolved for.
      if (policy.principal === null || policy.principal.id !== request.principal.user) {
        return refuse(policy, dim, "request principal is not the principal this policy was resolved for", "default");
      }
      const failing = rules.find((r) => !grantAllows(r.grant, request.principal, sa));
      return failing === undefined ? null : { ...refuse(policy, dim, `${request.principal.user} (${request.principal.role}) is not in the grant of ${failing.layer}`, failing.layer) };
    }
  }
}

/** Convenience: policy permits the request. */
export function permits(policy: EffectivePolicy, request: PolicyRequest): boolean {
  return explainRefusal(policy, request) === null;
}
