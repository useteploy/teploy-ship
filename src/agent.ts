import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter, Usage } from "@neutron-build/ai";
import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { Action } from "./actions.js";
import { FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, describeAction, parseAction } from "./actions.js";
import type { ApprovalPolicy } from "./approval.js";
import { ensureKernel, installKernel, runCell, stopKernel } from "./kernel.js";
import { condenseIfNeeded, defaultCondenseConfig } from "./memory.js";
import type { CondenseConfig } from "./memory.js";
import { formatObservation, systemPrompt } from "./prompt.js";
import { RecoveryTracker, defaultRecoveryConfig } from "./recovery.js";
import type { RecoveryConfig } from "./recovery.js";

export interface AgentStep {
  index: number;
  /** The model's full response (reasoning + the action block). */
  thought: string;
  action: Action;
  /** Execution result, absent for finish/none. */
  result?: ExecResult;
  observation?: string;
}

export interface AgentEvent {
  type: "thought" | "action" | "observation" | "finish" | "error";
  step: number;
  text: string;
}

export interface RunAgentOptions {
  model: ModelAdapter;
  executor: AgentExecutor;
  task: string;
  /** Absolute workdir shown to the agent (default /work — the sandbox convention). */
  workdir?: string;
  /** Continue a prior conversation (e.g. a previous run's result.messages); task becomes the next user turn. */
  priorMessages?: Message[];
  /** Max action turns before giving up (default 20). */
  maxSteps?: number;
  /** Per-action wall-clock cap, ms (default 120000). */
  actionTimeoutMs?: number;
  /** Cap on an observation fed back to the model, chars (default 8000). */
  maxObservationChars?: number;
  /** Classifies each executable action; "required" actions must be approved. */
  approveAction?: ApprovalPolicy;
  /** Resolver for approval-required actions in the live loop (true = run). */
  onApprovalRequest?: (action: Action) => boolean | Promise<boolean>;
  /** Loop/failure recovery tuning; false disables stuck detection. */
  recovery?: RecoveryConfig | false;
  /** Context condensation tuning; false disables it. */
  condense?: CondenseConfig | false;
  /** Persistent python kernel (variables survive between actions); false = per-file execution. */
  kernel?: boolean;
  /**
   * Verified-finish guard (default on): the FIRST finish of a run is held
   * once — with zero successful executions the agent is told to do the
   * work; otherwise it is told to prove each deliverable with a real
   * command before finishing again. A second finish is always honored
   * (never an infinite refusal loop), and a finish on the final step is
   * honored immediately (a nudge there could only burn the run).
   */
  requireVerifiedFinish?: boolean;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
}

export interface AgentResult {
  status: "finished" | "max-steps" | "aborted" | "error";
  /** The finish summary, or the reason the run ended. */
  summary: string;
  steps: AgentStep[];
  /** Full conversation, for inspection or a follow-up turn. */
  messages: Message[];
  /** Total model usage across every call in the run (cache fields included). */
  usage: Usage;
}

/**
 * The CodeAct loop: assemble the conversation, ask the model for one
 * action, execute it in the sandbox, feed the observation back, repeat
 * until the agent finishes or the step budget runs out. This is the
 * agent "brain" — thin on purpose in M1 (the AI SDK owns model calls,
 * the executor owns compute); recovery/eval tuning is a later milestone.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const workdir = options.workdir ?? "/work";
  const maxSteps = options.maxSteps ?? 20;
  const maxObs = options.maxObservationChars ?? 8000;
  const emit = options.onEvent ?? (() => {});

  let messages: Message[] =
    options.priorMessages !== undefined && options.priorMessages.length > 0
      ? [...options.priorMessages, { role: "user", content: options.task }]
      : [
          { role: "system", content: systemPrompt({ workdir, task: options.task }) },
          { role: "user", content: "Begin. Work step by step and verify before finishing." },
        ];
  const steps: AgentStep[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const addTo = (u: Usage): void => {
    const cacheRead = (usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    const cacheWrite = (usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      totalTokens: usage.totalTokens + u.totalTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
  };

  const recovery = options.recovery === false ? null : new RecoveryTracker(options.recovery ?? defaultRecoveryConfig);
  const condense = options.condense === false ? null : (options.condense ?? defaultCondenseConfig);
  const summarize = async (transcript: string): Promise<string> => {
    const generated = await generateText({
      model: options.model,
      system: "Summarize this agent transcript into a compact progress recap: what was attempted, what worked, what failed, current state, and what remains. Be specific about file names and results.",
      prompt: transcript,
      maxOutputTokens: 800,
    });
    addTo(generated.usage);
    return generated.text;
  };

  let kernelUsed = false;
  let anySuccessfulAction = false;
  let finishNudged = false;
  try {
  for (let index = 0; index < maxSteps; index++) {
    if (options.abortSignal?.aborted) {
      return { status: "aborted", summary: "Run aborted.", steps, messages, usage };
    }

    // Keep the conversation inside the model's window before each call.
    if (condense !== null) {
      try {
        messages = await condenseIfNeeded(messages, summarize, condense);
      } catch (error) {
        emit({ type: "error", step: index, text: `condense failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    let thought: string;
    try {
      const generateOptions: Parameters<typeof generateText>[0] = { model: options.model, messages };
      if (options.abortSignal !== undefined) generateOptions.abortSignal = options.abortSignal;
      const generated = await generateText(generateOptions);
      addTo(generated.usage);
      thought = generated.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Model call failed: ${message}`, steps, messages, usage };
    }

    messages.push({ role: "assistant", content: thought });
    const action = parseAction(thought);
    emit({ type: "thought", step: index, text: thought });
    emit({ type: "action", step: index, text: describeAction(action) });

    if (action.kind === "finish") {
      if (options.requireVerifiedFinish !== false && !finishNudged && index + 1 < maxSteps) {
        finishNudged = true;
        const nudge = anySuccessfulAction ? FINISH_NUDGE_VERIFY : FINISH_NUDGE_NO_WORK;
        messages.push({ role: "user", content: nudge });
        steps.push({ index, thought, action });
        emit({ type: "observation", step: index, text: nudge });
        continue;
      }
      steps.push({ index, thought, action });
      emit({ type: "finish", step: index, text: action.message });
      return { status: "finished", summary: action.message, steps, messages, usage };
    }

    if (action.kind === "none" || action.kind === "invalid") {
      // No runnable action (or a malformed one): feed the reason back.
      const nudge =
        action.kind === "invalid"
          ? action.message
          : "No code block found. Respond with exactly one fenced code block (bash/python/edit/create), or a ```finish block if done.";
      messages.push({ role: "user", content: nudge });
      steps.push({ index, thought, action });
      emit({ type: "observation", step: index, text: nudge });
      continue;
    }

    if (options.approveAction !== undefined && (await options.approveAction(action)) === "required") {
      if (options.onApprovalRequest === undefined) {
        // No resolver in the live loop: treat as denied and let the agent adapt.
        const denied = "Action denied: it requires approval and no approver is available. Choose a safer action.";
        messages.push({ role: "user", content: denied });
        steps.push({ index, thought, action });
        emit({ type: "observation", step: index, text: denied });
        continue;
      }
      const approved = await options.onApprovalRequest(action);
      if (!approved) {
        const denied = "Action denied by the operator. Choose a different approach.";
        messages.push({ role: "user", content: denied });
        steps.push({ index, thought, action });
        emit({ type: "observation", step: index, text: denied });
        continue;
      }
    }

    if (action.kind === "python") kernelUsed = true;
    let result: ExecResult;
    try {
      result = await executeAction(options.executor, action, options.actionTimeoutMs, `s${index}`, options.kernel !== false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Execution failed: ${message}`, steps, messages, usage };
    }

    if (result.exitCode === 0) anySuccessfulAction = true;
    const observation = truncate(formatObservation(result), maxObs);
    messages.push({ role: "user", content: observation });
    steps.push({ index, thought, action, result, observation });
    emit({ type: "observation", step: index, text: observation });

    // Recovery: break loops and thrashing before they burn the budget.
    if (recovery !== null) {
      const signal = recovery.observe(action, result.exitCode);
      if (signal.kind === "abort") {
        emit({ type: "error", step: index, text: signal.message });
        return { status: "error", summary: signal.message, steps, messages, usage };
      }
      if (signal.kind === "nudge") {
        messages.push({ role: "user", content: signal.message });
        emit({ type: "observation", step: index, text: signal.message });
      }
    }
  }

  return {
    status: "max-steps",
    summary: `Reached the ${maxSteps}-step limit without finishing.`,
    steps,
    messages,
    usage,
  };
  } finally {
    // A local kernel is a real OS process; never leak it past the run.
    if (kernelUsed && options.kernel !== false) {
      await stopKernel(options.executor);
    }
  }
}

/**
 * Execute a code action through an executor. Shared by the live loop and
 * the durable workflow. `scriptSuffix` keeps replayed and live runs
 * writing the same paths (a durable step must be deterministic — no
 * Date.now() in filenames).
 *
 * Python prefers the persistent kernel (variables survive between
 * actions); if the kernel can't start in this workspace it falls back to
 * per-file execution. Edit/create run over getFile/putFile — structured
 * file surgery with no shell quoting anywhere.
 */
export async function executeAction(
  executor: AgentExecutor,
  action: Extract<Action, { kind: "bash" | "python" | "edit" | "create" }>,
  timeoutMs?: number,
  scriptSuffix?: string,
  useKernel = true,
): Promise<ExecResult> {
  const opts = timeoutMs !== undefined ? { timeoutMs } : {};
  const suffix = scriptSuffix ?? String(Date.now());

  switch (action.kind) {
    case "bash":
      return executor.exec(action.code, opts);

    case "python": {
      if (useKernel) {
        await installKernel(executor);
        if (await ensureKernel(executor)) {
          return runCell(executor, suffix, action.code, timeoutMs);
        }
      }
      const scriptPath = `.teploy-agent/step-${suffix}.py`;
      await executor.putFile(scriptPath, action.code);
      return executor.exec(`python3 ${scriptPath}`, opts);
    }

    case "create":
      await executor.putFile(action.file, action.content);
      return ok(`created ${action.file} (${action.content.length} chars)`);

    case "edit": {
      let current: string;
      try {
        current = new TextDecoder().decode(await executor.getFile(action.file));
      } catch {
        return fail(`edit failed: no such file: ${action.file} (use \`\`\`create for new files)`);
      }
      const occurrences = action.search === "" ? 0 : current.split(action.search).length - 1;
      if (occurrences === 0) {
        return fail(
          `edit failed: SEARCH text not found in ${action.file}. Read the file and copy the exact text (whitespace matters).`,
        );
      }
      if (occurrences > 1) {
        return fail(
          `edit failed: SEARCH text appears ${occurrences} times in ${action.file}. Include more surrounding lines to make it unique.`,
        );
      }
      await executor.putFile(action.file, current.replace(action.search, action.replace));
      return ok(`edited ${action.file}: 1 replacement`);
    }
  }
}

function ok(message: string): ExecResult {
  return { exitCode: 0, stdout: message, stderr: "", timedOut: false, truncated: false };
}

function fail(message: string): ExecResult {
  return { exitCode: 1, stdout: "", stderr: message, timedOut: false, truncated: false };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tail)}`;
}
