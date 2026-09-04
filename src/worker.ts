import { NondeterminismError, completeSleep, executeRunExclusive } from "@neutron-build/workflow";
import type { RunOutcome, WorkflowEvent } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { durableAgent, repoKeyOf } from "./durable.js";
import { resolveApprovalPolicy } from "./approval.js";
import { externalAdapters } from "./harness-external.js";
import { previewTargetFromEnv } from "./deploy.js";
import { telemetryTargetFromEnv } from "./observe.js";
import { testTargetFromEnv } from "./tests.js";
import type { ExecutorProvider, RunUsage, SandboxOverrides } from "./durable.js";
import { enqueueRun, proposeExternal } from "./runtime.js";
import { changeClassRequired, sweepBulletin } from "./bulletin.js";
import { parseSandboxUrls } from "./sandbox-pool.js";
import { attributionsFrom } from "./attributed-spend.js";
import { intakeActor } from "./actor.js";
import type { NucleusShipRuntime } from "./runtime.js";
import type { RunMeta } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import type { IntakeStore, IntakePolicy, IntakeTask } from "./intake.js";
import type { SourcePolicy } from "./policies.js";
import type { Project, ProjectStore } from "./projects.js";
import { repoSlug } from "./observe.js";
import {
  DEFAULT_MAX_INODE_USED_PCT,
  DEFAULT_MAX_LOAD_PER_CPU,
  DEFAULT_MIN_FREE_DISK_MB,
  DEFAULT_MIN_FREE_MB,
  capacityPlan,
  describeCapacity,
  hostHold,
  hostLoad,
  sandboxHostFromEnv,
  sandboxLimitsFor,
} from "./host-load.js";
import type { Capacity, HostHold, HostLimits, HostLoad } from "./host-load.js";
import { autoAllowedNow, formatWindow, windowFor } from "./governance.js";
import type { Windows } from "./governance.js";
import { makeObserveEmitter } from "./observe.js";
import { multiNotifier, projectNotifier, scanReport, slackNotifier, webhookNotifier } from "./notify.js";
import type { RunNotification, RunOrigin } from "./notify.js";
import { ladderRungsFromEvents, type Rung } from "./ladder.js";
import { runVerificationSummary, verificationFactsFromEvents } from "./verification-summary.js";
import type { ParsedFindings } from "./findings.js";
import { NucleusOutbox, flushOutbox, notificationId } from "./outbox.js";
import type { Outbox } from "./outbox.js";
import type { SpendStore } from "./spend.js";
import { utcDay } from "./spend.js";
import { NucleusAdmission } from "./admission.js";
import type { AdmissionControl } from "./admission.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import { effectiveAllowlist, parseOriginTokens, policyFromEnv } from "./repo-policy.js";
import {
  colocationOverrideNotice,
  colocationOverridden,
  colocationRefusal,
  detectForgeColocation,
  type SandboxProbe,
} from "./colocation.js";
import {
  akirooConnectorRefusal,
  akirooRefFrom,
  akirooTokenPrint,
  makeAkirooDecider,
  makeAkirooState,
  resolveAkirooTarget,
  sweepAkiroo,
} from "./akiroo.js";
import type { AkirooSweepDeps } from "./akiroo.js";
import { registerProject } from "./akiroo-project.js";
import type { CodeSearch } from "./code-index.js";
import { costUSD, isPricedModel } from "./pricing.js";
import { UPGRADE_HOLD_EVENT, replayDrift, upgradeHoldReason } from "./step-fingerprint.js";
import { makeObserveLogEmitter, selfwatchOnce } from "./selfwatch.js";

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
   * OVERRIDE for the ceiling on simultaneously-executing runs (or
   * SHIP_MAX_CONCURRENT_RUNS / --max-concurrent). Unset is the normal case:
   * the ceiling is then DERIVED from what the box has (capacityPlan in
   * host-load.ts) and re-derived on every heartbeat, so adding RAM, cores or
   * disk raises it and a squeeze lowers it without anyone touching a knob.
   * A run that would exceed the ceiling is deferred — its task stays proposed
   * and a later sweep picks it up. Parked runs still hold a slot (conservative).
   */
  maxConcurrentRuns?: number;
  /** Load-aware admission thresholds (host-load.ts); env SHIP_MIN_FREE_MB / SHIP_MAX_LOAD_PER_CPU. */
  minFreeMB?: number;
  maxLoadPerCpu?: number;
  /** Disk-aware admission on the docker root; env SHIP_MIN_FREE_DISK_MB / SHIP_MAX_INODE_USED_PCT. */
  minFreeDiskMB?: number;
  maxInodeUsedPct?: number;
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
    // One unpriced leg makes the run unpriced: a dollar total that silently
    // omitted part of the work would understate it (P5-3).
    if (usage.priced === false) total.priced = false;
    if (typeof usage.costUSD === "number" && total.priced !== false) total.costUSD = (total.costUSD ?? 0) + usage.costUSD;
  }
  if (found && total.priced === false) delete total.costUSD;
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

/**
 * L7: the origin an intake-launched run records. `source` and `dedupeKey` are
 * the task's own; `workItemRef` is recovered from the Akiroo footer the issue
 * body carries (AKIROO_REF_MARKER), which rides into the task's detail.
 */
export function intakeOrigin(task: Pick<IntakeTask, "source" | "dedupeKey" | "detail">): RunOrigin {
  const workItemRef = akirooRefFrom(task.detail);
  return { source: task.source, dedupeKey: task.dedupeKey, ...(workItemRef !== undefined ? { workItemRef } : {}) };
}

/**
 * What every notification about a run carries, read off its `run-started`
 * input: the repo, the task text, the origin and — for a scan — the mode.
 * All materialised at enqueue, so this is a read, never a derivation.
 */
export function notificationContext(events: WorkflowEvent[]): Pick<RunNotification, "repo" | "task" | "origin" | "mode"> {
  const started = events.find((e) => e.type === "run-started");
  const input = (started as { data?: { input?: { repo?: string; task?: string; origin?: RunOrigin; mode?: string } } } | undefined)
    ?.data?.input;
  return {
    ...(input?.repo !== undefined ? { repo: input.repo } : {}),
    ...(input?.task !== undefined ? { task: input.task } : {}),
    ...(input?.origin !== undefined ? { origin: input.origin } : {}),
    ...(input?.mode === "scan" ? { mode: "scan" as const } : {}),
  };
}

/**
 * What a TERMINAL notification adds: the pull request when the run opened one,
 * and for a scan the findings block (L7) — the recorded `scan-findings` step
 * plus the run's final write-up, bounded to the webhook payload budget.
 */
export function terminalContext(events: WorkflowEvent[]): Pick<RunNotification, "pr" | "findings"> {
  const done = events.find((e) => e.type === "run-completed");
  const output = (done?.data as { output?: { pr?: string; summary?: string } } | undefined)?.output;
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const parsed = (step?.data as { result?: ParsedFindings } | undefined)?.result;
  return {
    ...(output?.pr !== undefined ? { pr: output.pr } : {}),
    ...(parsed !== undefined
      ? {
          findings: scanReport(
            { found: parsed.found === true, findings: Array.isArray(parsed.findings) ? parsed.findings : [], errors: Array.isArray(parsed.errors) ? parsed.errors : [] },
            output?.summary ?? "",
          ),
        }
      : {}),
  };
}

/**
 * The contract-2 block (change_class, verification, merged), read off the
 * event log. Shared by the park branch and the terminal branch deliberately:
 * an `approve-merge` park is exactly the message whose evidence a decision
 * needs — the rungs and the paragraph ARE the case for merging — and building
 * them twice would be two places to disagree about the same run.
 *
 * The rungs prefer the recorded `ladder` step; a run without one gets the
 * list derived from its steps (ladder.ts ladderRungsFromEvents), so a
 * pre-ladder run still reports the verification it did record rather than
 * nothing. The summary is S-B's paragraph (verification-summary.ts), rendered
 * from the same log.
 */
export function verificationContext(events: WorkflowEvent[]): Pick<RunNotification, "changeClass" | "verification" | "merged"> {
  const facts = verificationFactsFromEvents(events);
  const changeClass = facts.changeClass?.class;
  const ladderStep = events.find((e) => e.type === "step-completed" && e.name === "ladder");
  const recorded = (ladderStep?.data as { result?: unknown } | undefined)?.result;
  const rungs = Array.isArray(recorded) ? (recorded as Rung[]) : ladderRungsFromEvents(events);
  return {
    ...(facts.changeClass !== undefined && (changeClass === "trivial" || changeClass === "normal" || changeClass === "serious")
      ? { changeClass }
      : {}),
    ...(facts.changeClass !== undefined || ladderStep !== undefined || facts.tests !== undefined || facts.preview !== undefined
      ? { verification: { rungs, summary: runVerificationSummary(events) } }
      : {}),
    ...(facts.merge?.kind === "merged" ? { merged: true } : {}),
  };
}

export interface IntakeSweepDeps {
  intake: Pick<IntakeStore, "list" | "setState" | "claim">;
  spend: SpendStore;
  /** Fleet-wide slots and counters (see admission.ts). */
  admission: AdmissionControl;
  policies: Record<string, IntakePolicy>;
  /**
   * Auto windows (governance.ts). Outside a source's window an "auto" task is
   * treated as "propose": it stays in the Inbox for a human. Absent = always.
   */
  windows?: Windows;
  dailyAutoLimit: number;
  maxConcurrentRuns: number;
  /** Per-source daily budget in USD; <= 0 disables the cap for that source. */
  budgetFor: (source: string) => number;
  /**
   * Project records (projects.ts): a task from a repo whose project sets a
   * sourcePolicy follows THAT instead of its source's, and a project budget
   * is checked in place of the source's for that task. Absent = sources only.
   */
  projects?: Pick<ProjectStore, "list">;
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

  // 2) Launch, if any source or project is configured "auto".
  const projects = new Map<string, Project>();
  for (const p of (await deps.projects?.list()) ?? []) projects.set(p.repo, p);
  const projectOf = (task: IntakeTask): Project | undefined => {
    const slug = task.repo !== undefined ? repoSlug(task.repo) : null;
    return slug === null ? undefined : projects.get(slug);
  };
  const anyAuto = Object.values(deps.policies).some((p) => p === "auto") || [...projects.values()].some((p) => p.sourcePolicy === "auto");
  if (!anyAuto) return;

  const parkedOutsideWindow = new Set<string>();
  for (const task of await deps.intake.list("proposed")) {
    const project = projectOf(task);
    if ((project?.sourcePolicy ?? deps.policies[task.source]) !== "auto") continue;
    // Outside its window an auto source is a propose source: the task waits
    // for a human, nothing is claimed, and the next in-window sweep takes it.
    if (!autoAllowedNow(deps.windows ?? {}, task.source, deps.now())) {
      if (!parkedOutsideWindow.has(task.source)) {
        parkedOutsideWindow.add(task.source);
        const w = windowFor(deps.windows ?? {}, task.source)!;
        deps.log(`[worker] intake: ${task.source} is outside its auto window (${formatWindow(w)}); tasks stay proposed`);
      }
      continue;
    }

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

      const budget = project?.dailyBudgetUSD ?? deps.budgetFor(task.source);
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
 * Exactly-once claim on a run's TERMINAL outcome, fleet-wide.
 *
 * Overlapping ticks can both observe the same completed run: a tick's due()
 * snapshot can predate the index write, and replaying a completed log returns
 * its recorded outcome again — so onComplete fires twice and would settle the
 * run's spend twice (observed live on 2026-08-24: one run, two
 * "cost $0.0128 recorded" lines). The KV claim decides a single winner across
 * workers and ticks; false means another tick already processed this outcome.
 *
 * A KV failure answers FALSE rather than true, deliberately: skipping a settle
 * under-counts spend, processing it twice over-counts, and a budget cap
 * over-reacting to phantom spend is the failure an operator cannot debug from
 * outside. Parks never claim — a run may park and resume repeatedly, and their
 * side effects are already idempotent.
 */
export interface TerminalClaim {
  (runId: string): Promise<boolean>;
  /**
   * Give a claim back. For the winner whose side effects then FAILED: a
   * settle that dies after winning the claim would otherwise be lost for good
   * — the run is no longer due, so nothing fires handleComplete again, and
   * the claim key says "done" to anyone who looks. Releasing makes the state
   * honest (unsettled and unclaimed) so a later pass can settle it. Only the
   * holder's own value is deleted (compare-and-delete), never a rival's.
   */
  release: (runId: string) => Promise<void>;
}

export function makeTerminalClaim(
  runtime: { kind: "file" | "nucleus"; owner: string; db?: NucleusPgwire },
  host: string,
): TerminalClaim {
  const doneLocally = new Set<string>();
  const value = `${runtime.owner}:${host}`;
  const claim = (runId: string): Promise<boolean> => {
    if (runtime.kind === "nucleus" && runtime.db !== undefined) {
      return runtime.db.kv
        .setNX(`ship:done:${runId}`, value, { ttl: 7 * 24 * 60 * 60 })
        .catch(() => false);
    }
    if (doneLocally.has(runId)) return Promise.resolve(false);
    doneLocally.add(runId);
    return Promise.resolve(true);
  };
  claim.release = async (runId: string): Promise<void> => {
    if (runtime.kind === "nucleus" && runtime.db !== undefined) {
      await runtime.db.kv.cdel(`ship:done:${runId}`, value).catch(() => false);
      return;
    }
    doneLocally.delete(runId);
  };
  return claim;
}

/**
 * Run `fn` up to `attempts` times, waiting `delayMs` (doubling) between tries.
 *
 * For the store reads and writes inside a terminal settle. Under load the
 * pool surfaces a transient rejection (pg-pool rejecting with `undefined`,
 * seen as "Cannot read properties of undefined (reading 'name')"), and a
 * settle that gives up on the first one loses the run's cost from the ledger
 * for good: measured 2026-08-25, 1 of 45 runs, $0.0278 in the audit and
 * absent from the budget.
 */
export async function retrying<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; onRetry?: (attempt: number, error: unknown) => void },
): Promise<T> {
  let delay = opts.delayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= opts.attempts) throw error;
      opts.onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * The repo a run serialises on (C7), read from its own log: the repo URL in
 * its recorded input, normalised the way repo memory keys it, so every run
 * against the same repository contends on the same string whatever surface
 * enqueued it.
 *
 * Undefined for a run with no repo — nothing to contend over — and
 * deliberately undefined for a SCAN: a scan publishes nothing (L2 / D3), so
 * it cannot touch the shared mutable surface (the repo's branches) the lock
 * exists to protect, and holding a read-only audit behind a fix run would
 * delay it for nothing. A repo URL the parser refuses still serialises on its
 * raw form; the lock key only has to be consistent, not canonical.
 */
export function repoLockKeyOf(events: readonly WorkflowEvent[]): string | undefined {
  const started = events.find((e) => e.type === "run-started");
  const input = (started as { data?: { input?: { repo?: string; mode?: string } } } | undefined)?.data?.input;
  const repo = input?.repo;
  if (repo === undefined || repo === "") return undefined;
  if (input?.mode === "scan") return undefined;
  try {
    return repoKeyOf(repo);
  } catch {
    return repo;
  }
}

/**
 * Launch due runs up to the concurrency ceiling, and no further.
 *
 * This is the P3-4 seam: behaviour AT the cap is QUEUE, never drop — the runs
 * not launched are simply still in the due list, and the next pass picks them
 * up when a slot frees. Returned is how many were launched this pass.
 *
 * A run is OFFERED at most once per pass: a run this pass launched but could
 * not run (another worker's lease, the upgrade fence, another run holding its
 * repo per C7) resolves without ever entering `inflight`, so without this
 * bound the find below would re-pick it immediately and one pass would spin
 * on store loads until something outside it changed. The next pass — the
 * tick, or the progress callback of a run that did run — is soon enough.
 */
export async function launchDueBounded(deps: {
  due: () => Promise<Array<{ runId: string; sleeping: boolean }>>;
  inflight: ReadonlySet<string>;
  launching: ReadonlySet<string>;
  maxConcurrent: number;
  /**
   * Load-aware admission (C2): does the HOST have room for one more run right
   * now? Checked before every launch, so a pass that starts with room stops
   * the moment the box does not. Absent = only the ceiling applies.
   */
  hostOk?: () => boolean;
  launch: (runId: string, sleeping: boolean) => void;
}): Promise<number> {
  let launched = 0;
  const offered = new Set<string>();
  // A run occupies ONE slot however many sets it is in. During execution it is
  // in both: `launching` from launch until driveOne returns, `inflight` from
  // lease-won until completion. Summing the two sizes counted every executing
  // run twice, and the worker held at ~half the configured ceiling under load
  // (measured 2026-08-25: ceiling 4, never more than 2-3 in flight).
  const occupied = (): number => new Set([...deps.inflight, ...deps.launching]).size;
  while (occupied() < deps.maxConcurrent && (deps.hostOk?.() ?? true)) {
    const due = await deps.due();
    const next = due.find((d) => !deps.inflight.has(d.runId) && !deps.launching.has(d.runId) && !offered.has(d.runId));
    if (next === undefined) break;
    offered.add(next.runId);
    deps.launch(next.runId, next.sleeping);
    launched += 1;
  }
  return launched;
}

/** What `releaseUpgradeHolds` needs, as data, so a test can drive it without a store. */
export interface UpgradeHoldDeps {
  listMeta: () => Promise<RunMeta[]>;
  loadEvents: (runId: string) => Promise<WorkflowEvent[]>;
  markWake: (runId: string) => Promise<void>;
  saveMeta: (meta: RunMeta) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Release the runs the upgrade fence is holding that this build now agrees with.
 *
 * A hold is a fact about two BUILDS, not about the run, and the documented fix
 * is a rollback — so it must not also require someone to remember which runs to
 * resume afterwards. `replayDrift` is recomputed from the log rather than read
 * from anywhere, so this can only ever release a run the running code really
 * can replay; a hold that is still real stays held.
 *
 * Bounded by the number of held runs, which is zero on every ordinary tick.
 */
export async function releaseUpgradeHolds(deps: UpgradeHoldDeps): Promise<string[]> {
  const held = (await deps.listMeta()).filter((m) => m.eventName === UPGRADE_HOLD_EVENT && m.status === "waiting");
  const released: string[] = [];
  for (const meta of held) {
    let events: WorkflowEvent[];
    try {
      events = await deps.loadEvents(meta.runId);
    } catch {
      continue; // an unreadable log is not evidence that the hold is over
    }
    if (replayDrift(events) !== null) continue;
    // Both halves, because they are read by different paths: markWake is what
    // the Nucleus index answers with (and it is what makes the run due again),
    // while the raw meta doc is what a file-backed read returns. An empty
    // eventName rather than an absent one — the Nucleus column map only writes
    // the keys the object carries, so omitting it would leave the hold's name
    // sitting in the column.
    await deps.saveMeta({ ...meta, status: "queued", eventName: "", updatedAt: new Date().toISOString() });
    await deps.markWake(meta.runId);
    released.push(meta.runId);
    deps.log(`[worker] released ${meta.runId} from its upgrade hold: this build replays its recorded step sequence`);
  }
  return released;
}

/**
 * The resident worker: executes due durable runs under leases, bounded by the
 * concurrency ceiling. Safe to run alongside CLI invocations and other workers
 * — a run someone else holds is simply skipped; crash recovery is the event
 * log's job. This is what makes `approve` from a laptop a true handoff: the
 * laptop delivers the decision and flags the run due; the worker carries it to
 * completion.
 *
 * The worker drives execution itself rather than starting the SDK Scheduler
 * (P3-4): the Scheduler has no concurrency bound, so overlapping ticks grow
 * executing runs without limit — SHIP_MAX_CONCURRENT_RUNS only ever gated
 * auto-launches. Here, at the ceiling a due run WAITS: it stays due in the
 * index and executes when a slot frees. Nothing is dropped or errored; the cap
 * bounds concurrency, never admission.
 */
export function startWorker(options: WorkerOptions): {
  /** Stop accepting work; resolves once timers are down and the outbox is flushed. */
  stop: () => Promise<void>;
  /** True while runs are still executing, a sweep is mid-pass, or completion work is unlanded. */
  busy: () => boolean;
  /** The run ids executing on this worker right now. */
  executing: () => string[];
  /** Count of detached completion tasks (settlement, notify, meta) still in flight. */
  unsettled: () => number;
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
  /**
   * Per-sandbox limits sized from the host (B1). Ship's TypeScript set none at
   * all before this, so every run got the teploy-sandbox daemon's fixed
   * default (1 CPU / 1 GB) whatever the box was — starving a 16 GB builder and
   * over-committing a 2 GB VM.
   *
   * Precedence is unchanged and explicit per field: the project record wins
   * (projects.ts sandboxLimits, materialised into the run input at enqueue and
   * arriving here via sandboxOverridesOf), and the derived value only fills in
   * what it did not say. Filling in HERE rather than at enqueue is deliberate:
   * the sandbox step records the container handle, not the overrides, so this
   * changes nothing about a replay's step sequence.
   */
  function hostSizedOverrides(o?: SandboxOverrides): SandboxOverrides {
    const derived = sandboxLimitsFor(lastLoad, capacity.maxConcurrent, sandboxHost);
    return {
      ...(o ?? {}),
      limits: {
        memoryMb: o?.limits?.memoryMb ?? derived.memoryMb,
        cpus: o?.limits?.cpus ?? derived.cpus,
        ...(o?.limits?.pids !== undefined ? { pids: o.limits.pids } : {}),
      },
    };
  }
  // Forwarded call-by-call rather than spread, so the source provider keeps its
  // own `this`, and the optional members stay ABSENT when the source has none
  // (durable.ts gates snapshot/restore on both being present).
  const src = options.executor;
  const executor: ExecutorProvider = {
    create: (o) => src.create(hostSizedOverrides(o)),
    attach: (handle) => src.attach(handle),
    ...(src.isolated !== undefined ? { isolated: src.isolated } : {}),
    ...(src.snapshot !== undefined ? { snapshot: (handle: string) => src.snapshot!(handle) } : {}),
    ...(src.createFrom !== undefined
      ? { createFrom: (image: string, o?: SandboxOverrides) => src.createFrom!(image, hostSizedOverrides(o)) }
      : {}),
    ...(src.destroy !== undefined ? { destroy: (handle: string) => src.destroy!(handle) } : {}),
    ...(src.warmInfo !== undefined ? { warmInfo: (handle: string) => src.warmInfo!(handle) } : {}),
    ...(src.warmCommit !== undefined ? { warmCommit: (handle: string) => src.warmCommit!(handle) } : {}),
  };
  const wf = durableAgent({
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    model: options.model,
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    // Per-run cost ceiling (SHIP_MAX_RUN_COST_USD). Off unless configured —
    // the daily caps remain the primary bound; this stops ONE pathological run.
    maxRunCostUSD: options.maxRunCostUSD ?? envNum("SHIP_MAX_RUN_COST_USD") ?? 0,
    // The provider's own isolation flag decides the gate, not an env guess:
    // it is already load-bearing (an externally-sourced task refuses to run
    // on a non-isolating provider) and its contract says false is the safe
    // answer. Isolated -> gate only what outlives the container; not isolated
    // -> the strict LocalExecutor list, because commands reach the host.
    approveAction: resolveApprovalPolicy({ sandboxed: options.executor.isolated === true }),
    executor,
    workdir: options.workdir,
    ...(options.gitToken !== undefined ? { gitToken: options.gitToken } : {}),
    ...(options.githubToken !== undefined ? { githubToken: options.githubToken } : {}),
    ...(options.repoPolicy !== undefined ? { repoPolicy: options.repoPolicy } : {}),
    repoMemory: options.runtime.memory,
    projects: options.runtime.projects,
    steer: options.runtime.steer,
    ...(options.codeSearch !== undefined ? { codeSearch: options.codeSearch } : {}),
    // External harnesses (claude-code, opencode). Always carried; whether the
    // binary is in the sandbox image is a recorded preflight step per run.
    harnesses: externalAdapters(),
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
  // L8 contracts 1 and 4: the kind-tagged records (project acks, reverts) on
  // the same signed URL as the run webhook. One-shot by design — see
  // projectNotifier's doc in notify.ts.
  const projectNotify = projectNotifier({ log });
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
  /**
   * Detached completion work still running: spend settlement, the notification,
   * the Observe emit, the meta write.
   *
   * Counted because `handleComplete` removes the run from `inflight` BEFORE it
   * starts any of that, so a shutdown that waited only on `inflight` saw
   * `busy()` go false immediately and closed the connection pool underneath the
   * settlement — which is precisely the failure the ordered shutdown in cli.ts
   * was written to stop, still present because the thing it waited on did not
   * cover the thing it was waiting for. A run's cost reaching the ledger is the
   * one piece of shutdown work that cannot be redone by the next worker.
   */
  let settling = 0;
  const tracked = (work: Promise<unknown>): void => {
    settling++;
    // `.catch` before `.finally`, not after: a rejected completion task would
    // otherwise make the chain itself reject, and a voided rejected promise is
    // an unhandled rejection that can take the process down at exactly the
    // moment it is trying to shut down cleanly.
    void work
      .catch((error) => log(`[worker] completion task failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        settling--;
      });
  };
  const claimTerminalOutcome = makeTerminalClaim(options.runtime, host);
  const handleError = (runId: string, error: unknown): void => {
    inflight.delete(runId);
    log(`[worker] run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const handleStart = (runId: string): void => {
    inflight.add(runId);
    log(`[worker] picked up ${runId}`);
    // Record where this run is executing so the dashboard can show placement.
    void options.runtime.placement.set(runId, host).catch(() => {});
  };
  const handleComplete = (runId: string, outcome: { status: string; eventName?: string }): void => {
      inflight.delete(runId);
      log(`[worker] ${runId} → ${outcome.status}`);
      // TERMINAL outcomes are processed exactly once, fleet-wide.
      //
      // A racing tick can replay-finalise a completed run (its due() snapshot
      // predates the index write; executeRunExclusive then replays the log,
      // returns the recorded outcome, and onComplete fires a SECOND time —
      // observed live on 2026-08-24 settling one run's spend twice). The KV
      // claim decides a single winner across workers and ticks; the loser does
      // nothing. Non-terminal outcomes (parks) skip the claim: a run may park
      // and resume repeatedly, and their side effects are already idempotent
      // (outbox ids dedupe the notifications).
      const terminal = outcome.status === "completed" || outcome.status === "failed" || outcome.status === "cancelled";
      // One claim shared by every terminal side effect below (settle, notify,
      // observe). Parks resolve true without claiming.
      const terminalPass = !terminal ? Promise.resolve(true) : claimTerminalOutcome(runId);
      // Settle spend for every run this worker finishes. This used to live in
      // the intake sweep, which only reconciled runs it had auto-launched and
      // was tracking in memory — so a run started from the Inbox never had its
      // cost recorded and never counted against a budget, on a product whose
      // pitch is cost transparency. Completion is the one point every durable
      // run passes through regardless of how it was launched.
      tracked((async () => {
        if (!(await terminalPass)) return; // a racing tick already processed this outcome
        const onRetry = (attempt: number, error: unknown): void =>
          log(`[worker] ${runId}: settle read/write attempt ${attempt} failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        const [meta, events] = await retrying(
          () => Promise.all([options.runtime.loadMeta(runId), options.runtime.store.load(runId)]),
          { attempts: 4, delayMs: 500, onRetry },
        );
        const settled = readOutcome(events);
        if (!settled.terminal) return; // a park is not a finish
        // The fleet resources this run held come back whatever the outcome was.
        await admission.releaseSlot(runId);
        await options.runtime.spend.release(runId).catch(() => {});
        const source = meta?.source;
        if (source === undefined || source === "") return; // pre-source run; nothing to attribute
        const model = meta?.model ?? modelId;
        const day = utcDay(new Date());
        if (settled.usage?.priced === false) {
          // The run consumed a quota Ship cannot price (a subscription-fed
          // harness). Counted, never priced, and never written as $0 — the
          // Spend page shows the count as its own line (P5-3). A run that
          // consumed NOTHING (the binary never answered, a credential was
          // refused) is not a quota draw and is not counted — the same gate
          // as `cost <= 0` below for priced runs.
          if (!(settled.usage.totalTokens > 0)) return;
          await options.runtime.unpricedRuns.add(source, day, runId);
          log(`[worker] ${runId} (${source}) ran unpriced (${settled.usage.totalTokens} tokens on a quota Ship cannot price) — counted to ${day}, not priced`);
          return;
        }
        const cost = costUSD(model, settled.usage);
        // A run that burned tokens and priced at zero is COUNTED, not dropped.
        //
        // Found by the end-to-end smoke against the deployed build. Before the
        // precedence rule in pricing.ts (an explicit SHIP_MODEL_PRICING entry
        // beats a quota prefix), a deployment that set both fell between the
        // two settle branches and reached NEITHER ledger. That configuration
        // is priced now; this branch stays as the backstop for any other way
        // consumption can price at zero — a quota or local model with tokens
        // — so nothing is ever dropped, only counted.
        if (cost <= 0) {
          if (!((settled.usage?.totalTokens ?? 0) > 0)) return;
          await options.runtime.unpricedRuns.add(source, day, runId);
          log(
            `[worker] ${runId} (${source}) priced at $0 on ${model} but consumed ${settled.usage?.totalTokens} tokens — ` +
              `counted to ${day} as unpriced rather than dropped`,
          );
          return;
        }
        if (!isPricedModel(model)) {
          // Loud, because the number below is a conservative guess and the
          // budget cap is now enforcing against it. Add the model to pricing.ts.
          log(`[worker] ${runId}: model ${model} is not in the pricing table — charging the highest known rate`);
        }
        await retrying(() => options.runtime.spend.add(source, day, cost), { attempts: 4, delayMs: 500, onRetry });
        log(`[worker] ${runId} (${source}) cost $${cost.toFixed(4)} recorded to ${day}`);
        // The same cost, cut by repository and by actor. Fire-and-forget with
        // its own guard, in the style of the surrounding side effects:
        // attribution is reporting, and a failure here must never break or
        // delay the settle above it — the budget ledger is the record that
        // matters. Same cost > 0 gate as the source settle, inherited by
        // placement (the block returned above when cost <= 0).
        const attribution = attributionsFrom(meta, events);
        if (attribution.repo !== undefined) {
          void options.runtime.attributedSpend.add("repo", attribution.repo, day, cost).catch((error) =>
            log(
              `[worker] ${runId}: attributed spend (repo) failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
        if (attribution.actor !== undefined) {
          void options.runtime.attributedSpend.add("actor", attribution.actor, day, cost).catch((error) =>
            log(
              `[worker] ${runId}: attributed spend (actor) failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      })().catch(async (error) => {
        log(
          `[worker] ${runId}: spend settle failed: ${error instanceof Error ? error.message : String(error)}\n` +
            (error instanceof Error && error.stack !== undefined ? error.stack : ""),
        );
        // Give the claim back so the failure is visible as "unsettled" rather
        // than silently recorded as done — see TerminalClaim.release.
        await claimTerminalOutcome.release(runId);
        log(`[worker] ${runId}: terminal claim released — this run's cost is NOT in the ledger`);
      }));
      if (notify.enabled) {
        // Both branches read the event log for context. The park branch used to
        // skip that, but a parked run is exactly the one a consumer must be able
        // to route and describe — "run-7f3a is waiting" with no repo and no task
        // is an approval request nobody can act on. One store read per park is
        // cheap; parks are rare by construction.
        tracked((async () => {
          if (!(await terminalPass)) return;
          let events: Awaited<ReturnType<typeof options.runtime.store.load>>;
          try {
            events = await options.runtime.store.load(runId);
          } catch {
            // A store read failure must not lose the notification entirely — a
            // bare status still tells a consumer the run needs attention.
            notify.runEvent({
              runId,
              status: outcome.status,
              ...(outcome.status === "waiting" && outcome.eventName !== undefined ? { eventName: outcome.eventName } : {}),
            });
            return;
          }
          const context = notificationContext(events);
          // The contract-2 block rides BOTH branches: a park is the message a
          // decision is made from (the rungs and the paragraph are the case
          // for or against), and a terminal event is the record of what the
          // verification added up to.
          const verification = verificationContext(events);
          if (outcome.status === "waiting") {
            notify.runEvent({
              runId,
              status: outcome.status,
              ...(outcome.eventName !== undefined ? { eventName: outcome.eventName } : {}),
              ...context,
              ...verification,
            });
            return;
          }
          // Terminal: include the PR link when the run opened one, and the
          // findings when it was a scan.
          notify.runEvent({ runId, status: outcome.status, ...context, ...terminalContext(events), ...verification });
        })());
      }
      // L8 D4: the per-repo numbers. One row per (repo, kind, runId) — the
      // store's key makes this idempotent, so the worker recording `merged`
      // and the forge's own pull_request webhook recording it again is one
      // row, not two. Sent is every repo run that reached an outcome (a
      // refused or empty run counts as sent: it was work Akiroo paid for);
      // parked is a waiting outcome; merged rides the contract-2 fact. The
      // web process adds reverted (revert-watch) and the forge-merged rows.
      // Fire-and-forget in the style of attribution: reporting must never
      // break a settle.
      tracked((async () => {
        if (!(await terminalPass)) return;
        let events: WorkflowEvent[];
        try {
          events = await options.runtime.store.load(runId);
        } catch {
          return;
        }
        const context = notificationContext(events);
        if (context.repo === undefined || context.mode === "scan") return;
        const verification = verificationContext(events);
        const pr = terminalContext(events).pr;
        try {
          await options.runtime.repoStats.record({ repo: context.repo, kind: "sent", runId, ...(pr !== undefined ? { pr } : {}), at: new Date().toISOString() });
          if (outcome.status === "waiting") {
            await options.runtime.repoStats.record({ repo: context.repo, kind: "parked", runId, at: new Date().toISOString() });
          }
          if (verification.merged === true) {
            await options.runtime.repoStats.record({ repo: context.repo, kind: "merged", runId, ...(pr !== undefined ? { pr } : {}), at: new Date().toISOString() });
          }
        } catch (error) {
          log(`[worker] ${runId}: repo stats failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })());
      // Dogfood the run into Observe (no-op unless configured).
      if (observe.enabled) {
        tracked((async () => {
          if (!(await terminalPass)) return;
          try {
            const [meta, events] = await Promise.all([options.runtime.loadMeta(runId), options.runtime.store.load(runId)]);
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
          } catch {
            // telemetry must never fail a run
          }
        })());
      }
      // The index is status-authoritative, but persist the terminal status
      // onto the raw meta doc too so it's self-consistent (accurate for
      // direct reads / file mode, not just the index-overlaid reads).
      // UNCONDITIONAL: loadMeta overlays the index status, which the
      // scheduler already recorded as this outcome — a "changed?" guard
      // compares outcome to itself and never writes (the raw doc kept its
      // stale pre-terminal status forever).
      tracked(options.runtime.placement.set(runId, host).catch(() => {}));
      tracked(
        options.runtime
          .loadMeta(runId)
          .then((meta) => {
            if (meta !== null) {
              return options.runtime.saveMeta({ ...meta, status: outcome.status, updatedAt: new Date().toISOString() });
            }
          })
          .catch((error) => log(`[worker] ${runId}: meta update failed: ${error instanceof Error ? error.message : String(error)}`)),
      );
    };

  const envInt = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const modelId = options.modelId ?? "worker-default";
  const admission = options.admission ?? new NucleusAdmission(options.runtime.db);
  // Unset is the normal case — the ceiling is measured, not configured (B1).
  // Set, and it wins outright and says so on the Fleet page, because an
  // operator who typed a number meant it.
  const maxConcurrentOverride = options.maxConcurrentRuns ?? envInt("SHIP_MAX_CONCURRENT_RUNS");
  // What a run is assumed to cost while it is in flight. Held against the
  // source's daily budget from admission until settlement replaces it with the
  // real number, so a burst of launches cannot all pass the same budget read.
  const estimatedRunCostUSD = options.estimatedRunCostUSD ?? envInt("SHIP_ESTIMATED_RUN_COST_USD") ?? 0.5;
  const defaultBudget = options.dailyBudgetUSD ?? envInt("SHIP_DAILY_BUDGET_USD") ?? 10;
  const budgets = options.intakeBudgets ?? {};
  const envPolicies = options.intakePolicies ?? {};

  // ---- Bounded execution (P3-4). Mirrors the SDK Scheduler's tick, with two
  // differences that are the point: launches stop at the concurrency ceiling
  // (due runs WAIT in the index rather than all executing at once), and a run
  // whose log is already terminal is finalised in the index instead of being
  // replayed again (the racing-tick double-processing that double-settled
  // spend, observed live on 2026-08-24).
  const launching = new Set<string>();
  // Load-aware admission (C2): below SHIP_MIN_FREE_MB of available memory or
  // above SHIP_MAX_LOAD_PER_CPU, a due run waits exactly as it does at the
  // ceiling — nothing dropped, nothing errored. The reason is logged once a
  // minute (not once a tick) and carried on the heartbeat for the Fleet page.
  const hostLimits: HostLimits = {
    minFreeMB: options.minFreeMB ?? envNum("SHIP_MIN_FREE_MB") ?? DEFAULT_MIN_FREE_MB,
    maxLoadPerCpu: options.maxLoadPerCpu ?? envNum("SHIP_MAX_LOAD_PER_CPU") ?? DEFAULT_MAX_LOAD_PER_CPU,
    minFreeDiskMB: options.minFreeDiskMB ?? envNum("SHIP_MIN_FREE_DISK_MB") ?? DEFAULT_MIN_FREE_DISK_MB,
    maxInodeUsedPct: options.maxInodeUsedPct ?? envNum("SHIP_MAX_INODE_USED_PCT") ?? DEFAULT_MAX_INODE_USED_PCT,
  };
  let lastLoad: HostLoad = hostLoad();
  // The sandbox daemon's box, when the operator says it differs from this one
  // (host-load.ts:sandboxHostFromEnv). Read once: it is a statement about a
  // machine, not a measurement of one.
  const sandboxHost = sandboxHostFromEnv();
  log(
    sandboxHost.totalMemMB !== undefined || sandboxHost.cpus !== undefined
      ? `[worker] sandbox limits sized from SHIP_SANDBOX_HOST_*: ${sandboxHost.totalMemMB ?? lastLoad.totalMemMB} MB, ${sandboxHost.cpus ?? lastLoad.cpus} cpu`
      : `[worker] sandbox limits sized from this host (${lastLoad.totalMemMB} MB, ${lastLoad.cpus} cpu); set SHIP_SANDBOX_HOST_MEMORY_MB if the daemon runs elsewhere`,
  );
  let held: HostHold | null = null;
  let heldLoggedAt = 0;
  // The ceiling, derived from the box (host-load.ts capacityPlan) and re-derived
  // on every heartbeat below. Read at call time everywhere it is used — the
  // drive loop, the intake sweep and the heartbeat all see the current value.
  let capacity: Capacity = capacityPlan(lastLoad, {
    limits: hostLimits,
    activeRuns: 0,
    ...(maxConcurrentOverride !== undefined ? { override: maxConcurrentOverride } : {}),
  });
  log(`[worker] capacity: ${describeCapacity(lastLoad, capacity)}`);
  /**
   * Re-sense the box and re-derive the ceiling. Logs only on a CHANGE — the
   * derived value must be visible, not silent, and not a line every 15s.
   * `held` is recomputed from the same snapshot so the heartbeat never
   * publishes a hold that belongs to different numbers.
   */
  const resense = (): void => {
    lastLoad = hostLoad();
    held = hostHold(lastLoad, hostLimits);
    const next = capacityPlan(lastLoad, {
      limits: hostLimits,
      activeRuns: inflight.size,
      ...(maxConcurrentOverride !== undefined ? { override: maxConcurrentOverride } : {}),
    });
    if (next.maxConcurrent !== capacity.maxConcurrent || next.binding !== capacity.binding) {
      log(`[worker] capacity ${capacity.maxConcurrent} -> ${describeCapacity(lastLoad, next)}`);
    }
    capacity = next;
  };
  const hostOk = (): boolean => {
    lastLoad = hostLoad();
    held = hostHold(lastLoad, hostLimits);
    if (held !== null && Date.now() - heldLoggedAt > 60_000) {
      heldLoggedAt = Date.now();
      const disk =
        lastLoad.disk === undefined
          ? "disk unsensed"
          : `${lastLoad.disk.freeMB} MB disk free (${lastLoad.disk.usedPct}% used, ${lastLoad.disk.inodeUsedPct}% inodes)`;
      log(
        `[worker] holding launches: ${held} (${lastLoad.freeMemMB} MB available, load ${lastLoad.load1.toFixed(2)} on ${lastLoad.cpus} cpus, ${disk}; ` +
          `limits ${hostLimits.minFreeMB} MB / ${hostLimits.maxLoadPerCpu} per cpu / ${hostLimits.minFreeDiskMB} MB disk / ${hostLimits.maxInodeUsedPct}% inodes)`,
      );
    }
    return held === null;
  };
  const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["run-completed", "run-failed", "run-cancelled"]);
  /**
   * Hold a run this build must not replay (the upgrade fence, step-fingerprint.ts).
   *
   * NOTHING IS WRITTEN TO THE EVENT LOG. An `event-waiting` event is a cursor
   * event, so recording the hold in the log would itself alter the sequence the
   * hold exists to protect. The state lives in the run index (status `waiting`,
   * which stops it coming due every tick) and on its meta, both outside the log.
   *
   * Nothing here is destructive and nothing is remembered: the fingerprint is
   * recomputed on every attempt, so rolling the deployment back and running
   * `teploy-ship resume` releases the run, and `releaseUpgradeHolds` below
   * releases it without anyone asking.
   */
  const holdForUpgrade = async (runId: string, reason: string): Promise<void> => {
    log(`[worker] HOLDING ${reason}`);
    await options.runtime.index.record(runId, wf.name, {
      status: "waiting",
      eventName: UPGRADE_HOLD_EVENT,
    } as RunOutcome);
    const meta = await options.runtime.loadMeta(runId).catch(() => null);
    if (meta !== null) {
      await options.runtime
        .saveMeta({ ...meta, status: "waiting", eventName: UPGRADE_HOLD_EVENT, updatedAt: new Date().toISOString() })
        .catch((error) => log(`[worker] ${runId}: hold meta write failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    handleComplete(runId, { status: "waiting", eventName: UPGRADE_HOLD_EVENT });
  };
  /** Execute one due run. Returns true when this pass made progress (a slot likely freed). */
  const driveOne = async (runId: string, sleeping: boolean): Promise<boolean> => {
    try {
      const events = await options.runtime.store.load(runId);
      const terminal = events.find((e) => TERMINAL_EVENTS.has(e.type));
      if (terminal !== undefined) {
        // Finished elsewhere (or its writer died between the terminal event and
        // the index write). Make the index agree so it stops coming due, run
        // the terminal bookkeeping once — the KV claim inside handleComplete
        // decides the winner — and never execute it again.
        const status = terminal.type === "run-completed" ? "completed" : terminal.type === "run-failed" ? "failed" : "cancelled";
        await options.runtime.index.record(runId, wf.name, { status } as never);
        handleComplete(runId, { status });
        return true;
      }
      // THE UPGRADE FENCE, before anything is executed or woken. A run whose
      // recorded step sequence differs from this build's would hit a
      // NondeterminismError partway through its replay; holding it here keeps
      // the run exactly as its log left it and turns "unrunnable until someone
      // notices" into a decision in the inbox. Checked per attempt rather than
      // once at startup so a rollback releases it on the next tick.
      const drift = replayDrift(events);
      if (drift !== null) {
        await holdForUpgrade(runId, upgradeHoldReason(runId, drift));
        return false;
      }
      // PER-REPO SERIALIZATION (C7): one active run per repository. Two runs
      // racing on one repo push overlapping branches and force the second PR
      // to rebase onto bytes its verification never saw — the lock makes that
      // rare by construction instead of handling it after the fact. A run that
      // cannot take its repo's lock stays due; the next tick retries it, which
      // is the queue. Held for the execution pass only and released in the
      // finally below — a park releases it too, because a run parked on a human
      // for days is not active and must not wedge its repo behind it.
      const repoLock = repoLockKeyOf(events);
      if (repoLock !== undefined && !(await admission.acquireRepo(runId, repoLock))) {
        log(`[worker] ${runId} queued behind the run holding ${repoLock} (C7: one active run per repo)`);
        return false; // another run is executing against this repo right now
      }
      try {
        if (sleeping) await completeSleep(options.runtime.store, runId);
        const outcome = await executeRunExclusive({
          workflow: wf,
          runId,
          store: options.runtime.store,
          leases: options.runtime.leases,
          owner: options.runtime.owner,
          onStart: () => handleStart(runId),
        });
        if (outcome === null) return false; // another worker holds the lease; not ours to run
        await options.runtime.index.record(runId, wf.name, outcome);
        handleComplete(runId, outcome);
        return true;
      } finally {
        if (repoLock !== undefined) await admission.releaseRepo(runId).catch(() => {});
      }
    } catch (error) {
      // The backstop the fingerprint cannot be. A fingerprint is computed from
      // the source ORDER of step calls, so a reordering achieved by swapping
      // two helper CALL SITES leaves it unchanged (see step-fingerprint.ts);
      // the engine catches that on replay and every other divergence besides.
      // Without this branch a diverged run was logged and left due, so the
      // worker re-attempted it every tick forever and nobody was told.
      if (error instanceof NondeterminismError) {
        inflight.delete(runId);
        await holdForUpgrade(
          runId,
          `run ${runId} diverged from its recorded log under this build (${error.message}). ` +
            `Its log is intact. Roll the deployment back to release it, or cancel the run.`,
        ).catch((held) => log(`[worker] ${runId}: could not record the upgrade hold: ${held instanceof Error ? held.message : String(held)}`));
        return false;
      }
      handleError(runId, error);
      return false;
    }
  };
  let driving = false;
  /**
   * Set by `stop()`. Clearing the interval is not enough on its own: a run that
   * makes progress re-enters `drive()` from its own completion handler (the
   * fill-a-freed-slot path below), so a worker that had been told to stop could
   * still pick up a brand-new run afterwards — and then be killed mid-step by
   * the shutdown that had just asked it to stop.
   */
  let stopping = false;
  const drive = async (): Promise<void> => {
    if (driving || stopping) return;
    driving = true;
    try {
      await launchDueBounded({
        due: () => options.runtime.index.due(new Date()),
        inflight,
        launching,
        maxConcurrent: capacity.maxConcurrent,
        // A pass already in flight when stop() lands must not launch one more
        // run on its next loop iteration; the guard at the top of drive() only
        // covers passes that have not started.
        hostOk: () => !stopping && hostOk(),
        launch: (runId, sleeping) => {
          launching.add(runId);
          void driveOne(runId, sleeping)
            .catch(() => false)
            .then((progressed) => {
              launching.delete(runId);
              // Fill a freed slot immediately; when nothing progressed (lease
              // contention, an error), the interval is soon enough — an
              // immediate retry loop would hammer the store for nothing.
              if (progressed) void drive().catch(() => {});
            });
        },
      });
    } finally {
      driving = false;
    }
  };
  const driveTimer = setInterval(
    () =>
      void drive().catch((error) =>
        log(
          `[worker] tick failed (store unreachable?): ${error instanceof Error ? error.message : String(error)}\n` +
            (error instanceof Error && error.stack !== undefined ? error.stack : ""),
        ),
      ),
    options.intervalMs ?? 5000,
  );
  driveTimer.unref?.();
  void drive().catch(() => {});

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
    // Same fail-closed rule for the windows: an unreadable governance store
    // must not turn a 09:00-18:00 rule into "always".
    let windows: Windows;
    try {
      windows = (await options.runtime.governance.get()).windows;
    } catch (err) {
      log(
        `[worker] governance read failed; skipping auto-launch this sweep (fail closed): ${err instanceof Error ? err.message : String(err)}`,
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
      windows,
      dailyAutoLimit: options.dailyAutoLimit ?? envInt("SHIP_DAILY_AUTO_LIMIT") ?? 10,
      maxConcurrentRuns: capacity.maxConcurrent,
      budgetFor: (source) => storeBudgets[source] ?? budgets[source] ?? defaultBudget,
      projects: options.runtime.projects,
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
          // The handle the webhook payload asserted for whoever opened the
          // issue. Unverified — the delivery signature proves the payload came
          // from the forge, not that the forge is honest about the author.
          actor: intakeActor(task.requestedBy, task.source),
          // A swept task was proposed by a webhook, a chat message, or an
          // issue body — never by a human typing into this process.
          trust: "external",
          // L6: a task whose text came from a PUBLIC board is classified before
          // it can push, whatever SHIP_CHANGE_CLASS says for this deployment.
          // The board's own gate already refuses to run automatically unless
          // the deployment-wide flag is on, so this is the narrower belt: it
          // survives someone turning that flag off without remembering that a
          // public board depends on it.
          ...(changeClassRequired(task.source) ? { changeClass: true } : {}),
          ...(task.repo !== undefined ? { repo: task.repo } : {}),
          ...(task.pr !== undefined ? { pr: task.pr } : {}),
          // L7: where the task came from, so the outcome can find its way home.
          // The Akiroo footer rides the issue body into the task's detail; the
          // structured ref is recovered from it here, once, at launch.
          origin: intakeOrigin(task),
        });
      },
      now: () => new Date(),
      log,
    });
  };

  // L1: the Akiroo hop. Ship PULLS — a worker behind a tailnet needs only
  // outbound HTTPS, and Akiroo never holds a forge token. No-op unless both
  // AKIROO_URL and AKIROO_PULL_TOKEN resolve. See src/akiroo.ts.
  //
  // Resolved EVERY tick rather than once at startup. The connect handshake
  // writes both values into the runtime config store from the web process while
  // this worker is already running, and the contract is that the worker picks
  // them up on its next poll — a target captured at boot would mean a restart
  // is still required, which is the whole thing the handshake removes.
  //
  // This is the worker loop, NOT a durable step: durable.ts never touches the
  // connector (`grep akiroo src/durable.ts` is empty, and must stay so). A
  // config read inside a durable step would change the step sequence on replay
  // and throw a NondeterminismError, leaving in-flight runs permanently
  // unrunnable. Keep the read here.
  const akirooCursor = options.runtime.akirooCursor;
  const akirooDecide = makeAkirooDecider(options.runtime);
  const akirooRepoPolicy = options.repoPolicy ?? policyFromEnv();
  const akirooState = makeAkirooState(undefined);
  // What the connector looked like on the previous tick, so the change is
  // logged once rather than every five seconds. The token is never part of it:
  // its identity is carried as a short digest so a rotation is still visible.
  let akirooPrint = "";
  const akirooSweep = async (): Promise<void> => {
    try {
      const resolution = await resolveAkirooTarget(options.runtime.config);
      const print =
        resolution.target === undefined
          ? `${resolution.status}:${resolution.reason ?? ""}`
          : `${resolution.status}:${resolution.target.url}:${akirooTokenPrint(resolution.target.token)}`;
      if (print !== akirooPrint) {
        akirooPrint = print;
        akirooState.retarget(resolution);
        if (resolution.target !== undefined) {
          log(
            `[worker] akiroo: pulling work from ${resolution.target.url}` +
              ` (${resolution.status === "runtime" ? "set by the connect handshake" : "from the environment"})`,
          );
        } else if (resolution.status === "misconfigured") {
          log(`[worker] akiroo: connector not usable — ${resolution.reason ?? "half-configured"}`);
        } else {
          log("[worker] akiroo: connector not configured");
        }
      }
      if (resolution.target === undefined) return;
      // DEPLOY.md documents the return leg as required; this enforces it at
      // connector start. See akirooConnectorRefusal for why the WHOLE
      // connector refuses rather than only the project rows.
      const refusal = akirooConnectorRefusal();
      if (refusal !== undefined) {
        akirooState.recordError(new Error(refusal));
        if (akirooPrint !== `no-notify:${refusal}`) {
          akirooPrint = `no-notify:${refusal}`;
          log(`[worker] akiroo: ${refusal}`);
        }
        return;
      }
      const deps: AkirooSweepDeps = {
        target: resolution.target,
        cursor: akirooCursor,
        deliveries: options.runtime.deliveries,
        intake: options.runtime.intake,
        registerProject: (payload) =>
          registerProject(
            {
              projects: options.runtime.projects,
              repoPolicy: akirooRepoPolicy,
              hookBase: (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, ""),
              hookSecret: process.env.SHIP_WEBHOOK_SECRET ?? "",
              notify: projectNotify,
              log,
            },
            payload,
          ).then(() => {}),
        enqueueScan: async (input) => {
          const runId = `run-${randomUUID().slice(0, 8)}`;
          await enqueueRun(options.runtime, {
            runId,
            task: input.task,
            model: input.model ?? modelId,
            repo: input.repo,
            mode: "scan",
            source: "akiroo",
            // The scan contract names a room, not a person, so the run is
            // recorded as unattributable rather than as the room's id.
            actor: intakeActor(undefined, "akiroo"),
            trust: "external",
            origin: input.origin,
          });
          return { runId };
        },
        decide: akirooDecide,
        repoPolicy: akirooRepoPolicy,
        log,
      };
      const result = await sweepAkiroo(deps);
      akirooState.recordPull(result);
      if (result.pulled > 0) {
        log(`[worker] akiroo: pulled ${result.pulled}, handled ${result.handled}, acked ${result.acked}`);
      }
    } catch (error) {
      // Logged, never thrown: Akiroo being unreachable — or the config store
      // being briefly unreadable — must not stop the intake sweep that shares
      // this tick.
      akirooState.recordError(error);
      log(`[worker] akiroo sweep: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // L6: promote notes that have crossed their board's threshold.
  //
  // Resident rather than an API route someone has to call: a board whose policy
  // is `auto` is a promise that Ship is watching it, and a promise kept only
  // when a cron remembers is not one. Same tick and same reentrancy guard as
  // the intake and Akiroo sweeps, and errors are logged rather than thrown for
  // the same reason — a board being unreadable must not stop the queue.
  const bulletinSweep = async (): Promise<void> => {
    try {
      const result = await sweepBulletin({
        store: options.runtime.bulletin,
        propose: (input) => proposeExternal(options.runtime, input),
        projectFor: (repo) => options.runtime.projects.forRepo(repo),
        log,
      });
      if (result.sent > 0) log(`[worker] bulletin: promoted ${result.sent} note(s)`);
    } catch (error) {
      log(`[worker] bulletin sweep: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Let go of anything the upgrade fence is holding that this build can now
  // replay — the rollback half of the fence, so nobody has to remember it.
  // Errors logged, never thrown, like every other leg on this tick.
  const holdSweep = async (): Promise<void> => {
    try {
      await releaseUpgradeHolds({
        listMeta: () => options.runtime.listMeta(),
        loadEvents: (runId) => options.runtime.store.load(runId),
        markWake: (runId) => options.runtime.index.markWake(runId),
        saveMeta: (meta) => options.runtime.saveMeta(meta),
        log,
      });
    } catch (error) {
      log(`[worker] upgrade-hold sweep: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Reentrancy guard: a sweep can outlast intervalMs when Nucleus is slow, and
  // two overlapping sweeps re-launch the same proposed task (duplicate PRs) and
  // double-count its spend. Skip a tick if the previous sweep is still running.
  // The Akiroo pull rides the same guard and the same tick for the same reason:
  // two overlapping pulls would both hand the same row to a handler.
  //
  // The chain is KEPT, not just flagged, so stop() can await it: an in-flight
  // sweep may hold claimed intake tasks whose enqueue never landed, or an
  // Akiroo pull between fetch and ack, and a shutdown that returned while one
  // was mid-pass abandoned it.
  let sweepChain: Promise<void> | null = null;
  const intakeTimer = setInterval(() => {
    if (sweepChain !== null) return;
    sweepChain = sweep()
      .then(() => akirooSweep())
      .then(() => bulletinSweep())
      .then(() => holdSweep())
      .then(() => retryNotifications())
      .catch((error) => log(`[worker] intake sweep: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        sweepChain = null;
      });
  }, options.intervalMs ?? 5000);
  intakeTimer.unref?.();

  // Fleet heartbeat: announce this worker's host, sandbox, capacity, and live
  // load so the dashboard can show the fleet. Staleness (a dead process) is
  // inferred from lastSeen, so the interval doubles as the liveness signal.
  const startedAt = new Date().toISOString();
  const sandboxLabel = process.env.SHIP_SANDBOX_URL ?? "host";

  // B4: is this the forge's own box?
  //
  // Once, at startup, before any run is claimed. It costs one sandbox and it is
  // the one decision an operator must never be left to remember — see
  // colocation.ts for why the answer is a refusal rather than a warning.
  // Deliberately fire-and-forget with its own error handling: a probe that
  // cannot run must not stop a worker from starting, but it also must not be
  // silently read as "safe" (detectForgeColocation reports it as unknown).
  void checkForgeColocation({ executor: options.executor, repoPolicy: options.repoPolicy, log }).catch((error) => {
    log(`[worker] forge co-location check: ${error instanceof Error ? error.message : String(error)}`);
  });
  const beat = (): Promise<void> => {
    // Sense on the beat rather than relying on the drive loop's hostOk() having
    // run: the numbers this publishes and the ceiling it reports then come from
    // ONE snapshot, and both are at most one beat old. This is where the
    // ceiling is re-derived, so adding a VM's worth of RAM or clearing a full
    // disk raises it within 15s, and a squeeze lowers it within 15s.
    resense();
    return (
      // Renewing first: a concurrency slot carries a TTL so a dead worker cannot
      // wedge the fleet, which means a LIVE worker has to keep saying it is alive.
      // The per-repo locks (C7) carry the same TTL for the same reason — a run
      // can outlive one 5-minute window, and a repo queue must not stall behind
      // an expired lock nobody renews.
      admission
        .renewSlots()
        .catch(() => {})
        .then(() => admission.renewRepos().catch(() => {}))
        .then(() =>
          options.runtime.fleet.heartbeat({
            owner: options.runtime.owner,
            host,
            sandbox: sandboxLabel,
            maxConcurrent: capacity.maxConcurrent,
            activeRuns: inflight.size,
            startedAt,
            lastSeen: new Date().toISOString(),
            freeMemMB: lastLoad.freeMemMB,
            load1: Math.round(lastLoad.load1 * 100) / 100,
            cpus: lastLoad.cpus,
            ...(held !== null ? { held } : {}),
            totalMemMB: lastLoad.totalMemMB,
            capacityBinding: capacity.binding,
            ...(lastLoad.disk !== undefined
              ? {
                  diskFreeMB: lastLoad.disk.freeMB,
                  diskUsedPct: lastLoad.disk.usedPct,
                  inodeUsedPct: lastLoad.disk.inodeUsedPct,
                }
              : {}),
          }),
        )
        .catch((error) => log(`[worker] fleet heartbeat: ${error instanceof Error ? error.message : String(error)}`))
    );
  };
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), 15000);
  heartbeatTimer.unref?.();

  // Self-observability (P3-6): one health pass a minute — queue depth, worker
  // liveness, stuck-run detection — reported locally only when something is
  // wrong, and always emitted to Observe's log ingest when wired. Reports, never
  // kills: a "stuck" run may be a long thinking call, and terminating a live run
  // is the operator's call with the evidence in front of them.
  const selfwatch = makeObserveLogEmitter(log);
  const selfwatchIntervalS = envInt("SHIP_SELFWATCH_INTERVAL_S") ?? 60;
  let selfwatchTimer: ReturnType<typeof setInterval> | undefined;
  if (selfwatchIntervalS > 0) {
    const watch = (): Promise<void> =>
      selfwatchOnce({
        runtime: options.runtime,
        fleet: options.runtime.fleet,
        owner: options.runtime.owner,
        activeRuns: inflight.size,
        log,
        ...(selfwatch.enabled ? { emitter: selfwatch } : {}),
      }).then(() => undefined);
    void watch().catch(() => {});
    selfwatchTimer = setInterval(() => void watch().catch(() => {}), selfwatchIntervalS * 1000);
    selfwatchTimer.unref?.();
  }

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
    /**
     * Stop taking new work. Returns once the timers are down AND any intake
     * sweep in flight has settled — the sweep chain can hold claimed tasks or
     * a mid-ack Akiroo pull, and abandoning one is what this exists to
     * prevent. Use {@link busy} to wait for what is still executing before
     * tearing the runtime down under it.
     */
    stop: async () => {
      stopping = true;
      clearInterval(intakeTimer);
      clearInterval(heartbeatTimer);
      clearInterval(reapTimer);
      if (selfwatchTimer !== undefined) clearInterval(selfwatchTimer);
      clearInterval(driveTimer);
      // The wait the rewritten shutdown dropped: a sweep that was mid-pass
      // when the timers cleared. The chain never rejects (every leg catches),
      // so awaiting it is safe even against a store that errors late.
      if (sweepChain !== null) await sweepChain;
      // One last flush so a notification owed by a run that just finished is
      // attempted before the process goes, rather than waiting for the next
      // worker to pick it up.
      if (notify.enabled) await flush().catch(() => {});
    },
    /**
     * True while there is work a shutdown would interrupt: a run executing, a
     * launch in flight, a sweep mid-pass, or detached completion work (spend
     * settlement, the outbox, the meta write) that has not landed.
     *
     * `settling` is the one a caller cannot see any other way, and it is the
     * one that matters most: a run's cost reaching the ledger is the only piece
     * of this the next worker cannot redo.
     */
    busy: () => inflight.size > 0 || launching.size > 0 || sweepChain !== null || settling > 0,
    /** Runs executing on this worker right now — what a shutdown would interrupt. */
    executing: () => [...inflight],
    /** Completion work started but not landed. Zero means nothing is owed to the store. */
    unsettled: () => settling,
  };
}

/**
 * Run the B4 co-location gate once, at worker startup.
 *
 * Exported for the test, and because an operator standing up a new box wants to
 * be able to ask the question before committing to it.
 *
 * When it fires the process EXITS. A worker that keeps running while refusing
 * every launch looks healthy on the Fleet page and quietly does nothing, which
 * is the worst of both — and the operator's next action is the same either way:
 * move the worker, or set the override.
 */
export async function checkForgeColocation(deps: {
  executor: ExecutorProvider;
  repoPolicy?: RepoPolicyConfig;
  log: (line: string) => void;
  /** Injected by the test; production exits the process. */
  onRefuse?: (message: string) => void;
}): Promise<void> {
  const origins = forgeOrigins(deps.repoPolicy);
  if (origins.length === 0) return;

  // The probe runs in a real sandbox on the host the sandboxes run on, which is
  // the whole point — nothing else can see past this process's netns.
  const probe: SandboxProbe | undefined =
    deps.executor.isolated === true
      ? async (command: string) => {
          const created = await deps.executor.create();
          try {
            const result = await deps.executor.attach(created.handle).exec(command, { timeoutMs: 20_000 });
            return { exitCode: result.exitCode, stdout: result.stdout };
          } finally {
            await deps.executor.destroy?.(created.handle).catch(() => {});
          }
        }
      : undefined;

  const result = await detectForgeColocation({
    origins,
    // What the gate is actually about: where the agent's code runs. A remote
    // pool means the worker may sit beside the forge — see colocation.ts.
    sandboxUrls: parseSandboxUrls(process.env.SHIP_SANDBOX_URL),
    ...(probe !== undefined ? { probe } : {}),
  });
  for (const note of result.unknown) deps.log(`[worker] forge co-location: could not determine — ${note}`);
  if (result.colocated.length === 0) return;

  if (colocationOverridden()) {
    deps.log(colocationOverrideNotice(result.colocated));
    return;
  }
  const message = colocationRefusal(result.colocated);
  deps.log(`[worker] ${message}`);
  if (deps.onRefuse !== undefined) {
    deps.onRefuse(message);
    return;
  }
  process.exit(3);
}

/**
 * The origins Ship would send a git credential to: every allowlist entry, plus
 * every origin with a token configured. Those are exactly the forges a run can
 * clone from, so they are exactly the ones worth asking about.
 */
export function forgeOrigins(policy?: RepoPolicyConfig): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined || value === "") return;
    try {
      out.add(new URL(value).origin);
    } catch {
      // Allowlist entries may be origin+owner ("http://host:1234/tyler"); the
      // URL parse above already handles those. Anything else is not an origin.
    }
  };
  // effectiveAllowlist folds SHIP_REPO_ALLOWLIST together with every project
  // record's clone URL, which is exactly the set a run can be pointed at.
  for (const entry of effectiveAllowlist(policy ?? {})) add(entry.origin);
  for (const origin of Object.keys(parseOriginTokens(policy?.originTokens))) add(origin);
  return [...out];
}
