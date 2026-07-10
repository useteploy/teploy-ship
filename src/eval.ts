import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";

import { runAgent } from "./agent.js";
import { secretEnvNames } from "./guard.js";
import type { AgentResult, RunAgentOptions } from "./agent.js";

/** Outcome of an independent verification check. */
export interface Verification {
  passed: boolean;
  detail?: string;
}

/**
 * One benchmark task. `verify` is the whole point of the harness: it runs
 * AFTER the agent finishes, in the same workspace, and decides pass/fail
 * on its own — the agent's "finish" claim is never trusted. A task passes
 * only if the work is actually there.
 */
export interface EvalTask {
  name: string;
  /** The instruction handed to the agent. */
  prompt: string;
  /** Seed the workspace before the agent starts (files, fixtures). */
  setup?: (executor: AgentExecutor) => Promise<void>;
  /** Independent check of the workspace after the agent stops. */
  verify: (executor: AgentExecutor) => Promise<Verification>;
  maxSteps?: number;
}

export interface EvalRunResult {
  task: string;
  attempt: number;
  passed: boolean;
  detail?: string;
  agentStatus: AgentResult["status"];
  steps: number;
  durationMs: number;
}

export interface EvalReport {
  results: EvalRunResult[];
  /** Tasks that passed at least once (pass@k over the attempts). */
  passedTasks: number;
  totalTasks: number;
  /** Individual attempt pass rate across all runs. */
  attemptPassRate: number;
  passRate: number;
}

export interface EvalExecutor {
  executor: AgentExecutor;
  /** Workdir shown to the agent and where verification runs. */
  workdir: string;
  cleanup: () => Promise<void>;
}

export interface RunEvalOptions {
  tasks: EvalTask[];
  model: ModelAdapter;
  /** Fresh, isolated workspace per attempt (default: a local temp dir). */
  createExecutor?: () => Promise<EvalExecutor>;
  /** Attempts per task; >1 reports pass@k and a stable pass rate (default 1). */
  repeats?: number;
  /** Extra agent options (recovery/condense/approval/timeouts). */
  agentOptions?: Partial<Omit<RunAgentOptions, "model" | "executor" | "task" | "workdir">>;
  onResult?: (result: EvalRunResult) => void;
}

/** Run a task suite and score it. Each attempt is fully isolated. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const repeats = options.repeats ?? 1;
  const createExecutor = options.createExecutor ?? localEvalExecutor;
  const results: EvalRunResult[] = [];

  for (const task of options.tasks) {
    for (let attempt = 0; attempt < repeats; attempt++) {
      const { executor, workdir, cleanup } = await createExecutor();
      const started = Date.now();
      let result: EvalRunResult;
      try {
        if (task.setup) await task.setup(executor);

        const agentResult = await runAgent({
          model: options.model,
          executor,
          task: task.prompt,
          workdir,
          ...(task.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}),
          ...options.agentOptions,
        });

        // Independent verification — the agent's status does not decide this.
        let verification: Verification;
        try {
          verification = await task.verify(executor);
        } catch (error) {
          verification = { passed: false, detail: `verify threw: ${error instanceof Error ? error.message : String(error)}` };
        }

        result = {
          task: task.name,
          attempt,
          passed: verification.passed,
          ...(verification.detail !== undefined ? { detail: verification.detail } : {}),
          agentStatus: agentResult.status,
          steps: agentResult.steps.length,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        result = {
          task: task.name,
          attempt,
          passed: false,
          detail: `run threw: ${error instanceof Error ? error.message : String(error)}`,
          agentStatus: "error",
          steps: 0,
          durationMs: Date.now() - started,
        };
      } finally {
        await cleanup().catch(() => {});
      }

      results.push(result);
      options.onResult?.(result);
    }
  }

  return report(results, options.tasks.length);
}

function report(results: EvalRunResult[], totalTasks: number): EvalReport {
  const byTask = new Map<string, boolean>();
  for (const result of results) {
    byTask.set(result.task, (byTask.get(result.task) ?? false) || result.passed);
  }
  const passedTasks = [...byTask.values()].filter(Boolean).length;
  const attemptPasses = results.filter((r) => r.passed).length;
  return {
    results,
    passedTasks,
    totalTasks,
    attemptPassRate: results.length === 0 ? 0 : attemptPasses / results.length,
    passRate: totalTasks === 0 ? 0 : passedTasks / totalTasks,
  };
}

/** A fresh LocalExecutor in a throwaway temp dir; cleans up after itself. */
export async function localEvalExecutor(): Promise<EvalExecutor> {
  const root = await mkdtemp(join(tmpdir(), "teploy-eval-"));
  return {
    executor: new LocalExecutor({ root, envDenylist: secretEnvNames() }),
    workdir: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Verification helper: the task passes iff `command` exits 0 in the
 * workspace. The standard way to check real work — run the tests, run the
 * program, grep the output.
 */
export function checkCommand(command: string): (executor: AgentExecutor) => Promise<Verification> {
  return async (executor) => {
    const result = await executor.exec(command);
    return {
      passed: result.exitCode === 0,
      detail: result.exitCode === 0 ? undefined : `check \`${command}\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  };
}

/** A one-line-per-task summary plus the headline pass rate. */
export function formatReport(report: EvalReport): string {
  const lines = report.results.map((r) => {
    const mark = r.passed ? "PASS" : "FAIL";
    const detail = r.passed ? "" : `  — ${r.detail ?? r.agentStatus}`;
    return `  [${mark}] ${r.task} (${r.steps} steps, ${r.durationMs}ms)${detail}`;
  });
  const pct = (report.passRate * 100).toFixed(0);
  return `${lines.join("\n")}\n\n${report.passedTasks}/${report.totalTasks} tasks passed (${pct}%)`;
}
