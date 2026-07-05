import {
  LeaseManager,
  NucleusEventStore,
  RunIndex,
  executeRun,
  executeRunExclusive,
} from "@neutron-build/workflow";
import type { EventStore, RunOutcome, WorkflowDefinition } from "@neutron-build/workflow";

import { NucleusPgwire } from "./nucleus-pgwire.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import type { RunMeta } from "./run-store.js";

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
    input?: { task: string },
  ): Promise<RunOutcome | null>;
  saveMeta(meta: RunMeta): Promise<void>;
  loadMeta(runId: string): Promise<RunMeta | null>;
  listMeta(): Promise<RunMeta[]>;
  /** Flag a parked run due so a resident worker picks it up (nucleus only). */
  markWake?(runId: string): Promise<void>;
  close(): Promise<void>;
}

export function fileRuntime(): ShipRuntime {
  const store = new FileEventStore();
  const meta = new RunMetaStore();
  return {
    kind: "file",
    store,
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
