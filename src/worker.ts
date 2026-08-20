import { Scheduler } from "@neutron-build/workflow";
import type { WorkflowDefinition, WorkflowEvent } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { durableAgent } from "./durable.js";
import { previewTargetFromEnv } from "./deploy.js";
import { telemetryTargetFromEnv } from "./observe.js";
import { testTargetFromEnv } from "./tests.js";
import type { ExecutorProvider, RunUsage } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { enqueueRun } from "./runtime.js";
import type { NucleusShipRuntime } from "./runtime.js";
import type { IntakeStore, IntakePolicy, IntakeTask } from "./intake.js";
import type { SourcePolicy } from "./policies.js";
import { makeObserveEmitter } from "./observe.js";
import { multiNotifier, slackNotifier, webhookNotifier } from "./notify.js";
import type { RunNotification } from "./notify.js";
import { NucleusOutbox, flushOutbox, notificationId } from "./outbox.js";
import type { Outbox } from "./outbox.js";
import type { SpendStore } from "./spend.js";
import { utcDay } from "./spend.js";
import { NucleusAdmission } from "./admission.js";
import type { AdmissionControl } from "./admission.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import type { CodeSearch } from "./code-index.js";
import { costUSD, isPricedModel } from "./pricing.js";

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
  /** Token used instead for github.com repos (SHIP_GITHUB_TOKEN). */
  githubToken?: string;
  /** Repository allowlist + per-origin credentials (defaults to the environment). */
  repoPolicy?: RepoPolicyConfig;
  /** Per-source intake policies; unlisted sources default to "propose". */
  intakePolicies?: Record<string, IntakePolicy>;
  /** Nucleus code index behind repo-index refresh + the ```search action. */
  codeSearch?: CodeSearch;
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
  /** Fleet-wide admission control. Defaults to the Nucleus-backed implementation. */
  admission?: AdmissionControl;
  /** Hard per-run spend ceiling in USD (0 = off, or SHIP_MAX_RUN_COST_USD). */
  maxRunCostUSD?: number;
  /** Durable notification outbox. Defaults to the Nucleus-backed implementation. */
  outbox?: Outbox;
  /**
   * Budget held per in-flight run until its real cost is known (default 0.50,
   * or SHIP_ESTIMATED_RUN_COST_USD). Only affects how conservatively the daily
   * budget admits concurrent launches; settlement always records actual cost.
   */
  estimatedRunCostUSD?: number;
  /**
   * Turn budget for a durable run (default 40, or SHIP_MAX_STEPS). Every
   * webhook-, Inbox- and sweep-launched run shares this ceiling; the daily
   * spend caps are what actually bound cost, so this only needs to be high
   * enough that real work is not cut off mid-task.
   */
  maxSteps?: number;
  log?: (line: string) => void;
}

/**
 * Sum every model call recorded in a run's step log.
 *
 * A completed run reports its own total in the workflow output, but a FAILED or
 * CANCELLED one never gets to return anything — and those runs still made paid
 * model calls. Reading usage out of the recorded steps means cost is recovered
 * from whatever the run got through, which is what a spend cap has to count.
 * Steps that record usage: turn-N-think, turn-N-condense, turn-N-critic,
 * plan-think — all of them shaped { text, usage }.
 */
export function usageFromEvents(events: WorkflowEvent[]): RunUsage | undefined {
  const total: RunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let found = false;
  for (const event of events) {
    if (event.type !== "step-completed") continue;
    const usage = (event.data as { result?: { usage?: RunUsage } } | undefined)?.result?.usage;
    if (usage === undefined || typeof usage !== "object") continue;
    found = true;
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    if (usage.cacheReadTokens !== undefined) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  }
  return found ? total : undefined;
}

/** Extract terminal status + summed usage from a run's event log. */
export function readOutcome(events: WorkflowEvent[]): { terminal: boolean; usage?: RunUsage } {
  const terminal = events.find(
    (e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled",
  );
  if (terminal === undefined) return { terminal: false };
  if (terminal.type === "run-completed") {
    const usage = (terminal.data as { output?: { usage?: RunUsage } } | undefined)?.output?.usage;
    if (usage !== undefined) return { terminal: true, usage };
  }
  // Failed/cancelled (or a completed run from before usage was reported):
  // reconstruct from the steps so the spend is not silently written off.
  const reconstructed = usageFromEvents(events);
  return reconstructed !== undefined ? { terminal: true, usage: reconstructed } : { terminal: true };
}

export interface IntakeSweepDeps {
  intake: Pick<IntakeStore, "list" | "setState" | "claim">;
  spend: SpendStore;
  /** Fleet-wide slots and counters (see admission.ts). */
  admission: AdmissionControl;
  policies: Record<string, IntakePolicy>;
  dailyAutoLimit: number;
  maxConcurrentRuns: number;
  /** Per-source daily budget in USD; <= 0 disables the cap for that source. */
  budgetFor: (source: string) => number;
  /** What one run is assumed to cost while it is in flight (budget reservation). */
  estimatedRunCostUSD: number;
  /** Runs this worker launched that may still be executing: runId -> source. */
  inFlight: Map<string, string>;
  /** Terminal-check for a launched run (from its event log). */
  outcomeOf: (runId: string) => Promise<{ terminal: boolean }>;
  /** Enqueue a proposed task as a run under a runId the caller already reserved against. */
  launch: (task: IntakeTask, runId: string) => Promise<void>;
  /** Mint a run id. Injected so tests are deterministic. */
  newRunId: () => string;
  now: () => Date;
  log: (line: string) => void;
}

/**
 * One intake sweep. It (1) releases the fleet resources of any run this worker
 * launched that has since finished, then (2) auto-launches proposed tasks for
 * "auto" sources under three limits that are now FLEET-WIDE rather than
 * per-process: the daily launch count, the concurrency ceiling, and the
 * per-source daily spend budget. A task blocked by any of them stays proposed.
 *
 * Acquisition order is chosen so a late refusal can be undone. The task claim
 * and the concurrency slot are both releasable, and the budget hold is
 * releasable; the daily launch count is NOT (it is a one-way counter), so it is
 * taken last, immediately before the launch that consumes it.
 */
export async function sweepIntake(deps: IntakeSweepDeps): Promise<void> {
  const today = utcDay(deps.now());

  // 1) A finished run gives back its concurrency slot and its budget hold.
  // Spend is NOT settled here — the worker's onComplete does that for every
  // run, whatever launched it. Settling in both places would double-count.
  for (const [runId] of [...deps.inFlight]) {
    const outcome = await deps.outcomeOf(runId);
    if (!outcome.terminal) continue;
    deps.inFlight.delete(runId);
    await deps.admission.releaseSlot(runId);
  }

  // 2) Launch, if any source is configured "auto".
  if (!Object.values(deps.policies).some((p) => p === "auto")) return;

  for (const task of await deps.intake.list("proposed")) {
    if (deps.policies[task.source] !== "auto") continue;

    // Claim first: two workers sweeping the same proposed list must collapse to
    // one run. Losing just means someone else got there — take no resources.
    if (!(await deps.intake.claim(task.taskId))) continue;

    const runId = deps.newRunId();
    let slotTaken = false;
    let holdTaken = false;
    try {
      if (!(await deps.admission.acquireSlot(runId, deps.maxConcurrentRuns))) {
        deps.log(
          `[worker] intake: fleet at the concurrency ceiling (${deps.maxConcurrentRuns}); ${task.taskId} stays proposed`,
        );
        await deps.intake.setState(task.taskId, "proposed");
        break; // no slots for anyone this sweep
      }
      slotTaken = true;

      const budget = deps.budgetFor(task.source);
      if (budget > 0) {
        // Reserve BEFORE reading the total, so two workers admitting at once
        // see each other's commitment instead of both reading the same room.
        await deps.spend.reserve(runId, task.source, today, deps.estimatedRunCostUSD);
        holdTaken = true;
        const committed = await deps.spend.get(task.source, today);
        if (committed > budget) {
          deps.log(
            `[worker] intake: ${task.source} would exceed its daily budget ($${budget.toFixed(2)}; committed $${committed.toFixed(2)}); ${task.taskId} stays proposed`,
          );
          await deps.intake.setState(task.taskId, "proposed");
          continue;
        }
      }

      if (!(await deps.admission.takeDailyLaunch(task.source, today, deps.dailyAutoLimit))) {
        deps.log(`[worker] intake: ${task.source} hit the daily auto cap (${deps.dailyAutoLimit}); ${task.taskId} stays proposed`);
        await deps.intake.setState(task.taskId, "proposed");
        continue;
      }

      await deps.launch(task, runId);
      await deps.intake.setState(task.taskId, "launched", runId);
      deps.inFlight.set(runId, task.source);
      slotTaken = false; // the run owns it now; released when it finishes
      holdTaken = false; // released at settlement
      deps.log(`[worker] intake: auto-launched ${task.taskId} (${task.source}) as ${runId}`);
    } catch (error) {
      // Put everything back so a later sweep can retry cleanly, then surface it.
      await deps.intake.setState(task.taskId, "proposed").catch(() => {});
      throw error;
    } finally {
      if (slotTaken) await deps.admission.releaseSlot(runId).catch(() => {});
      if (holdTaken) await deps.spend.release(runId).catch(() => {});
    }
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
export function startWorker(options: WorkerOptions): {
  scheduler: Scheduler;
  /** Stop accepting work; resolves once timers are down and the outbox is flushed. */
  stop: () => Promise<void>;
  /** True while runs are still executing or a sweep is mid-flight. */
  busy: () => boolean;
} {
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const envMaxSteps = Number(process.env.SHIP_MAX_STEPS);
  const maxSteps = options.maxSteps ?? (Number.isFinite(envMaxSteps) && envMaxSteps > 0 ? envMaxSteps : undefined);
  const envNum = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const wf = durableAgent({
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    model: options.model,
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    // Per-run cost ceiling (SHIP_MAX_RUN_COST_USD). Off unless configured —
    // the daily caps remain the primary bound; this stops ONE pathological run.
    maxRunCostUSD: options.maxRunCostUSD ?? envNum("SHIP_MAX_RUN_COST_USD") ?? 0,
    executor: options.executor,
    approveAction: defaultApprovalPolicy,
    workdir: options.workdir,
    ...(options.gitToken !== undefined ? { gitToken: options.gitToken } : {}),
    ...(options.githubToken !== undefined ? { githubToken: options.githubToken } : {}),
    ...(options.repoPolicy !== undefined ? { repoPolicy: options.repoPolicy } : {}),
    repoMemory: options.runtime.memory,
    steer: options.runtime.steer,
    ...(options.codeSearch !== undefined ? { codeSearch: options.codeSearch } : {}),
    // Where this worker may deploy previews (SHIP_PREVIEW_DIR and friends).
    // Absent on a worker that has no app checkout to run the CLI in; a run
    // that asked for a preview then records the step as disabled rather than
    // silently skipping it.
    ...(previewTargetFromEnv() !== undefined ? { preview: previewTargetFromEnv()! } : {}),
    // Where this worker reads service health (OBSERVE_URL + OBSERVE_READ_TOKEN
    // + OBSERVE_SERVICE). Absent unless all three are set.
    ...(telemetryTargetFromEnv() !== undefined ? { telemetry: telemetryTargetFromEnv()! } : {}),
    // The project's test command (SHIP_TEST_COMMAND), run by Ship after the
    // agent stops rather than trusted from the agent's own account.
    ...(testTargetFromEnv() !== undefined ? { tests: testTargetFromEnv()! } : {}),
  });
  const host = hostname();
  // Opt-in: emit each completed run to Observe (no-op unless configured).
  const observe = makeObserveEmitter(log);
  // Opt-in: tell someone when a run parks or settles. Slack gets prose for a
  // person (SHIP_SLACK_WEBHOOK_URL); the signed webhook gets a record for a
  // program (SHIP_NOTIFY_URL + SHIP_NOTIFY_SECRET) — that is the one a
  // workspace consumes to offer an approve button. Either, both, or neither.
  const notify = multiNotifier([slackNotifier({ log }), webhookNotifier({ log })]);
  const outbox = options.outbox ?? new NucleusOutbox(options.runtime.db);
  /** Record that a notification is owed. */
  const owe = (event: RunNotification): Promise<void> =>
    outbox.enqueue({ id: notificationId(event), event });
  /** Attempt every owed notification; failures stay owed with a backoff. */
  const flush = (): Promise<number> =>
    flushOutbox(outbox, (event, id) => notify.runEvent(event, id)).catch((error) => {
      log(`[worker] outbox flush failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    });
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
      // Settle spend for every run this worker finishes. This used to live in
      // the intake sweep, which only reconciled runs it had auto-launched and
      // was tracking in memory — so a run started from the Inbox never had its
      // cost recorded and never counted against a budget, on a product whose
      // pitch is cost transparency. Completion is the one point every durable
      // run passes through regardless of how it was launched.
      void (async () => {
        const [meta, events] = await Promise.all([options.runtime.loadMeta(runId), options.runtime.store.load(runId)]);
        const settled = readOutcome(events);
        if (!settled.terminal) return; // a park is not a finish
        // The fleet resources this run held come back whatever the outcome was.
        await admission.releaseSlot(runId);
        await options.runtime.spend.release(runId).catch(() => {});
        const source = meta?.source;
        if (source === undefined || source === "") return; // pre-source run; nothing to attribute
        const model = meta?.model ?? modelId;
        const cost = costUSD(model, settled.usage);
        if (cost <= 0) return;
        if (!isPricedModel(model)) {
          // Loud, because the number below is a conservative guess and the
          // budget cap is now enforcing against it. Add the model to pricing.ts.
          log(`[worker] ${runId}: model ${model} is not in the pricing table — charging the highest known rate`);
        }
        const day = utcDay(new Date());
        await options.runtime.spend.add(source, day, cost);
        log(`[worker] ${runId} (${source}) cost $${cost.toFixed(4)} recorded to ${day}`);
      })().catch((error) =>
        log(`[worker] ${runId}: spend settle failed: ${error instanceof Error ? error.message : String(error)}`),
      );
      if (notify.enabled) {
        // Both branches read the event log for context. The park branch used to
        // skip that, but a parked run is exactly the one a consumer must be able
        // to route and describe — "run-7f3a is waiting" with no repo and no task
        // is an approval request nobody can act on. One store read per park is
        // cheap; parks are rare by construction.
        void options.runtime.store
          .load(runId)
          .then((events) => {
            const started = events.find((e) => e.type === "run-started");
            const input = (started as { data?: { input?: { repo?: string; task?: string } } } | undefined)?.data?.input;
            const context = {
              ...(input?.repo !== undefined ? { repo: input.repo } : {}),
              ...(input?.task !== undefined ? { task: input.task } : {}),
            };
            if (outcome.status === "waiting") {
              notify.runEvent({
                runId,
                status: outcome.status,
                ...(outcome.eventName !== undefined ? { eventName: outcome.eventName } : {}),
                ...context,
              });
              return;
            }
            // Terminal: include the PR link when the run opened one.
            const done = events.find((e) => e.type === "run-completed");
            const pr = (done?.data as { output?: { pr?: string } } | undefined)?.output?.pr;
            notify.runEvent({ runId, status: outcome.status, ...(pr !== undefined ? { pr } : {}), ...context });
          })
          // A store read failure must not lose the notification entirely — a
          // bare status still tells a consumer the run needs attention.
          .catch(() =>
            notify.runEvent({
              runId,
              status: outcome.status,
              ...(outcome.status === "waiting" && outcome.eventName !== undefined ? { eventName: outcome.eventName } : {}),
            }),
          );
      }
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
      // UNCONDITIONAL: loadMeta overlays the index status, which the
      // scheduler already recorded as this outcome — a "changed?" guard
      // compares outcome to itself and never writes (the raw doc kept its
      // stale pre-terminal status forever).
      void options.runtime.placement.set(runId, host).catch(() => {});
      void options.runtime
        .loadMeta(runId)
        .then((meta) => {
          if (meta !== null) {
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
  const admission = options.admission ?? new NucleusAdmission(options.runtime.db);
  const maxConcurrentRuns = options.maxConcurrentRuns ?? envInt("SHIP_MAX_CONCURRENT_RUNS") ?? 3;
  // What a run is assumed to cost while it is in flight. Held against the
  // source's daily budget from admission until settlement replaces it with the
  // real number, so a burst of launches cannot all pass the same budget read.
  const estimatedRunCostUSD = options.estimatedRunCostUSD ?? envInt("SHIP_ESTIMATED_RUN_COST_USD") ?? 0.5;
  const defaultBudget = options.dailyBudgetUSD ?? envInt("SHIP_DAILY_BUDGET_USD") ?? 10;
  const budgets = options.intakeBudgets ?? {};
  const envPolicies = options.intakePolicies ?? {};

  // The policy store is dashboard-authoritative; seed it from the env defaults
  // once (first run) so an operator who never opens the UI keeps the same
  // behavior, then let store edits win on every subsequent sweep.
  void options.runtime.policies
    .seed(envPolicies)
    .catch((err) => log(`[worker] policy seed failed: ${err instanceof Error ? err.message : String(err)}`));

  // Runs this worker launched and is still holding fleet resources for.
  const inFlight = new Map<string, string>();

  // Retry anything the outbox still owes. Rides the sweep timer rather than a
  // timer of its own: the retry cadence only has to be "eventually", and the
  // backoff inside the outbox is what actually paces it.
  const retryNotifications = async (): Promise<void> => {
    if (!notify.enabled) return;
    await flush();
  };

  const sweep = async (): Promise<void> => {
    // Re-read the live policies each tick so dashboard edits take effect
    // without a worker restart. Store wins over the env seed; a per-source
    // budget in the store overrides the global default.
    //
    // FAIL CLOSED on a read failure: auto-launching with only the env
    // defaults means auto-launching without the per-source budget caps the
    // operator set in the store — a degraded DB must never widen spend
    // authority. Proposals just wait; the sweep retries within seconds.
    let stored: SourcePolicy[];
    try {
      stored = await options.runtime.policies.list();
    } catch (err) {
      log(
        `[worker] policy read failed; skipping auto-launch this sweep (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const policies: Record<string, IntakePolicy> = { ...envPolicies };
    const storeBudgets: Record<string, number> = {};
    for (const p of stored) {
      policies[p.source] = p.policy;
      if (p.dailyBudgetUSD !== undefined) storeBudgets[p.source] = p.dailyBudgetUSD;
    }
    // Release tasks claimed for a run that never came into existence (the
    // worker died between claiming and enqueueing). Without this they stay
    // "launched" forever, pointing at a run id nothing will ever produce.
    await options.runtime.intake
      .reconcile(async (runId) => (await options.runtime.store.load(runId)).length > 0)
      .then((released) => {
        if (released.length > 0) log(`[worker] intake: released ${released.length} task(s) whose launch never landed`);
      })
      .catch((error) => log(`[worker] intake reconcile: ${error instanceof Error ? error.message : String(error)}`));

    return sweepIntake({
      intake: options.runtime.intake,
      spend: options.runtime.spend,
      admission,
      policies,
      dailyAutoLimit: options.dailyAutoLimit ?? envInt("SHIP_DAILY_AUTO_LIMIT") ?? 10,
      maxConcurrentRuns,
      budgetFor: (source) => storeBudgets[source] ?? budgets[source] ?? defaultBudget,
      estimatedRunCostUSD,
      inFlight,
      outcomeOf: async (runId) => readOutcome(await options.runtime.store.load(runId)),
      newRunId: () => `run-${randomUUID().slice(0, 8)}`,
      launch: async (task, runId) => {
        await enqueueRun(options.runtime, {
          runId,
          task: task.detail !== undefined ? `${task.title}\n\n${task.detail}` : task.title,
          model: modelId,
          source: task.source,
          // A swept task was proposed by a webhook, a chat message, or an
          // issue body — never by a human typing into this process.
          trust: "external",
          ...(task.repo !== undefined ? { repo: task.repo } : {}),
          ...(task.pr !== undefined ? { pr: task.pr } : {}),
        });
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
      .then(() => retryNotifications())
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
    // Renewing first: a concurrency slot carries a TTL so a dead worker cannot
    // wedge the fleet, which means a LIVE worker has to keep saying it is alive.
    admission
      .renewSlots()
      .catch(() => {})
      .then(() => options.runtime.fleet
      .heartbeat({
        owner: options.runtime.owner,
        host,
        sandbox: sandboxLabel,
        maxConcurrent: maxConcurrentRuns,
        activeRuns: inflight.size,
        startedAt,
        lastSeen: new Date().toISOString(),
      }))
      .catch((error) => log(`[worker] fleet heartbeat: ${error instanceof Error ? error.message : String(error)}`));
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), 15000);
  heartbeatTimer.unref?.();

  // Retire workers that stopped heartbeating a long time ago. The registry
  // keeps every worker it has ever seen, so without this the Fleet page slowly
  // fills with dead hosts (ours had entries last seen 400+ hours back) and the
  // table never stops growing. A day is far past the 45s staleness mark, so a
  // box that is merely down still shows up as stale before it is forgotten.
  const retentionMs = 24 * 60 * 60 * 1000;
  const reap = (): Promise<void> =>
    options.runtime.fleet
      .prune(new Date(Date.now() - retentionMs))
      .then((dropped) => {
        if (dropped > 0) log(`[worker] fleet: retired ${dropped} worker(s) unseen for over 24h`);
      })
      .catch((error) => log(`[worker] fleet prune: ${error instanceof Error ? error.message : String(error)}`));
  void reap();
  const reapTimer = setInterval(() => void reap(), 60 * 60 * 1000);
  reapTimer.unref?.();

  log(`[worker] watching for due runs as ${options.runtime.owner}`);
  return {
    scheduler,
    /**
     * Stop taking new work. Returns once the timers are down and the scheduler
     * has been told to stop; use {@link busy} to wait for what is still
     * executing before tearing the runtime down under it.
     */
    stop: async () => {
      clearInterval(intakeTimer);
      clearInterval(heartbeatTimer);
      clearInterval(reapTimer);
      scheduler.stop();
      // One last flush so a notification owed by a run that just finished is
      // attempted before the process goes, rather than waiting for the next
      // worker to pick it up.
      if (notify.enabled) await flush().catch(() => {});
    },
    /** True while runs are still executing or a sweep is mid-flight. */
    busy: () => inflight.size > 0 || sweeping,
  };
}
