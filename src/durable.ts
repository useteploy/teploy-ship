import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import { SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { workflow } from "@neutron-build/workflow";
import type { WorkflowContext, WorkflowDefinition } from "@neutron-build/workflow";

import { executeAction, workspaceFingerprint } from "./agent.js";
import { FINISH_NUDGE_CLEAN_TREE, FINISH_NUDGE_FAILED, FINISH_NUDGE_NO_EVIDENCE, FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, parseAction } from "./actions.js";
import { criticFeedback, isApproved, reviewWork } from "./critic.js";
import {
  commentOnPr,
  commitAndPush,
  findOpenPullRequest,
  fixPrompt,
  openPullRequest,
  parseRepoUrl,
  pullRequestUrl,
  reviewPrompt,
  setupRepo,
  setupRepoForPr,
  resolvePr,
  workingDiff,
} from "./git.js";
import { deployPreview, previewComment, type PreviewOutcome, type PreviewTarget } from "./deploy.js";
import { refusalMessage, warningMessage } from "./publish-policy.js";
import type { RepoCheckout, RepoRef } from "./git.js";
import { assertRepoAllowed, credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig, RepoTrust } from "./repo-policy.js";
import { condenseIfNeeded, defaultCondenseConfig } from "./memory.js";
import type { CondenseConfig } from "./memory.js";
import { RecoveryTracker, defaultRecoveryConfig } from "./recovery.js";
import type { RecoveryConfig } from "./recovery.js";
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
import { costUSD } from "./pricing.js";

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
   * Where `repo` came from. "external" (webhook, chat, issue text) may only
   * name an allowlisted origin; "operator" (an authenticated human typed it)
   * is additionally allowed when no allowlist is configured. Absent means
   * operator, so runs enqueued before this field existed replay unchanged.
   * See repo-policy.ts.
   */
  trust?: RepoTrust;
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
  /**
   * Stuck detection (default OFF here, unlike the live loop where it is on).
   * `true` uses `defaultRecoveryConfig`; an object overrides individual
   * thresholds; `false` is an explicit opt-out that also disables `settle`,
   * matching runAgent's `recovery: false`.
   *
   * TWO things ride in the RUN INPUT rather than in DurableAgentConfig, and
   * both are load-bearing rather than stylistic:
   *
   * - PRESENCE, like steer/index/guard/critic: a run enqueued before this
   *   feature existed has no `recovery` in its `run-started` input, so it
   *   replays without the per-turn fingerprint step and cannot trip a
   *   step-sequence mismatch on a worker running the new code.
   * - THE THRESHOLDS. These decide which turn the run TERMINATES on. A worker
   *   configured with a tighter threshold than the one the log was written
   *   under would return early, leaving recorded steps unconsumed —
   *   `leftoverCursorEvent()` then raises NondeterminismError, which
   *   `executeRun` THROWS rather than records, leaving the run permanently
   *   unrunnable rather than merely failed. Config-level tuning would be a
   *   live nondeterminism bug; input-level tuning is fixed at enqueue.
   */
  recovery?: boolean | RecoveryTuning;
  /**
   * Deliberate termination (default off): when the tree already holds a change
   * and successful commands stop changing it, the agent is verifying rather
   * than building — offer it a finish, and end the run as `settled` rather
   * than as `stuck`. See RunAgentOptions.finishWhenSettled in agent.ts for the
   * measured motivation and for how to read a sweep that has it on.
   *
   * It is a branch of the stuck detector, so it turns the tracker on by
   * itself; `recovery: false` still disables both.
   */
  settle?: boolean;
  /**
   * Hold a finish whose working tree is UNCHANGED (default off).
   *
   * The finish gate otherwise asks only whether a COMMAND succeeded, which an
   * agent satisfies with read-only ones while writing nothing. On the
   * 2026-08-18 cross-family run, 4 of 9 claude-haiku-4-5 runs reported
   * `finished` having never edited a file, against 0 of 100 GLM runs — the
   * empty-patch rate tracked model FAMILY, not model strength, which is what
   * makes it a harness defect rather than a capability gap.
   *
   * On the run input rather than config, and absent by default, because it
   * adds a recorded step (`turn-N-finish-tree`): a worker replaying a log
   * written before this existed must not find a step the log does not contain.
   */
  requireEdit?: boolean;
  /**
   * Deploy the pushed branch to a preview environment and link it on the PR.
   *
   * Absent by default, like every other capability on this input, because it
   * adds recorded steps (`preview-deploy`, `preview-comment`) and step
   * presence must be a function of the recorded input — no run enqueued before
   * this field existed replays differently.
   *
   * Advisory end to end: a preview that fails is reported on the pull request
   * and never fails the run. The change is the deliverable; the URL is
   * evidence about it.
   */
  preview?: boolean;
  /**
   * "This run has no `repo`, but its workspace is already a git tree — scope
   * its code index here and let the diff-based passes run."
   *
   * Four capabilities used to be gated on `checkout !== null`, i.e. on the run
   * having cloned a repository: the `repo-index` refresh, the prompt's
   * advertisement of ```search, the ```search handler itself, and the critic.
   * A workspace run therefore got NONE of them, silently — `--durable --critic`
   * with no `--repo` was a no-op that logged nothing, and a benchmark of the
   * product path could not include the critic or the index at all. (A
   * SWE-bench container cannot be a repo run: /testbed is pip-installed
   * editable, so an agent editing a clone elsewhere is graded against the
   * untouched original.)
   *
   * The critic only ever needed a git diff and the index only ever needed a
   * scope key, so the honest gate is "is there a keyed git workspace", which is
   * what this supplies. It rides on the run INPUT, absent by default, for the
   * same reason as steer/index/guard/critic/requireEdit above: every branch it
   * widens adds a recorded step (`repo-index`, `turn-N-search`,
   * `turn-N-critic-diff`, `turn-N-critic`), and step PRESENCE must be a
   * function of the recorded input. No log written before this field existed
   * contains it, so nothing enqueued earlier replays differently.
   *
   * It is NOT a substitute for `repo`: no clone, no branch, no commit, no PR.
   */
  workspaceKey?: string;
}

/**
 * Per-run recovery thresholds. `settle` is omitted because it is its own input
 * flag above — one switch, one place.
 */
export type RecoveryTuning = Partial<Omit<RecoveryConfig, "settle">>;

export interface DurableAgentOutput {
  /**
   * "plan-rejected" is terminal-but-not-success: the operator denied the plan,
   * so nothing was built. It used to report "finished", which made a refusal
   * indistinguishable from a completed task in dashboards, metrics and
   * notifications. "budget-exhausted" likewise records that the run was stopped
   * by its cost ceiling rather than by finishing or running out of turns.
   *
   * "stuck" and "settled" are the two endings stuck detection adds (input
   * `recovery` / `settle`). Neither is the agent saying "done": "stuck" is the
   * harness cutting a looping, thrashing or spinning run short, "settled" is a
   * tree that holds a complete-looking change and stopped moving. Both publish
   * their work as an INCOMPLETE (draft/WIP) pull request for that reason.
   */
  status: "finished" | "max-steps" | "plan-rejected" | "budget-exhausted" | "stuck" | "settled";
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
/**
 * Maps the CLI's --settle onto the durable run input.
 *
 * Extracted so it can be pinned by a test. Deleting the single spread that
 * used to live inline in executePass left the whole suite green while
 * `teploy-ship run --durable --settle` became a silent no-op — the flag is
 * registered in args.ts and honoured in durable.ts, and only this line joined
 * them. That is the house's signature shape: correct on both ends, unwired in
 * between.
 *
 * --settle turns the stuck detector on as well: settle is a branch of it, and
 * a durable input has no "recovery defaults on" to opt out of, so gating it
 * the way runAgent does would make the flag a no-op here.
 */
export function durableRecoveryInput(
  opts?: { settle?: boolean },
): { recovery?: true; settle?: true } {
  return opts?.settle === true ? { recovery: true, settle: true } : {};
}

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
  /**
   * Does this provider isolate the agent from the host?
   *
   * Load-bearing rather than informational: a run whose task came from outside
   * will not execute on a non-isolating provider (see the check in the
   * workflow). Providers must be honest here — false is the safe answer.
   */
  isolated?: boolean;
  snapshot?: (handle: string) => Promise<string>;
  createFrom?: (image: string) => Promise<{ handle: string }>;
  /**
   * Release a workspace. Optional, and deliberately best-effort: the provider
   * had no way to say "done with this" at all, so every run's container sat
   * allocated until the daemon's TTL reaper noticed — and a snapshot-restore
   * cycle left the SUPERSEDED container behind too, so one run that parked
   * three times held four workspaces. On a busy box that is most of the
   * capacity.
   */
  destroy?: (handle: string) => Promise<void>;
}

export interface DurableAgentConfig {
  model: ModelAdapter;
  executor: ExecutorProvider;
  /** Deterministic classifier: "required" actions park the run on an approval event. */
  approveAction?: ApprovalPolicy;
  workdir?: string;
  /** Turn budget for a run (default 40). See the note at its use site. */
  maxSteps?: number;
  /**
   * Model id for pricing this run's usage. Only needed for the per-run cost
   * ceiling below; the adapter itself carries no id we can price from.
   */
  modelId?: string;
  /**
   * Hard per-run spend ceiling in USD (0 or absent disables it). Turn count is
   * a poor proxy for cost — one turn can carry a huge context, a condensation
   * call and a critic pass — so a run that is expensive rather than long was
   * previously bounded by nothing until the DAILY cap noticed after the fact.
   * Checked before each model call; crossing it ends the run as
   * "budget-exhausted" with whatever work exists published as normal.
   */
  maxRunCostUSD?: number;
  actionTimeoutMs?: number;
  maxObservationChars?: number;
  name?: string;
  /** Total run budget passed to the workflow (e.g. "7d"). */
  runTimeout?: string | number;
  /** Deploy token for repo runs (clone/push/PR). Required when input.repo is set. */
  gitToken?: string;
  /** Token used instead for github.com repos (SHIP_GITHUB_TOKEN). */
  githubToken?: string;
  /**
   * Repository allowlist + per-origin credentials. Defaults to the process
   * environment; gitToken/githubToken above fold into it as the fallbacks.
   */
  repoPolicy?: RepoPolicyConfig;
  /** Per-repo memory: recent-run notes injected into and recorded by repo runs. */
  repoMemory?: RepoMemoryStore;
  /**
   * Where this worker may deploy previews, if it may at all.
   *
   * Worker wiring, deliberately NOT part of the run input: it names a
   * directory and a binary on this host, and it carries the credentials that
   * reach the deploy target. A run says whether it WANTS a preview; only the
   * operator says where one can go. A worker without this records the step as
   * disabled rather than skipping it, so the step sequence stays a function of
   * the input — same rule as the code index.
   */
  preview?: PreviewTarget;
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
  // Single-token config folds into the policy so credential selection and the
  // allowlist are one lookup rather than two places that can disagree.
  const repoPolicy: RepoPolicyConfig = {
    ...policyFromEnv(),
    ...config.repoPolicy,
    ...(config.gitToken !== undefined ? { gitToken: config.gitToken } : {}),
    ...(config.githubToken !== undefined ? { githubToken: config.githubToken } : {}),
  };

  return workflow<DurableAgentInput, DurableAgentOutput>(
    config.name ?? "coding-agent",
    async (ctx: WorkflowContext, input: DurableAgentInput): Promise<DurableAgentOutput> => {
      // Untrusted work needs isolation, and the check belongs HERE rather than
      // at process start: a worker that refuses to boot is a worker whose
      // operator reaches for the override, and then everything is unsandboxed
      // forever. Refusing the specific run instead keeps the dashboard, manual
      // runs and operator-launched work fully functional, and puts the reason
      // on the run where whoever triggered it will actually read it.
      if (input.trust === "external" && config.executor.isolated !== true && !allowUnsandboxedIntake()) {
        throw new Error(
          "refusing to run an externally-sourced task without an isolated executor: this task came from a webhook, " +
            "chat message, or issue body, and agent commands would run directly on the host. Configure a sandbox " +
            "(SHIP_SANDBOX_URL + SHIP_SANDBOX_TOKEN), or set SHIP_ALLOW_UNSANDBOXED_INTAKE=1 if this machine is " +
            "genuinely disposable.",
        );
      }
      let handle = await ctx.step("sandbox", async () => (await config.executor.create()).handle);
      let executor = config.executor.attach(handle);

      // Repo runs: clone + branch as a recorded step, then hand the agent
      // a repo-aware task. On replay the step returns the recorded
      // checkout without touching the network.
      let checkout: RepoCheckout | null = null;
      if (input.repo !== undefined) {
        const repoUrl = input.repo;
        checkout = await ctx.step("repo-setup", async () => {
          // The last gate before a credential meets an origin. Intake screens
          // the URL too, but this run may have been enqueued by an older
          // binary or a surface that forgot to — so the check that actually
          // guards the token lives next to the token.
          const ref = assertRepoAllowed(repoUrl, { trust: input.trust ?? "operator", config: repoPolicy });
          const token = credentialFor(ref, repoPolicy);
          // file:// remotes (tests, local mirrors) take no credentials
          if (token === "" && ref.base !== "file://") {
            throw new Error("repo run needs a git credential on the executing worker (SHIP_GIT_TOKEN or SHIP_GIT_TOKENS)");
          }
          if (input.pr === undefined) return setupRepo(executor, { ref, token, runId: ctx.runId });
          // A fork PR's head branch lives in another repository, which the
          // allowlist has to cover too — resolve its credential the same way.
          const resolved = await resolvePr(ref, token, input.pr);
          const headToken =
            resolved.headRepo !== undefined
              ? credentialFor(assertRepoAllowed(resolved.headRepo, { trust: "external", config: repoPolicy }), repoPolicy)
              : "";
          return setupRepoForPr(executor, { ref, token, pr: input.pr, ...(headToken !== "" ? { headToken } : {}) });
        });
      }
      const repoKey = input.repo !== undefined ? repoKeyOf(input.repo) : null;
      /**
       * The code-index scope for this run: the repo key on a repo run, the
       * caller's `workspaceKey` on a keyed workspace run, null when there is
       * neither. `repoKey !== null` and `checkout !== null` are the same
       * condition (both derive from `input.repo`), so this is exactly the old
       * gate widened by one absent-by-default input field.
       */
      const scopeKey = repoKey ?? input.workspaceKey ?? null;
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
      if (input.index === true && scopeKey !== null) {
        await ctx.step("repo-index", async () => {
          if (config.codeSearch === undefined) return "disabled (no code index configured on this worker)";
          try {
            const stats = await config.codeSearch.refresh(executor, scopeKey);
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

      const searchable = input.index === true && scopeKey !== null && config.codeSearch !== undefined;
      let messages: Message[] = [{ role: "system", content: systemPrompt({ workdir, task, search: searchable }) }];
      let anySuccessfulAction = false;
      /** Bounded holds for a finish over an unchanged tree. See FINISH_NUDGE_CLEAN_TREE. */
      let cleanTreeNudges = 0;
      let finishNudged = false;
      let evidenceNudged = false;
      /** Executions (successful or not) since the verify nudge was issued. */
      let execsSinceNudge = 0;
      let failNudges = 0;
      let lastExecFailed = false;
      let criticDone = false;
      /**
       * The most recent finish the gate HELD, and only when the hold was the
       * benign "prove it" one. A run that ends on a harness sentence while one
       * of these exists throws away the agent's own account of the work —
       * which becomes the PR body and the repo-memory note.
       */
      let lastHeldFinish: string | undefined;

      // Stuck detection. The tracker itself is never persisted: it is a pure
      // state machine over (action, exitCode, fingerprint), so replaying the
      // same recorded observations in the same order re-derives the same state
      // — exactly how anySuccessfulAction/finishNudged/criticDone above are
      // already re-derived on every pass.
      const recoveryTuning: RecoveryTuning =
        typeof input.recovery === "object" && input.recovery !== null ? input.recovery : {};
      const recoveryOn = input.recovery !== false && (input.recovery !== undefined || input.settle === true);
      const recovery = recoveryOn
        ? new RecoveryTracker({
            ...defaultRecoveryConfig,
            ...recoveryTuning,
            ...(input.settle === true ? { settle: true } : {}),
          })
        : null;

      const maxRunCostUSD = config.maxRunCostUSD ?? 0;
      const modelId = config.modelId ?? "";
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
          const superseded = handle;
          handle = await ctx.step("plan-restore", async () => (await config.executor.createFrom!(parkImage)).handle);
          executor = config.executor.attach(handle);
          // The snapshot captured everything the old container held; keeping it
          // allocated through the park (and every later park) is pure waste.
          if (superseded !== handle) await dispose(config, superseded);
        }

        if (!decision.approved) {
          const reason = decision.reason !== undefined ? `: ${decision.reason}` : "";
          // Nothing will run in the freshly restored workspace — let it go.
          await dispose(config, handle);
          return { status: "plan-rejected", summary: `Plan rejected by the operator${reason}.`, turns: 0, usage };
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
        // Cost ceiling, checked before spending more. Derived purely from
        // replayed step usage, so a resumed run stops at the same turn.
        if (maxRunCostUSD > 0 && costUSD(modelId, usage) >= maxRunCostUSD) {
          const spent = costUSD(modelId, usage);
          const summary = `Stopped at the $${maxRunCostUSD.toFixed(2)} per-run cost ceiling (spent ~$${spent.toFixed(2)}) after ${turn} turns.`;
          const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, summary, repoPolicy, true);
          await dispose(config, handle);
          return { status: "budget-exhausted", summary, turns: turn, usage, ...(pr !== null ? { pr } : {}) };
        }
        // Mid-run steering: drain the operator's pending notes as a
        // recorded step (the store is read once, live; replay returns the
        // recorded notes). Advisory — a store hiccup never fails the run.
        if (input.steer === true) {
          // Keyed by turn so the drain is idempotent: this mutates the store
          // before the step result is committed, and a crash in that window
          // would otherwise consume the operator's notes without delivering
          // them (they are not in the log, and they are no longer pending).
          const steers = await ctx.step(`turn-${turn}-steer`, async () =>
            config.steer !== undefined ? config.steer.drain(ctx.runId, turn).catch(() => []) : [],
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
              execsSinceNudge = 0;
              nudge = anySuccessfulAction ? FINISH_NUDGE_VERIFY : FINISH_NUDGE_NO_WORK;
            } else if (lastExecFailed && failNudges < 2) {
              failNudges += 1;
              nudge = FINISH_NUDGE_FAILED;
            } else if (!evidenceNudged && execsSinceNudge === 0) {
              // Asked to prove the work and came back having run NOTHING — the
              // hallucinated-verification finish the gate exists to catch.
              evidenceNudged = true;
              nudge = FINISH_NUDGE_NO_EVIDENCE;
            } else if (
              // The tree check, ported from agent.ts. The branches above ask
              // whether a COMMAND succeeded, which an agent satisfies with cat,
              // grep and pytest while writing nothing — 4 of 9 haiku runs
              // finished that way on 2026-08-18 against 0 of 100 GLM runs.
              //
              // Gated on `requireEdit` and bounded at two holds. The gate has
              // to live on the run INPUT, not on config: it adds a recorded
              // step, and a worker replaying an OLD log under new code would
              // otherwise find a step the log does not contain. Absent from the
              // input means no step, so every existing run replays untouched.
              input.requireEdit === true &&
              // Deliberately NOT gated on `checkout !== null`, unlike the
              // critic below. The critic needs a repo checkout to diff against;
              // workspaceFingerprint only needs a git workspace, and requiring
              // a checkout would make this inert for plain durable runs — which
              // are exactly the ones with no PR review to catch an empty result.
              cleanTreeNudges < 2 &&
              (await ctx.step(`turn-${turn}-finish-tree`, async () => {
                try {
                  const fp = await workspaceFingerprint(executor);
                  return fp !== undefined && !fp.dirty;
                } catch {
                  return false;
                }
              }))
            ) {
              cleanTreeNudges += 1;
              nudge = FINISH_NUDGE_CLEAN_TREE;
            } else if (
              input.critic === true &&
              // A git diff is all the critic needs, so a keyed workspace run
              // qualifies as well as a repo checkout. Gating on the checkout
              // alone made `--durable --critic` with no `--repo` a silent
              // no-op, and made the critic unreachable on the product's own
              // benchmark path.
              (checkout !== null || input.workspaceKey !== undefined) &&
              !criticDone
            ) {
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
              // Only the benign "prove it" hold leaves the agent's claim usable
              // as the run's official account. Every other hold is a REJECTION
              // — NO_WORK (nothing done), FAILED (its last command failed),
              // NO_EVIDENCE (claimed verification it never ran), or a critic
              // disapproval — and adopting the claim there would launder a
              // judgement the run explicitly refused into the PR body and the
              // repo-memory note. Assignment, not a conditional set: an earlier
              // VERIFY claim must not survive a later rejection.
              lastHeldFinish = nudge === FINISH_NUDGE_VERIFY ? action.message : undefined;
              messages.push({ role: "user", content: nudge });
              continue;
            }
          }
          const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, action.message, repoPolicy);
          await dispose(config, handle);
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
            if (config.codeSearch === undefined || scopeKey === null) {
              return "Code search is not available in this run. Use grep/rg via ```bash instead.";
            }
            try {
              return formatSearchHits(query, await config.codeSearch.search(scopeKey, query));
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
            const superseded = handle;
            handle = await ctx.step(`turn-${turn}-restore`, async () => (await config.executor.createFrom!(parkImage)).handle);
            executor = config.executor.attach(handle);
            if (superseded !== handle) await dispose(config, superseded);
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
        execsSinceNudge += 1;
        lastExecFailed = result.exitCode !== 0;
        messages.push({ role: "user", content: truncate(formatObservation(result), maxObs) });

        // Recovery: break loops, thrashing and busywork before they burn the
        // turn budget. The progress fingerprint is what turns "the command
        // worked" into "the work moved".
        //
        // The read is real I/O, so it lives INSIDE a step — that is the whole
        // reason it is replay-safe, and four properties make it so:
        //  - PRESENCE is a function of the recorded run input (`recovery` /
        //    `settle`) and of reaching this point, which earlier replayed
        //    steps decide. A pre-feature log never runs it at all.
        //  - THE NAME is turn-scoped and sits in a fixed position, always
        //    immediately after `turn-N-exec`.
        //  - THE RESULT is `{hash, dirty} | null` — JSON-clean, and ctx.step
        //    returns the post-JSON value, so live and replay observe the same
        //    object.
        //  - ERRORS are caught INSIDE the step so it always records a value. A
        //    step that throws would re-run on replay and could branch
        //    differently (the same rule the critic-diff step states above).
        //
        // The fingerprint runs `git add -A`, an idempotent index mutation.
        // Publishing is unaffected: commitAndPush gates on `git status
        // --porcelain`, which still reports staged entries, then stages again
        // itself.
        if (recovery !== null) {
          const fingerprint = await ctx.step(`turn-${turn}-fingerprint`, async () => {
            try {
              return (await workspaceFingerprint(executor)) ?? null;
            } catch {
              return null;
            }
          });
          const signal = recovery.observe(action, result.exitCode, fingerprint?.hash, fingerprint?.dirty);
          if (signal.kind === "abort" || signal.kind === "stop") {
            // Both endings publish, and both publish as INCOMPLETE. The work
            // still ships (the SWE-bench lesson: real fixes die in runs that
            // never got to say finish), but as a draft/WIP PR — in neither case
            // did the agent declare itself done.
            const summary = signal.kind === "stop" ? (lastHeldFinish ?? signal.message) : signal.message;
            const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, summary, repoPolicy, true);
            await dispose(config, handle);
            return {
              status: signal.kind === "stop" ? "settled" : "stuck",
              summary,
              turns: turn + 1,
              usage,
              ...(pr !== null ? { pr } : {}),
            };
          }
          if (signal.kind === "nudge") {
            messages.push({ role: "user", content: signal.message });
          }
        }
      }

      // Non-empty diffs are published even off a max-steps exit — real
      // fixes die in runs that never got to say finish (SWE-bench lesson).
      // Non-empty diffs are still published off a max-steps exit — real fixes
      // died in runs that never got to say finish — but as a DRAFT, because
      // "ran out of turns" and "done" must not look alike to a reviewer.
      const pr = await publishIfRepoRun(ctx, executor, config, input, checkout, `Reached the ${maxSteps}-turn limit.`, repoPolicy, true);
      await dispose(config, handle);
      return { status: "max-steps", summary: `Reached the ${maxSteps}-turn limit.`, turns: maxSteps, usage, ...(pr !== null ? { pr } : {}) };
    },
    config.runTimeout !== undefined ? { timeout: config.runTimeout } : {},
  );
}

/**
 * The scope key for a repository's code index and memory.
 *
 * Includes the ORIGIN, not just owner/repo. Two different hosts routinely carry
 * the same path — a self-hosted `tyler/teploy-ship` and a GitHub
 * `tyler/teploy-ship`, or an internal fork of a public project — and keying on
 * owner/repo alone merged their vector chunks into one namespace and mixed
 * their run history into each other's prompts. On a private mirror of a public
 * repo that is a disclosure, not just a mix-up.
 */
export /** Escape hatch for a disposable machine. Read at use, so it is testable. */
function allowUnsandboxedIntake(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHIP_ALLOW_UNSANDBOXED_INTAKE ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function repoKeyOf(repoUrl: string): string {
  const ref = parseRepoUrl(repoUrl);
  const origin = ref.base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `${origin}/${ref.owner}/${ref.repo}`;
}

/**
 * Publish a repo run's work: commit, push, open or update the PR, remember it.
 *
 * Split into SEPARATE recorded steps on purpose. As one step, a crash anywhere
 * inside replayed the whole callback: the push is idempotent (same commit), but
 * a second PR POST opens a duplicate or fails the run for a PR that was in fact
 * created, and the comment and the memory note would both be written twice.
 * With one step per external effect, replay resumes at the first one that never
 * completed — and the PR step additionally looks for an existing PR before
 * creating one, so even a crash BETWEEN the API call and the step record
 * converges instead of duplicating.
 *
 * `incomplete` marks work that stopped at a limit rather than at a finish: it
 * becomes a draft/WIP pull request so a reviewer, and any merge automation,
 * can tell the difference.
 */
async function publishIfRepoRun(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  checkout: RepoCheckout | null,
  summary: string,
  policy: RepoPolicyConfig,
  incomplete = false,
): Promise<string | null> {
  if (checkout === null || input.repo === undefined) return null;
  const repoUrl = input.repo;
  const co = checkout;
  const ref = assertRepoAllowed(repoUrl, { trust: input.trust ?? "operator", config: policy });
  const token = credentialFor(ref, policy);
  const headToken = co.headRepo !== undefined ? credentialFor(parseRepoUrl(co.headRepo), policy) : "";

  // 1. Commit + push. Screened first; a refusal is recorded and stops here.
  const push = await ctx.step("repo-push", async () => {
    const result = await commitAndPush(executor, {
      ref,
      token,
      checkout: co,
      message: `${input.task.slice(0, 68)}\n\nTeploy Ship ${ctx.runId}`,
      ...(headToken !== "" ? { headToken } : {}),
    });
    return result.kind === "refused"
      ? { kind: "refused" as const, message: refusalMessage(result.screen) }
      : result.kind === "pushed"
        ? {
            kind: "pushed" as const,
            sha: result.sha,
            // An unusual-looking diff is published, but as a draft that says
            // what looked unusual — the reviewer decides, not the limit.
            ...(result.screen !== undefined ? { warning: warningMessage(result.screen) } : {}),
          }
        : { kind: "empty" as const };
  });

  const remember = async (pr?: string): Promise<void> => {
    if (config.repoMemory === undefined) return;
    // Its own step: the memory write is an external effect like the others, and
    // replaying it would duplicate the note.
    await ctx.step("repo-memory", async () => {
      await config
        .repoMemory!.record({
          // The SAME key loadRepoContext reads with. These had drifted apart:
          // context was read under the origin-scoped key and notes were written
          // under a bare owner/repo, so a run never saw its own history back.
          repo: repoKeyOf(repoUrl),
          note: runNote({ task: input.task, summary, ...(pr !== undefined ? { pr } : {}) }),
          runId: ctx.runId,
        })
        .catch(() => {}); // memory is advisory — never fail a publish over it
      return true;
    });
  };

  // Review follow-up: the PR already exists — the push updated it; reply there.
  if (input.pr !== undefined) {
    const prUrl = pullRequestUrl(ref, input.pr);
    const body =
      push.kind === "refused"
        ? push.message
        : push.kind === "empty"
          ? `No code change was needed for this feedback (run ${ctx.runId}).\n\n${summary.slice(0, 800)}`
          : `Pushed ${push.sha.slice(0, 10)} addressing this (run ${ctx.runId}).\n\n${summary.slice(0, 800)}`;
    await ctx.step("repo-comment", async () => {
      await commentOnPr(ref, token, input.pr!, body);
      return true;
    });
    // A review follow-up pushed new commits to the same branch, so the preview
    // that branch is on is now stale. Refresh it, unless nothing was pushed.
    if (push.kind === "pushed") await previewIfAsked(ctx, config, input, co.branch, ref, token, input.pr);
    await remember(prUrl);
    return prUrl;
  }

  if (push.kind === "refused") {
    // Nothing to link: the diff never left the sandbox. The reason is on the
    // run's timeline via the recorded step.
    await remember();
    return null;
  }
  if (push.kind === "empty") {
    await remember();
    return null;
  }

  // A diff that tripped a size or shape limit ships as a draft even when the
  // agent finished cleanly.
  const flagged = push.kind === "pushed" && push.warning !== undefined;
  const asDraft = incomplete || flagged;
  const pr = await ctx.step("repo-pr", async () => {
    const existing = await findOpenPullRequest({ ref, token, head: co.branch, owner: ref.owner }).catch(() => null);
    if (existing !== null) return { url: existing.url, number: existing.number };
    const created = await openPullRequest({
      ref,
      token,
      head: co.branch,
      base: co.base,
      draft: asDraft,
      title: prTitle(input.task, incomplete),
      body:
        `${summary}\n\n---\nTask: ${input.task}\nRun: ${ctx.runId}\nGenerated by Teploy Ship.` +
        (incomplete
          ? `\n\n**This run did not finish** — it stopped at a limit, so the change may be partial. Review before merging.`
          : "") +
        (push.kind === "pushed" && push.warning !== undefined ? `\n\n${push.warning}` : ""),
    });
    return { url: created.url, number: created.number };
  });
  await previewIfAsked(ctx, config, input, co.branch, ref, token, pr.number);
  await remember(pr.url);
  return pr.url;
}

/**
 * Deploy a preview of the pushed branch and say so on the pull request.
 *
 * Both steps are recorded whenever `input.preview` is set, including when this
 * worker has no preview target — a disabled note keeps the step sequence a
 * function of the recorded input rather than of which host picked the run up.
 *
 * Nothing here can fail the run. The deploy shells out to the `teploy` CLI on
 * the WORKER host (never in the agent's sandbox, which must not hold deploy
 * credentials), and every failure path returns an outcome instead of throwing.
 */
async function previewIfAsked(
  ctx: WorkflowContext,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  branch: string,
  ref: RepoRef,
  token: string,
  pr: number | undefined,
): Promise<void> {
  if (input.preview !== true) return;

  const outcome = await ctx.step("preview-deploy", async (): Promise<PreviewOutcome> => {
    if (config.preview === undefined) {
      return { kind: "skipped", reason: "no preview target configured on this worker" };
    }
    try {
      return await deployPreview(config.preview, branch);
    } catch (error) {
      // deployPreview is written not to throw; if it ever does, the run must
      // still end with its pull request.
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  });

  // A skipped preview on an unconfigured worker is not news for a reviewer;
  // a failed one is, and so is a URL.
  if (outcome.kind === "skipped") return;
  if (pr === undefined) return;
  await ctx.step("preview-comment", async () => {
    await commentOnPr(ref, token, pr, previewComment(outcome, ctx.runId)).catch(() => {});
    return true;
  });
}

/**
 * Best-effort workspace release. Never throws and never blocks the run: a
 * container that outlives its usefulness is a capacity problem, but a run that
 * fails because cleanup failed is a correctness problem.
 */
async function dispose(config: DurableAgentConfig, handle: string, log?: (line: string) => void): Promise<void> {
  if (config.executor.destroy === undefined) return;
  await config.executor.destroy(handle).catch((error) => {
    log?.(`sandbox ${handle} could not be released: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function prTitle(task: string, incomplete: boolean): string {
  const prefix = incomplete ? "[incomplete] " : "";
  const room = 72 - prefix.length;
  return `${prefix}${task.length > room ? `${task.slice(0, room)}…` : task}`;
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
    isolated: true,
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
    async destroy(handle: string) {
      await SandboxExecutor.attach(handle, base).destroy();
    },
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-(max - head))}`;
}
