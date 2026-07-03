import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { Action } from "./actions.js";
import { describeAction, parseAction } from "./actions.js";
import type { ApprovalPolicy } from "./approval.js";
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

  let messages: Message[] = [
    { role: "system", content: systemPrompt({ workdir, task: options.task }) },
    { role: "user", content: "Begin. Work step by step and verify before finishing." },
  ];
  const steps: AgentStep[] = [];

  const recovery = options.recovery === false ? null : new RecoveryTracker(options.recovery ?? defaultRecoveryConfig);
  const condense = options.condense === false ? null : (options.condense ?? defaultCondenseConfig);
  const summarize = async (transcript: string): Promise<string> => {
    const generated = await generateText({
      model: options.model,
      system: "Summarize this agent transcript into a compact progress recap: what was attempted, what worked, what failed, current state, and what remains. Be specific about file names and results.",
      prompt: transcript,
      maxOutputTokens: 800,
    });
    return generated.text;
  };

  for (let index = 0; index < maxSteps; index++) {
    if (options.abortSignal?.aborted) {
      return { status: "aborted", summary: "Run aborted.", steps, messages };
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
      thought = generated.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Model call failed: ${message}`, steps, messages };
    }

    messages.push({ role: "assistant", content: thought });
    const action = parseAction(thought);
    emit({ type: "thought", step: index, text: thought });
    emit({ type: "action", step: index, text: describeAction(action) });

    if (action.kind === "finish") {
      steps.push({ index, thought, action });
      emit({ type: "finish", step: index, text: action.message });
      return { status: "finished", summary: action.message, steps, messages };
    }

    if (action.kind === "none") {
      // The model produced no runnable action; nudge it once and continue.
      const nudge = "No code block found. Respond with exactly one fenced code block (bash/python), or a ```finish block if done.";
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

    let result: ExecResult;
    try {
      result = await executeAction(options.executor, action, options.actionTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Execution failed: ${message}`, steps, messages };
    }

    const observation = truncate(formatObservation(result), maxObs);
    messages.push({ role: "user", content: observation });
    steps.push({ index, thought, action, result, observation });
    emit({ type: "observation", step: index, text: observation });

    // Recovery: break loops and thrashing before they burn the budget.
    if (recovery !== null) {
      const signal = recovery.observe(action, result.exitCode);
      if (signal.kind === "abort") {
        emit({ type: "error", step: index, text: signal.message });
        return { status: "error", summary: signal.message, steps, messages };
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
  };
}

/**
 * Execute a code action through an executor. Python runs via a written
 * file so multi-line code and tracebacks work. Shared by the live loop
 * and the durable workflow. `scriptSuffix` keeps replayed and live runs
 * writing the same path (a durable step must be deterministic — no
 * Date.now() in the filename).
 */
export async function executeAction(
  executor: AgentExecutor,
  action: Extract<Action, { kind: "bash" | "python" }>,
  timeoutMs?: number,
  scriptSuffix?: string,
): Promise<ExecResult> {
  const opts = timeoutMs !== undefined ? { timeoutMs } : {};
  if (action.kind === "bash") {
    return executor.exec(action.code, opts);
  }
  const scriptPath = `.teploy-agent/step-${scriptSuffix ?? String(Date.now())}.py`;
  await executor.putFile(scriptPath, action.code);
  return executor.exec(`python3 ${scriptPath}`, opts);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tail)}`;
}
