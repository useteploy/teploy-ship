/**
 * S22 wiring (wave 4) — a READ-ONLY, derived "Mission view" of an existing
 * coordination record, built with mission.ts. SHADOW ONLY: this module launches
 * nothing, stores nothing and is never consulted by coordination.ts; the
 * coordination's own states, launchNext idempotency and completion rule are
 * untouched. The view answers "what would the general mission contract say
 * about this pair?" so that contract can be compared with the fixed
 * coordinator before anything is ever migrated onto it.
 *
 * THE PROJECTION (mission.ts header, "HOW THIS SUBSUMES coordination.ts"):
 *   nodes            `api` and `client`, client.dependsOn = ["api"]
 *   inputRevisions   client.inputRevisions.api = the API merge's sha, as the
 *                    coordination recorded it (api.anchorSha) — what the client
 *                    task was told to build against. The record stores only
 *                    one anchor; a client that has merged has had its own
 *                    anchorSha overwritten, so the planned-on revision for a
 *                    launched client is client.anchorSha only while it is
 *                    running/failed, and api.anchorSha otherwise. `plannedOn`
 *                    in the facts overrides it when a caller has a better
 *                    source.
 *   Deliverable      type "patch"; revision = the DELIVERY RECORD's merge sha
 *                    (an independent reading), else the child's own recorded
 *                    merge sha. A delivery sha that differs from the anchor the
 *                    client was planned on is a STALE input, as in rule 5.
 *   Outcome accepted ONLY from the task record's `acceptance === "accepted"`
 *                    (task-record.ts: a recorded change decision on the latest
 *                    attempt). A merged child with no recorded acceptance is
 *                    `completed`, not `accepted`: "finished" never counts.
 *   failed-API hold  api failed => client `blocked` (mission.ts settle()).
 *   waivers          a recorded accept-risk over an incompatible/uncertain
 *                    compatibility verdict is a WAIVER of the `compatibility`
 *                    requirement (actor = who accepted), reported as waived,
 *                    never as accepted.
 *   aggregate gate   requirements api-change, client-change, compatibility,
 *                    plus integration-evidence's status (via integrationGate,
 *                    so SHIP_INTEGRATION_CHECK and the declaration decide
 *                    whether it applies, exactly as coordinationComplete does).
 *
 * Flag: SHIP_MISSION_VIEW=on. Default off; the page renders nothing extra and
 * this module is not called.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";
import { integrationGate } from "./coordination.js";
import type { CoordinationChild, CoordinationRecord } from "./coordination.js";
import type { IntegrationStatus } from "./integration-evidence.js";
import {
  aggregateAcceptance,
  createMission,
  nodeReadiness,
  readyNodes,
} from "./mission.js";
import type { AggregateResult, Mission, MissionNode, MissionSpec, NodeSpec, NodeState, Requirement, Waiver } from "./mission.js";
import { taskRecord } from "./task-record.js";
import type { AcceptanceState } from "./task-record.js";
import type { ShipRuntime } from "./runtime.js";

export function missionViewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SHIP_MISSION_VIEW ?? "").trim().toLowerCase() === "on";
}

/** What the task record and delivery record say about one child's latest run. */
export interface ChildFacts {
  /** task-record.ts acceptance of the child's latest attempt. */
  acceptance: AcceptanceState;
  /** The delivery record's merged sha, when a record exists and carries one. */
  deliverySha?: string;
}

export interface CoordinationFacts {
  api: ChildFacts;
  client: ChildFacts;
  /** Overrides the planned-on API revision when the caller can state it. */
  plannedOn?: string;
}

export const NO_FACTS: CoordinationFacts = { api: { acceptance: "not-recorded" }, client: { acceptance: "not-recorded" } };

const REQUIREMENTS: readonly Requirement[] = [
  { id: "api-change", deliverableType: "patch" },
  { id: "client-change", deliverableType: "patch" },
  { id: "compatibility" },
];

const ZERO = { costCents: 0, steps: 0 };

interface Built {
  mission: Mission;
  waivers: Waiver[];
  notes: string[];
}

/** The child's own merge sha as the coordination recorded it. */
function nonEmpty(sha: string | undefined): string | undefined {
  return sha === undefined || sha === "" ? undefined : sha;
}

/** mergedSha when recorded, else the starter's anchorSha (the same fallback coordination.ts uses for the client). */
function ownSha(child: CoordinationChild): string | undefined {
  return nonEmpty(child.mergedSha ?? child.anchorSha);
}

function nodeStateOf(child: CoordinationChild, facts: ChildFacts, revision: string | undefined): NodeState {
  switch (child.state) {
    case "pending":
    case "held":
      return "pending";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "merged":
    case "delivered":
      // Merged without a provable sha has no deliverable to accept; it stays
      // `running` (unfinished as far as the contract can tell) and is noted.
      if (revision === undefined) return "running";
      if (facts.acceptance === "accepted") return "accepted";
      if (facts.acceptance === "rejected") return "rejected";
      return "completed";
  }
}

export function missionSpecFromCoordination(
  record: CoordinationRecord,
  facts: CoordinationFacts = NO_FACTS,
): { spec: MissionSpec; waivers: Waiver[]; notes: string[]; deliverables: Map<string, { revision: string }> } {
  const notes: string[] = [];
  const deliverables = new Map<string, { revision: string }>();
  const merged = (c: CoordinationChild) => c.state === "merged" || c.state === "delivered";

  const apiRevision = merged(record.api) ? (facts.api.deliverySha ?? ownSha(record.api)) : undefined;
  const clientRevision = merged(record.client) ? (facts.client.deliverySha ?? ownSha(record.client)) : undefined;
  if (merged(record.api) && apiRevision === undefined) notes.push("The API child merged without a recorded commit sha; its deliverable is unproven.");
  if (merged(record.client) && clientRevision === undefined) notes.push("The client child merged without a recorded commit sha; its deliverable is unproven.");
  if (apiRevision !== undefined) deliverables.set("api", { revision: apiRevision });
  if (clientRevision !== undefined) deliverables.set("client", { revision: clientRevision });

  // The revision the client was planned on (see the header).
  const launchedAnchor = record.client.state === "running" || record.client.state === "failed" ? record.client.anchorSha : undefined;
  const plannedOn = nonEmpty(facts.plannedOn) ?? nonEmpty(launchedAnchor) ?? nonEmpty(record.api.anchorSha) ?? apiRevision ?? "<not planned yet>";

  const clientCompatible = record.client.clientCheck === "compatible";
  const nodes: NodeSpec[] = [
    {
      id: "api",
      goal: `API change in ${record.api.repo}`,
      deliverableType: "patch",
      dependsOn: [],
      inputRevisions: {},
      authority: { grants: ["write:api"] },
      budget: ZERO,
      acceptance: { contract: "task record: recorded change decision accepted", covers: ["api-change"] },
      state: nodeStateOf(record.api, facts.api, apiRevision),
      attempts: record.api.attempts,
    },
    {
      id: "client",
      goal: `Client change in ${record.client.repo}`,
      deliverableType: "patch",
      dependsOn: ["api"],
      inputRevisions: { api: plannedOn },
      authority: { grants: ["write:client"] },
      budget: ZERO,
      acceptance: {
        contract: "task record: recorded change decision accepted; compatibility check compatible",
        covers: ["client-change", ...(clientCompatible ? ["compatibility"] : [])],
      },
      state: nodeStateOf(record.client, facts.client, clientRevision),
      attempts: record.client.attempts,
    },
  ];

  const waivers: Waiver[] = [];
  const check = record.client.clientCheck;
  if ((check === "incompatible" || check === "uncertain") && record.client.checkAccepted !== undefined) {
    waivers.push({
      requirementId: "compatibility",
      actor: record.client.checkAccepted.by,
      reason: `accepted the risk of an ${check} compatibility check`,
    });
  }
  if (record.client.state === "held" && record.client.holdReason !== undefined) notes.push(`Client held: ${record.client.holdReason}`);

  return {
    spec: {
      id: record.id,
      goal: record.parentIntent,
      authority: { grants: ["write:api", "write:client"] },
      budget: ZERO,
      nodes,
    },
    waivers,
    notes,
    deliverables,
  };
}

/** Build the Mission: createMission settles blocked; deliverables/failures are attached afterwards (they never affect settle). */
function build(record: CoordinationRecord, facts: CoordinationFacts): Built {
  const { spec, waivers, notes, deliverables } = missionSpecFromCoordination(record, facts);
  const created = createMission(spec);
  const nodes: MissionNode[] = created.nodes.map((n) => {
    const d = deliverables.get(n.id);
    const child = n.id === "api" ? record.api : record.client;
    const withDeliverable = d !== undefined && n.state !== "pending" && n.state !== "running" && n.state !== "failed" ? { ...n, deliverable: { type: "patch", revision: d.revision } } : n;
    return n.state === "failed" ? { ...withDeliverable, failure: child.failReason ?? "failed" } : withDeliverable;
  });
  return { mission: { ...created, nodes }, waivers, notes };
}

export interface MissionNodeView {
  id: string;
  repo: string;
  state: NodeState;
  revision?: string;
  plannedOn?: string;
  blockedBy: string[];
  /** nodeReadiness reasons while pending; empty otherwise. */
  reasons: string[];
}

export interface MissionView {
  missionId: string;
  nodes: MissionNodeView[];
  ready: string[];
  blocked: Array<{ id: string; by: string[] }>;
  /** Nodes whose planned-on API revision no longer equals the API deliverable's. */
  stale: string[];
  aggregate: AggregateResult;
  integration: IntegrationStatus | null;
  /** The combined answer: aggregate acceptance AND the integration gate. */
  verdict: "accepted" | "waived" | "not-accepted";
  notes: string[];
}

export function coordinationMissionView(
  record: CoordinationRecord,
  facts: CoordinationFacts = NO_FACTS,
  options: { env?: NodeJS.ProcessEnv; waivers?: readonly Waiver[] } = {},
): MissionView {
  const { mission, waivers, notes } = build(record, facts);
  const aggregate = aggregateAcceptance(mission, REQUIREMENTS, [...waivers, ...(options.waivers ?? [])]);
  const integration = integrationGate(record, options.env !== undefined ? { env: options.env } : {});
  const stale = mission.nodes
    .filter((n) => n.dependsOn.some((d) => {
      const dep = mission.nodes.find((x) => x.id === d);
      return dep?.deliverable !== undefined && dep.deliverable.revision !== n.inputRevisions[d];
    }))
    .map((n) => n.id);
  const verdict = aggregate.verdict === "not-accepted" || integration?.blocking === true ? "not-accepted" : aggregate.verdict;
  return {
    missionId: mission.id,
    nodes: mission.nodes.map((n) => ({
      id: n.id,
      repo: n.id === "api" ? record.api.repo : record.client.repo,
      state: n.state,
      ...(n.deliverable !== undefined ? { revision: n.deliverable.revision } : {}),
      ...(n.dependsOn.length > 0 ? { plannedOn: n.inputRevisions[n.dependsOn[0]!] } : {}),
      blockedBy: [...(n.blockedBy ?? [])],
      reasons: n.state === "pending" ? nodeReadiness(mission, n.id).reasons : [],
    })),
    ready: readyNodes(mission).map((n) => n.id),
    blocked: mission.nodes.filter((n) => n.state === "blocked").map((n) => ({ id: n.id, by: [...(n.blockedBy ?? [])] })),
    stale,
    aggregate,
    integration,
    verdict,
    notes,
  };
}

/**
 * Read the two facts the projection needs from the stores, READ-ONLY: the
 * child's own latest run as a one-attempt task record (acceptance) and its
 * delivery record (merge sha). A child with no run, or an unreadable one, gets
 * "not-recorded" — unknown is never read as accepted.
 */
export async function coordinationFacts(runtime: ShipRuntime, record: CoordinationRecord): Promise<CoordinationFacts> {
  const read = async (child: CoordinationChild): Promise<ChildFacts> => {
    if (child.runId === undefined) return { acceptance: "not-recorded" };
    try {
      const events = (await runtime.store.load(child.runId)) as WorkflowEvent[];
      const tr = taskRecord(child.runId, [{ meta: { runId: child.runId, task: "", status: "", model: "", createdAt: "", updatedAt: "" }, events }]);
      const delivery = await runtime.deliveryRecords?.get(child.runId).catch(() => null);
      return {
        acceptance: tr.acceptance,
        ...(delivery?.mergedSha !== undefined && delivery.mergedSha !== "" ? { deliverySha: delivery.mergedSha } : {}),
      };
    } catch {
      return { acceptance: "not-recorded" };
    }
  };
  const [api, client] = await Promise.all([read(record.api), read(record.client)]);
  return { api, client };
}

/** The page loader's one call. Never throws: a failure costs the panel only. */
export async function missionViewFor(
  runtime: ShipRuntime,
  record: CoordinationRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ view: MissionView } | { error: string }> {
  try {
    return { view: coordinationMissionView(record, await coordinationFacts(runtime, record), { env }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "the mission view could not be built" };
  }
}
