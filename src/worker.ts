import { Scheduler } from "@neutron-build/workflow";
import type { WorkflowDefinition } from "@neutron-build/workflow";
import type { ModelAdapter } from "@neutron-build/ai";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import type { NucleusShipRuntime } from "./runtime.js";

export interface WorkerOptions {
  runtime: NucleusShipRuntime;
  model: ModelAdapter;
  executor: ExecutorProvider;
  /** The agent's working directory inside its executor. */
  workdir: string;
  /** Poll interval for due runs (default 5s). */
  intervalMs?: number;
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
  log(`[worker] watching for due runs as ${options.runtime.owner}`);
  return { scheduler, stop: () => scheduler.stop() };
}
