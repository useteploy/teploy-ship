import { Scheduler } from "@neutron-build/workflow";
import type { WorkflowDefinition, WorkflowEvent } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider, RunUsage } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { enqueueRun } from "./runtime.js";
import type { NucleusShipRuntime } from "./runtime.js";
import type { IntakeStore, IntakePolicy, IntakeTask } from "./intake.js";
import type { SourcePolicy } from "./policies.js";
import { makeObserveEmitter } from "./observe.js";
import type { SpendStore } from "./spend.js";
import { utcDay } from "./spend.js";
import { costUSD } from "./pricing.js";

export type { IntakePolicy } from "./intake.js";

export interface WorkerOptions {
  runtime: NucleusShipRuntime;
  model: ModelAdapter;
  /** Model id recorded on runs the intake sweep launches (also prices their spend). */
  modelId?: string;
  executor: ExecutorProvider;
  /** The agent's working directory inside its executor. */
  workdir: string;
  /** Poll interval for due runs (default 5s). */
  intervalMs?: number;
  /** Deploy token for repo runs (clone/push/PR). */
  gitToken?: string;
  /** Per-source intake policies; unlisted sources default to "propose". */
  intakePolicies?: Record<string, IntakePolicy>;
  /** Auto-launches allowed per source per day (default 10, process-local). */
  dailyAutoLimit?: number;
  /**
   * Ceiling on simultaneously-executing auto-launched runs (default 3, or
   * SHIP_MAX_CONCURRENT_RUNS). A run that would exceed it is deferred —
   * its task stays proposed and a later sweep picks it up. Parked runs
   * still hold a slot (conservative).
   */
  maxConcurrentRuns?: number;
  /**
   * Per-source daily spend cap in USD (default 10, or SHIP_DAILY_BUDGET_USD;
   * <= 0 disables). Enforced ALONGSIDE the count cap: a source whose
   * accumulated spend today already meets its budget is refused.
   */
  dailyBudgetUSD?: number;
  /** Per-source budget overrides (USD/day) taking precedence over dailyBudgetUSD. */
  intakeBudgets?: Record<string, number>;
  log?: (line: string) => void;
}

/** Extract terminal status + summed usage from a run's event log. */
function readOutcome(events: WorkflowEvent[]): { terminal: boolean; usage?: RunUsage } {
  const terminal = events.find(
    (e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled",
  );
  if (terminal === undefined) return { terminal: false };
  if (terminal.type === "run-completed") {
    const usage = (terminal.data as { output?: { usage?: RunUsage } } | undefined)?.output?.usage;
    if (usage !== undefined) return { terminal: true, usage };
  }
  return { terminal: true };
}

export interface IntakeSweepDeps {
  intake: Pick<IntakeStore, "list" | "setState">;
  spend: SpendStore;
  policies: Record<string, IntakePolicy>;
  dailyAutoLimit: number;
  maxConcurrentRuns: number;
  /** Per-source daily budget in USD; <= 0 disables the cap for that source. */
  budgetFor: (source: string) => number;
  /** Model id used to price a completed run's usage. */
  modelId: string;
  /** Process-local per-source launch counters (bucketed by UTC day). */
  launchedToday: Map<string, { day: string; count: number }>;
  /** Runs this worker launched that may still be executing: runId -> source. */
  inFlight: Map<string, string>;
  /** Terminal-check + usage for a launched run (from its event log). */
  outcomeOf: (runId: string) => Promise<{ terminal: boolean; usage?: RunUsage }>;
  /** Enqueue a proposed task as a run; returns the new runId. */
  launch: (task: IntakeTask) => Promise<string>;
  now: () => Date;
  log: (line: string) => void;
}

/**
 * One intake sweep, factored out of the resident worker so both caps are
 * unit-testable. It (1) settles spend for in-flight runs that finished and
 * frees their concurrency slot, then (2) auto-launches proposed tasks for
 * "auto" sources bounded by three independent limits: the count cap, the
 * global concurrency ceiling, and the per-source daily spend budget. A
 * task blocked by any cap stays proposed for a later sweep.
 */
export async function sweepIntake(deps: IntakeSweepDeps): Promise<void> {
  const today = utcDay(deps.now());

  // 1) Reconcile: record spend for finished runs and release their slots.
  for (const [runId, source] of [...deps.inFlight]) {
    const outcome = await deps.outcomeOf(runId);
    if (!outcome.terminal) continue;
    const cost = costUSD(deps.modelId, outcome.usage);
    if (cost > 0) {
      await deps.spend.add(source, today, cost);
      deps.log(`[worker] intake: ${runId} (${source}) cost $${cost.toFixed(4)} recorded to ${today}`);
    }
    deps.inFlight.delete(runId);
  }

  // 2) Launch, if any source is configured "auto".
  if (!Object.values(deps.policies).some((p) => p === "auto")) return;

  for (const task of await deps.intake.list("proposed")) {
    if (deps.policies[task.source] !== "auto") continue;

    if (deps.inFlight.size >= deps.maxConcurrentRuns) {
      deps.log(
        `[worker] intake: at concurrency ceiling (${deps.maxConcurrentRuns} in flight); ${task.taskId} stays proposed`,
      );
      break; // no slots left for any source this sweep
    }

    const counter = deps.launchedToday.get(task.source);
    const count = counter?.day === today ? counter.count : 0;
    if (count >= deps.dailyAutoLimit) {
      deps.log(`[worker] intake: ${task.source} hit the daily auto cap (${deps.dailyAutoLimit}); ${task.taskId} stays proposed`);
      continue;
    }

    const budget = deps.budgetFor(task.source);
    if (budget > 0) {
      const spent = await deps.spend.get(task.source, today);
      if (spent >= budget) {
        deps.log(
          `[worker] intake: ${task.source} hit the daily budget cap ($${budget.toFixed(2)}; spent $${spent.toFixed(2)}); ${task.taskId} stays proposed`,
        );
        continue;
      }
    }

    const runId = await deps.launch(task);
    await deps.intake.setState(task.taskId, "launched", runId);
    deps.inFlight.set(runId, task.source);
    deps.launchedToday.set(task.source, { day: today, count: count + 1 });
    deps.log(`[worker] intake: auto-launched ${task.taskId} (${task.source}) as ${runId}`);
  }
}

/**
 * The resident worker: registers the coding-agent workflow and lets the
 * Workflow SDK's scheduler execute due runs under leases. Safe to run
 * alongside CLI invocations and other workers — a run someone else holds
 * is simply skipped; crash recovery is the event log's job. This is what
 * makes `approve` from a laptop a true handoff: the laptop delivers the
 * decision and flags the run due; the worker carries it to completion.
 */
export function startWorker(options: WorkerOptions): { scheduler: Scheduler; stop: () => void } {
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const wf = durableAgent({
    model: options.model,
    executor: options.executor,
    approveAction: defaultApprovalPolicy,
    workdir: options.workdir,
    ...(options.gitToken !== undefined ? { gitToken: options.gitToken } : {}),
    repoMemory: options.runtime.memory,
  });
  const host = hostname();
  // Opt-in: emit each completed run to Observe (no-op unless configured).
  const observe = makeObserveEmitter(log);
  // Runs actively executing on THIS worker — reported as fleet load. A Set keyed
  // by runId (not a counter) so it self-corrects: onRunStart fires only after we
  // win the lease, and onComplete OR onError removes it — a run that throws
  // (nondeterminism/store error) still gets cleaned up, and an error before the
  // lease is won (which never added) is a harmless no-op delete.
  const inflight = new Set<string>();
  const scheduler = new Scheduler({
    workflows: [wf as unknown as WorkflowDefinition<never, unknown>],
    store: options.runtime.store,
    leases: options.runtime.leases,
    index: options.runtime.index,
    owner: options.runtime.owner,
    intervalMs: options.intervalMs ?? 5000,
    onError: (runId, error) => {
      inflight.delete(runId);
      log(`[worker] run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    },
    onTickError: (error) =>
      log(`[worker] tick failed (store unreachable?): ${error instanceof Error ? error.message : String(error)}`),
    onRunStart: (runId) => {
      inflight.add(runId);
      log(`[worker] picked up ${runId}`);
      // Record where this run is executing so the dashboard can show placement.
      void options.runtime.placement.set(runId, host).catch(() => {});
    },
    onComplete: (runId, outcome) => {
      inflight.delete(runId);
      log(`[worker] ${runId} → ${outcome.status}`);
      // Dogfood the run into Observe (no-op unless configured).
      if (observe.enabled) {
        void Promise.all([options.runtime.loadMeta(runId), options.runtime.store.load(runId)])
          .then(([meta, events]) => {
            const usage = readOutcome(events).usage;
            const started = events.find((e) => e.type === "run-started");
            const input = (started as { data?: { input?: { repo?: string; pr?: number } } } | undefined)?.data?.input;
            observe.emitRun({
              runId,
              model: meta?.model ?? "",
              status: outcome.status,
              ...(usage !== undefined ? { usage } : {}),
              ...(input?.repo !== undefined ? { repo: input.repo } : {}),
              ...(input?.pr !== undefined ? { pr: input.pr } : {}),
            });
          })
          .catch(() => {});
      }
      // The index is status-authoritative, but persist the terminal status
      // onto the raw meta doc too so it's self-consistent (accurate for
      // direct reads / file mode, not just the index-overlaid reads).
      void options.runtime.placement.set(runId, host).catch(() => {});
      void options.runtime
        .loadMeta(runId)
        .then((meta) => {
          if (meta !== null && meta.status !== outcome.status) {
            return options.runtime.saveMeta({ ...meta, status: outcome.status, updatedAt: new Date().toISOString() });
          }
        })
        .catch((error) => log(`[worker] ${runId}: meta update failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  });
  scheduler.start();

  const envInt = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const modelId = options.modelId ?? "worker-default";
  const maxConcurrentRuns = options.maxConcurrentRuns ?? envInt("SHIP_MAX_CONCURRENT_RUNS") ?? 3;
  const defaultBudget = options.dailyBudgetUSD ?? envInt("SHIP_DAILY_BUDGET_USD") ?? 10;
  const budgets = options.intakeBudgets ?? {};
  const envPolicies = options.intakePolicies ?? {};

  // The policy store is dashboard-authoritative; seed it from the env defaults
  // once (first run) so an operator who never opens the UI keeps the same
  // behavior, then let store edits win on every subsequent sweep.
  void options.runtime.policies
    .seed(envPolicies)
    .catch((err) => log(`[worker] policy seed failed: ${err instanceof Error ? err.message : String(err)}`));

  // Intake sweep state, process-local across ticks.
  const launchedToday = new Map<string, { day: string; count: number }>();
  const inFlight = new Map<string, string>();

  const sweep = async (): Promise<void> => {
    // Re-read the live policies each tick so dashboard edits take effect
    // without a worker restart. Store wins over the env seed; a per-source
    // budget in the store overrides the global default.
    let stored: SourcePolicy[] = [];
    try {
      stored = await options.runtime.policies.list();
    } catch (err) {
      log(`[worker] policy read failed, using env defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
    const policies: Record<string, IntakePolicy> = { ...envPolicies };
    const storeBudgets: Record<string, number> = {};
    for (const p of stored) {
      policies[p.source] = p.policy;
      if (p.dailyBudgetUSD !== undefined) storeBudgets[p.source] = p.dailyBudgetUSD;
    }
    return sweepIntake({
      intake: options.runtime.intake,
      spend: options.runtime.spend,
      policies,
      dailyAutoLimit: options.dailyAutoLimit ?? 10,
      maxConcurrentRuns,
      budgetFor: (source) => storeBudgets[source] ?? budgets[source] ?? defaultBudget,
      modelId,
      launchedToday,
      inFlight,
      outcomeOf: async (runId) => readOutcome(await options.runtime.store.load(runId)),
      launch: async (task) => {
        const runId = `run-${randomUUID().slice(0, 8)}`;
        await enqueueRun(options.runtime, {
          runId,
          task: task.detail !== undefined ? `${task.title}\n\n${task.detail}` : task.title,
          model: modelId,
          ...(task.repo !== undefined ? { repo: task.repo } : {}),
          ...(task.pr !== undefined ? { pr: task.pr } : {}),
        });
        return runId;
      },
      now: () => new Date(),
      log,
    });
  };

  // Reentrancy guard: a sweep can outlast intervalMs when Nucleus is slow, and
  // two overlapping sweeps re-launch the same proposed task (duplicate PRs) and
  // double-count its spend. Skip a tick if the previous sweep is still running.
  let sweeping = false;
  const intakeTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep()
      .catch((error) => log(`[worker] intake sweep: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        sweeping = false;
      });
  }, options.intervalMs ?? 5000);
  intakeTimer.unref?.();

  // Fleet heartbeat: announce this worker's host, sandbox, capacity, and live
  // load so the dashboard can show the fleet. Staleness (a dead process) is
  // inferred from lastSeen, so the interval doubles as the liveness signal.
  const startedAt = new Date().toISOString();
  const sandboxLabel = process.env.SHIP_SANDBOX_URL ?? "host";
  const beat = (): Promise<void> =>
    options.runtime.fleet
      .heartbeat({
        owner: options.runtime.owner,
        host,
        sandbox: sandboxLabel,
        maxConcurrent: maxConcurrentRuns,
        activeRuns: inflight.size,
        startedAt,
        lastSeen: new Date().toISOString(),
      })
      .catch((error) => log(`[worker] fleet heartbeat: ${error instanceof Error ? error.message : String(error)}`));
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), 15000);
  heartbeatTimer.unref?.();

  log(`[worker] watching for due runs as ${options.runtime.owner}`);
  return {
    scheduler,
    stop: () => {
      clearInterval(intakeTimer);
      clearInterval(heartbeatTimer);
      scheduler.stop();
    },
  };
}
