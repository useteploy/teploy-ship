import type { ShipRuntime } from "./runtime.js";
import type { WorkerInfo } from "./fleet.js";

/**
 * Ship watching itself: queue depth, worker liveness, and stuck-run detection.
 *
 * Ship's pitch is unattended operation, and unattended means the operator is
 * NOT looking. A run that wedged (a hung model call, a dead executor, a
 * worker that crashed mid-run) is invisible until someone goes looking for it
 * — which is the difference between a tool you babysit and one you use.
 *
 * Detection reads the EVENT LOG, not the status column: a status is a claim
 * about the run, the last recorded event is a fact. A run whose last event is
 * old while it is neither terminal nor parked is either executing very slowly
 * or not executing at all, and both deserve a line someone can grep for.
 *
 * Emission goes to Observe's log ingest (POST /api/v1/logs, the same API key
 * the LLM emitter uses) so the numbers land in the same place as everything
 * else you run. Local logging stays quiet unless something is WRONG — a
 * heartbeat line every minute is noise that trains an operator to stop
 * reading the log.
 *
 * Detection REPORTS; it never kills. A run that looks stuck may be a long
 * model call with extended thinking (measured: 9+ minutes for one turn on the
 * 2026-08-20 parity sweep), and terminating a live run is an irreversible call
 * an operator should make with the evidence in front of them.
 */

/** A worker is stale when its last heartbeat is older than this. */
export const WORKER_STALE_S = 45;

export interface StuckRun {
  runId: string;
  status: string;
  /** Seconds since the run's last recorded event. */
  lastEventAgeS: number;
  /** True once any step completed after run-started. */
  progressed: boolean;
}

export interface HealthSnapshot {
  at: string;
  owner: string;
  /** Runs recorded as executing on this worker right now. */
  activeRuns: number;
  /** Runs that are neither terminal nor parked, minus those executing fleet-wide (clamped at 0). */
  queueDepth: number;
  /** Runs parked awaiting a human decision. */
  parked: number;
  workers: Array<WorkerInfo & { lastSeenAgeS: number; stale: boolean }>;
  /** Runs with no progress event for longer than the threshold. */
  stuck: StuckRun[];
  /** Runs enqueued but never picked up for longer than the threshold. */
  neverStarted: StuckRun[];
}

/** Default: no event for 30 minutes makes a run worth reporting. */
export const DEFAULT_STUCK_MINUTES = 30;

export interface HealthDeps {
  /** Only the reads the health pass uses, so tests stay structural. */
  runtime: { listMeta: ShipRuntime["listMeta"]; store: { load: (runId: string) => Promise<Array<{ type: string; at: string }>> } };
  fleet: { list: ShipRuntime["fleet"]["list"] };
  /** The calling worker's owner id and live execution count. */
  owner: string;
  activeRuns: number;
  stuckMinutes?: number;
  now?: () => Date;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * One health pass. Bounded to the recent-run window (the same bound every
 * dashboard read uses) — a stuck run from three weeks ago is someone else's
 * archaeology, and scanning all history on every pass is how a health check
 * becomes the thing that makes the system unhealthy.
 */
export async function computeHealth(deps: HealthDeps): Promise<HealthSnapshot> {
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  const thresholdMs = (deps.stuckMinutes ?? DEFAULT_STUCK_MINUTES) * 60_000;

  const [metas, workers] = await Promise.all([deps.runtime.listMeta({ limit: 200 }), deps.fleet.list()]);
  const live = workers.map((w) => {
    const age = (nowMs - new Date(w.lastSeen).getTime()) / 1000;
    return { ...w, lastSeenAgeS: Number.isFinite(age) ? Math.max(0, Math.round(age)) : 0, stale: !Number.isFinite(age) || age > WORKER_STALE_S };
  });

  const stuck: StuckRun[] = [];
  const neverStarted: StuckRun[] = [];
  let parked = 0;
  let open = 0;
  for (const meta of metas) {
    if (TERMINAL.has(meta.status)) continue;
    if (meta.status === "waiting") {
      parked += 1;
      continue;
    }
    open += 1;
    let lastEventAt = meta.updatedAt;
    let progressed = false;
    try {
      const events = await deps.runtime.store.load(meta.runId);
      if (events.length > 0) {
        lastEventAt = events[events.length - 1]!.at;
        progressed = events.some((e) => e.type === "step-completed");
      }
    } catch {
      // An unreadable log is a store problem, not evidence about the run; the
      // updatedAt fallback above keeps this pass honest either way.
    }
    const ageS = Math.max(0, Math.round((nowMs - new Date(lastEventAt).getTime()) / 1000));
    if (ageS * 1000 < thresholdMs) continue;
    const entry: StuckRun = { runId: meta.runId, status: meta.status, lastEventAgeS: ageS, progressed };
    if (progressed) stuck.push(entry);
    else neverStarted.push(entry);
  }

  const fleetActive = live.reduce((sum, w) => sum + (w.activeRuns ?? 0), 0);
  return {
    at: now().toISOString(),
    owner: deps.owner,
    activeRuns: deps.activeRuns,
    queueDepth: Math.max(0, open - fleetActive),
    parked,
    workers: live,
    stuck,
    neverStarted,
  };
}

/** Which parts of a snapshot deserve a human's attention. */
export function healthWarnings(snapshot: HealthSnapshot): string[] {
  const lines: string[] = [];
  for (const s of snapshot.stuck) {
    lines.push(`run ${s.runId} looks stuck: no event for ${Math.round(s.lastEventAgeS / 60)}m (status ${s.status})`);
  }
  for (const s of snapshot.neverStarted) {
    lines.push(`run ${s.runId} was enqueued ${Math.round(s.lastEventAgeS / 60)}m ago and never started`);
  }
  for (const w of snapshot.workers) {
    if (w.stale) lines.push(`worker ${w.owner}@${w.host} last heartbeat ${w.lastSeenAgeS}s ago (stale)`);
  }
  return lines;
}

export interface ObserveLogEmitter {
  enabled: boolean;
  emitLog(entry: { level: string; message: string; attributes?: Record<string, unknown> }): void;
}

const NOOP: ObserveLogEmitter = { enabled: false, emitLog: () => {} };

/**
 * The log ingest counterpart of makeObserveEmitter (observe.ts): same env
 * pair (OBSERVE_URL + OBSERVE_API_KEY), fire-and-forget, never throws into
 * the caller. Service name is fixed so Ship's self-observations are
 * filterable in Observe's log search.
 */
export function makeObserveLogEmitter(log: (line: string) => void = () => {}): ObserveLogEmitter {
  const base = (process.env.OBSERVE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.OBSERVE_API_KEY ?? "";
  if (base === "" || key === "") return NOOP;
  const site = process.env.OBSERVE_SITE ?? "";
  return {
    enabled: true,
    emitLog(entry) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key };
      if (site !== "") headers["x-observe-site"] = site;
      void fetch(`${base}/api/v1/logs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          level: entry.level,
          message: entry.message,
          service_name: "teploy-ship",
          ...(entry.attributes !== undefined ? { attributes: entry.attributes } : {}),
        }),
      }).catch((err) => log(`[selfwatch] emit failed: ${err instanceof Error ? err.message : String(err)}`));
    },
  };
}

/**
 * One observation pass: compute, report anomalies locally, always emit the
 * snapshot to Observe when wired. Returns the warnings so callers (and tests)
 * can assert on them.
 */
export async function selfwatchOnce(
  deps: HealthDeps & { emitter?: ObserveLogEmitter; log?: (line: string) => void },
): Promise<HealthSnapshot> {
  const log = deps.log ?? (() => {});
  const snapshot = await computeHealth(deps);
  for (const line of healthWarnings(snapshot)) log(`[selfwatch] ${line}`);
  if (deps.emitter?.enabled) {
    deps.emitter.emitLog({
      level: snapshot.stuck.length > 0 || snapshot.neverStarted.length > 0 ? "warn" : "info",
      message:
        `ship health: ${snapshot.activeRuns} active, ${snapshot.queueDepth} queued, ${snapshot.parked} parked, ` +
        `${snapshot.stuck.length} stuck, ${snapshot.neverStarted.length} never started, ` +
        `${snapshot.workers.filter((w) => w.stale).length}/${snapshot.workers.length} workers stale`,
      attributes: {
        owner: snapshot.owner,
        activeRuns: snapshot.activeRuns,
        queueDepth: snapshot.queueDepth,
        parked: snapshot.parked,
        stuck: snapshot.stuck.map((s) => s.runId),
        neverStarted: snapshot.neverStarted.map((s) => s.runId),
        staleWorkers: snapshot.workers.filter((w) => w.stale).map((w) => w.owner),
      },
    });
    for (const s of snapshot.stuck) {
      deps.emitter.emitLog({
        level: "warn",
        message: `run ${s.runId} looks stuck: no event for ${Math.round(s.lastEventAgeS / 60)}m (status ${s.status})`,
        attributes: { runId: s.runId, status: s.status, lastEventAgeS: s.lastEventAgeS },
      });
    }
  }
  return snapshot;
}
