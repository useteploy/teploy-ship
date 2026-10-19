/**
 * Reconciler for leaked sandbox containers — the daemon's live runs that no
 * non-terminal Ship run owns.
 *
 * WHY THIS EXISTS (found live 2026-10-18 on compute-1: 14 teploy-sbx-* up,
 * 44 minutes to 24 hours old). `dispose` sits on the workflow's normal exit
 * paths, and the workflow body settles its workspaces on every throw since
 * the same fix — but two shapes still escape it:
 *
 *  1. A run that went terminal WITHOUT a final pass. cancelRun appends
 *     run-cancelled and executeRun's terminal short-circuit settles the next
 *     pass before the workflow body ever runs — a run parked at approve-merge
 *     or an ask when it was cancelled keeps its parked container forever
 *     (run-request-aafce8ff, cancelled at turn-8-ask, container still up).
 *     The total-budget failure in run.js is the same shape.
 *  2. A worker that died mid-pass (SIGKILL skips every finally).
 *
 * The daemon's TTL reaper is the backstop, but Ship asks for
 * SHIP_SANDBOX_TTL_SEC sized to the longest run allowed (24 h on the
 * reference deployment) — so a leaked container holds a box's memory and PID
 * budget for a day.
 *
 * OWNERSHIP FROM THE LOG, NOT NEW STATE. A sandbox is owned when a
 * NON-TERMINAL run's log records its handle — the `sandbox` step, an
 * `attempt-N-sandbox` step, or a park's `*-restore` step. A parked run is
 * non-terminal, so its container (and the snapshot it restores from, which
 * this sweeper never touches — snapshot-gc owns images) is kept by
 * construction. Terminal runs own nothing: their containers are this
 * sweeper's to destroy.
 *
 * Bounded like everything that walks runs: the newest REAP_RUNS metas per
 * pass. A parked run older than that window is beyond the sweep's reach, and
 * at that age the daemon's own TTL has its container anyway.
 *
 * FAIL CLOSED everywhere: an unreadable meta list, an unreadable non-terminal
 * run's log, or a host whose list call fails keeps every sandbox this pass.
 *
 * DESTRUCTIVE BY FLAG ONLY: SHIP_SANDBOX_REAP=off|log|on, default `log` — the
 * sweep names what it would destroy and destroys nothing until an operator
 * has watched it say so.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

/** Runs examined per pass, newest first. The sweep's whole bound. */
export const REAP_RUNS = 200;

/** SHIP_SANDBOX_REAP: off silences it, log names candidates, on destroys. */
export type SandboxReapMode = "off" | "log" | "on";

/**
 * The default grace a sandbox gets before it can be unowned: the same
 * SHIP_SANDBOX_TTL_SEC grammar resolveSandboxTtlSec reads in cli.ts (its
 * floor, its 2 h default, its "size it for the longest run you allow"
 * guidance) — the TTL is the honest measure of "no live run can still be
 * between create and first record".
 */
export function resolveSandboxReapGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHIP_SANDBOX_TTL_SEC;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const ttlSec = Number.isFinite(n) ? n : 7200;
  return Math.max(600, Math.trunc(ttlSec)) * 1000;
}

export function resolveSandboxReapMode(raw: string | undefined): SandboxReapMode {
  const mode = (raw ?? "").trim().toLowerCase();
  return mode === "off" || mode === "on" ? mode : "log";
}

/** One run as the daemon's list reports it. `handle` is pool-tagged. */
export interface ListedSandbox {
  handle: string;
  /** ISO-8601, when the daemon created the container. */
  createdAt?: string;
  /** A sandbox under an active lease is in use by someone; never this sweeper's. */
  leaseHeld?: boolean;
}

/**
 * The sandbox handles a run's log names: the primary `sandbox` step (its
 * result is a bare string pre-thread-warm, `{handle, boot}` after), every
 * extra attempt's `attempt-N-sandbox`, and every park's `*-restore` — a
 * restored container is the run's live workspace until the next restore or
 * the run's end. Superseded handles appear here too; destroying one that is
 * already gone is the daemon's 404, which the sweeper treats as done.
 */
export function workspaceHandles(events: readonly { type: string; name?: string; data?: unknown }[]): string[] {
  const handles: string[] = [];
  for (const e of events) {
    if (e.type !== "step-completed" || e.name === undefined) continue;
    if (e.name !== "sandbox" && !/^attempt-\d+-sandbox$/.test(e.name) && !/^(?:attempt-\d+-)?(?:plan|merge|turn-\d+(?:-delegate)?)-restore$/.test(e.name)) {
      continue;
    }
    const result = (e.data as { result?: unknown } | undefined)?.result;
    const handle = typeof result === "string" ? result : (result as { handle?: unknown } | undefined)?.handle;
    if (typeof handle === "string" && handle !== "" && !handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

/** What sandboxReaper reads — structural so tests share one shape. */
export interface SandboxReapDeps {
  /** Every sandbox the configured daemons hold, pool-tagged. */
  list(): Promise<ListedSandbox[]>;
  /** Recent runs, newest first; the limit passed is the sweep's bound. */
  listMeta(options?: { limit?: number }): Promise<{ runId: string; status: string }[]>;
  /** A run's event log. */
  loadEvents(runId: string): Promise<readonly WorkflowEvent[]>;
  /** The provider's destroy (the pool routes it by the handle's host tag). */
  destroy(handle: string): Promise<void>;
}

function destroyFoundNothing(message: string): boolean {
  return /status 404|no such|not found|no longer configured/i.test(message);
}

/**
 * The reconciler. Create once (the worker's interval); each `sweep()` is one
 * bounded pass that never throws — a failing store or daemon is logged and
 * retried on the next pass, and in `log` mode it names every candidate it
 * would have destroyed.
 */
export function sandboxReaper(
  deps: SandboxReapDeps,
  options: { mode?: SandboxReapMode; graceMs?: number; limit?: number; now?: () => number; log?: (line: string) => void } = {},
): { sweep: () => Promise<number> } {
  const mode = options.mode ?? "log";
  const graceMs = options.graceMs ?? resolveSandboxReapGraceMs();
  const limit = options.limit ?? REAP_RUNS;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  return {
    async sweep(): Promise<number> {
      if (mode === "off") return 0;
      let sandboxes: ListedSandbox[];
      try {
        sandboxes = await deps.list();
      } catch (error) {
        log(`[sandbox-reap] could not list sandboxes, keeping everything this pass: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      }
      let metas: { runId: string; status: string }[];
      try {
        metas = await deps.listMeta({ limit });
      } catch (error) {
        log(`[sandbox-reap] could not list runs, keeping everything this pass: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      }
      // Ownership: every handle a non-terminal run's log names. A non-terminal
      // run whose log cannot be read keeps EVERYTHING — the reverse would
      // destroy a parked run's container on a store blip.
      const owned = new Set<string>();
      let blind = false;
      for (const meta of metas) {
        if (meta.status === "completed" || meta.status === "failed" || meta.status === "cancelled") continue;
        let events: readonly WorkflowEvent[];
        try {
          events = await deps.loadEvents(meta.runId);
        } catch (error) {
          blind = true;
          log(`[sandbox-reap] ${meta.runId} (${meta.status}) has an unreadable log, keeping everything this pass: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        for (const handle of workspaceHandles(events)) owned.add(handle);
      }
      if (blind) return 0;
      let destroyed = 0;
      for (const sandbox of sandboxes) {
        if (sandbox.leaseHeld === true) continue;
        if (owned.has(sandbox.handle)) continue;
        const created = sandbox.createdAt !== undefined ? Date.parse(sandbox.createdAt) : NaN;
        if (!Number.isFinite(created) || created + graceMs > now()) continue;
        const ageMin = Number.isFinite(created) ? Math.round((now() - created) / 60_000) : "?";
        if (mode === "log") {
          log(`[sandbox-reap] would destroy sandbox ${sandbox.handle} (${ageMin} min old, owned by no non-terminal run); set SHIP_SANDBOX_REAP=on to destroy`);
          continue;
        }
        try {
          await deps.destroy(sandbox.handle);
          destroyed++;
          log(`[sandbox-reap] destroyed sandbox ${sandbox.handle} (${ageMin} min old, owned by no non-terminal run)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (destroyFoundNothing(message)) continue;
          log(`[sandbox-reap] sandbox ${sandbox.handle} could not be destroyed: ${message}`);
        }
      }
      return destroyed;
    },
  };
}
