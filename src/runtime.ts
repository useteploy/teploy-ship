import {
  LeaseManager,
  NucleusEventStore,
  RunIndex,
  WIRE_FORMAT_VERSION,
  executeRun,
  executeRunExclusive,
} from "@neutron-build/workflow";
import type { EventStore, RunOutcome, WorkflowDefinition } from "@neutron-build/workflow";

import { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
import type { IntakeStore } from "./intake.js";
import { FileSpendStore, NucleusSpendStore } from "./spend.js";
import type { SpendStore } from "./spend.js";
import { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
import type { PolicyStore } from "./policies.js";
import { FileFleetStore, NucleusFleetStore, FilePlacementStore, NucleusPlacementStore } from "./fleet.js";
import type { FleetStore, PlacementStore } from "./fleet.js";
import { FileRepoMemory, NucleusRepoMemory } from "./repo-memory.js";
import type { RepoMemoryStore } from "./repo-memory.js";
import { FileSteerStore, NucleusSteerStore } from "./steer.js";
import type { SteerStore } from "./steer.js";
import { NucleusPgwire } from "./nucleus-pgwire.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import type { RunMeta } from "./run-store.js";

export type { RunMeta } from "./run-store.js";
export type { IntakeStore, IntakeTask, ProposeInput } from "./intake.js";
export { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
export type { SpendStore, SpendEntry } from "./spend.js";
export { FileSpendStore, NucleusSpendStore, utcDay } from "./spend.js";
export type { PolicyStore, SourcePolicy } from "./policies.js";
export { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
export type { FleetStore, WorkerInfo, PlacementStore } from "./fleet.js";
export { FileFleetStore, NucleusFleetStore, FilePlacementStore, NucleusPlacementStore } from "./fleet.js";
export type { RepoMemoryStore, RepoNote } from "./repo-memory.js";
export { FileRepoMemory, NucleusRepoMemory, loadRepoContext, runNote } from "./repo-memory.js";
export type { SteerStore, SteerNote } from "./steer.js";
export { FileSteerStore, NucleusSteerStore } from "./steer.js";
export type { CodeSearch, CodeSearchHit, RefreshStats } from "./code-index.js";
export { NucleusCodeIndex } from "./code-index.js";
export { parseRepoToken, slackTaskFromMention, linearTaskFromIssue, ciFixTaskFromWorkflowRun } from "./intake-sources.js";
export type { Notifier, RunNotification } from "./notify.js";
export { formatRunNotification, notifiable, slackNotifier } from "./notify.js";
export { PLAN_EVENT } from "./plan.js";
export type { PlanDecisionPayload } from "./plan.js";
export type { ModelPricing, UsageLike } from "./pricing.js";
export { costUSD, pricingFor } from "./pricing.js";

/**
 * Where durable runs live. The file runtime keeps everything on this
 * machine (~/.local/state/teploy-ship); the nucleus runtime keeps event
 * logs, run metadata, and executor leases in a shared Nucleus, so any
 * machine — including a resident `teploy-ship worker` — can list,
 * continue, or complete a run.
 */
export interface ShipRuntime {
  kind: "file" | "nucleus";
  store: EventStore;
  /**
   * One execution pass. Returns null when another executor holds the
   * run's lease (nucleus only) — the run continues there, not here.
   */
  execute(
    workflow: WorkflowDefinition<{ task: string }, unknown>,
    runId: string,
    input?: { task: string; repo?: string; pr?: number; plan?: boolean; steer?: boolean; index?: boolean; guard?: boolean },
  ): Promise<RunOutcome | null>;
  saveMeta(meta: RunMeta): Promise<void>;
  loadMeta(runId: string): Promise<RunMeta | null>;
  listMeta(): Promise<RunMeta[]>;
  /** Flag a parked run due so a resident worker picks it up (nucleus only). */
  markWake?(runId: string): Promise<void>;
  /** The intake queue: proposed tasks awaiting launch. */
  intake: IntakeStore;
  /** Per-source, per-UTC-day spend ledger backing the worker's budget cap. */
  spend: SpendStore;
  /** Editable per-source intake policies (dashboard-managed, env-seeded). */
  policies: PolicyStore;
  /** Live registry of workers in the fleet (heartbeat + capacity/load). */
  fleet: FleetStore;
  /** Which worker host executed each run (fleet placement). */
  placement: PlacementStore;
  /** Per-repo playbook memory (notes Ship records about its own runs). */
  memory: RepoMemoryStore;
  /** Mid-run steering notes the dashboard sends into running runs. */
  steer: SteerStore;
  close(): Promise<void>;
}

export function fileRuntime(): ShipRuntime {
  const store = new FileEventStore();
  const meta = new RunMetaStore();
  return {
    kind: "file",
    store,
    intake: new FileIntakeStore(),
    spend: new FileSpendStore(),
    policies: new FilePolicyStore(),
    fleet: new FileFleetStore(),
    placement: new FilePlacementStore(),
    memory: new FileRepoMemory(),
    steer: new FileSteerStore(),
    execute: (workflow, runId, input) =>
      executeRun({ workflow, runId, store, ...(input !== undefined ? { input } : {}) }),
    saveMeta: (m) => meta.save(m),
    loadMeta: (runId) => meta.load(runId),
    listMeta: () => meta.list(),
    close: async () => {},
  };
}

const META_COLLECTION = "ship_meta";

/** The nucleus runtime plus the raw pieces the worker's scheduler needs. */
export interface NucleusShipRuntime extends ShipRuntime {
  index: RunIndex;
  leases: LeaseManager;
  owner: string;
  /** The raw pgwire adapter — the code index builds on it directly. */
  db: NucleusPgwire;
}

export async function nucleusRuntime(url: string, owner: string): Promise<NucleusShipRuntime> {
  const db = new NucleusPgwire(url);
  const store = new NucleusEventStore(db.streams, { prefix: "ship" });
  const index = new RunIndex(db.document, { collection: "ship_runs" });
  const leases = new LeaseManager(db.kv, { prefix: "ship:lease", ttlSeconds: 60 });

  const saveMeta = async (m: RunMeta): Promise<void> => {
    const doc = { ...m } as Record<string, unknown>;
    const updated = await db.document.update(META_COLLECTION, { runId: m.runId }, doc);
    if (updated === 0) await db.document.insert(META_COLLECTION, doc);
  };
  // The index is status-authoritative: the worker records outcomes there
  // (not in ship_meta), so reads overlay index status onto the meta doc.
  const toMeta = (doc: Record<string, unknown>, rec?: Record<string, unknown>): RunMeta => {
    const m = doc as unknown as RunMeta;
    if (rec === undefined || typeof rec.status !== "string") return m;
    const overlaid: RunMeta = { ...m, status: rec.status };
    if (rec.status === "waiting" && typeof rec.eventName === "string") {
      overlaid.eventName = rec.eventName;
    } else {
      delete overlaid.eventName;
    }
    if (typeof rec.updatedAt === "string" && rec.updatedAt > m.updatedAt) {
      overlaid.updatedAt = rec.updatedAt;
    }
    return overlaid;
  };

  return {
    kind: "nucleus",
    store,
    index,
    leases,
    owner,
    db,
    intake: new NucleusIntakeStore(db),
    spend: new NucleusSpendStore(db),
    policies: new NucleusPolicyStore(db),
    fleet: new NucleusFleetStore(db),
    placement: new NucleusPlacementStore(db),
    memory: new NucleusRepoMemory(db),
    steer: new NucleusSteerStore(db),
    async execute(workflow, runId, input) {
      const outcome = await executeRunExclusive({
        workflow,
        runId,
        store,
        leases,
        owner,
        ...(input !== undefined ? { input } : {}),
      });
      if (outcome !== null) await index.record(runId, workflow.name, outcome);
      return outcome;
    },
    saveMeta,
    async loadMeta(runId) {
      const docs = await db.document.find(META_COLLECTION, { runId });
      if (docs.length === 0) return null;
      const records = await db.document.find("ship_runs", { runId });
      return toMeta(docs[0]!, records[0]);
    },
    async listMeta() {
      const docs = await db.document.find(META_COLLECTION, {});
      const records = await db.document.find("ship_runs", {});
      const byRun = new Map(records.map((r) => [r.runId as string, r]));
      return docs
        .map((doc) => toMeta(doc, byRun.get((doc as { runId?: string }).runId ?? "")))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    markWake: (runId) => index.markWake(runId),
    close: () => db.close(),
  };
}

/**
 * Enqueue a run without executing it: append the run-started event
 * (exactly the shape executeRun writes on an empty log) and flag the run
 * due. A resident worker picks it up on its next tick; with the file
 * runtime there is no worker, so the caller resumes it explicitly. This
 * is how surfaces that must never run the agent in-process (the web UI)
 * commission work.
 */
export async function enqueueRun(
  runtime: ShipRuntime,
  options: { runId: string; task: string; model: string; repo?: string; pr?: number; plan?: boolean; workflowName?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await runtime.store.append(options.runId, {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: now,
    data: {
      workflow: options.workflowName ?? "coding-agent",
      input: {
        task: options.task,
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
        ...(options.pr !== undefined ? { pr: options.pr } : {}),
        ...(options.plan === true ? { plan: true } : {}),
        // Every newly-enqueued run is steerable and index-eligible; runs
        // enqueued before these flags existed replay without the extra
        // steps (input-gated in durable). The executing worker's config
        // decides whether indexing actually happens.
        steer: true,
        index: true,
        guard: true,
      },
    },
  });
  await runtime.saveMeta({
    runId: options.runId,
    task: options.task,
    model: options.model,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });
  // markWake only updates an existing index record; a freshly enqueued
  // run has none, so the scheduler would never see it. record() is the
  // insert-or-update path — "wake" makes the run due immediately.
  if (runtime.kind === "nucleus") {
    const nucleus = runtime as NucleusShipRuntime;
    await nucleus.index.record(
      options.runId,
      options.workflowName ?? "coding-agent",
      { status: "wake" } as unknown as RunOutcome,
    );
  }
}
