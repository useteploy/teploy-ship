import { Scheduler } from "@neutron-build/workflow";
import type { WorkflowDefinition } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { randomUUID } from "node:crypto";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { enqueueRun } from "./runtime.js";
import type { NucleusShipRuntime } from "./runtime.js";

/**
 * Per-source intake policy. Auto is OFF unless a source is explicitly
 * configured "auto" — autonomy is earned per source, never default —
 * and even then a daily launch cap bounds the blast radius of a storm
 * (count-based v1; spend-based caps arrive with cost telemetry).
 */
export type IntakePolicy = "ignore" | "propose" | "auto";

export interface WorkerOptions {
  runtime: NucleusShipRuntime;
  model: ModelAdapter;
  /** Model id recorded on runs the intake sweep launches. */
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
  log?: (line: string) => void;
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
  });
  const scheduler = new Scheduler({
    workflows: [wf as unknown as WorkflowDefinition<never, unknown>],
    store: options.runtime.store,
    leases: options.runtime.leases,
    index: options.runtime.index,
    owner: options.runtime.owner,
    intervalMs: options.intervalMs ?? 5000,
    onError: (runId, error) =>
      log(`[worker] run ${runId}: ${error instanceof Error ? error.message : String(error)}`),
  });
  scheduler.start();

  // Intake sweep: launch proposed tasks whose source is configured
  // "auto". Dedupe already happened at propose time; the cap here bounds
  // a storm that produced many distinct tasks.
  const launchedToday = new Map<string, { day: string; count: number }>();
  const sweep = async (): Promise<void> => {
    const policies = options.intakePolicies ?? {};
    if (Object.values(policies).every((p) => p !== "auto")) return;
    const limit = options.dailyAutoLimit ?? 10;
    const today = new Date().toISOString().slice(0, 10);
    for (const task of await options.runtime.intake.list("proposed")) {
      if (policies[task.source] !== "auto") continue;
      const counter = launchedToday.get(task.source);
      const count = counter?.day === today ? counter.count : 0;
      if (count >= limit) {
        log(`[worker] intake: ${task.source} hit the daily auto cap (${limit}); ${task.taskId} stays proposed`);
        continue;
      }
      const runId = `run-${randomUUID().slice(0, 8)}`;
      await enqueueRun(options.runtime, {
        runId,
        task: task.detail !== undefined ? `${task.title}

${task.detail}` : task.title,
        model: options.modelId ?? "worker-default",
        ...(task.repo !== undefined ? { repo: task.repo } : {}),
        ...(task.pr !== undefined ? { pr: task.pr } : {}),
      });
      await options.runtime.intake.setState(task.taskId, "launched", runId);
      launchedToday.set(task.source, { day: today, count: count + 1 });
      log(`[worker] intake: auto-launched ${task.taskId} (${task.source}) as ${runId}`);
    }
  };
  const intakeTimer = setInterval(() => {
    void sweep().catch((error) => log(`[worker] intake sweep: ${error instanceof Error ? error.message : String(error)}`));
  }, options.intervalMs ?? 5000);
  intakeTimer.unref?.();

  log(`[worker] watching for due runs as ${options.runtime.owner}`);
  return {
    scheduler,
    stop: () => {
      clearInterval(intakeTimer);
      scheduler.stop();
    },
  };
}
