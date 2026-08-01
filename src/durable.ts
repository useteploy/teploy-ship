import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import { SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { workflow } from "@neutron-build/workflow";
import type { WorkflowContext, WorkflowDefinition } from "@neutron-build/workflow";

import { executeAction } from "./agent.js";
import { FINISH_NUDGE_FAILED, FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, parseAction } from "./actions.js";
import { criticFeedback, isApproved, reviewWork } from "./critic.js";
import { commentOnPr, commitAndPush, fixPrompt, openPullRequest, parseRepoUrl, reviewPrompt, setupRepo, setupRepoForPr, tokenFor, workingDiff } from "./git.js";
import type { RepoCheckout } from "./git.js";
import { condenseIfNeeded, defaultCondenseConfig } from "./memory.js";
import type { CondenseConfig } from "./memory.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import type { RepoMemoryStore } from "./repo-memory.js";
import type { SteerStore } from "./steer.js";
import { formatSearchHits } from "./code-index.js";
import { screenUntrusted } from "./guard.js";
import type { CodeSearch } from "./code-index.js";
import { PLAN_EVENT } from "./plan.js";
import type { PlanDecisionPayload } from "./plan.js";
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
  /**
   * Plan preview: the run writes a plan first and PARKS on `PLAN_EVENT`
   * before touching anything — deliver a PlanDecisionPayload (approve /
   * approve-with-edits / deny) to continue. Opt-in per run; auto-launched
   * intake runs stay execute-first.
   */
  plan?: boolean;
  /**
   * Mid-run steering: drain the steer store at the top of every turn (a
   * recorded step) and feed the operator's notes to the agent. Gated on
   * the RUN INPUT — not config — so runs enqueued before this feature
   * replay without a step-sequence mismatch on any executor.
   */
  steer?: boolean;
  /**
   * Codebase indexing: repo runs refresh the Nucleus code index after
   * clone (a recorded step) and the agent gets the ```search action.
   * Input-gated like steer so pre-feature runs replay unchanged; the
   * executing worker still needs codeSearch configured to do real work.
   */
  index?: boolean;
  /**
   * Injection screening: when the task text (external issue/PR content)
   * matches known injection shapes, record the flags as a step so the
   * operator sees them in the run timeline. Input-gated like the others
   * so pre-feature runs replay unchanged.
   */
  guard?: boolean;
  /**
   * Post-finish critic pass: before a finish that survives the verify
   * nudge is honored, an independent reviewer (Team/TeamPolicy over a
   * single critic member — see critic.ts) checks the working-tree diff
   * against the task and either approves or sends the run back once with
   * concrete feedback. Bounded to one critic-triggered retry per run —
   * this never loops. Input-gated like steer/index/guard so pre-feature
   * runs replay unchanged. Repo runs only (it reviews a git diff); a
   * non-repo run or an empty diff skips it and finishes as today.
   */
  critic?: boolean;
}

export interface DurableAgentOutput {
  status: "finished" | "max-steps";
  summary: string;
  turns: number;
  /** PR opened by a repo run (absent for workspace runs or empty diffs). */
  pr?: string;
  /** Model usage summed across the run's turns (cache fields included). */
  usage?: RunUsage;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
  /** Turn budget for a run (default 40). See the note at its use site. */
  maxSteps?: number;
  actionTimeoutMs?: number;
  maxObservationChars?: number;
  name?: string;
  /** Total run budget passed to the workflow (e.g. "7d"). */
  runTimeout?: string | number;
  /** Deploy token for repo runs (clone/push/PR). Required when input.repo is set. */
  gitToken?: string;
  /** Token used instead for github.com repos (SHIP_GITHUB_TOKEN). */
  githubToken?: string;
  /** Per-repo memory: recent-run notes injected into and recorded by repo runs. */
  repoMemory?: RepoMemoryStore;
  /**
   * Context condensation (default on, same budgets as the live loop):
   * when the history outgrows the budget, the middle turns are replaced
   * by a summary produced in a recorded step — the decision is a pure
   * function of replayed messages, so replay stays deterministic.
   * NOTE: enabling/disabling changes the step sequence of runs long
   * enough to condense — don't flip it under in-flight runs.
   */
  condense?: CondenseConfig | false;
  /**
   * Where steer notes are drained from when input.steer is set. Absent
   * store + steer-enabled input just drains empty — the step sequence
   * stays identical across executors regardless of their wiring.
   */
  steer?: Pick<SteerStore, "drain">;
  /**
   * The Nucleus code index behind ```search and the repo-index refresh.
   * Like steer, its ABSENCE never changes the step sequence — steps run
   * whenever input.index is set and record "unavailable" results.
   */
  codeSearch?: CodeSearch;
}

export { PLAN_EVENT } from "./plan.js";
export type { PlanDecisionPayload } from "./plan.js";

const PLAN_REQUEST =
  "Before doing any work: write a short numbered plan for this task — the steps you will take, " +
  "the files you expect to touch, and how you will verify the result. Plain text only, NO code " +
  "blocks and NO commands. The operator reviews this plan before you are allowed to act.";

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
  // 40, not 20. Nothing outside the eval harness ever set this, so every
  // webhook-, Inbox- and sweep-launched run was capped at twenty model turns
  // — enough to lose a real task to the ceiling rather than to the work (the
  // SWE-bench gauge recorded a run spending its last ten steps just locating
  // pytest). Cost is bounded by the daily spend caps, not by this.
  const maxSteps = config.maxSteps ?? 40;
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
          const token = tokenFor(ref, config);
          // file:// remotes (tests, local mirrors) take no credentials
          if (token === "" && ref.base !== "file://") {
            throw new Error("repo run needs gitToken on the executing worker (SHIP_GIT_TOKEN)");
          }
          return input.pr !== undefined
            ? setupRepoForPr(executor, { ref, token, pr: input.pr })
            : setupRepo(executor, { ref, token, runId: ctx.runId });
        });
      }
      const repoKey = input.repo !== undefined ? repoKeyOf(input.repo) : null;
      // Playbook + recent-run notes, recorded so replay never re-reads
      // a tree or memory that has since changed.
      let repoContext = "";
      if (checkout !== null && repoKey !== null) {
        repoContext = await ctx.step("repo-context", () =>
          loadRepoContext(executor, {
            repo: repoKey,
            ...(config.repoMemory !== undefined ? { memory: config.repoMemory } : {}),
          }),
        );
      }
      // Refresh the Nucleus code index for this repo (incremental, hash
      // diff). Input-gated; a worker without codeSearch records "disabled"
      // so the step sequence never depends on executor wiring. Advisory —
      // an index failure degrades ```search, never the run.
      if (input.index === true && checkout !== null && repoKey !== null) {
        await ctx.step("repo-index", async () => {
          if (config.codeSearch === undefined) return "disabled (no code index configured on this worker)";
          try {
            const stats = await config.codeSearch.refresh(executor, repoKey);
            return `${stats.indexed} files indexed (${stats.chunks} chunks), ${stats.removed} removed of ${stats.files} tracked${stats.capped ? " (capped)" : ""}`;
          } catch (error) {
            return `index refresh failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        });
      }
      // Surface injection attempts in the external task text on the run
      // timeline. screenUntrusted is a pure function of the recorded
      // input, so step PRESENCE (only when flagged) replays identically.
      if (input.guard === true && repoKey !== null) {
        const screen = screenUntrusted(input.task);
        if (screen.flags.length > 0) {
          await ctx.step("injection-guard", () => ({
            flagged: screen.flags,
            note: "task text matched injection patterns; it is framed as data and cannot approve actions",
          }));
        }
      }
      const task =
        checkout !== null
          ? input.pr !== undefined
            ? reviewPrompt({ task: input.task, branch: checkout.branch, pr: input.pr, context: repoContext })
            : fixPrompt({ task: input.task, branch: checkout.branch, base: checkout.base, context: repoContext })
          : input.task;

      const searchable = input.index === true && checkout !== null && config.codeSearch !== undefined;
      let messages: Message[] = [{ role: "system", content: systemPrompt({ workdir, task, search: searchable }) }];
      let anySuccessfulAction = false;
      let finishNudged = false;
      let failNudges = 0;
      let lastExecFailed = false;
      let criticDone = false;

      const usage: RunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const addUsage = (u: Partial<RunUsage> | undefined): void => {
        if (u === undefined) return;
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
        usage.totalTokens += u.totalTokens ?? 0;
        if (u.cacheReadTokens !== undefined) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cacheReadTokens;
        if (u.cacheWriteTokens !== undefined) usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
      };

      // Plan preview: think the plan, park on the operator's decision,
      // then work under the approved (possibly edited) plan. The park
      // reuses the approval machinery — snapshot before, restore after —
      // so a plan reviewed days later still has its workspace.
      if (input.plan === true) {
        messages.push({ role: "user", content: PLAN_REQUEST });
        const planStep = await ctx.step("plan-think", async () => {
          const generated = await generateText({ model: config.model, messages });
          return { text: generated.text, usage: generated.usage };
        });
        addUsage(planStep.usage);

        const canSnapshot = config.executor.snapshot !== undefined && config.executor.createFrom !== undefined;
        let parkImage: string | undefined;
        if (canSnapshot) {
          parkImage = await ctx.step("plan-snapshot", () => config.executor.snapshot!(handle));
        }
        const decision = await ctx.waitForEvent<PlanDecisionPayload>(PLAN_EVENT);
        if (parkImage !== undefined) {
          handle = await ctx.step("plan-restore", async () => (await config.executor.createFrom!(parkImage)).handle);
          executor = config.executor.attach(handle);
        }

        if (!decision.approved) {
          const reason = decision.reason !== undefined ? `: ${decision.reason}` : "";
          return { status: "finished", summary: `Plan rejected by the operator${reason}.`, turns: 0, usage };
        }
        const edited =
          typeof decision.plan === "string" &&
          decision.plan.trim() !== "" &&
          decision.plan.trim() !== planStep.text.trim();
        messages.push({ role: "assistant", content: planStep.text.trim() === "" ? "(no plan)" : planStep.text });
        messages.push({
          role: "user",
          content: edited
            ? `The operator approved an EDITED version of your plan — follow THIS version, not your original:\n\n${decision.plan!.trim()}\n\nExecute it now, step by step, and verify before finishing.`
            : "The operator approved your plan. Execute it now, step by step, and verify before finishing.",
        });
      } else {
        messages.push({ role: "user", content: "Begin. Work step by step and verify before finishing." });
      }

      const condense = config.condense === false ? null : (config.condense ?? defaultCondenseConfig);

      for (let turn = 0; turn < maxSteps; turn++) {
        // Mid-run steering: drain the operator's pending notes as a
        // recorded step (the store is read once, live; replay returns the
        // recorded notes). Advisory — a store hiccup never fails the run.
        if (input.steer === true) {
          const steers = await ctx.step(`turn-${turn}-steer`, async () =>
            config.steer !== undefined ? config.steer.drain(ctx.runId).catch(() => []) : [],
          );
          for (const text of steers) {
            messages.push({ role: "user", content: `Operator steering — adjust course accordingly: ${text}` });
          }
        }

        if (condense !== null) {
          messages = await condenseIfNeeded(
            messages,
            async (transcript) => {
              const summaryStep = await ctx.step(`turn-${turn}-condense`, async () => {
                const generated = await generateText({
                  model: config.model,
                  system:
                    "Summarize this agent transcript into a compact progress recap: what was attempted, what worked, what failed, current state, and what remains. Be specific about file names and results.",
                  prompt: transcript,
                  maxOutputTokens: 800,
                });
                return { text: generated.text, usage: generated.usage };
              });
              addUsage(summaryStep.usage);
              return summaryStep.text;
            },
            condense,
          );
        }

        // The step records { text, usage } so replay re-accumulates cost
        // without re-calling the model. Logs from before telemetry
        // recorded the bare text — both shapes replay.
        const generatedStep = await ctx.step(`turn-${turn}-think`, async () => {
          const generated = await generateText({ model: config.model, messages });
          return { text: generated.text, usage: generated.usage };
        });
        const step = typeof generatedStep === "string" ? { text: generatedStep, usage: undefined } : generatedStep;
        const thought = step.text;
        addUsage(step.usage);
        // An empty model response serializes to an empty text content block,
        // which Anthropic rejects on the next call — never store it empty
        // (parseAction on "" gives a "none" action → nudged below).
        messages.push({ role: "assistant", content: thought.trim() === "" ? "(no response)" : thought });

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
            } else if (input.critic === true && checkout !== null && !criticDone) {
              criticDone = true;
              // Both failures are caught INSIDE the step, so the step always
              // records a value rather than throwing: a step that throws would
              // re-run on replay and could take a different branch, breaking
              // determinism. Same fail-open-on-broken-review rule as the live
              // loop in agent.ts — a real non-approval verdict still blocks.
              const diff = await ctx.step(`turn-${turn}-critic-diff`, async () => {
                try {
                  return await workingDiff(executor);
                } catch {
                  return "";
                }
              });
              if (diff.trim() !== "") {
                const reviewStep = await ctx.step(`turn-${turn}-critic`, async () => {
                  try {
                    const review = await reviewWork(config.model, { task: input.task, summary: action.message, diff });
                    return { text: review.text, usage: review.usage, reviewed: true };
                  } catch {
                    return { text: "", usage: undefined, reviewed: false };
                  }
                });
                addUsage(reviewStep.usage);
                if (reviewStep.reviewed && !isApproved(reviewStep.text)) {
                  nudge = criticFeedback(reviewStep.text);
                }
              }
            }
            if (nudge !== null) {
              messages.push({ role: "user", content: nudge });
              continue;
            }
          }
          const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, action.message);
          return { status: "finished", summary: action.message, turns: turn + 1, usage, ...(pr !== null ? { pr } : {}) };
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

        // Semantic retrieval: worker-side (Nucleus + embedder), recorded —
        // replay returns the recorded hits on any executor, wired or not.
        if (action.kind === "search") {
          const query = action.query;
          const observation = await ctx.step(`turn-${turn}-search`, async () => {
            if (config.codeSearch === undefined || repoKey === null) {
              return "Code search is not available in this run. Use grep/rg via ```bash instead.";
            }
            try {
              return formatSearchHits(query, await config.codeSearch.search(repoKey, query));
            } catch (error) {
              return `Code search failed (${error instanceof Error ? error.message : String(error)}). Use grep/rg via \`\`\`bash instead.`;
            }
          });
          messages.push({ role: "user", content: truncate(observation, maxObs) });
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
      return { status: "max-steps", summary: `Reached the ${maxSteps}-turn limit.`, turns: maxSteps, usage, ...(pr !== null ? { pr } : {}) };
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
    const ref = parseRepoUrl(repoUrl);
    const token = tokenFor(ref, config);
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
  /** Sandbox network mode for the run (default "none" — the daemon's safe default). */
  network?: "none" | "egress";
  fetch?: typeof globalThis.fetch;
}): ExecutorProvider {
  const base = { baseURL: options.baseURL, token: options.token, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) };
  const create = {
    image: options.image,
    ...(options.ttlSec !== undefined ? { ttlSec: options.ttlSec } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
  };
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
