import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import { SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { workflow } from "@neutron-build/workflow";
import type { WorkflowContext, WorkflowDefinition } from "@neutron-build/workflow";

import { executeAction } from "./agent.js";
import { parseAction } from "./actions.js";
import type { ApprovalPolicy } from "./approval.js";
import { formatObservation, systemPrompt } from "./prompt.js";

export interface DurableAgentInput {
  task: string;
}

export interface DurableAgentOutput {
  status: "finished" | "max-steps";
  summary: string;
  turns: number;
}

/**
 * Supplies the executor. `create` runs once (recorded as a step) and
 * returns a serializable handle; `attach` reconstructs a client from that
 * handle on every execution pass — including replays and post-suspension
 * resumes — with no I/O.
 */
export interface ExecutorProvider {
  create: () => Promise<{ handle: string }>;
  attach: (handle: string) => AgentExecutor;
  /**
   * Optional snapshot support (both or neither). With it, the durable
   * agent snapshots the workspace before parking on approval and
   * restores from the snapshot after the decision — so a parked run
   * survives its container's TTL. `snapshot` returns a durable image
   * ref; `createFrom` boots a fresh workspace from one.
   */
  snapshot?: (handle: string) => Promise<string>;
  createFrom?: (image: string) => Promise<{ handle: string }>;
}

export interface DurableAgentConfig {
  model: ModelAdapter;
  executor: ExecutorProvider;
  /** Deterministic classifier: "required" actions park the run on an approval event. */
  approveAction?: ApprovalPolicy;
  workdir?: string;
  maxSteps?: number;
  actionTimeoutMs?: number;
  maxObservationChars?: number;
  name?: string;
  /** Total run budget passed to the workflow (e.g. "7d"). */
  runTimeout?: string | number;
}

/** The event name a turn's approval-required action parks on. Deliver {approved, reason?}. */
export function approvalEvent(turn: number): string {
  return `turn-${turn}-approval`;
}

export interface ApprovalDecisionPayload {
  approved: boolean;
  reason?: string;
}

/**
 * The CodeAct agent as a durable workflow. Every model call and every
 * execution is a recorded step, so a crashed run replays completed turns
 * from the log and continues without re-calling the model or re-running
 * commands. Approval-required actions park the run on a `waitForEvent`
 * (deliver an ApprovalDecisionPayload to `approvalEvent(turn)`), so a
 * human gate costs nothing while pending — the AI SDK/Workflow approval
 * bridge applied to a coding agent.
 *
 * Durability across long parks: when the provider supports snapshots
 * (see ExecutorProvider), the workspace is committed to an image before
 * every approval park and restored into a fresh container after the
 * decision — so a run parked for days survives its container's TTL.
 * Without snapshot support, the old limitation stands: approvals must
 * resolve within the container's lifetime. Crash-recovery replay within
 * a run works in both cases.
 */
export function durableAgent(
  config: DurableAgentConfig,
): WorkflowDefinition<DurableAgentInput, DurableAgentOutput> {
  const workdir = config.workdir ?? "/work";
  const maxSteps = config.maxSteps ?? 20;
  const maxObs = config.maxObservationChars ?? 8000;

  return workflow<DurableAgentInput, DurableAgentOutput>(
    config.name ?? "coding-agent",
    async (ctx: WorkflowContext, input: DurableAgentInput): Promise<DurableAgentOutput> => {
      let handle = await ctx.step("sandbox", async () => (await config.executor.create()).handle);
      let executor = config.executor.attach(handle);

      const messages: Message[] = [
        { role: "system", content: systemPrompt({ workdir, task: input.task }) },
        { role: "user", content: "Begin. Work step by step and verify before finishing." },
      ];

      for (let turn = 0; turn < maxSteps; turn++) {
        const thought = await ctx.step(`turn-${turn}-think`, async () => {
          const generated = await generateText({ model: config.model, messages });
          return generated.text;
        });
        messages.push({ role: "assistant", content: thought });

        const action = parseAction(thought);
        if (action.kind === "finish") {
          return { status: "finished", summary: action.message, turns: turn + 1 };
        }
        if (action.kind === "none" || action.kind === "invalid") {
          messages.push({
            role: "user",
            content:
              action.kind === "invalid"
                ? action.message
                : "No code block found. Respond with exactly one fenced code block, or a ```finish block if done.",
          });
          continue;
        }

        // Approval policy is deterministic (pure classifier), so the
        // decision to park replays identically; only the human decision
        // is external input, delivered via waitForEvent.
        const decision = config.approveAction ? await config.approveAction(action) : "auto";
        if (decision === "required") {
          // With snapshot support, persist the workspace BEFORE parking:
          // the park can outlive the container's TTL. The snapshot ref is
          // a recorded step result, so replay reconstructs it for free.
          const canSnapshot = config.executor.snapshot !== undefined && config.executor.createFrom !== undefined;
          let parkImage: string | undefined;
          if (canSnapshot) {
            parkImage = await ctx.step(`turn-${turn}-snapshot`, () => config.executor.snapshot!(handle));
          }

          const approval = await ctx.waitForEvent<ApprovalDecisionPayload>(approvalEvent(turn));

          // Restore AFTER the park either way (approved or denied — the
          // run continues in both cases and the original container may
          // be long gone). The new handle is a recorded step result, so
          // replay re-attaches identically without re-creating anything.
          if (parkImage !== undefined) {
            handle = await ctx.step(`turn-${turn}-restore`, async () => (await config.executor.createFrom!(parkImage)).handle);
            executor = config.executor.attach(handle);
          }

          if (!approval.approved) {
            const reason = approval.reason !== undefined ? `: ${approval.reason}` : "";
            messages.push({ role: "user", content: `Action denied by the operator${reason}. Choose a different approach.` });
            continue;
          }
        }

        const result = await ctx.step(`turn-${turn}-exec`, () =>
          executeAction(executor, action, config.actionTimeoutMs, `t${turn}`),
        );
        messages.push({ role: "user", content: truncate(formatObservation(result), maxObs) });
      }

      return { status: "max-steps", summary: `Reached the ${maxSteps}-turn limit.`, turns: maxSteps };
    },
    config.runTimeout !== undefined ? { timeout: config.runTimeout } : {},
  );
}

/**
 * ExecutorProvider over a live teploy-sandbox daemon, snapshot-capable —
 * the production wiring for durable Ship runs. Handles are
 * "runId" strings; snapshots are daemon image refs.
 */
export function sandboxProvider(options: {
  baseURL: string;
  token: string;
  image: string;
  ttlSec?: number;
  fetch?: typeof globalThis.fetch;
}): ExecutorProvider {
  const base = { baseURL: options.baseURL, token: options.token, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) };
  const create = { image: options.image, ...(options.ttlSec !== undefined ? { ttlSec: options.ttlSec } : {}) };
  return {
    async create() {
      const sandbox = await SandboxExecutor.start({ ...base, create });
      return { handle: sandbox.runId };
    },
    attach(handle: string) {
      return SandboxExecutor.attach(handle, base);
    },
    async snapshot(handle: string) {
      return SandboxExecutor.attach(handle, base).snapshot();
    },
    async createFrom(image: string) {
      const sandbox = await SandboxExecutor.start({ ...base, create: { ...create, image } });
      return { handle: sandbox.runId };
    },
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-(max - head))}`;
}
