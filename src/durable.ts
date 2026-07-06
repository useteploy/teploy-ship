import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import { SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { workflow } from "@neutron-build/workflow";
import type { WorkflowContext, WorkflowDefinition } from "@neutron-build/workflow";

import { executeAction } from "./agent.js";
import { FINISH_NUDGE_FAILED, FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, parseAction } from "./actions.js";
import { commentOnPr, commitAndPush, fixPrompt, openPullRequest, parseRepoUrl, reviewPrompt, setupRepo, setupRepoForPr } from "./git.js";
import type { RepoCheckout } from "./git.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import type { RepoMemoryStore } from "./repo-memory.js";
import type { ApprovalPolicy } from "./approval.js";
import { formatObservation, systemPrompt } from "./prompt.js";

export interface DurableAgentInput {
  task: string;
  /**
   * When set, the run is a repo run: the workflow clones this URL as a
   * recorded step before the agent starts (credential-free remote — the
   * token comes from the executing worker's config, never the input or
   * the log) and, after the agent's work, commits/pushes any non-empty
   * diff and opens a PR as recorded steps.
   */
  repo?: string;
  /** Review follow-up: work PR #pr's existing head branch and reply there. */
  pr?: number;
}

export interface DurableAgentOutput {
  status: "finished" | "max-steps";
  summary: string;
  turns: number;
  /** PR opened by a repo run (absent for workspace runs or empty diffs). */
  pr?: string;
}

// (review follow-ups set input.pr — the run works the EXISTING PR branch
// and replies on the thread instead of opening a new PR)

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
  /** Deploy token for repo runs (clone/push/PR). Required when input.repo is set. */
  gitToken?: string;
  /** Per-repo memory: recent-run notes injected into and recorded by repo runs. */
  repoMemory?: RepoMemoryStore;
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

      // Repo runs: clone + branch as a recorded step, then hand the agent
      // a repo-aware task. On replay the step returns the recorded
      // checkout without touching the network.
      let checkout: RepoCheckout | null = null;
      if (input.repo !== undefined) {
        const repoUrl = input.repo;
        checkout = await ctx.step("repo-setup", async () => {
          const ref = parseRepoUrl(repoUrl);
          const token = config.gitToken ?? "";
          // file:// remotes (tests, local mirrors) take no credentials
          if (token === "" && ref.base !== "file://") {
            throw new Error("repo run needs gitToken on the executing worker (SHIP_GIT_TOKEN)");
          }
          return input.pr !== undefined
            ? setupRepoForPr(executor, { ref, token, pr: input.pr })
            : setupRepo(executor, { ref, token, runId: ctx.runId });
        });
      }
      // Playbook + recent-run notes, recorded so replay never re-reads
      // a tree or memory that has since changed.
      let repoContext = "";
      if (checkout !== null && input.repo !== undefined) {
        const repoKey = repoKeyOf(input.repo);
        repoContext = await ctx.step("repo-context", () =>
          loadRepoContext(executor, {
            repo: repoKey,
            ...(config.repoMemory !== undefined ? { memory: config.repoMemory } : {}),
          }),
        );
      }
      const task =
        checkout !== null
          ? input.pr !== undefined
            ? reviewPrompt({ task: input.task, branch: checkout.branch, pr: input.pr, context: repoContext })
            : fixPrompt({ task: input.task, branch: checkout.branch, base: checkout.base, context: repoContext })
          : input.task;

      const messages: Message[] = [
        { role: "system", content: systemPrompt({ workdir, task }) },
        { role: "user", content: "Begin. Work step by step and verify before finishing." },
      ];
      let anySuccessfulAction = false;
      let finishNudged = false;
      let failNudges = 0;
      let lastExecFailed = false;

      for (let turn = 0; turn < maxSteps; turn++) {
        const thought = await ctx.step(`turn-${turn}-think`, async () => {
          const generated = await generateText({ model: config.model, messages });
          return generated.text;
        });
        messages.push({ role: "assistant", content: thought });

        const action = parseAction(thought);
        if (action.kind === "finish") {
          // First finish is held once (verify-or-do-the-work), second is
          // honored; a finish on the final turn is honored immediately.
          // Both branches derive purely from replayed step results, so the
          // nudge is deterministic across resume/replay.
          if (turn + 1 < maxSteps) {
            let nudge: string | null = null;
            if (!finishNudged) {
              finishNudged = true;
              nudge = anySuccessfulAction ? FINISH_NUDGE_VERIFY : FINISH_NUDGE_NO_WORK;
            } else if (lastExecFailed && failNudges < 2) {
              failNudges += 1;
              nudge = FINISH_NUDGE_FAILED;
            }
            if (nudge !== null) {
              messages.push({ role: "user", content: nudge });
              continue;
            }
          }
          const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, action.message);
          return { status: "finished", summary: action.message, turns: turn + 1, ...(pr !== null ? { pr } : {}) };
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
        if (result.exitCode === 0) anySuccessfulAction = true;
        lastExecFailed = result.exitCode !== 0;
        messages.push({ role: "user", content: truncate(formatObservation(result), maxObs) });
      }

      // Non-empty diffs are published even off a max-steps exit — real
      // fixes die in runs that never got to say finish (SWE-bench lesson).
      const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, `Reached the ${maxSteps}-turn limit.`);
      return { status: "max-steps", summary: `Reached the ${maxSteps}-turn limit.`, turns: maxSteps, ...(pr !== null ? { pr } : {}) };
    },
    config.runTimeout !== undefined ? { timeout: config.runTimeout } : {},
  );
}

function repoKeyOf(repoUrl: string): string {
  const ref = parseRepoUrl(repoUrl);
  return `${ref.owner}/${ref.repo}`;
}

/** Recorded publish step for repo runs: commit, push, open the PR. */
async function publishIfRepoRun(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  checkout: RepoCheckout | null,
  summary: string,
): Promise<string | null> {
  if (checkout === null || input.repo === undefined) return null;
  const repoUrl = input.repo;
  const co = checkout;
  const result = await ctx.step("repo-publish", async () => {
    const token = config.gitToken ?? "";
    const ref = parseRepoUrl(repoUrl);
    const pushed = await commitAndPush(executor, {
      ref,
      token,
      checkout: co,
      message: `${input.task.slice(0, 68)}\n\nTeploy Ship ${ctx.runId}`,
    });
    // Review follow-up: the PR already exists — push updated it; reply
    // on the thread (marker doubles as the self-trigger guard).
    const remember = async (pr?: string): Promise<void> => {
      if (config.repoMemory === undefined) return;
      await config.repoMemory
        .record({
          repo: `${ref.owner}/${ref.repo}`,
          note: runNote({ task: input.task, summary, ...(pr !== undefined ? { pr } : {}) }),
          runId: ctx.runId,
        })
        .catch(() => {}); // memory is advisory — never fail a publish over it
    };
    if (input.pr !== undefined) {
      const prUrl = `${ref.base}/${ref.owner}/${ref.repo}/pulls/${input.pr}`;
      if (pushed === null) {
        await commentOnPr(ref, token, input.pr, `No code change was needed for this feedback (run ${ctx.runId}).\n\n${summary.slice(0, 800)}`);
        await remember(prUrl);
        return { pr: prUrl };
      }
      await commentOnPr(ref, token, input.pr, `Pushed ${pushed.sha.slice(0, 10)} addressing this (run ${ctx.runId}).\n\n${summary.slice(0, 800)}`);
      await remember(prUrl);
      return { pr: prUrl };
    }
    if (pushed === null) {
      await remember();
      return { pr: null };
    }
    const pr = await openPullRequest({
      ref,
      token,
      head: co.branch,
      base: co.base,
      title: input.task.length > 72 ? `${input.task.slice(0, 72)}…` : input.task,
      body: `${summary}\n\n---\nTask: ${input.task}\nRun: ${ctx.runId}\nGenerated by Teploy Ship.`,
    });
    await remember(pr.url);
    return { pr: pr.url };
  });
  return (result as { pr: string | null }).pr;
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
