/**
 * S22 — the mission graph: explicit goals, dependencies, acceptance and
 * bounded child work, as PURE data and pure functions. Nothing here reads a
 * store, launches a run or calls a model; it is the contract a general
 * coordinator must satisfy, written and tested before the coordinator.
 *
 * HOW THIS SUBSUMES coordination.ts. coordination.ts is deliberately a fixed
 * shape: one API child, one client child, the client held until the API
 * child's merge, a compatibility verdict, a hold on failure. In graph terms
 * that is two nodes (`api`, `client`), `client.dependsOn = ["api"]`, the
 * client's `inputRevisions.api` = the API's merged SHA (the "anchor"), a
 * third node or acceptance clause for the compatibility check, and "failed
 * API child holds the client" = the `blocked` propagation below. It stays
 * untouched; a later slice can express `createCoordination` as a two-node
 * mission and keep its launchNext idempotency, which this module does not
 * replace (it never enqueues anything).
 *
 * Rules (each pinned in mission.test.ts):
 *  1. A mission is bounded: node count, delegation depth and per-parent
 *     fan-out have limits, checked before anything runs.
 *  2. Dependencies form a DAG. A cycle, a dangling dependency, a self
 *     dependency, a duplicate id, or a node unreachable from the mission root
 *     is refused with a named issue — never silently repaired.
 *  3. A child can never hold more authority than its parent, and the children
 *     of a parent can never be budgeted for more than the parent holds. A
 *     grant is an exact string; there are no wildcards, so "subset" is a set
 *     comparison, not a pattern argument.
 *  4. Two nodes that may run at the same time may not hold the same write
 *     grant. Ordering them (dependsOn) resolves it; the validator does not
 *     pick a winner.
 *  5. A dependency is satisfied only by an ACCEPTED deliverable at the exact
 *     revision the dependant states it was planned against. A moved revision
 *     is stale, not satisfied and not missing; a missing stated revision is
 *     unsatisfied (fail closed).
 *  6. A failed, cancelled or rejected child blocks everything downstream of
 *     it. Completed and accepted work is never touched by a sibling's
 *     failure, and a retry reuses the same node (same id), so it can neither
 *     duplicate a finished sibling nor lose its deliverable.
 *  7. The mission is accepted on its AGGREGATE requirements: each must be
 *     covered by an accepted, non-stale deliverable of the right type. The
 *     number of finished children is never consulted. A waiver (actor and
 *     reason, both non-blank) records a decision to proceed without a
 *     requirement; it is reported as waived and never as accepted.
 *
 * Not here (listed in the hand-off): persistence, launching, replanning
 * (adding nodes mid-run), external inputs that are not another node's
 * deliverable, and the integration-evidence gate on the final result.
 */

export interface Authority {
  /** Exact grant strings, e.g. "read:repo-a", "write:repo-a", "network". */
  grants: readonly string[];
}

/** Both dimensions are additive across siblings, which is why they were chosen. */
export interface Budget {
  costCents: number;
  steps: number;
}

export type NodeState =
  | "pending"
  | "blocked"
  | "running"
  | "completed" // produced a deliverable; not yet accepted
  | "accepted"
  | "rejected" // deliverable refused by its acceptance check
  | "failed"
  | "cancelled";

export interface Deliverable {
  /** Typed so a requirement can ask for "patch" and not be met by a "report". */
  type: string;
  /** The exact revision produced (a commit id, an artefact digest). */
  revision: string;
}

export interface NodeAcceptance {
  /** What the validator (separate evidence access) must establish. */
  contract: string;
  /** Mission requirement ids this node's accepted deliverable is claimed to cover. */
  covers: readonly string[];
}

export interface MissionNode {
  id: string;
  goal: string;
  /** Delegating node; undefined = a direct child of the mission. */
  parent?: string;
  /** The type of deliverable this node must produce. */
  deliverableType: string;
  dependsOn: readonly string[];
  /** dependency id -> the revision of that dependency's deliverable this node was planned on. */
  inputRevisions: Readonly<Record<string, string>>;
  authority: Authority;
  budget: Budget;
  acceptance: NodeAcceptance;
  state: NodeState;
  attempts: number;
  deliverable?: Deliverable;
  /** Dependency ids whose failure/cancel/rejection is holding this node. */
  blockedBy?: readonly string[];
  failure?: string;
}

export type NodeSpec = Omit<MissionNode, "state" | "attempts" | "deliverable" | "blockedBy" | "failure"> &
  Partial<Pick<MissionNode, "state" | "attempts">>;

export interface Mission {
  id: string;
  goal: string;
  authority: Authority;
  budget: Budget;
  nodes: readonly MissionNode[];
}

export interface MissionSpec {
  id: string;
  goal: string;
  authority: Authority;
  budget: Budget;
  nodes: readonly NodeSpec[];
}

export interface MissionLimits {
  maxNodes: number;
  /** Delegation depth; a direct child of the mission is depth 1. */
  maxDepth: number;
  /** Children (delegated or direct) per parent. */
  maxFanOut: number;
  /** Attempts per node, first run included. */
  maxAttempts: number;
}

export const DEFAULT_MISSION_LIMITS: MissionLimits = { maxNodes: 12, maxDepth: 3, maxFanOut: 6, maxAttempts: 3 };

export type MissionIssueCode =
  | "duplicate-id"
  | "empty-id"
  | "dangling-parent"
  | "dangling-dependency"
  | "self-dependency"
  | "cycle"
  | "dependency-on-lineage"
  | "unreachable"
  | "too-many-nodes"
  | "too-deep"
  | "too-wide"
  | "authority-escalation"
  | "budget-invalid"
  | "budget-oversubscribed"
  | "missing-input-revision"
  | "write-conflict";

export interface MissionIssue {
  code: MissionIssueCode;
  /** The node the issue is about; undefined for mission-level issues. */
  node?: string;
  detail: string;
}

export interface MissionValidation {
  ok: boolean;
  issues: MissionIssue[];
}

export class MissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionError";
  }
}

const ROOT = "<mission>";

function validBudget(b: Budget): boolean {
  return [b.costCents, b.steps].every((n) => Number.isFinite(n) && n >= 0);
}

/**
 * Check a spec against the structural rules. Collects EVERY issue rather than
 * stopping at the first, so one planning pass can fix a whole proposal.
 */
export function validateMission(spec: MissionSpec | Mission, limits: MissionLimits = DEFAULT_MISSION_LIMITS): MissionValidation {
  const issues: MissionIssue[] = [];
  const add = (code: MissionIssueCode, detail: string, node?: string) => issues.push({ code, node, detail });
  const nodes = spec.nodes;

  if (nodes.length > limits.maxNodes) add("too-many-nodes", `${nodes.length} nodes exceeds the limit of ${limits.maxNodes}`);
  if (!validBudget(spec.budget)) add("budget-invalid", "mission budget must be finite and non-negative");

  const byId = new Map<string, NodeSpec>();
  for (const n of nodes) {
    if (typeof n.id !== "string" || n.id.trim() === "") {
      add("empty-id", "a node has an empty id");
      continue;
    }
    if (byId.has(n.id)) {
      add("duplicate-id", `id "${n.id}" is used more than once`, n.id);
      continue;
    }
    byId.set(n.id, n);
  }

  for (const n of byId.values()) {
    if (n.parent !== undefined && !byId.has(n.parent)) add("dangling-parent", `parent "${n.parent}" does not exist`, n.id);
    for (const d of n.dependsOn) {
      if (d === n.id) add("self-dependency", "a node cannot depend on itself", n.id);
      else if (!byId.has(d)) add("dangling-dependency", `dependency "${d}" does not exist`, n.id);
      else if (n.inputRevisions[d] === undefined || n.inputRevisions[d] === "") {
        add("missing-input-revision", `no input revision stated for dependency "${d}"`, n.id);
      }
    }
    if (!validBudget(n.budget)) add("budget-invalid", "node budget must be finite and non-negative", n.id);
  }

  // Delegation tree: depth, reachability, fan-out. A parent cycle never reaches
  // the mission root, which is how it is caught as "unreachable".
  const depth = new Map<string, number>();
  const depthOf = (id: string): number | undefined => {
    if (depth.has(id)) return depth.get(id);
    const seen = new Set<string>();
    let cur: string | undefined = id;
    let d = 0;
    while (cur !== undefined) {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) return undefined;
      d++;
      cur = node.parent;
    }
    depth.set(id, d);
    return d;
  };
  const children = new Map<string, NodeSpec[]>();
  for (const n of byId.values()) {
    const d = depthOf(n.id);
    if (d === undefined) {
      if (n.parent === undefined || byId.has(n.parent)) add("unreachable", "not reachable from the mission root through its delegation chain", n.id);
    } else if (d > limits.maxDepth) {
      add("too-deep", `delegation depth ${d} exceeds the limit of ${limits.maxDepth}`, n.id);
    }
    const key = n.parent ?? ROOT;
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  for (const [parent, kids] of children) {
    if (kids.length > limits.maxFanOut) {
      add("too-wide", `${kids.length} children exceeds the fan-out limit of ${limits.maxFanOut}`, parent === ROOT ? undefined : parent);
    }
  }

  // Authority and budget never grow downward.
  for (const [parent, kids] of children) {
    const pAuth = parent === ROOT ? spec.authority : byId.get(parent)?.authority;
    const pBudget = parent === ROOT ? spec.budget : byId.get(parent)?.budget;
    if (!pAuth || !pBudget) continue;
    const held = new Set(pAuth.grants);
    for (const k of kids) {
      const extra = k.authority.grants.filter((g) => !held.has(g));
      if (extra.length > 0) add("authority-escalation", `holds ${extra.map((g) => `"${g}"`).join(", ")} which its parent does not`, k.id);
    }
    if (kids.every((k) => validBudget(k.budget))) {
      const cost = kids.reduce((s, k) => s + k.budget.costCents, 0);
      const steps = kids.reduce((s, k) => s + k.budget.steps, 0);
      if (cost > pBudget.costCents || steps > pBudget.steps) {
        add(
          "budget-oversubscribed",
          `children budget ${cost}c/${steps} steps exceeds the parent's ${pBudget.costCents}c/${pBudget.steps} steps`,
          parent === ROOT ? undefined : parent,
        );
      }
    }
  }

  // Dependency graph: cycles (iterative colouring, one issue per back edge).
  const colour = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (start: string) => {
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
    colour.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const deps = (byId.get(top.id)?.dependsOn ?? []).filter((d) => byId.has(d) && d !== top.id);
      if (top.i >= deps.length) {
        colour.set(top.id, 2);
        stack.pop();
        continue;
      }
      const next = deps[top.i++];
      const c = colour.get(next);
      if (c === 1) {
        const path = stack.map((s) => s.id);
        const cyc = [...path.slice(path.indexOf(next)), next];
        const key = [...cyc.slice(0, -1)].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          add("cycle", `dependency cycle ${cyc.join(" -> ")}`, next);
        }
      } else if (c === undefined) {
        colour.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  };
  for (const id of byId.keys()) if (!colour.has(id)) visit(id);

  // A node waiting on its own ancestor or descendant would deadlock a delegator.
  const lineage = (id: string): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    for (let cur = byId.get(id)?.parent; cur !== undefined && !seen.has(cur); cur = byId.get(cur)?.parent) {
      seen.add(cur);
      out.add(cur);
    }
    return out;
  };
  const ancestors = new Map<string, Set<string>>();
  for (const id of byId.keys()) ancestors.set(id, lineage(id));
  for (const n of byId.values()) {
    for (const d of n.dependsOn) {
      if (!byId.has(d) || d === n.id) continue;
      if (ancestors.get(n.id)?.has(d) || ancestors.get(d)?.has(n.id)) {
        add("dependency-on-lineage", `depends on "${d}", its own ancestor or descendant`, n.id);
      }
    }
  }

  // Parallel writers: two nodes with no ordering between them, same write grant.
  // Transitive reachability over dependsOn (cycle-safe via a visited set).
  const reach = new Map<string, Set<string>>();
  const reachOf = (id: string): Set<string> => {
    const cached = reach.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length > 0) {
      const d = stack.pop() as string;
      if (out.has(d) || !byId.has(d)) continue;
      out.add(d);
      stack.push(...(byId.get(d)?.dependsOn ?? []));
    }
    reach.set(id, out);
    return out;
  };
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) continue; // delegation, not competition
      if (reachOf(a.id).has(b.id) || reachOf(b.id).has(a.id)) continue; // ordered
      const bw = new Set(b.authority.grants.filter((g) => g.startsWith("write:")));
      const shared = a.authority.grants.filter((g) => g.startsWith("write:") && bw.has(g));
      if (shared.length > 0) {
        add("write-conflict", `"${a.id}" and "${b.id}" may run together and both hold ${shared.map((g) => `"${g}"`).join(", ")}`, a.id);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Validate and build the initial mission. Throws MissionError listing every issue. */
export function createMission(spec: MissionSpec, limits: MissionLimits = DEFAULT_MISSION_LIMITS): Mission {
  const v = validateMission(spec, limits);
  if (!v.ok) throw new MissionError(`invalid mission: ${v.issues.map((i) => `${i.code}${i.node ? `(${i.node})` : ""}`).join(", ")}`);
  const nodes: MissionNode[] = spec.nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    inputRevisions: { ...n.inputRevisions },
    authority: { grants: [...n.authority.grants] },
    budget: { ...n.budget },
    acceptance: { contract: n.acceptance.contract, covers: [...n.acceptance.covers] },
    state: n.state ?? "pending",
    attempts: n.attempts ?? 0,
  }));
  return settle({ id: spec.id, goal: spec.goal, authority: { grants: [...spec.authority.grants] }, budget: { ...spec.budget }, nodes });
}

const HOLDING: ReadonlySet<NodeState> = new Set<NodeState>(["failed", "cancelled", "rejected", "blocked"]);

/**
 * Recompute `blocked` from scratch. Only not-yet-started nodes move between
 * pending and blocked; running, completed and accepted work is never rewritten
 * by what happens upstream or beside it. Computed to a fixed point because a
 * block propagates down a chain, and cleared the same way when a retry
 * returns the upstream node to pending.
 */
function settle(mission: Mission): Mission {
  let nodes = [...mission.nodes];
  for (;;) {
    const state = new Map(nodes.map((n) => [n.id, n.state] as const));
    let changed = false;
    nodes = nodes.map((n) => {
      if (n.state !== "pending" && n.state !== "blocked") return n;
      const by = n.dependsOn.filter((d) => HOLDING.has(state.get(d) as NodeState));
      const next: NodeState = by.length > 0 ? "blocked" : "pending";
      const same = next === n.state && (next === "pending" ? n.blockedBy === undefined : sameList(n.blockedBy, by));
      if (same) return n;
      changed = true;
      const { blockedBy: _drop, ...rest } = n;
      return next === "blocked" ? { ...rest, state: next, blockedBy: by } : { ...rest, state: next };
    });
    if (!changed) return { ...mission, nodes };
  }
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

/** Why a node can or cannot start. Reasons are for the operator; `ready` is the gate. */
export function nodeReadiness(mission: Mission, nodeId: string): Readiness {
  const node = mission.nodes.find((n) => n.id === nodeId);
  if (!node) return { ready: false, reasons: [`no node "${nodeId}"`] };
  if (node.state !== "pending") return { ready: false, reasons: [`state is ${node.state}`] };
  const reasons: string[] = [];
  for (const d of node.dependsOn) {
    const dep = mission.nodes.find((n) => n.id === d);
    const stated = node.inputRevisions[d];
    if (!dep) reasons.push(`dependency "${d}" does not exist`);
    else if (dep.state !== "accepted" || !dep.deliverable) reasons.push(`dependency "${d}" is ${dep.state}, not accepted`);
    else if (stated === undefined || stated === "") reasons.push(`no input revision stated for "${d}"`);
    else if (dep.deliverable.revision !== stated) {
      reasons.push(`dependency "${d}" is at revision ${dep.deliverable.revision}, planned on ${stated} (stale)`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

/** Nodes that may start now: pending, every dependency accepted at the stated revision. */
export function readyNodes(mission: Mission): MissionNode[] {
  return mission.nodes.filter((n) => nodeReadiness(mission, n.id).ready);
}

export type Outcome =
  | { kind: "started" }
  | { kind: "completed"; deliverable: Deliverable }
  | { kind: "accepted" }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; reason?: string }
  | { kind: "retry" };

const ALLOWED: Record<Outcome["kind"], readonly NodeState[]> = {
  started: ["pending"],
  completed: ["running"],
  accepted: ["completed"],
  rejected: ["completed"],
  failed: ["running", "pending", "blocked"],
  cancelled: ["pending", "blocked", "running"],
  retry: ["failed", "cancelled", "rejected"],
};

/**
 * Record one node's outcome, returning a NEW mission (the input is never
 * modified). Illegal transitions throw rather than being absorbed: a worker
 * reporting "completed" for a node that never started is a bug to surface.
 * `started` additionally requires readiness, so a stale or unaccepted input
 * cannot be run past by reporting it.
 */
export function applyOutcome(
  mission: Mission,
  nodeId: string,
  outcome: Outcome,
  limits: MissionLimits = DEFAULT_MISSION_LIMITS,
): Mission {
  const node = mission.nodes.find((n) => n.id === nodeId);
  if (!node) throw new MissionError(`no node "${nodeId}"`);
  if (!ALLOWED[outcome.kind].includes(node.state)) {
    throw new MissionError(`cannot apply "${outcome.kind}" to node "${nodeId}" in state ${node.state}`);
  }
  let next: MissionNode;
  switch (outcome.kind) {
    case "started": {
      const r = nodeReadiness(mission, nodeId);
      if (!r.ready) throw new MissionError(`node "${nodeId}" is not ready: ${r.reasons.join("; ")}`);
      next = { ...node, state: "running", attempts: node.attempts + 1 };
      break;
    }
    case "completed": {
      if (outcome.deliverable.type !== node.deliverableType) {
        throw new MissionError(`node "${nodeId}" must deliver "${node.deliverableType}", got "${outcome.deliverable.type}"`);
      }
      if (outcome.deliverable.revision === "") throw new MissionError(`node "${nodeId}" deliverable has no revision`);
      next = { ...node, state: "completed", deliverable: { ...outcome.deliverable } };
      break;
    }
    case "accepted":
      next = { ...node, state: "accepted" };
      break;
    case "rejected":
      next = { ...node, state: "rejected", failure: outcome.reason };
      break;
    case "failed":
      next = { ...node, state: "failed", failure: outcome.reason };
      break;
    case "cancelled":
      next = { ...node, state: "cancelled", failure: outcome.reason };
      break;
    case "retry": {
      if (node.attempts >= limits.maxAttempts) {
        throw new MissionError(`node "${nodeId}" has used its ${limits.maxAttempts} attempts; escalate instead of retrying`);
      }
      // Same node, same id: a retry cannot add a sibling or touch one. The old
      // (rejected) deliverable is dropped so nothing downstream can be
      // satisfied by it while the new attempt is open.
      const { deliverable: _d, failure: _f, ...rest } = node;
      next = { ...rest, state: "pending" };
      break;
    }
  }
  return settle({ ...mission, nodes: mission.nodes.map((n) => (n.id === nodeId ? next : n)) });
}

export interface Requirement {
  id: string;
  /** If set, only a deliverable of this type can cover it. */
  deliverableType?: string;
}

export interface Waiver {
  requirementId: string;
  actor: string;
  reason: string;
}

export type AggregateVerdict = "accepted" | "waived" | "not-accepted";

export interface AggregateResult {
  /** True only when every requirement is covered AND no node is unresolved. Waivers never set it. */
  accepted: boolean;
  /** "waived" = would be complete but for explicitly waived requirements; a distinct, weaker state. */
  verdict: AggregateVerdict;
  covered: Array<{ requirement: string; by: string[] }>;
  waived: Array<{ requirement: string; actor: string; reason: string }>;
  unmet: string[];
  /** Waivers refused (unknown requirement, blank actor or reason). */
  invalidWaivers: string[];
  /** Nodes that are not accepted: failed/blocked/cancelled/rejected/pending/running/completed. */
  openNodes: Array<{ id: string; state: NodeState }>;
  /** Accepted nodes whose inputs have since moved, so they cover nothing. */
  staleNodes: string[];
}

/** An accepted node planned on a dependency revision that has since changed or been withdrawn. */
function isStale(mission: Mission, node: MissionNode): boolean {
  return node.dependsOn.some((d) => {
    const dep = mission.nodes.find((n) => n.id === d);
    return !dep || !dep.deliverable || dep.deliverable.revision !== node.inputRevisions[d];
  });
}

/**
 * Parent acceptance. Coverage comes from accepted, non-stale deliverables
 * that claim the requirement and (when the requirement names a type) have it.
 * The count of finished children does not appear anywhere in this function,
 * on purpose: five accepted children covering four of five requirements is
 * "not-accepted".
 */
export function aggregateAcceptance(mission: Mission, requirements: readonly Requirement[], waivers: readonly Waiver[] = []): AggregateResult {
  const staleNodes = mission.nodes.filter((n) => n.state === "accepted" && isStale(mission, n)).map((n) => n.id);
  const stale = new Set(staleNodes);
  const covered: AggregateResult["covered"] = [];
  const uncovered: string[] = [];
  for (const r of requirements) {
    const by = mission.nodes
      .filter(
        (n) =>
          n.state === "accepted" &&
          !stale.has(n.id) &&
          n.deliverable !== undefined &&
          n.acceptance.covers.includes(r.id) &&
          (r.deliverableType === undefined || n.deliverable.type === r.deliverableType),
      )
      .map((n) => n.id);
    if (by.length > 0) covered.push({ requirement: r.id, by });
    else uncovered.push(r.id);
  }

  const known = new Set(requirements.map((r) => r.id));
  const waived: AggregateResult["waived"] = [];
  const invalidWaivers: string[] = [];
  for (const w of waivers) {
    const ok = known.has(w.requirementId) && w.actor.trim() !== "" && w.reason.trim() !== "";
    if (!ok) invalidWaivers.push(w.requirementId);
    else if (uncovered.includes(w.requirementId) && !waived.some((x) => x.requirement === w.requirementId)) {
      waived.push({ requirement: w.requirementId, actor: w.actor.trim(), reason: w.reason.trim() });
    }
  }
  const waivedIds = new Set(waived.map((w) => w.requirement));
  const unmet = uncovered.filter((id) => !waivedIds.has(id));
  const openNodes = mission.nodes.filter((n) => n.state !== "accepted").map((n) => ({ id: n.id, state: n.state }));

  const settled = unmet.length === 0 && openNodes.length === 0 && staleNodes.length === 0;
  const accepted = settled && waived.length === 0;
  return {
    accepted,
    verdict: accepted ? "accepted" : settled ? "waived" : "not-accepted",
    covered,
    waived,
    unmet,
    invalidWaivers,
    openNodes,
    staleNodes,
  };
}
