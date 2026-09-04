import type { RunOrigin } from "./notify.js";
import { akirooTrailersFrom } from "./akiroo.js";
import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter } from "@neutron-build/ai";
import { SandboxExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { isSuspension, workflow } from "@neutron-build/workflow";
import type { WorkflowContext, WorkflowDefinition } from "@neutron-build/workflow";

import { executeAction, workspaceFingerprint } from "./agent.js";
import { FINISH_NUDGE_CLEAN_TREE, FINISH_NUDGE_FAILED, FINISH_NUDGE_NO_EVIDENCE, FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, parseAction } from "./actions.js";
import { criticFeedback, isApproved, parsePick, pickAttempt, reviewWork } from "./critic.js";
import type { PickCandidate } from "./critic.js";
import {
  commentOnPr,
  commitAndPush,
  findOpenPullRequest,
  fixPrompt,
  formatReviewComments,
  listPrReviewComments,
  openPullRequest,
  mergePullRequest,
  markPullRequestReady,
  closePullRequest,
  rebaseOntoBase,
  requestReviewers,
  parseRepoUrl,
  pullRequestUrl,
  readPullRequestBody,
  reviewPrompt,
  checkoutRepo,
  setupRepo,
  setupRepoForPr,
  resolvePr,
  updatePullRequestBody,
  workingDiff,
} from "./git.js";
import { deployPreview, resolvePreviewTarget, rollbackDeploy, type PreviewOutcome, type PreviewTarget } from "./deploy.js";
import {
  effectiveAuthority,
  ladderGate,
  type Authority,
  type ObserveOutcome,
  type ProjectVerification,
  type Rung,
  type SmokeOutcome,
  type VisualOutcome,
} from "./ladder.js";
import { buildIfDeclared, observeIfDeclared, recordLadder, smokeIfDeclared, visualIfDeclared, type LadderHooks } from "./ladder-steps.js";
import { compareAroundNow, effectiveTelemetryTarget, telemetryAppliesTo, telemetryRegression, type TelemetryTarget, type TelemetryVerdict } from "./observe.js";
import { spliceVerification, verificationSection, type Evidence } from "./verification.js";
import { shortHash, warmClient, warmSlugOf, type WarmState } from "./warm.js";
import { mergeFact, verificationSummary, type VerificationFacts } from "./verification-summary.js";
import { preExisting, runTests, testComment, testTargetFromInput, testsFailedNudge, type TestOutcome, type TestTarget } from "./tests.js";
import { refusalMessage, warningMessage } from "./publish-policy.js";
import type { RepoCheckout, RepoRef } from "./git.js";
import { assertRepoAllowed, credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig, RepoTrust } from "./repo-policy.js";
import { condenseIfNeeded, defaultCondenseConfig } from "./memory.js";
import type { CondenseConfig } from "./memory.js";
import { RecoveryTracker, defaultRecoveryConfig } from "./recovery.js";
import type { RecoveryConfig } from "./recovery.js";
import { loadRepoContext, runNote } from "./repo-memory.js";
import type { ProjectStore } from "./projects.js";
import type { RepoMemoryStore } from "./repo-memory.js";
import type { SteerStore } from "./steer.js";
import { formatSearchHits } from "./code-index.js";
import { frameUntrusted, screenUntrusted } from "./guard.js";
import { networkForTrust, parseNetworkTier, wireNetwork } from "./egress.js";
import type { NetworkTier } from "./egress.js";
import type { CodeSearch } from "./code-index.js";
import { CHANGE_EVENT, MERGE_EVENT, PLAN_EVENT } from "./plan.js";
import type { ChangeDecisionPayload, MergeDecisionPayload } from "./plan.js";
import { classifyChange, mergeParkSummary, midRunParkReasons, parseNumstat } from "./change-class.js";
import type { ChangedFile, ChangeVerdict } from "./change-class.js";
import type { PlanDecisionPayload } from "./plan.js";
import type { ApprovalPolicy } from "./approval.js";
import { SCAN_EDIT_REFUSED, SCAN_MIDPOINT_REMINDER, formatObservation, scanFindingsNudge, scanPrompt, systemPrompt } from "./prompt.js";
import { parseFindings } from "./findings.js";
import type { ParsedFindings, ScanFinding } from "./findings.js";
import { costUSD } from "./pricing.js";
import { HARNESS_VERSIONS, NATIVE_HARNESS_ID, selectAdapter } from "./harness.js";
import type { HarnessAdapter, HarnessBudget, HarnessRef, HarnessResult, HarnessTask, HarnessUsage, HarnessWorkspace } from "./harness.js";

/**
 * Retry policy for steps whose failure loses real work.
 *
 * There were 33 `ctx.step(` calls in this file and NONE of them had a retry, so
 * one transient blip from the forge — a 502 from Forgejo, a dropped connection
 * mid-push — failed a whole run that had already spent forty turns and real
 * money producing a correct change. These four steps (push, open PR, comment,
 * request reviewers) are the ones that talk to something across a network at
 * the very end of a run, which is exactly where a failure is most expensive and
 * least likely to be the run's own fault.
 *
 * IN-PROCESS retries (retryDelay 0), deliberately not a durable park. The
 * engine parks the run for any non-zero delay, and a park here would release
 * the sandbox the publish gate is still working out of — trading a lost run for
 * a differently lost run. A per-attempt timeout bounds a hung connection, which
 * is the failure an immediate retry does not fix on its own.
 *
 * Adding retries changes no step NAME, so a run whose log predates this replays
 * untouched: the extra events only ever exist on a path that previously ended
 * the run outright.
 */
const EXTERNAL_EFFECT_RETRY = { retries: 3, retryDelay: 0, timeout: 120_000 } as const;

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
   * Where the task came from (L7), materialised at enqueue. Read by the
   * worker's notification builder, never by the workflow: it gates no step,
   * so a run enqueued without it replays unchanged.
   */
  origin?: RunOrigin;
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
   * Warm repo cache (SB-A): ask the sandbox daemon for this repo's warm
   * volume, reuse the clone and dependency tree it holds instead of
   * cloning cold, and publish the volume back as the template when it is
   * new or its lockfiles have moved (a recorded `warm-cache` step).
   *
   * Input-gated like steer/index/guard, and for a sharper reason than
   * theirs: the cache is LIVE HOST STATE. A run whose template was
   * evicted between execution and replay must walk the same step
   * sequence, so nothing about the cache may decide step presence — only
   * this field, written at enqueue, does. Repo runs that are not PR runs
   * (a PR checkout resolves a head from another repository, and its
   * volume is not the repo's steady state).
   */
  warm?: boolean;
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
   * Read the affected service's error rate and latency around this change and
   * put the numbers on the pull request.
   *
   * Absent by default like every other capability here — it adds recorded
   * steps (`telemetry-check`, `telemetry-comment`), and step presence must
   * stay a function of the recorded input.
   *
   * Advisory: a read that fails, or that finds too little traffic to say
   * anything, is reported as exactly that and never fails the run.
   */
  telemetry?: boolean;
  /**
   * Run the project's test suite after the agent stops, and put the result on
   * the pull request.
   *
   * Ship runs it, not the agent: an agent's account of its own testing is the
   * claim the verified-finish gate exists because models get it wrong. Absent
   * by default — it adds a recorded `tests` step.
   */
  tests?: boolean;
  /**
   * The evidence loop (C4): take a BASELINE suite run before the agent edits,
   * and send a finish back to work when the suite it leaves is red for a
   * reason this run caused.
   *
   * Input-gated, like every other optional feature here, and for the sharpest
   * version of the reason: both halves ADD RECORDED STEPS (`baseline-tests`,
   * `turn-N-finish-tests`). A worker that ran them on a run whose log predates
   * them requests a step the log does not have, which is a NondeterminismError
   * that executeRun THROWS rather than records — the run becomes permanently
   * unrunnable, not merely failed. The P5-1 replay fence in harness.test.ts
   * caught exactly that during this change.
   */
  testsFeedback?: boolean;
  /**
   * Iterate-until-green bound (D3 / Phase 1): how many times a red suite at
   * the finish gate may send the run back to work with the failure output
   * before Ship stops trying. Materialised at ENQUEUE from `SHIP_FIX_RETRIES`
   * (default 2 — the historical bound, now explicit) whenever `testsFeedback`
   * is on.
   *
   * ABSENT keeps the pre-field behaviour exactly: two attempts, and the third
   * red finish is honoured without another suite run. Present changes the
   * step sequence on the exhausting finish — the suite runs once more and a
   * `turn-N-fix-exhausted` step records the last failure with the diff — so
   * it has to ride on the recorded input, like every other step-adding flag.
   */
  fixRetries?: number;
  /**
   * The critic is ADVISORY (D3): its verdict becomes risk notes on the run
   * and the pull request, never a retry or a veto. Materialised at enqueue
   * whenever both `critic` and `tests` are on — with a suite recorded, the
   * suite is the trust boundary and one model's opinion of a diff is not.
   * Absent (no suite, or a run enqueued before this existed) keeps the single
   * critic-triggered retry, which is then the only check the run has.
   */
  criticAdvisory?: boolean;
  /**
   * The change-class gate (L3): before pushing, classify what the run actually
   * touched and PARK when it is `serious` — a migration, an auth file, a
   * deletion, or a change too large for "review it" to be a real answer.
   *
   * Input-gated for the usual reason, sharpened by the fact that this one adds
   * a `waitForEvent`: a worker that parked a run whose log predates the gate
   * would request an event the log has no record of, and the replay would fail
   * as a NondeterminismError rather than merely behaving differently.
   */
  changeClass?: boolean;
  /**
   * Auto-merge (L5 / D5): when the change classified `trivial`, the suite
   * PASSED, the pull request opened non-draft and telemetry did not get worse,
   * merge the pull request instead of leaving it for a human.
   *
   * Materialised at ENQUEUE from the repo's project record (`autoMerge`,
   * projects.ts) — never read from the store at execution time. The usual
   * replay rule applies (it adds an `auto-merge` step, so step presence must
   * be a function of the recorded input), and one specific to this field: the
   * project record is EDITABLE from the dashboard, so a worker that re-read it
   * mid-replay could merge a pull request the log says was left open, or
   * refuse to replay a merge that already happened.
   *
   * Off unless the repo says on, and additionally requires `changeClass` —
   * `trivial` is the whole authority for merging without a human, and without
   * the gate there is no verdict to read. See enqueueRun in runtime.ts.
   */
  autoMerge?: boolean;
  /**
   * Boundary-only parks (C1). With this on, a change parks AFTER the push,
   * not before: the run pushes, opens a DRAFT pull request, runs every
   * verification leg it was given, and parks on `MERGE_EVENT`
   * ("approve-merge") with the evidence attached. Every change the run may
   * not merge unattended parks here — a `serious` one always, and a
   * `trivial` or `normal` one whenever the authority it carries stops short
   * of merging that class (mergesUnattended). A pull request Ship may not
   * merge and nobody is asked about is a pull request nobody merges. Approve
   * rebases the branch onto the default branch, re-runs the suite when the
   * rebase changed the bytes, marks the pull request ready and MERGES it —
   * the person's decision is the authority; deny closes it.
   *
   * The mid-run park (CHANGE_EVENT, before the push) survives ONLY for a
   * change that deletes files or touches a schema/migration path — see
   * midRunParkReasons in change-class.ts.
   *
   * A separate flag from `changeClass`, materialised at enqueue, so a run
   * enqueued under the old routing replays under it: the new steps and the
   * new wait are admitted by THIS field, and the upgrade fence sees the old
   * runs' sequence unchanged.
   */
  mergeGate?: boolean;
  /**
   * Auto-rollback OBSERVATION (P1-4 / L4): after `preview-deploy` and
   * `telemetry-check`, judge the measured before/after and record a `rollback`
   * step saying whether the service got worse and what would happen about it.
   *
   * Separate flag from `autoDeploy` below because they answer different
   * questions: this one turns the WATCHING on and costs nothing (it is a pure
   * function of two steps that already ran), `autoDeploy` turns the ACTING on.
   * The plan's instruction is to build the observable half first and let the
   * recorded steps argue for the thresholds before anything is rolled back.
   *
   * Input-gated for the standard reason: it adds a recorded step.
   */
  rollback?: boolean;
  /**
   * Auto-deploy authority (L4 / L5, per repo): permission for this run to run
   * `teploy` against the real app rather than only to say what it would do.
   * Today the one thing it authorises is the rollback above actually running.
   *
   * Materialised at enqueue from the project record's `autoDeploy`, and never
   * set without `rollback` — a permission to act with nothing watching is not
   * a feature.
   */
  autoDeploy?: boolean;
  /**
   * The verification ladder this run owes (C4 / contract 1): which rungs were
   * declared on the project — build command, tests command, preview app +
   * smoke, visual diff, observe window. Materialised at ENQUEUE from the
   * project record and never re-read at execution, like every capability
   * here, because the ladder ADDS RECORDED STEPS (`build`, `preview-smoke`,
   * `visual-diff`, `observe-window`, `ladder`) and the record is editable: a
   * replay must run the rungs the log was written under.
   *
   * The declaration is also the CAP on `authority` below (ladder.ts): the
   * rungs a project declares are the most it may ever do unattended.
   */
  verification?: ProjectVerification;
  /**
   * The EFFECTIVE authority this run acts under (C4 / contract 1):
   * the project's setting, capped by its declared ladder, floored by
   * neverAuto — computed at enqueue, carried on the log. The auto-merge gate
   * reads THIS, never the store, for the same reason it reads `autoMerge`
   * from the input: the permission to merge has to be a fact of the record,
   * not of a dashboard edit that landed mid-replay.
   *
   * ABSENT keeps the legacy merge gate exactly (a run enqueued before the
   * ladder existed, or a project with nothing authority-shaped on it): the
   * gate is then the historical conditions over verdict/suite/draft/
   * regression, and a replay of an old log computes what it computed.
   */
  authority?: Authority;
  /**
   * What this run is FOR (L2 / D3). Absent — the only value any existing log
   * carries — is the ordinary fix run. `"scan"` is a read-only audit: the agent
   * reads the repository and reports findings, and Ship publishes nothing.
   *
   * Everything scan mode changes is gated on this field, which is why it is on
   * the run input rather than resolved from config at execution time. That is
   * the standing rule here (see `testsFeedback` and `changeClass` above) and it
   * is load-bearing in both directions for this one:
   *
   * - Scan mode ADDS a step (`scan-findings`), so a worker that decided "scan"
   *   from its own env would request a step an older log does not contain — a
   *   NondeterminismError that executeRun THROWS rather than records, leaving
   *   the run permanently unrunnable.
   * - Scan mode also REMOVES steps: `publishIfRepoRun` returns before
   *   `repo-push`. A worker that decided that at execution time would leave the
   *   log's recorded publish steps unconsumed, which is the same failure from
   *   the other side (`leftoverCursorEvent`).
   *
   * The mode is what disables publishing — not the prompt. Five of the seven
   * 2026-08-26 nightly scans pushed code they had been asked in prose not to
   * push; a run mode cannot be forgotten mid-run.
   */
  mode?: "fix" | "scan";
  /**
   * Per-repo evidence, materialised at ENQUEUE from the evidence store
   * (`teploy-ship evidence set`): the test command this repo runs and the
   * Observe service it is built from.
   *
   * On the run INPUT for the same replay rule as every capability above, and
   * for one specific to it: the evidence store is EDITABLE, and a worker that
   * re-read it at execution time could run a different command on replay than
   * the log recorded. Absent by default, so runs enqueued before per-repo
   * evidence existed replay unchanged and fall back to the worker's env
   * wiring exactly as before.
   *
   * `observeRepo` is normally the evidence key itself — the service named by
   * `observeService` is built from the repo the entry describes.
   */
  testCommand?: string;
  testTimeoutMs?: number;
  observeService?: string;
  observeRepo?: string;
  /**
   * Reviewers the pull request must request (governance.ts, per repo),
   * materialised at ENQUEUE. Adds a recorded `repo-reviewers` step after the
   * PR opens; the request failing is that step's recorded outcome and never
   * fails the run or the PR — the reviewer rule is a control on who looks,
   * not on whether the work lands.
   */
  reviewers?: { users: string[]; teams: string[] };
  /**
   * The repo's own sandbox image / network / limits (projects.ts), copied
   * from the project record at enqueue so a replay boots the image the log
   * was written under. Absent = the worker's defaults. No recorded step
   * depends on these, so adding them changed no in-flight run's replay.
   *
   * `sandboxNetwork` records the tier the PROJECT RECORD asked for, not
   * necessarily the one the run executed on: `sandboxOverridesOf` downgrades
   * `open` to `allowlist` for an externally-sourced task, and recording the
   * declared value keeps that fact derivable from the log alone (the run page
   * and `explainRun` both read it back out). A log written before three tiers
   * existed carries the old `egress` spelling, which parses as `allowlist`.
   */
  sandboxImage?: string;
  sandboxNetwork?: NetworkTier;
  /** Extra egress allowlist entries for this run (projects.ts sandboxEgressAllow). */
  sandboxEgressAllow?: string[];
  sandboxLimits?: { memoryMb?: number; cpus?: number; pids?: number };
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
  /**
   * Which harness executes this run, materialised at ENQUEUE from
   * `SHIP_HARNESS` (see harness.ts). Absent = the native loop, so every log
   * written before adapters existed replays through exactly the steps it
   * contains. The executing worker refuses a harness it does not carry, or
   * one whose version differs from the recorded one, rather than substituting
   * — the recorded steps belong to that program.
   */
  harness?: HarnessRef;
  /**
   * Multi-harness attempts (P5-4), materialised at ENQUEUE from
   * `SHIP_HARNESS_ATTEMPTS` on repo runs only. Two or more refs: every
   * listed harness tries the task in its own workspace, a recorded
   * `harness-pick` step has the critic choose, and only the winner's tree
   * goes through the publish gate. Absent = one attempt on `harness`. Off by
   * default — the measurements argue for diverse harnesses, not more loops.
   */
  harnessAttempts?: HarnessRef[];
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
  status: "finished" | "max-steps" | "plan-rejected" | "budget-exhausted" | "stuck" | "settled" | "error";
  summary: string;
  turns: number;
  /** PR opened by a repo run (absent for workspace runs or empty diffs). */
  pr?: string;
  /** Model usage summed across the run's turns (cache fields included). */
  usage?: RunUsage;
  /**
   * What a `mode: "scan"` run found (L2 / D3). Absent on every other run, so
   * no recorded output shape changes — the P5-1 replay fence in harness.test.ts
   * compares the replayed output to the recorded one byte for byte.
   *
   * On the OUTPUT as well as on the `scan-findings` step because these two
   * surfaces answer different questions: the step is "what happened in this
   * run", the output is "what does this run mean", and the outcome is what the
   * API, the CLI and Akiroo read without walking the event log.
   */
  findings?: ScanFinding[];
  /**
   * The agent's own finish message. On a fix run `summary` above is the
   * "what I did / what I verified / what I could not verify" paragraph
   * rendered from recorded steps (verification-summary.ts); this is what the
   * model said, kept because the PR body and repo memory quote it.
   */
  agentSummary?: string;
  /** The critic's advisory notes over the verified tree, when it ran. */
  riskNotes?: string;
}

/** Model usage summed across a run. `priced`/`costUSD` are the P5-3 honesty fields; see harness.ts. */
export type RunUsage = HarnessUsage;

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

/**
 * Per-run overrides of the provider's defaults, recorded in the run input at
 * enqueue from the repo's project record (projects.ts). A provider that has no
 * such knobs (the local one) ignores them.
 */
export interface SandboxOverrides {
  image?: string;
  /** The EFFECTIVE tier, after the external-task downgrade. See sandboxOverridesOf. */
  network?: NetworkTier;
  /** Extra allowlist entries, unioned with the daemon's built-in registries. */
  egressAllow?: string[];
  limits?: { memoryMb?: number; cpus?: number; pids?: number };
  /**
   * Boot this run on the repo's warm volume (warm.ts). Derived from the
   * recorded input, never from live cache state, so a replay asks for
   * exactly what the original run asked for.
   */
  warm?: { repo: string; path?: string };
}

export interface ExecutorProvider {
  create: (overrides?: SandboxOverrides) => Promise<{ handle: string }>;
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
  createFrom?: (image: string, overrides?: SandboxOverrides) => Promise<{ handle: string }>;
  /**
   * Release a workspace. Optional, and deliberately best-effort: the provider
   * had no way to say "done with this" at all, so every run's container sat
   * allocated until the daemon's TTL reaper noticed — and a snapshot-restore
   * cycle left the SUPERSEDED container behind too, so one run that parked
   * three times held four workspaces. On a busy box that is most of the
   * capacity.
   */
  destroy?: (handle: string) => Promise<void>;
  /**
   * The warm repo cache (SB-A), present only on a provider that can talk
   * to a daemon holding one. `warmInfo` reports the run volume's current
   * lockfile hash beside its repo's published template hash; `warmCommit`
   * publishes the volume as that template. Both answer null for the
   * ordinary states — no cache store on the daemon, no warm volume on
   * this run, no template for this repo yet — so the caller degrades to
   * the cold path instead of failing a run over a cache.
   */
  warmInfo?: (handle: string) => Promise<WarmState | null>;
  warmCommit?: (handle: string) => Promise<WarmState | null>;
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
  /** Project records: their clone URLs join the allowlist for every run. See projects.ts. */
  projects?: Pick<ProjectStore, "list">;
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
   * Where this worker reads telemetry, if it may at all. Worker wiring for the
   * same reason as `preview`: it carries a credential (an Observe share token)
   * and names a service on a host the run does not choose.
   */
  telemetry?: TelemetryTarget;
  /**
   * The project's test command, run by Ship after the agent stops. Worker
   * wiring: the command depends on the checkout this host has, not on the run.
   */
  tests?: TestTarget;
  /**
   * Hooks the ladder steps use (ladder-steps.ts): the clock the observe
   * window anchors to and the sleep it waits with. Injectable so tests need
   * neither a real minute nor a fake timer; absent means real time, which is
   * what production wants — the window is the point, not an inconvenience.
   */
  ladder?: LadderHooks;
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
  /**
   * External harness adapters this worker can execute (claude-code, opencode —
   * see harness-external.ts). The native loop is always available and is not
   * listed here. Selection is by the run INPUT, never by this list.
   */
  harnesses?: HarnessAdapter[];
}

export { CHANGE_EVENT, MERGE_EVENT, PLAN_EVENT } from "./plan.js";
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
  /**
   * Stable id of whoever decided (see actor.ts). Recorded in the delivered
   * event, which is where an audit reader looks — approving is remote code
   * execution and spend, so "a person unblocked this" was never enough.
   *
   * Optional and unread by the loop on purpose: nothing about how the run
   * proceeds may depend on it, or a replay of a decision delivered before this
   * field existed would diverge.
   */
  by?: string;
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
  // Single-token config folds into the policy so credential selection and the
  // allowlist are one lookup rather than two places that can disagree.
  const basePolicy: RepoPolicyConfig = {
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
      // Resolved before any step: a pure lookup, and a harness this worker does
      // not carry must fail the run before a sandbox is allocated for it.
      const registry = [nativeAdapter(config), ...(config.harnesses ?? [])];
      const adapter = selectAdapter(registry, input.harness);
      // Multi-attempt is a repo-run capability (each extra attempt clones its
      // own checkout); a recorded list on a workspace run is a single attempt.
      const attemptRefs = input.repo !== undefined && (input.harnessAttempts?.length ?? 0) >= 2 ? input.harnessAttempts! : null;
      const attemptAdapters = attemptRefs !== null ? attemptRefs.map((ref) => selectAdapter(registry, ref)) : [adapter];
      if (
        input.trust === "external" &&
        (config.executor.isolated !== true || attemptAdapters.some((a) => !a.isolated)) &&
        !allowUnsandboxedIntake()
      ) {
        throw new Error(
          "refusing to run an externally-sourced task without an isolated executor: this task came from a webhook, " +
            "chat message, or issue body, and agent commands would run directly on the host. Configure a sandbox " +
            "(SHIP_SANDBOX_URL + SHIP_SANDBOX_TOKEN), or set SHIP_ALLOW_UNSANDBOXED_INTAKE=1 if this machine is " +
            "genuinely disposable.",
        );
      }
      const sandboxOverrides = sandboxOverridesOf(input);
      // The allowlist is the env floor plus every project record, read once
      // per execution (a store read, not a step — it decides nothing about
      // the step sequence) so a project added while the worker runs counts.
      const repoPolicy = await withProjects(basePolicy, config.projects);
      const handle = await ctx.step("sandbox", async () => (await config.executor.create(sandboxOverrides)).handle);
      const executor = config.executor.attach(handle);

      // C5: is the container this run recorded still ALIVE?
      //
      // `sandbox` is a recorded step, so a replay gets the original handle back
      // and attaches to it without asking whether it still exists. After the
      // sandbox TTL it does not, and every subsequent command failed with the
      // daemon's own `run not found` — an error that names nothing an operator
      // can act on and that reads like a bug in Ship. Snapshots are only taken
      // at approval parks, so for an ordinary run there is nothing to restore
      // from; the honest thing is to say precisely what happened and why the
      // run cannot continue.
      //
      // Deliberately NOT a recorded step: it is a liveness probe about the
      // container, not a fact about the run, and recording it would make its
      // answer replay as "alive" forever — which is the exact bug.
      if (config.executor.isolated === true) {
        const alive = await executor.exec("true", { timeoutMs: 15_000 }).then(
          (r) => r.exitCode === 0,
          () => false,
        );
        if (!alive) {
          throw new Error(
            `the sandbox this run recorded (${handle}) is no longer available — it has almost certainly outlived its TTL ` +
              `(SHIP_SANDBOX_TTL_SEC). A durable run replays its recorded container rather than creating a new one, and ` +
              `there is no snapshot to restore from unless the run parked for an approval. Re-enqueue the task; the run's ` +
              `log is intact and explains what it had done.`,
          );
        }
      }

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
          // Warm reuse (SB-A) when this run booted a warm volume that already
          // holds a clone; a cold clone otherwise. Both end in the same
          // checkout, so the step's OUTPUT — the only thing a replay reads —
          // does not depend on which path ran.
          if (input.pr === undefined) return checkoutRepo(executor, { ref, token, runId: ctx.runId, warm: input.warm === true });
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
            // Bounded: SHIP_INDEX_TIMEOUT_MS (default 2 min). Read here, not
            // materialised into the input — the step's OUTPUT is what replays,
            // and a slower or faster index on replay changes nothing recorded.
            const capMs = Number(process.env.SHIP_INDEX_TIMEOUT_MS) || 120_000;
            const stats = await config.codeSearch.refresh(executor, scopeKey, {
              deadlineMs: Date.now() + capMs,
              // Ordering is the highest-leverage lever this step has. The
              // budget is roughly a hundred chunks at the measured embedding
              // rate, so the question is which hundred — see orderPaths.
              task: input.task,
            });
            // Say what the INDEX now holds, not only what this sweep did. "3
            // files indexed" on a 400-file repo read as success; the number
            // that matters to anyone reading a run is coverage, and it was
            // nowhere on the timeline.
            const coverage = await config.codeSearch.coverage(scopeKey).catch(() => null);
            const held =
              coverage === null
                ? ""
                : `; index holds ${coverage.indexedFiles}/${coverage.trackedFiles} files` +
                  (coverage.trackedFiles > 0 ? ` (${Math.round((coverage.indexedFiles / coverage.trackedFiles) * 100)}%)` : "");
            const rate = stats.msPerChunk !== null ? `, ${stats.msPerChunk}ms/chunk` : "";
            return (
              `${stats.indexed} files indexed (${stats.chunks} chunks${rate}), ${stats.unchanged} unchanged, ` +
              `${stats.removed} removed of ${stats.files} tracked` +
              `${stats.timedOut ? ` (stopped at the ${Math.round(capMs / 1000)}s index cap)` : stats.capped ? " (capped)" : ""}${held}`
            );
          } catch (error) {
            return `index refresh failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        });
      }
      // BASELINE (C4). Run the suite once before the agent has touched
      // anything, so "Tests: FAILED" on the pull request can distinguish a
      // regression this run caused from breakage it inherited. On 2026-08-26 a
      // Go 1.24/1.25 base-image mismatch made every Go pull request arrive
      // marked `tests: failed` and cost a day of reading them as the agent's
      // fault — there was no way to tell, because nobody had run the suite
      // first. Repo runs only: a keyed workspace has no base branch to be a
      // baseline OF.
      const baseline =
        checkout !== null && input.testsFeedback === true
          ? await runSuite(ctx, executor, config, input, "baseline-")
          : undefined;

      // WARM CACHE (SB-A), the publish half. Here rather than straight after
      // the checkout on purpose: the baseline suite has just installed the
      // repo's dependencies, and a template WITHOUT them saves a clone while
      // a template with them saves the install too — which is the larger
      // half of a run's fixed cost. The agent has not touched anything yet,
      // so what gets published is the repo's clean steady state.
      //
      // A recorded step, and input-gated on `warm`: a log written before this
      // existed carries no such field and replays through the same sequence.
      // Everything the body depends on — the worker's wiring, the daemon's
      // answer, the cache's contents — is handled INSIDE it and reported as
      // text, exactly as repo-index does, because none of it is knowable from
      // a log and all of it can change between an execution and its replay.
      if (input.warm === true && checkout !== null) {
        await ctx.step("warm-cache", async () => {
          if (config.executor.warmInfo === undefined || config.executor.warmCommit === undefined) {
            return "disabled (this worker's executor has no warm cache)";
          }
          try {
            const state = await config.executor.warmInfo(handle);
            if (state === null) return "disabled (this run has no warm volume)";
            if (state.booted && state.templateHash === state.lockHash) {
              return `reused ${state.repo} (lockfiles ${shortHash(state.lockHash)}, unchanged)`;
            }
            const published = await config.executor.warmCommit(handle);
            if (published === null) return `could not publish the ${state.repo} template (the daemon declined)`;
            return state.booted
              ? `refreshed ${published.repo} (lockfiles ${shortHash(state.templateHash ?? "")} -> ${shortHash(published.lockHash)})`
              : `seeded ${published.repo} (lockfiles ${shortHash(published.lockHash)})`;
          } catch (error) {
            // Never fatal. A cache that cannot be written costs time, not
            // correctness — the run already has its checkout.
            return `warm cache skipped: ${error instanceof Error ? error.message : String(error)}`;
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
      // A batched review arrives as one submitted review plus N inline
      // comments, and the intake layer deliberately coalesces those N+1
      // deliveries into ONE task so the reviewer gets one run and one push
      // (see reviewTaskFromReviewEvent in intake-sources.ts). The cost of that
      // coalescing is that the task text carries whichever comment arrived
      // first — so the run reads the rest of the thread here, from the forge,
      // rather than addressing one of three complaints and calling it done.
      //
      // A recorded step, and best-effort inside it: review context is
      // advisory, and a follow-up run that dies because the comments API
      // rate-limited would be worse than one that addresses only what it was
      // handed.
      const reviewContext =
        checkout !== null && input.pr !== undefined && input.repo !== undefined
          ? await ctx.step("pr-review-comments", async () => {
              try {
                const ref = assertRepoAllowed(input.repo!, { trust: input.trust ?? "operator", config: repoPolicy });
                const rendered = formatReviewComments(await listPrReviewComments(ref, credentialFor(ref, repoPolicy), input.pr!));
                // Comment bodies are written by whoever can comment on the PR.
                // reviewPrompt frames its `task` argument but NOT `context`
                // (which normally carries Ship's own repo notes), so the
                // framing has to happen here — otherwise reading the rest of
                // the thread would be a way to smuggle instructions into a run
                // that the task text itself is screened for.
                return rendered === "" ? "" : frameUntrusted(rendered);
              } catch {
                return "";
              }
            })
          : "";

      // A scan is framed as a scan wherever it runs — repo checkout or bare
      // workspace — because the framing is the ONLY thing that tells the agent
      // what its deliverable is. The enforcement (no publish, no edits) is in
      // the loop and the publish gate below and does not depend on this.
      const task =
        input.mode === "scan"
          ? scanPrompt({
              task: input.task,
              ...(checkout !== null ? { branch: checkout.branch } : {}),
              ...(repoContext !== "" ? { context: repoContext } : {}),
            })
          : checkout !== null
          ? input.pr !== undefined
            ? reviewPrompt({
                task: input.task,
                branch: checkout.branch,
                pr: input.pr,
                context: [repoContext, reviewContext].filter((c) => c !== undefined && c !== "").join("\n\n"),
              })
            : fixPrompt({ task: input.task, branch: checkout.branch, base: checkout.base, context: repoContext })
          : input.task;

      const budget: HarnessBudget = { maxSteps, maxRunCostUSD: config.maxRunCostUSD ?? 0 };
      const harnessTask: HarnessTask = {
        prompt: task,
        // So the finish gate can tell a suite this run broke from one it
        // inherited, and only send the agent back for the former.
        ...(baseline !== undefined ? { testsBaseline: baseline } : {}),
        task: input.task,
        input,
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(checkout !== null ? { baseBranch: checkout.base } : {}),
      };
      // The loop used to hold handle/executor as `let` locals and reassign them
      // on a snapshot restore; the workspace carries them now so the publish
      // gate reads whichever container the attempt ended in.
      const primary: HarnessWorkspace = { ctx, handle, executor, workdir, checkout, scopeKey, stepPrefix: "" };

      /**
       * Collect a scan's findings out of the agent's own finish message, as a
       * recorded step, on scan runs only.
       *
       * A step and not a bare call: the parse is pure, but its RESULT is the
       * run's deliverable, and a deliverable that only exists in a return value
       * is invisible to the run page, the API and `explain`. Recording it puts
       * the findings, the drop reasons and "no array at all" on the timeline
       * where the run is read. Nothing here touches the sandbox, so it is also
       * the one sink a scan cannot fail to deliver — see findings.ts's header
       * for what happened to the file-shaped one.
       */
      const collectFindings = async (summary: string): Promise<ParsedFindings | null> =>
        input.mode === "scan" ? await ctx.step("scan-findings", () => parseFindings(summary)) : null;

      if (attemptRefs === null) {
        let result: HarnessResult;
        try {
          result = await adapter.run(harnessTask, primary, budget, () => {});
        } catch (error) {
          // A SUSPENSION IS NOT A FAILURE, and rescuing it publishes work the
          // run is parked asking about. The plan park, a turn approval and the
          // C1 merge boundary all suspend from inside the session; each of
          // them means "paused on a human", not "threw", and the tree is not
          // lost — the next pass resumes exactly here. Found as a live bug: a
          // plan-preview on a repo run pushed the unapproved tree as an
          // incomplete draft before the operator had answered anything.
          if (isSuspension(error)) throw error;
          // C5: DO NOT LOSE THE WORK.
          //
          // publishIfRepoRun used to sit only on the normal return path, so a
          // run that made thirty turns of real edits and then threw — a
          // provider 500 on turn 31, a step that ran out of retries — lost all
          // of it. The tree was correct and nobody ever saw it.
          //
          // The deliverable is the edited tree, whatever the loop believes
          // happened. So the tree is published, marked incomplete, and the
          // error is re-thrown afterwards: the run is still a failure and must
          // still be reported as one. Best-effort, and swallowing its own
          // failure, because a rescue that turns one error into a different
          // error tells the operator less than the original did.
          const rescued = await rescuePublish(ctx, primary, config, input, checkout, repoPolicy, error, baseline);
          await dispose(config, primary.handle);
          if (rescued !== null) {
            await ctx.step("publish-on-failure", () => ({
              pr: rescued,
              note: "the run failed, but the work it had already done was pushed and published as an incomplete pull request",
            }));
          }
          throw error;
        }
        // BEFORE the publish gate, so a scan whose findings step throws never
        // reaches a push. (It cannot throw — parseFindings is total — but the
        // ordering is the guarantee, not the implementation.)
        const scanned = await collectFindings(result.summary);
        const facts = factsOf(result, baseline);
        const pr =
          result.status === "plan-rejected"
            ? null
            : await publishIfRepoRun(
                ctx,
                primary.executor,
                config,
                input,
                checkout,
                result.summary,
                repoPolicy,
                result.incomplete,
                result.evidence,
                baseline,
                primary.handle,
                facts,
              );
        await dispose(config, primary.handle);
        return {
          status: result.status,
          ...summaryFields(input, result, facts),
          turns: result.turns,
          usage: result.usage,
          ...(pr !== null ? { pr } : {}),
          ...(scanned !== null ? { findings: scanned.findings } : {}),
        };
      }

      // Multi-harness attempts (P5-4). Attempt 0 runs in the primary workspace
      // already set up above; every further attempt gets its own sandbox and
      // checkout as recorded steps. Each attempt's diff is recorded, the
      // critic picks once, and only the winner reaches the publish gate.
      const attempts: Array<{ ws: HarnessWorkspace; adapter: HarnessAdapter; result: HarnessResult; diff: string }> = [];
      for (let i = 0; i < attemptAdapters.length; i++) {
        const attemptAdapter = attemptAdapters[i]!;
        const p = `attempt-${i}-`;
        let ws: HarnessWorkspace;
        if (i === 0) {
          ws = { ...primary, stepPrefix: p };
        } else {
          const attemptHandle = await ctx.step(`${p}sandbox`, async () => (await config.executor.create(sandboxOverrides)).handle);
          const attemptExecutor = config.executor.attach(attemptHandle);
          const attemptCheckout = await ctx.step(`${p}repo-setup`, async () => {
            const ref = assertRepoAllowed(input.repo!, { trust: input.trust ?? "operator", config: repoPolicy });
            // checkoutRepo, not setupRepo: every attempt boots its own warm
            // volume (the daemon copies the template per run), and a cold
            // clone into one that already holds the repo fails outright.
            return checkoutRepo(attemptExecutor, { ref, token: credentialFor(ref, repoPolicy), runId: ctx.runId, warm: input.warm === true });
          });
          ws = { ctx, handle: attemptHandle, executor: attemptExecutor, workdir, checkout: attemptCheckout, scopeKey, stepPrefix: p };
        }
        const result = await attemptAdapter.run(harnessTask, ws, budget, () => {});
        const diff = await ctx.step(`${p}diff`, async () => {
          try {
            return await workingDiff(ws.executor);
          } catch {
            return "";
          }
        });
        attempts.push({ ws, adapter: attemptAdapter, result, diff });
      }

      const pick = await ctx.step("harness-pick", async () => {
        const candidates: PickCandidate[] = attempts
          .map((a, i) => ({ attempt: i + 1, harness: a.adapter.id, summary: a.result.summary, diff: a.diff }))
          .filter((c) => c.diff.trim() !== "");
        if (candidates.length === 0) {
          return { winner: 0, reason: "no attempt produced a diff", candidates: [] as number[], usage: undefined };
        }
        if (candidates.length === 1) {
          return { winner: candidates[0]!.attempt - 1, reason: "only one attempt produced a diff", candidates: [candidates[0]!.attempt], usage: undefined };
        }
        try {
          const verdict = await pickAttempt(config.model, { task: input.task, candidates });
          const chosen = parsePick(verdict.text, candidates.map((c) => c.attempt));
          return chosen === null
            ? { winner: candidates[0]!.attempt - 1, reason: `critic verdict did not name an attempt (${verdict.text.trim().slice(0, 200)}); first candidate published`, candidates: candidates.map((c) => c.attempt), usage: verdict.usage }
            : { winner: chosen - 1, reason: verdict.text.trim().slice(0, 400), candidates: candidates.map((c) => c.attempt), usage: verdict.usage };
        } catch (error) {
          // Fail open to the first candidate, recorded as such: a broken picker
          // must not throw away every attempt's work, and must not throw from
          // a step (it would re-run on replay).
          return { winner: candidates[0]!.attempt - 1, reason: `critic unavailable (${error instanceof Error ? error.message : String(error)}); first candidate published`, candidates: candidates.map((c) => c.attempt), usage: undefined };
        }
      });

      const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const addUsage = (u: HarnessUsage | Partial<HarnessUsage> | undefined): void => {
        if (u === undefined) return;
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
        usage.totalTokens += u.totalTokens ?? 0;
        if (u.cacheReadTokens !== undefined) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cacheReadTokens;
        if (u.cacheWriteTokens !== undefined) usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
        if (u.priced === false) usage.priced = false;
        if (typeof u.costUSD === "number") usage.costUSD = (usage.costUSD ?? 0) + u.costUSD;
      };
      for (const a of attempts) addUsage(a.result.usage);
      addUsage(pick.usage);
      if (usage.priced === false) delete usage.costUSD;
      const turns = attempts.reduce((n, a) => n + a.result.turns, 0);

      const winner = attempts[pick.winner]!;
      const losers = attempts.filter((a) => a !== winner);
      for (const loser of losers) await dispose(config, loser.ws.handle);
      const names = attempts.map((a, i) => `${a.adapter.id}${i === pick.winner ? " (published)" : ""}`).join(", ");
      const summary = `${winner.result.summary}\n\nPicked from ${attempts.length} harness attempts: ${names}.`;
      // Unreachable today — enqueueRun does not materialise `harnessAttempts`
      // on a scan (runtime.ts), so a scan always takes the single-attempt path
      // above. Kept because "the findings step is next to every publish call"
      // is the invariant, and a future enqueue surface that pairs the two
      // should not have to rediscover it.
      const scanned = await collectFindings(winner.result.summary);
      const facts = factsOf(winner.result, baseline);
      const pr =
        winner.result.status === "plan-rejected"
          ? null
          : await publishIfRepoRun(
              ctx,
              winner.ws.executor,
              config,
              input,
              winner.ws.checkout,
              summary,
              repoPolicy,
              winner.result.incomplete,
              // The winner's own workspace produced it, and the publish gate
              // runs against that same workspace — see the executor above.
              winner.result.evidence,
              baseline,
              winner.ws.handle,
              facts,
            );
      await dispose(config, winner.ws.handle);
      return {
        status: winner.result.status,
        ...summaryFields(input, { ...winner.result, summary }, facts),
        turns,
        usage,
        ...(pr !== null ? { pr } : {}),
        ...(scanned !== null ? { findings: scanned.findings } : {}),
      };
    },
    config.runTimeout !== undefined ? { timeout: config.runTimeout } : {},
  );
}


/**
 * The native CodeAct loop as a harness adapter — the current code,
 * re-entry-pointed. Every recorded step name is unchanged when `stepPrefix`
 * is empty, which the replay fixtures in harness.test.ts pin.
 */
export function nativeAdapter(config: DurableAgentConfig): HarnessAdapter {
  // How many executing turns a held finish gets to produce an edit before the
  // run stops waiting. See heldCleanAtTurn: the hold tells an agent its tree is
  // unchanged, and an agent that has still written nothing this many turns
  // later is not going to. Ending then costs a hypothetical late edit and saves
  // the rest of the run; grinding on to the cap costs the run and saves nothing,
  // because a clean tree publishes nothing either way.
  const HOLD_GRACE_TURNS = 8;
  const maxObs = config.maxObservationChars ?? 8000;
  return {
    id: NATIVE_HARNESS_ID,
    version: HARNESS_VERSIONS[NATIVE_HARNESS_ID]!,
    isolated: true,
    async run(task, ws, budget, onEvent): Promise<HarnessResult> {
      const input = task.input;
      const p = ws.stepPrefix;
      const maxSteps = budget.maxSteps;
      const searchable = input.index === true && ws.scopeKey !== null && config.codeSearch !== undefined;
      onEvent({ kind: "started", harness: NATIVE_HARNESS_ID });
      let messages: Message[] = [{ role: "system", content: systemPrompt({ workdir: ws.workdir, task: task.prompt, search: searchable }) }];
      let anySuccessfulAction = false;
      /** Bounded holds for a finish over an unchanged tree. See FINISH_NUDGE_CLEAN_TREE. */
      let cleanTreeNudges = 0;
      /**
       * The turn a clean-tree hold last fired on, or null if none is standing.
       *
       * The hold sends the agent back to work; what it cannot do is make it
       * come back. On the 2026-08-20 parity sweep 8 runs took the nudge, never
       * attempted another finish, and ground on to the 40-turn cap with a tree
       * that was still clean — the whole of that arm's ~30% wall-clock cost,
       * spent to produce nothing. See HOLD_GRACE_TURNS.
       */
      let heldCleanAtTurn: number | null = null;
      let finishNudged = false;
      let evidenceNudged = false;
      /** Executions (successful or not) since the verify nudge was issued. */
      let execsSinceNudge = 0;
      let failNudges = 0;
      let lastExecFailed = false;
      let criticDone = false;
      /**
       * The suite result the critic was shown, and the turn it describes.
       *
       * Carried out on the harness result so the publish gate can reuse it
       * instead of running the suite a second time over an identical tree —
       * but only when the run FINISHED on that same turn, which is exactly the
       * case where nothing touched the workspace in between. Any other ending
       * leaves it unset and the publish gate runs the suite itself.
       */
      let criticEvidence: TestOutcome | undefined;
      let criticEvidenceTurn = -1;
      /** How many times a red suite has sent this run back to work (C4). */
      let testsNudges = 0;
      /** Set when the attempts ran out with the suite still red (input.fixRetries). */
      let fixExhausted: { attempts: number; exitCode: number } | undefined;
      /** The critic's advisory notes (input.criticAdvisory), carried out on the result. */
      let criticNotes: { approved: boolean; notes: string } | undefined;
      /**
       * The most recent finish the gate HELD, and only when the hold was the
       * benign "prove it" one. A run that ends on a harness sentence while one
       * of these exists throws away the agent's own account of the work —
       * which becomes the PR body and the repo-memory note.
       */
      let lastHeldFinish: string | undefined;

      /**
       * Read-only scan mode (L2 / D3).
       *
       * Everything scan mode does inside this loop is derived from the recorded
       * INPUT and from turn state that is already re-derived on replay
       * (`finishNudged`, `criticDone` and friends above). It records NO new
       * step and consumes none — a scan pushes messages and refuses actions, so
       * an old log replays through exactly the steps it contains and a scan
       * log's step sequence is a strict subset of a fix run's.
       */
      const scanRun = input.mode === "scan";
      /** Bounded like every other hold here. Two re-asks, then take what came. */
      let scanFindingsNudges = 0;
      /**
       * When to tell a scan to start writing up. 60% of the budget: early
       * enough that a re-ask still has turns to land in, late enough that the
       * reading is real. Derived from the same `maxSteps` the loop bounds on,
       * so it moves with the budget rather than being a magic 12.
       */
      const scanWriteUpTurn = Math.max(1, Math.floor(maxSteps * 0.6));

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

      const maxRunCostUSD = budget.maxRunCostUSD;
      const modelId = config.modelId ?? "";
      const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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
        const planStep = await ws.ctx.step(`${p}plan-think`, async () => {
          const generated = await generateText({ model: config.model, messages });
          return { text: generated.text, usage: generated.usage };
        });
        addUsage(planStep.usage);

        const canSnapshot = config.executor.snapshot !== undefined && config.executor.createFrom !== undefined;
        let parkImage: string | undefined;
        if (canSnapshot) {
          parkImage = await ws.ctx.step(`${p}plan-snapshot`, () => config.executor.snapshot!(ws.handle));
        }
        const decision = await ws.ctx.waitForEvent<PlanDecisionPayload>(PLAN_EVENT);
        if (parkImage !== undefined) {
          const superseded = ws.handle;
          ws.handle = await ws.ctx.step(`${p}plan-restore`, async () => (await config.executor.createFrom!(parkImage, sandboxOverridesOf(input))).handle);
          ws.executor = config.executor.attach(ws.handle);
          // The snapshot captured everything the old container held; keeping it
          // allocated through the park (and every later park) is pure waste.
          if (superseded !== ws.handle) await dispose(config, superseded);
        }

        if (!decision.approved) {
          const reason = decision.reason !== undefined ? `: ${decision.reason}` : "";
          return { status: "plan-rejected", summary: `Plan rejected by the operator${reason}.`, turns: 0, usage, incomplete: false };
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
          return { status: "budget-exhausted", summary: summary, turns: turn, usage, incomplete: true };
        }
        // Mid-run steering: drain the operator's pending notes as a
        // recorded step (the store is read once, live; replay returns the
        // recorded notes). Advisory — a store hiccup never fails the run.
        if (input.steer === true) {
          // Keyed by turn so the drain is idempotent: this mutates the store
          // before the step result is committed, and a crash in that window
          // would otherwise consume the operator's notes without delivering
          // them (they are not in the log, and they are no longer pending).
          const steers = await ws.ctx.step(`${p}turn-${turn}-steer`, async () =>
            config.steer !== undefined ? config.steer.drain(ws.ctx.runId, turn).catch(() => []) : [],
          );
          for (const text of steers) {
            messages.push({ role: "user", content: `Operator steering — adjust course accordingly: ${text}` });
          }
        }

        // The write-up deadline. Ship's own steer, not the operator's, and
        // deliberately NOT routed through the steer store: it is a property of
        // the mode, must not depend on a store being configured, and must not
        // consume an operator note's turn slot. A pushed message records no
        // step, so this is invisible to replay.
        if (scanRun && turn === scanWriteUpTurn) {
          messages.push({ role: "user", content: SCAN_MIDPOINT_REMINDER });
        }

        if (condense !== null) {
          messages = await condenseIfNeeded(
            messages,
            async (transcript) => {
              const summaryStep = await ws.ctx.step(`${p}turn-${turn}-condense`, async () => {
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
        onEvent({ kind: "turn", turn });
        const generatedStep = await ws.ctx.step(`${p}turn-${turn}-think`, async () => {
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
        // A SCAN'S FINISH GATE, and it replaces the fix-run chain below rather
        // than adding to it. Every hold in that chain asks a question about an
        // EDIT — did a command succeed, is the tree still clean, does the suite
        // pass, does the critic approve the diff — and a scan makes no edit, so
        // those holds would send a correct scan back to work for failing to do
        // the one thing it is forbidden to do.
        //
        // The question a scan is held on instead is whether it delivered. Two
        // re-asks, then whatever came back is accepted: a model that cannot
        // emit the array in three attempts will not emit it in six, and the
        // free text is still on the timeline either way.
        if (scanRun && action.kind === "finish") {
          const parsed = parseFindings(action.message);
          if (!parsed.found && scanFindingsNudges < 2 && turn + 1 < maxSteps) {
            scanFindingsNudges += 1;
            messages.push({ role: "user", content: scanFindingsNudge(parsed.errors) });
            continue;
          }
          // `incomplete` is about a pull request, and a scan opens none.
          return { status: "finished", summary: action.message, turns: turn + 1, usage, incomplete: false };
        }
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
              (await ws.ctx.step(`${p}turn-${turn}-finish-tree`, async () => {
                try {
                  const fp = await workspaceFingerprint(ws.executor);
                  return fp !== undefined && !fp.dirty;
                } catch {
                  return false;
                }
              }))
            ) {
              cleanTreeNudges += 1;
              heldCleanAtTurn = turn;
              nudge = FINISH_NUDGE_CLEAN_TREE;
            } else if (
              // RED SUITE (C4). Ship reported a failing suite on the pull
              // request and ENDED the run — no iterate-until-green, even with
              // turns left and the failure output in hand. The suite runs here
              // instead, at the finish gate, and a failure this run caused
              // sends it back to work with the real output.
              //
              // Gated on a baseline having been taken, or on the failure
              // differing from the baseline's: a repo whose suite was already
              // red must not have the agent chase breakage it did not cause,
              // which is precisely the Go 1.24/1.25 day.
              //
              // Bounded at two. A model that cannot fix the suite in two
              // attempts will not fix it in six, and every attempt costs a full
              // suite run — so the third failure publishes, marked, and a human
              // decides. Same shape as the other nudges above.
              input.tests === true &&
              input.testsFeedback === true &&
              // Bounded. Without `fixRetries` on the input the bound is the
              // historical two and the exhausting finish never runs the suite
              // (it short-circuits here), so every log written before the
              // field existed replays through exactly the steps it holds.
              // With it, the predicate runs on every finish: the exhausting
              // one runs the suite once more so the LAST failure describes
              // the tree that is actually published, and records it.
              (input.fixRetries !== undefined || testsNudges < 2) &&
              (await (async (): Promise<boolean> => {
                const outcome = await runSuite(ws.ctx, ws.executor, config, input, `${p}turn-${turn}-finish-`);
                if (outcome === undefined) return false;
                // Cache it either way: if this finish is allowed through, the
                // critic below and the publish gate both reuse it rather than
                // running a minutes-long suite again over the same bytes.
                criticEvidence = outcome;
                criticEvidenceTurn = turn;
                if (outcome.kind !== "failed") return false;
                if (preExisting(task.testsBaseline, outcome)) return false;
                if (testsNudges < (input.fixRetries ?? 2)) {
                  testsNudges += 1;
                  nudge = testsFailedNudge(outcome);
                  // The agent is going back to work, so this outcome describes a
                  // tree that is about to change.
                  criticEvidence = undefined;
                  criticEvidenceTurn = -1;
                  return true;
                }
                // EXHAUSTED. The finish is honoured — the work is published as
                // an incomplete draft carrying this failure — and the diff and
                // the last failure are recorded together so the run page and
                // the paragraph can show what was left for a human.
                const recorded = await ws.ctx.step(`${p}turn-${turn}-fix-exhausted`, async () => {
                  let diff = "";
                  try {
                    diff = await workingDiff(ws.executor);
                  } catch {
                    diff = "";
                  }
                  return {
                    kind: "failed" as const,
                    attempts: testsNudges,
                    bound: input.fixRetries ?? 2,
                    command: outcome.command,
                    exitCode: outcome.exitCode,
                    output: outcome.output,
                    diff: diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n…(truncated)` : diff,
                  };
                });
                fixExhausted = { attempts: recorded.attempts, exitCode: recorded.exitCode };
                return false;
              })())
            ) {
              // nudge was set inside the predicate; nothing further to do here.
            } else if (
              input.critic === true &&
              // A git diff is all the critic needs, so a keyed workspace run
              // qualifies as well as a repo checkout. Gating on the checkout
              // alone made `--durable --critic` with no `--repo` a silent
              // no-op, and made the critic unreachable on the product's own
              // benchmark path.
              (ws.checkout !== null || input.workspaceKey !== undefined) &&
              !criticDone
            ) {
              criticDone = true;
              // Both failures are caught INSIDE the step, so the step always
              // records a value rather than throwing: a step that throws would
              // re-run on replay and could take a different branch, breaking
              // determinism. Same fail-open-on-broken-review rule as the live
              // loop in agent.ts — a real non-approval verdict still blocks.
              const diff = await ws.ctx.step(`${p}turn-${turn}-critic-diff`, async () => {
                try {
                  return await workingDiff(ws.executor);
                } catch {
                  return "";
                }
              });
              if (diff.trim() !== "") {
                // The suite runs BEFORE the review, not after it.
                //
                // It used to run in publishIfRepoRun, after the loop had
                // already returned — so the reviewer formed its verdict
                // without the single most informative signal in the run, and a
                // change that broke the build could be approved on a diff that
                // read well. The tree is not touched between here and the
                // publish gate when the review approves, so the outcome is
                // carried out on the result and reused there rather than run
                // twice; a rejected review sends the agent back to editing and
                // the publish gate runs the suite again over what it produced.
                // The red-suite gate above already ran the suite this turn and
                // let the finish through, so the outcome is cached; only run it
                // here when that gate did not (tests off for this run).
                const evidence =
                  criticEvidenceTurn === turn && criticEvidence !== undefined
                    ? criticEvidence
                    : await runSuite(ws.ctx, ws.executor, config, input, `${p}turn-${turn}-critic-`);
                if (evidence !== undefined) {
                  criticEvidence = evidence;
                  criticEvidenceTurn = turn;
                }
                const reviewStep = await ws.ctx.step(`${p}turn-${turn}-critic`, async () => {
                  try {
                    const review = await reviewWork(
                      config.model,
                      {
                        task: task.task,
                        summary: action.message,
                        diff,
                        ...(evidence !== undefined ? { evidence: testComment(evidence) } : {}),
                      },
                      // A reviewer that can read the file it is judging is the
                      // difference between "this diff looks wrong" and "this
                      // diff IS wrong": a diff shows changed lines without the
                      // function around them, the caller that must still
                      // compile, or the test that covers it. Read-only — see
                      // readFileTool in critic.ts for why it is not exec.
                      { readFile: (path) => readWorkspaceFile(ws.executor, ws.workdir, path) },
                    );
                    return { text: review.text, usage: review.usage, reviewed: true };
                  } catch {
                    return { text: "", usage: undefined, reviewed: false };
                  }
                });
                addUsage(reviewStep.usage);
                if (reviewStep.reviewed && (input.criticAdvisory === true || fixExhausted !== undefined)) {
                  // ADVISORY (D3). The suite is the trust boundary; the review
                  // is a note on the verified tree, never a veto. The evidence
                  // stays cached: the tree is not going anywhere. The same is
                  // forced on the EXHAUSTING finish even when the run keeps the
                  // old veto semantics (no suite): the fix bound has run out,
                  // so no review verdict may buy the run another round of
                  // attempts — the finish parks with the notes attached.
                  criticNotes = { approved: isApproved(reviewStep.text), notes: reviewStep.text };
                } else if (reviewStep.reviewed && !isApproved(reviewStep.text)) {
                  nudge = criticFeedback(reviewStep.text);
                  // The agent is going back to work, so whatever the suite said
                  // describes a tree that is about to change. Drop it; the
                  // publish gate will run the suite over the final state.
                  criticEvidence = undefined;
                  criticEvidenceTurn = -1;
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
          return {
            status: "finished",
            summary: action.message,
            turns: turn + 1,
            usage,
            // A red suite the attempts could not fix is published as a draft
            // marked incomplete: the change may be right, but nothing proved it.
            incomplete: fixExhausted !== undefined,
            ...(criticEvidenceTurn === turn && criticEvidence !== undefined ? { evidence: criticEvidence } : {}),
            ...(testsNudges > 0 ? { fixAttempts: testsNudges } : {}),
            ...(fixExhausted !== undefined ? { fixExhausted } : {}),
            ...(criticNotes !== undefined ? { critic: criticNotes } : {}),
          };
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

        // A scan may not modify the tree — enforced HERE, before the action
        // reaches a step or the executor, so nothing is written and no
        // `turn-N-exec` is recorded for it.
        //
        // Belt to the publish gate's braces, and worth having on its own: the
        // 2026-08-26 scans that pushed code were not malicious, they were
        // BLOCKED from their real deliverable and spent a 40-turn budget doing
        // the thing they knew how to do. Refusing the edit with an explanation
        // and a place to put it (a finding's "fix") points that energy back at
        // the scan instead of merely discarding it later.
        //
        // ```bash can still write files, and that is fine: the publish gate is
        // what decides whether anything leaves the sandbox, and the remote has
        // been credential-free since the clone (git.ts setupRepo), so the agent
        // cannot push either.
        if (scanRun && (action.kind === "edit" || action.kind === "create")) {
          messages.push({ role: "user", content: SCAN_EDIT_REFUSED });
          continue;
        }

        // Semantic retrieval: worker-side (Nucleus + embedder), recorded —
        // replay returns the recorded hits on any executor, wired or not.
        if (action.kind === "search") {
          const query = action.query;
          const observation = await ws.ctx.step(`${p}turn-${turn}-search`, async () => {
            if (config.codeSearch === undefined || ws.scopeKey === null) {
              return "Code search is not available in this run. Use grep/rg via ```bash instead.";
            }
            try {
              // Coverage rides along with every observation. A miss with no
              // coverage figure reads as "that code is not in this repo",
              // which on the deployed index was wrong far more often than it
              // was right — see coverageLine in code-index.ts.
              const [hits, coverage] = await Promise.all([
                config.codeSearch.search(ws.scopeKey, query),
                config.codeSearch.coverage(ws.scopeKey).catch(() => null),
              ]);
              return formatSearchHits(query, hits, coverage);
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
            parkImage = await ws.ctx.step(`${p}turn-${turn}-snapshot`, () => config.executor.snapshot!(ws.handle));
          }

          const approval = await ws.ctx.waitForEvent<ApprovalDecisionPayload>(approvalEvent(turn));

          // Restore AFTER the park either way (approved or denied — the
          // run continues in both cases and the original container may
          // be long gone). The new handle is a recorded step result, so
          // replay re-attaches identically without re-creating anything.
          if (parkImage !== undefined) {
            const superseded = ws.handle;
            ws.handle = await ws.ctx.step(`${p}turn-${turn}-restore`, async () => (await config.executor.createFrom!(parkImage, sandboxOverridesOf(input))).handle);
            ws.executor = config.executor.attach(ws.handle);
            if (superseded !== ws.handle) await dispose(config, superseded);
          }

          if (!approval.approved) {
            const reason = approval.reason !== undefined ? `: ${approval.reason}` : "";
            messages.push({ role: "user", content: `Action denied by the operator${reason}. Choose a different approach.` });
            continue;
          }
        }

        const result = await ws.ctx.step(`${p}turn-${turn}-exec`, () =>
          executeAction(ws.executor, action, config.actionTimeoutMs, `t${turn}`),
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
          const fingerprint = await ws.ctx.step(`${p}turn-${turn}-fingerprint`, async () => {
            try {
              return (await workspaceFingerprint(ws.executor)) ?? null;
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
            return { status: signal.kind === "stop" ? "settled" : "stuck", summary, turns: turn + 1, usage, incomplete: true };
          }
          if (signal.kind === "nudge") {
            messages.push({ role: "user", content: signal.message });
          }
        }

        // A held finish that never came back. One recorded step, only on runs
        // that opted into the hold and actually took one, and only once the
        // grace has elapsed — so its presence is a function of the recorded
        // input and of earlier replayed results, exactly like the holds above.
        //
        // The requireEdit test is belt-and-braces and no mutation can kill it:
        // the only writer of heldCleanAtTurn sits inside the requireEdit-gated
        // hold, so it is already unreachable without it. Kept because it is the
        // determinism contract being stated where a reader will look for it,
        // and because a second writer added later would otherwise silently
        // start recording a step that old logs do not contain.
        if (input.requireEdit === true && heldCleanAtTurn !== null && turn - heldCleanAtTurn >= HOLD_GRACE_TURNS) {
          const stillClean = await ws.ctx.step(`${p}turn-${turn}-hold-recheck`, async () => {
            try {
              const fp = await workspaceFingerprint(ws.executor);
              return fp !== undefined && !fp.dirty;
            } catch {
              // Unreadable is not clean. Failing this open would end runs on a
              // transient git error, which is far worse than waiting.
              return false;
            }
          });
          if (stillClean) {
            // Publishes exactly as the cap would: incomplete, and on a HARNESS
            // sentence rather than the agent's. Not an oversight — the
            // clean-tree hold is a rejection, so it clears lastHeldFinish for
            // the reason spelled out at the nudge dispatch: adopting a claim
            // the run explicitly refused would launder it into the PR body and
            // the repo-memory note. The outcome is identical to running to the
            // cap; this only stops paying for the turns in between.
            const summary = `Held a finish over an unchanged tree and made no edit in the ${HOLD_GRACE_TURNS} turns since.`;
            return { status: "settled", summary: summary, turns: turn + 1, usage, incomplete: true };
          }
          // It wrote something. Normal flow resumes; a later finish is judged
          // on its own tree, not on this one.
          heldCleanAtTurn = null;
        }
      }

      // Non-empty diffs are published even off a max-steps exit — real
      // fixes die in runs that never got to say finish (SWE-bench lesson).
      // Non-empty diffs are still published off a max-steps exit — real fixes
      // died in runs that never got to say finish — but as a DRAFT, because
      // "ran out of turns" and "done" must not look alike to a reviewer.
      return { status: "max-steps", summary: `Reached the ${maxSteps}-turn limit.`, turns: maxSteps, usage, incomplete: true };
    },
  };
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
/**
 * The verification facts the loop itself established, before the publish gate
 * adds its own (verification-summary.ts). The publish gate mutates this object.
 */
function factsOf(result: HarnessResult, baseline: TestOutcome | undefined): VerificationFacts {
  return {
    agent: result.summary,
    status: result.status,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(result.fixAttempts !== undefined ? { fixAttempts: result.fixAttempts } : {}),
    ...(result.fixExhausted !== undefined ? { fixExhausted: result.fixExhausted } : {}),
    ...(result.critic !== undefined ? { critic: result.critic } : {}),
  };
}

/**
 * The output's `summary` and its companions. A scan's summary IS the model's
 * write-up (the findings parse out of it, and Akiroo reads it as such); every
 * other run's summary is the paragraph rendered from recorded steps, with the
 * agent's own account kept beside it.
 */
function summaryFields(
  input: DurableAgentInput,
  result: Pick<HarnessResult, "summary" | "critic">,
  facts: VerificationFacts,
): Pick<DurableAgentOutput, "summary" | "agentSummary" | "riskNotes"> {
  if (input.mode === "scan") return { summary: result.summary };
  return {
    summary: verificationSummary({ ...facts, ...(input.fixRetries !== undefined ? { fixRetries: input.fixRetries } : {}) }),
    agentSummary: result.summary,
    ...(result.critic !== undefined ? { riskNotes: result.critic.notes } : {}),
  };
}

/**
 * Publish whatever the tree holds after the run threw.
 *
 * Separate from publishIfRepoRun so the failure path can be read on its own,
 * and so its swallow-everything posture is explicit rather than smuggled into
 * the happy path. Returns the pull request URL, or null when there was nothing
 * to publish or the rescue itself failed.
 */
async function rescuePublish(
  ctx: WorkflowContext,
  ws: HarnessWorkspace,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  checkout: RepoCheckout | null,
  policy: RepoPolicyConfig,
  cause: unknown,
  baseline?: TestOutcome,
): Promise<string | null> {
  if (checkout === null || input.repo === undefined) return null;
  const why = cause instanceof Error ? cause.message : String(cause);
  try {
    return await publishIfRepoRun(
      ctx,
      ws.executor,
      config,
      input,
      checkout,
      `This run FAILED before it could finish, and this is the work it had already done.\n\n` +
        `The failure was: ${why.slice(0, 500)}\n\n` +
        "Treat the change as partial. Nothing here was reviewed by the agent's own finish gate, and the summary " +
        "it would have written does not exist.",
      policy,
      // Always incomplete: a run that threw did not finish, whatever its tree
      // looks like, and a reviewer must be able to tell that at a glance.
      true,
      undefined,
      baseline,
      undefined,
      // The rescued pull request carries the paragraph too (D3: every run),
      // built from what had actually been recorded when the run threw —
      // usually only the baseline — and the fact that it ended as a failure.
      { status: "failed", ...(baseline !== undefined ? { baseline } : {}) },
    );
  } catch {
    return null;
  }
}

async function publishIfRepoRun(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  checkout: RepoCheckout | null,
  summary: string,
  policy: RepoPolicyConfig,
  incomplete = false,
  evidence?: TestOutcome,
  baseline?: TestOutcome,
  /** The workspace handle, so the boundary park can snapshot it (C1). */
  handle?: string,
  /** Filled in as the gate goes; rendered into the PR lead and the run output. */
  facts: VerificationFacts = {},
): Promise<string | null> {
  // A SCAN PUBLISHES NOTHING (L2 / D3). First line of the function, before any
  // step, so no call site can forget it — this one guard covers the
  // single-attempt path, the multi-attempt path and `rescuePublish`, and covers
  // any call site added later.
  //
  // This is the whole fix. The MVP asked the model in prose not to change
  // files; on 2026-08-26 five of seven nightly scans pushed code anyway (an
  // invented nginx.conf, a 385-line package-lock regeneration, a doc comment
  // claiming validation that was never written) and every one of those pull
  // requests had to be closed by hand. A prompt is a request the model can drop
  // at turn 30; the publish gate not running is not.
  //
  // Returning null rather than throwing: publishing is the thing a scan does
  // not do, not an error it hit. The run's deliverable is the `scan-findings`
  // step, and it has already been recorded by the time this is called.
  if (input.mode === "scan") return null;
  if (checkout === null || input.repo === undefined) return null;
  const repoUrl = input.repo;
  const co = checkout;
  const ref = assertRepoAllowed(repoUrl, { trust: input.trust ?? "operator", config: policy });
  const token = credentialFor(ref, policy);
  const headToken = co.headRepo !== undefined ? credentialFor(parseRepoUrl(co.headRepo), policy) : "";
  // Contract 3: the `Akiroo-*:` footer lines ride the task text (the issue
  // body is the intake detail, which is the run's task). They are appended to
  // the commit message and the pull request body below, verbatim, so the item
  // and plan a change came from are readable off the forge and off `git log`
  // long after this run's page is gone.
  const trailers = akirooTrailersFrom(input.task);

  // 0. Run the suite BEFORE the push, so "tests passed" describes the code that
  // is about to become the pull request rather than an earlier state of it.
  // Unless the critic already ran it over this same tree — see testsIfAsked.
  // The ladder's `build` rung (C4) runs before the suite, for the same reason
  // a person types it first: a suite over a tree that cannot build is a
  // slower way of learning the build is broken.
  const build = await buildIfDeclared(ctx, executor, input);
  if (build !== undefined) facts.build = build;
  const tests = await testsIfAsked(ctx, executor, config, input, evidence);
  if (tests !== undefined) facts.tests = tests;

  // 0b. Classify the change, and park if it is serious (L3 / D2).
  //
  // BEFORE the push, deliberately. Once a branch exists on the forge the
  // question "may this be pushed" has already been answered, and a park that
  // happens afterwards is a park about a fact rather than a decision.
  //
  // PRE-DECIDED (2026-08-26): the gate is implemented at THIS point only, not
  // also after `plan-think`. The plan-time check adds no mechanism — it reuses
  // the existing `plan-approval` park — so it is a prompt change (teach the
  // plan to emit `DECISION:`) plus a classify call, and it answers a different
  // and weaker question: a plan's declared file list is a guess, while this
  // point has the actual diff. Reverses if plan-preview runs become common
  // enough that catching a serious change before the work is done is worth the
  // second gate; the classifier already accepts `planText` for that day.
  // Hoisted out of the block below so the auto-merge gate can read it. It is
  // the verdict of a RECORDED step, so a replay sees the same class it saw the
  // first time — which is what makes "trivial" usable as merge authority.
  let changeVerdict: ChangeVerdict | undefined;
  let changedList: ChangedFile[] = [];
  // C1: a change that neither deletes nor migrates, and that this run may not
  // merge on its own authority, is published as a draft and asked about at
  // the merge boundary (mergeBoundaryGate below) instead of here. The mid-run
  // park below is kept for a serious change that deletes or migrates.
  let boundaryPark = false;
  if (input.changeClass === true) {
    const verdict = await ctx.step("change-class", async () => {
      const files = await changedFiles(executor);
      return { ...classifyChange({ files, testsPassed: tests?.kind === "passed" }), files };
    });
    changeVerdict = verdict;
    changedList = verdict.files;
    facts.changeClass = { class: verdict.class, files: verdict.files.length };
    boundaryPark = input.mergeGate === true && midRunParkReasons(verdict.files).length === 0 && !mergesUnattended(input, verdict.class);
    if (verdict.class === "serious" && !boundaryPark) {
      const decision = await ctx.waitForEvent<ChangeDecisionPayload>(CHANGE_EVENT);
      if (!decision.approved) {
        // The work is NOT discarded: the tree is still in the workspace and the
        // classification, the reasons and the denial are all on the timeline.
        // A denial is a decision about publishing, not a judgement that the run
        // was worthless.
        await ctx.step("change-rejected", () => ({
          reason: decision.reason ?? "denied without a reason",
          class: verdict.class,
          reasons: verdict.reasons,
        }));
        return null;
      }
    }
  }

  // 1. Commit + push. Screened first; a refusal is recorded and stops here.
  const push = await ctx.step(
    "repo-push",
    async () => {
    const result = await commitAndPush(executor, {
      ref,
      token,
      checkout: co,
      message: `${input.task.slice(0, 68)}\n\nTeploy Ship ${ctx.runId}`,
      ...(headToken !== "" ? { headToken } : {}),
      ...(trailers.length > 0 ? { trailers } : {}),
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
    },
    EXTERNAL_EFFECT_RETRY,
  );
  facts.push = push.kind === "pushed" ? { kind: "pushed", sha: push.sha } : { kind: push.kind };

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
    await ctx.step(
      "repo-comment",
      async () => {
        await commentOnPr(ref, token, input.pr!, body);
        return true;
      },
      EXTERNAL_EFFECT_RETRY,
    );
    // A review follow-up pushed new commits to the same branch, so the preview
    // that branch is on is now stale. Refresh it, unless nothing was pushed.
    // A review follow-up pushed new commits, so any preview is stale and the
    // numbers moved. Refresh both, run the ladder legs over the fresh preview,
    // then amend the same Verification section.
    const followUpPreview = push.kind === "pushed" ? await previewIfAsked(ctx, config, input, co.branch) : undefined;
    const legs = await runLadderLegs(ctx, executor, config, input, followUpPreview, co.branch, { baseline, build, tests });
    const followUp: Evidence = {
      ...(tests !== undefined ? { tests } : {}),
      ...(baseline !== undefined ? { testsBaseline: baseline } : {}),
      ...(followUpPreview !== undefined ? { preview: followUpPreview } : {}),
      ...(input.telemetry === true ? { telemetry: await telemetryIfAsked(ctx, config, input) } : {}),
      ...(legs.rungs !== undefined ? { rungs: legs.rungs } : {}),
    };
    await publishVerification(ctx, ref, token, input.pr, followUp);
    // NO auto-merge and NO rollback watch on this path, deliberately. A review
    // follow-up is a run answering a comment on a pull request a person is
    // already reading — there is a human on the thread by definition, and
    // merging out from under them, or acting on a preview refresh they asked
    // for, is the wrong actor. PRE-DECIDED (2026-08-26); reverses if follow-up
    // runs ever become the unattended path, which would be a bigger change
    // than this one line.
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
  // A serious change headed for the boundary park opens as a DRAFT: nobody
  // may merge it before the decision, and the forge's own merge button is the
  // one path this workflow cannot see.
  const asDraft = incomplete || flagged || boundaryPark;
  const pr = await ctx.step(
    "repo-pr",
    async () => {
    const existing = await findOpenPullRequest({ ref, token, head: co.branch, owner: ref.owner }).catch(() => null);
    if (existing !== null) return { url: existing.url, number: existing.number };
    const created = await openPullRequest({
      ref,
      token,
      head: co.branch,
      base: co.base,
      draft: asDraft,
      title: prTitle(input.task, incomplete),
      ...(trailers.length > 0 ? { trailers } : {}),
      body:
        // The lead is the paragraph a reviewer reads instead of the diff:
        // what was done, what a recorded step verified, what nothing did.
        // Rendered from the facts known at this point — the preview and the
        // telemetry read come after the PR exists and land in the
        // Verification section below it.
        `${verificationSummary({ ...facts, ...(input.fixRetries !== undefined ? { fixRetries: input.fixRetries } : {}) })}\n\n` +
        `${summary}` +
        (facts.critic !== undefined && !facts.critic.approved
          ? `\n\n**Risk notes** (from the critic, after the suite; advisory):\n\n${facts.critic.notes.trim().slice(0, 1500)}`
          : "") +
        `\n\n---\nTask: ${input.task}\nRun: ${ctx.runId}\nGenerated by Teploy Ship.` +
        (incomplete
          ? facts.fixExhausted !== undefined
            ? `\n\n**The suite is still red** after ${facts.fixExhausted.attempts} fix attempts (exit ${facts.fixExhausted.exitCode}); the last failure is in the Verification section. Review before merging.`
            : `\n\n**This run did not finish** — it stopped at a limit, so the change may be partial. Review before merging.`
          : "") +
        (push.kind === "pushed" && push.warning !== undefined ? `\n\n${push.warning}` : ""),
    });
      return { url: created.url, number: created.number };
    },
    EXTERNAL_EFFECT_RETRY,
  );
  facts.pr = pr;
  await requestReviewersIfAsked(ctx, ref, token, pr.number, input);
  // Hoisted into locals rather than left inline in the publishVerification call:
  // the rollback watch (P1-4), the ladder legs and the auto-merge gate (L5)
  // all need to read what these steps produced, and none may re-run them.
  const preview = await previewIfAsked(ctx, config, input, co.branch);
  const telemetry = await telemetryIfAsked(ctx, config, input);
  // The ladder legs (C4 / L4): the smoke against the preview, the visual diff
  // against main, the observe window after it — then the rung list, recorded
  // as its own step so the webhook and the run page read ONE list instead of
  // each re-deriving it from six steps and disagreeing.
  const legs = await runLadderLegs(ctx, executor, config, input, preview, co.branch, { baseline, build, tests });
  if (legs.smoke !== undefined) facts.smoke = legs.smoke;
  if (legs.visual !== undefined) facts.visual = legs.visual;
  if (legs.observe !== undefined) facts.observeWindow = legs.observe;
  await publishVerification(ctx, ref, token, pr.number, {
    ...(tests !== undefined ? { tests } : {}),
    ...(baseline !== undefined ? { testsBaseline: baseline } : {}),
    preview,
    telemetry,
    ...(legs.rungs !== undefined ? { rungs: legs.rungs } : {}),
    // So a root-level suite over a change confined to one subtree is called
    // out on the pull request rather than read as a green gate (tests.ts).
    ...(changedList.length > 0 ? { changedPaths: changedList.map((f) => f.path) } : {}),
  });
  // Computed ONCE, outside any step, and fed to both gates below. It is a pure
  // function of the `telemetry-check` step's recorded verdict (see
  // telemetryRegression in observe.ts), so it replays identically — and
  // deriving it twice would leave two places that could disagree about whether
  // the same numbers were a regression.
  const regression = telemetry === undefined ? undefined : telemetryRegression(telemetry);
  if (preview !== undefined) facts.preview = preview.kind === "deployed" ? { kind: "deployed", url: preview.url } : { kind: preview.kind, reason: preview.reason };
  if (telemetry !== undefined) {
    facts.telemetry = telemetry.kind === "compared" ? { kind: "compared", worse: regression!.worse } : { kind: telemetry.kind, reason: telemetry.reason };
  }
  await rollbackIfWorse(ctx, config, input, preview, regression);
  const merge = await autoMergeIfAllowed(
    ctx,
    ref,
    token,
    input,
    pr.number,
    {
      ...(changeVerdict !== undefined ? { verdict: changeVerdict } : {}),
      ...(tests !== undefined ? { tests } : {}),
      draft: asDraft,
      ...(regression !== undefined ? { regression } : {}),
    },
    { executor, checkout: co, config },
    legs.rungs,
  );
  if (merge?.tests !== undefined) facts.tests = merge.tests;
  if (merge?.outcome.kind === "merged") facts.merge = { kind: "merged", via: "auto" };
  else if (merge?.outcome.kind === "held") facts.merge = { kind: "held", reasons: merge.outcome.reasons };
  else if (merge?.outcome.kind === "failed") facts.merge = { kind: "merge-failed", reason: merge.outcome.reason };
  if (boundaryPark && changeVerdict !== undefined) {
    const decided = await mergeBoundaryGate(ctx, executor, config, input, { ref, token, checkout: co, pr, handle }, {
      verdict: changeVerdict,
      files: changedList,
      ...(tests !== undefined ? { tests } : {}),
      ...(regression !== undefined ? { regression } : {}),
    });
    // The boundary decision supersedes whatever the auto-merge gate said about
    // the same pull request, and a rebase's re-run suite — when it happened —
    // supersedes the pre-rebase one: the paragraph describes the tree that was
    // decided on. The mapper is shared with the event-log producer so the two
    // cannot disagree about what a decision means.
    if (decided?.tests !== undefined) facts.tests = decided.tests;
    const fact = decided !== undefined ? mergeFact(decided.decision, "approved") : undefined;
    if (fact !== undefined) facts.merge = fact;
  }
  await remember(pr.url);
  return pr.url;
}

/** What the boundary decision produced, as recorded on the `merge-decision` step. */
type MergeDecisionStep =
  | { kind: "closed"; reason: string; ok: boolean; detail?: string }
  | { kind: "ready"; rebase: "up-to-date" | "rebased"; sha: string; ok: boolean; detail?: string }
  | { kind: "merged"; rebase: "up-to-date" | "rebased"; sha?: string }
  | { kind: "merge-failed"; rebase: "up-to-date" | "rebased"; status: number; reason: string }
  | { kind: "blocked"; reasons: string[] };

/**
 * The boundary park (C1) and what follows it (C7).
 *
 * The run has done the work, pushed, opened a DRAFT pull request and recorded
 * every verification leg it was given. Only now is a person asked, and the
 * question is the one a person can actually answer with the evidence in front
 * of them: merge this, or not. Nothing about the run's workspace is needed to
 * decide, which is what makes a park here survivable for days — the snapshot
 * exists so the rebase below has a checkout to run in.
 *
 * Approve: rebase `ship/<runId>` onto the current default branch. Up to date
 * means the verification on the pull request still describes these bytes, so
 * the pull request is marked ready at once. Rebased means it does not, so the
 * suite is re-run — the run re-verifies rather than asking again — and a
 * failure leaves the pull request a draft with the failure on it. A conflict
 * parks again with the files listed. An approved and re-verified change is
 * MERGED: the person's decision supplies the authority the run's own setting
 * withheld, and `autoMerge` governs only merges nobody was asked about. (It
 * used to merge only where `autoMerge` was on and otherwise mark the pull
 * request ready; "Approve merge" then left a person a second click in the
 * forge that nothing pointed at.)
 *
 * Deny: the pull request is closed with the reason. The branch stays.
 */
async function mergeBoundaryGate(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  target: { ref: RepoRef; token: string; checkout: RepoCheckout; pr: { url: string; number: number }; handle?: string },
  facts: { verdict: ChangeVerdict; files: ChangedFile[]; tests?: TestOutcome; regression?: { worse: boolean; reasons: string[] } },
): Promise<{ decision: MergeDecisionStep | undefined; tests?: TestOutcome }> {
  const { ref, token, checkout, pr } = target;
  let exec = executor;
  let handle = target.handle;
  const canSnapshot = handle !== undefined && config.executor.snapshot !== undefined && config.executor.createFrom !== undefined;
  let conflict: string[] | undefined;
  // The decision the loop ended on, so the caller's verification paragraph can
  // say how the merge question resolved, plus the re-run suite when an approval
  // rebased (the paragraph describes the tree that was decided on). Undefined
  // decision = still asking (the attempt bound ran out mid-conflict), which the
  // paragraph reports by omission.
  let final: MergeDecisionStep | undefined;
  let retests: TestOutcome | undefined;
  // Bounded: a person can be asked about the same conflict only so many times
  // before the honest outcome is "this branch needs a human at a keyboard".
  for (let attempt = 1; attempt <= 3; attempt++) {
    // The park's own record — what is being asked, and why. This is what the
    // run page, the approval row and the Akiroo card read.
    await ctx.step("merge-park", () => ({
      attempt,
      class: facts.verdict.class,
      reasons: facts.verdict.reasons,
      pr: pr.url,
      summary: mergeParkSummary(facts.verdict, facts.files, pr.url, conflict),
      ...(conflict !== undefined ? { conflict } : {}),
    }));
    let parkImage: string | undefined;
    if (canSnapshot && handle !== undefined) {
      const h = handle;
      parkImage = await ctx.step("merge-snapshot", () => config.executor.snapshot!(h));
    }
    const decision = await ctx.waitForEvent<MergeDecisionPayload>(MERGE_EVENT);
    if (parkImage !== undefined) {
      const image = parkImage;
      const superseded = handle;
      handle = (await ctx.step("merge-restore", async () => config.executor.createFrom!(image, sandboxOverridesOf(input)))).handle;
      exec = config.executor.attach(handle);
      if (superseded !== undefined && superseded !== handle) await dispose(config, superseded);
    }

    if (!decision.approved) {
      const reason = decision.reason ?? "denied without a reason";
      final = await ctx.step(
        "merge-decision",
        async (): Promise<MergeDecisionStep> => {
          await commentOnPr(ref, token, pr.number, `Closed by Teploy Ship (run ${ctx.runId}): the merge was denied.

${reason}`).catch(() => undefined);
          const closed = await closePullRequest(ref, token, pr.number);
          return { kind: "closed", reason, ok: closed.ok, ...(closed.reason !== undefined ? { detail: closed.reason } : {}) };
        },
        EXTERNAL_EFFECT_RETRY,
      );
      break;
    }

    const rebase = await ctx.step("merge-rebase", () => rebaseOntoBase(exec, { ref, token, checkout }));
    if (rebase.kind === "conflict") {
      conflict = rebase.files;
      continue;
    }
    if (rebase.kind === "failed") {
      final = await ctx.step("merge-decision", async (): Promise<MergeDecisionStep> => {
        await commentOnPr(ref, token, pr.number, `Teploy Ship (run ${ctx.runId}) could not rebase this branch onto ${checkout.base}: ${rebase.reason}`).catch(() => undefined);
        return { kind: "blocked", reasons: [`rebase failed: ${rebase.reason}`] };
      });
      break;
    }
    // Rebased = different bytes from the ones the pull request's Verification
    // section describes. Re-run the suite instead of asking; up to date keeps
    // the recorded result.
    const tests = rebase.kind === "rebased" ? await runSuite(ctx, exec, config, input, "rebase-") : facts.tests;
    if (rebase.kind === "rebased" && tests !== undefined) retests = tests;
    const blocked: string[] = [];
    if (tests !== undefined && tests.kind !== "passed" && tests.kind !== "disabled") blocked.push(`the suite did not pass after the rebase (${tests.kind})`);
    if (facts.regression?.worse === true) blocked.push(`the service got worse after this change: ${facts.regression.reasons.join("; ")}`);
    final = await ctx.step(
      "merge-decision",
      async (): Promise<MergeDecisionStep> => {
        if (blocked.length > 0) {
          await commentOnPr(ref, token, pr.number, `Approved, but not marked ready by Teploy Ship (run ${ctx.runId}):\n${blocked.map((b) => `- ${b}`).join("\n")}`).catch(() => undefined);
          return { kind: "blocked", reasons: blocked };
        }
        const ready = await markPullRequestReady(ref, token, pr.number);
        const note =
          rebase.kind === "rebased"
            ? `rebased onto ${checkout.base} (${rebase.base.slice(0, 10)}) and re-verified: suite ${tests?.kind ?? "not run"}`
            : `already on the tip of ${checkout.base}; the recorded verification stands`;
        // Marked ready first because a forge refuses to merge a draft; if that
        // refusal stands, the merge outcome below says so.
        const outcome = await mergePullRequest(ref, token, pr.number, {
          method: "squash",
          message: `Merged by Teploy Ship (run ${ctx.runId}) on an approved merge decision.

Classified ${facts.verdict.class}: ${facts.verdict.reasons.join("; ")}
${note}.`,
        });
        return outcome.kind === "merged"
          ? { kind: "merged", rebase: rebase.kind, ...(outcome.sha !== undefined ? { sha: outcome.sha } : {}) }
          : {
              kind: "merge-failed",
              rebase: rebase.kind,
              status: outcome.status,
              reason: ready.ok ? outcome.reason : `${outcome.reason} (the pull request could not be marked ready first: ${ready.reason ?? "refused"})`,
            };
      },
      EXTERNAL_EFFECT_RETRY,
    );
    break;
  }
  // The restored workspace is this function's own; the caller only knows the
  // handle it passed in, which the restore already released.
  if (handle !== undefined && handle !== target.handle) await dispose(config, handle);
  return { decision: final, ...(retests !== undefined ? { tests: retests } : {}) };
}

/** What the `rollback` step recorded. Every branch is an outcome, never a throw. */
type RollbackStep =
  | { kind: "not-deployed"; reason: string }
  | { kind: "healthy"; reasons: string[] }
  | { kind: "would-roll-back"; reasons: string[] }
  | { kind: "rolled-back"; reasons: string[]; output: string }
  | { kind: "failed"; reasons: string[]; reason: string };

/**
 * Watch what the change did to the service, and say what should happen (P1-4).
 *
 * OBSERVABLE FIRST, and that is the design rather than a stage of it. The
 * default outcome of this step is a sentence — "the service got worse, here is
 * the measurement, this is what I would have done" — and only a repo whose
 * project record carries `autoDeploy` gets the act. Nothing has ever been
 * rolled back by a machine in this system, so there is no distribution behind
 * `defaultRegressionThresholds` (observe.ts) yet; these recorded steps are how
 * one gets collected before anything destructive runs on them.
 *
 * TWO conditions, not one. The service must have got worse AND this run must
 * have actually deployed something — a repo whose p95 moved while Ship only
 * opened a pull request is watching an unrelated deploy, which is the same
 * false-attribution failure that cost the telemetry leg a live run on
 * 2026-08-21 (see telemetryIfAsked above).
 *
 * The step is recorded whenever `input.rollback` is set, refusals included, so
 * step presence stays a function of the recorded input — the same shape as
 * requestReviewersIfAsked and previewIfAsked.
 */
async function rollbackIfWorse(
  ctx: WorkflowContext,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
  regression: { worse: boolean; reasons: string[] } | undefined,
): Promise<void> {
  if (input.rollback !== true) return;
  await ctx.step("rollback", async (): Promise<RollbackStep> => {
    if (preview?.kind !== "deployed") {
      return {
        kind: "not-deployed",
        reason:
          preview === undefined
            ? "this run deployed nothing, so there is nothing to roll back"
            : `the deploy did not happen (${preview.kind}: ${preview.reason}), so there is nothing to roll back`,
      };
    }
    if (regression === undefined) {
      return { kind: "not-deployed", reason: "telemetry was not read for this run, so there is nothing to judge" };
    }
    if (!regression.worse) return { kind: "healthy", reasons: regression.reasons };
    // Worse, and the run deployed. From here the only question is authority.
    if (input.autoDeploy !== true) {
      return { kind: "would-roll-back", reasons: regression.reasons };
    }
    if (config.preview === undefined) {
      return {
        kind: "would-roll-back",
        reasons: [...regression.reasons, "this worker has no teploy working copy configured, so it could not act"],
      };
    }
    try {
      const outcome = await rollbackDeploy(config.preview);
      return outcome.kind === "rolled-back"
        ? { kind: "rolled-back", reasons: regression.reasons, output: outcome.output }
        : { kind: "failed", reasons: regression.reasons, reason: outcome.reason };
    } catch (error) {
      // rollbackDeploy is written not to throw; if it ever does, the run must
      // still end with its pull request. A rollback that failed is a page for a
      // human, not a failed run.
      return { kind: "failed", reasons: regression.reasons, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** What the `auto-merge` step recorded. `held` is the interesting one: it says WHY not. */
type AutoMergeStep =
  | { kind: "merged"; why: string[]; sha?: string }
  | { kind: "held"; reasons: string[] }
  | { kind: "failed"; status: number; reason: string };

/**
 * Merge without a human (L5 / D5, recut by C4 / D3).
 *
 * TWO GATES, ONE RULE: which one runs is a fact of the recorded input, never
 * of this build, so a replay computes what it computed.
 *
 * LEGACY (no `authority` on the input — every run enqueued before the ladder,
 * and every project with nothing authority-shaped on its record): the four
 * historical conditions — class `trivial`, suite `passed`, non-draft PR,
 * telemetry not worse. Unchanged, byte for byte, because these runs' logs
 * already hold their verdicts.
 *
 * LADDER (the input carries `authority`): the gate reads ONLY the recorded
 * rungs (ladder.ts ladderGate) — baseline, build, tests, preview smoke,
 * visual diff, observe window — plus the effective authority and the recorded
 * change class. The critic is nowhere in it: D3's whole bet is that the trust
 * boundary is what a step RECORDED, not what a model opined. The ladder also
 * caps the authority a project can hold (no tests rung declared -> never past
 * `send`; preview+visual -> `auto_trivial`; every rung -> `auto_normal`), and
 * the cap was applied at ENQUEUE, so the authority on the input is already
 * the effective one — this gate only re-reads it, never re-derives it.
 *
 * A FAILED MERGE IS NOT A FAILED RUN. mergePullRequest never throws and this
 * step never retries: the pull request is the deliverable and the merge is a
 * convenience on top of it. A retry is also actively wrong here — a timeout
 * after the forge merged, retried, comes back 405 "already merged" and would
 * record `failed` for a merge that happened.
 *
 * Recorded whenever `input.autoMerge` is set, refusals included. That is what
 * makes the timeline answer the question a reader of an unattended merge
 * actually has, which is not "did it merge" but "why was it allowed to".
 */
/**
 * Whether a change of this class merges with no person involved under the
 * authority this run carries. The boundary park (C1) asks a person about every
 * change this says no to. It mirrors the CLASS question of the two gates in
 * autoMergeIfAllowed — legacy `autoMerge` merges trivial only; the ladder
 * merges what its rung names — and nothing else: suite, draft and rung
 * evidence are that function's to check, and a merge it then holds is on the
 * timeline as `held`.
 */
function mergesUnattended(input: DurableAgentInput, cls: ChangeVerdict["class"]): boolean {
  if (input.autoMerge !== true) return false;
  if (input.authority === undefined) return cls === "trivial";
  if (input.authority === "auto_normal") return cls === "trivial" || cls === "normal";
  if (input.authority === "auto_trivial") return cls === "trivial";
  return false;
}

async function autoMergeIfAllowed(
  ctx: WorkflowContext,
  ref: RepoRef,
  token: string,
  input: DurableAgentInput,
  pr: number,
  facts: {
    verdict?: ChangeVerdict;
    tests?: TestOutcome;
    draft: boolean;
    regression?: { worse: boolean; reasons: string[] };
  },
  target?: { executor: AgentExecutor; checkout: RepoCheckout; config: DurableAgentConfig },
  /** The recorded rung list (`ladder` step), when the run declared a ladder. */
  rungs?: Rung[],
): Promise<{ outcome: AutoMergeStep; tests?: TestOutcome } | undefined> {
  if (input.autoMerge !== true) return undefined;
  const held: string[] = [];
  if (input.authority === undefined) {
    // LEGACY gate, verbatim (see the doc comment above).
    if (facts.verdict === undefined) {
      held.push("the change was never classified, so nothing authorises merging it");
    } else if (facts.verdict.class !== "trivial") {
      held.push(`the change classified ${facts.verdict.class}, and only trivial merges unattended`);
    }
    if (facts.tests === undefined) {
      held.push("the suite did not run for this run");
    } else if (facts.tests.kind !== "passed") {
      held.push(
        facts.tests.kind === "disabled"
          ? `no suite is configured for this repo (${facts.tests.reason})`
          : `the suite did not pass (${facts.tests.kind})`,
      );
    }
    if (facts.draft) held.push("the pull request opened as a draft, so a person is expected to read it");
    if (facts.regression?.worse === true) held.push(`the service got worse after this change: ${facts.regression.reasons.join("; ")}`);
  } else {
    // LADDER gate (C4 / D3): recorded rungs only. The rung list comes from
    // the `ladder` step; its absence on an authority-carrying input means
    // no rung was recorded at all, which the gate says and holds on.
    const gate = ladderGate({
      rungs: rungs ?? [],
      authority: input.authority,
      ...(facts.verdict !== undefined ? { changeClass: facts.verdict.class } : {}),
      draft: facts.draft,
    });
    held.push(...gate.reasons);
  }

  // REBASE-BEFORE-MERGE (C7). Only when every gate above said yes: a run that
  // is holding merges nothing, so it rebases nothing either — and a change
  // headed for the boundary park (mergeBoundaryGate) rebases at DECISION
  // time, where a fresh approval deserves a fresh base. The seconds between
  // the push and this step make the up-to-date case the common one; the rebase
  // exists for the base that moved under a serialization queue or a human
  // push, and a re-run suite over the new bytes — never a park, this path has
  // no human to park for. The hold reasons stay on the recorded step.
  let tests = facts.tests;
  if (held.length === 0 && target !== undefined) {
    const { executor, checkout, config } = target;
    const rebase = await ctx.step("auto-rebase", () => rebaseOntoBase(executor, { ref, token, checkout }));
    if (rebase.kind === "conflict") {
      held.push(`the branch conflicts with the current ${checkout.base}: ${rebase.files.join(", ")}`);
    } else if (rebase.kind === "failed") {
      held.push(`the branch could not be rebased onto ${checkout.base}: ${rebase.reason}`);
    } else if (rebase.kind === "rebased") {
      tests = await runSuite(ctx, executor, config, input, "auto-rebase-");
      if (tests !== undefined && tests.kind !== "passed" && tests.kind !== "disabled") {
        held.push(`the suite did not pass after the rebase (${tests.kind})`);
      }
    }
  }

  const outcome = await ctx.step("auto-merge", async (): Promise<AutoMergeStep> => {
    if (held.length > 0) return { kind: "held", reasons: held };

    const why = facts.verdict?.reasons ?? [];
    const outcome = await mergePullRequest(ref, token, pr, {
      method: "squash",
      message:
        `Merged by Teploy Ship (run ${ctx.runId}) without a human.\n\n` +
        (input.authority !== undefined
          ? `Authority ${input.authority}, classified ${facts.verdict?.class ?? "unclassified"}: ${why.join("; ")}\n` +
            `Rungs: ${(rungs ?? []).map((r) => `${r.name} ${r.status}`).join(", ") || "none recorded"}.`
          : `Classified trivial: ${why.join("; ")}\nSuite: ${tests?.kind ?? "not run"}.`),
    });
    return outcome.kind === "merged"
      ? { kind: "merged", why, ...(outcome.sha !== undefined ? { sha: outcome.sha } : {}) }
      : { kind: "failed", status: outcome.status, reason: outcome.reason };
  });
  // The rebase path's re-run suite, when it happened: the caller's verification
  // paragraph must describe the tree that was merged, not the pre-rebase one.
  return { outcome, ...(tests !== facts.tests ? { tests } : {}) };
}

/**
 * Ask the forge for the reviewers the repo's rule names. Recorded whenever
 * `input.reviewers` is set; a refused or failed request is the step's outcome,
 * visible on the run's timeline, and the pull request stays open regardless.
 */
async function requestReviewersIfAsked(
  ctx: WorkflowContext,
  ref: RepoRef,
  token: string,
  pr: number,
  input: DurableAgentInput,
): Promise<void> {
  if (input.reviewers === undefined) return;
  const asked = input.reviewers;
  await ctx.step("repo-reviewers", async (): Promise<{ kind: "requested" | "failed"; users: string[]; teams: string[]; reason?: string }> => {
    try {
      await requestReviewers({ ref, token, pr, users: asked.users, teams: asked.teams });
      return { kind: "requested", users: asked.users, teams: asked.teams };
    } catch (error) {
      return { kind: "failed", users: asked.users, teams: asked.teams, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Deploy a preview of the pushed branch and say so on the pull request.
 *
 * Both steps are recorded whenever the run asked for a preview — `input.preview`
 * or a declared preview rung (input.verification.preview) — including when this
 * worker has no preview target: a disabled note keeps the step sequence a
 * function of the recorded input rather than of which host picked the run up.
 *
 * A run with a declared preview APP (contract 1's `preview.app`) deploys that
 * app: the worker's preview directory may be a ROOT holding one clone per app
 * (`<dir>/<app>/teploy.yml`), so the app resolves to its own working copy —
 * resolvePreviewTarget, deploy.ts. The app's preview env (prod secrets
 * scrubbed, teploy injecting what the profile allows) is teploy's side of the
 * wire: Ship names the app and never sees an env value.
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
): Promise<PreviewOutcome | undefined> {
  if (input.preview !== true && input.verification?.preview === undefined) return undefined;

  const outcome = await ctx.step("preview-deploy", async (): Promise<PreviewOutcome> => {
    if (config.preview === undefined) {
      return { kind: "skipped", reason: "no preview target configured on this worker" };
    }
    const target = resolvePreviewTarget(config.preview, input.verification?.preview?.app);
    try {
      return await deployPreview(target, branch);
    } catch (error) {
      // deployPreview is written not to throw; if it ever does, the run must
      // still end with its pull request.
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  });

  // The outcome goes into the pull request BODY, with the telemetry, as one
  // Verification section — see publishVerification. Reporting it here as its
  // own comment made a reviewer hunt for two footnotes under the body.
  return outcome;
}

/**
 * The ladder legs that follow a preview (ladder-steps.ts): the smoke against
 * it, the visual diff of it vs main, the observe window after it, and the
 * rung list all of them reduce to — recorded as the `ladder` step so the
 * webhook and the run page read ONE list.
 *
 * A helper, not inline code, because BOTH publish paths must run the same
 * legs in the same order: the review follow-up path and the main gate carry
 * the same recorded input, and the standing rule (see
 * DurableAgentInput.verification) is that step presence and order are a
 * function of that input alone.
 */
async function runLadderLegs(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
  branch: string,
  suite: { baseline?: TestOutcome; build?: TestOutcome; tests?: TestOutcome },
): Promise<{ smoke?: SmokeOutcome; visual?: VisualOutcome; observe?: ObserveOutcome; rungs?: Rung[] }> {
  if (input.verification === undefined) return {};
  const smoke = await smokeIfDeclared(ctx, executor, input, preview);
  const visual = await visualIfDeclared(ctx, executor, input, preview);
  const observe = await observeIfDeclared(ctx, config, input, preview, branch);
  const rungs = await recordLadder(ctx, input, { ...suite, preview, ...(smoke !== undefined ? { smoke } : {}), ...(visual !== undefined ? { visual } : {}), ...(observe !== undefined ? { observe } : {}) });
  return { ...(smoke !== undefined ? { smoke } : {}), ...(visual !== undefined ? { visual } : {}), ...(observe !== undefined ? { observe } : {}), ...(rungs !== undefined ? { rungs } : {}) };
}

/**
 * Put the service's measured before/after on the pull request.
 *
 * The interesting case is the one that says nothing: a preview environment
 * serves almost no traffic, so the honest default outcome is "not enough data
 * to compare", printed as such. A confident number computed off nine requests
 * would look like proof and would be noise — the same mistake as reading a
 * process metric as a score, which cost two sweeps this week.
 */
async function telemetryIfAsked(
  ctx: WorkflowContext,
  config: DurableAgentConfig,
  input: DurableAgentInput,
): Promise<TelemetryVerdict | undefined> {
  if (input.telemetry !== true) return undefined;

  const verdict = await ctx.step("telemetry-check", async (): Promise<TelemetryVerdict> => {
    // Per-repo service/repo from the run input layered over the worker's
    // wiring: the URL and share token are the worker's (a run input never
    // carries a credential), the service is a fact about the repo and
    // travels with the run. A worker wired for one service must read each
    // repo's own service, not the one its env names.
    const target = effectiveTelemetryTarget(config.telemetry, input);
    if (target === undefined) {
      return { kind: "disabled", reason: "no telemetry target configured on this worker" };
    }
    // The service this comparison reads has to be the one this run touched.
    // Proven necessary by a live run on 2026-08-21: a worker set to watch
    // `fylun-web` reported its RED metrics on a pull request that changed one
    // line of Go in an unrelated repo, and the reviewer saw "p95 up 2653ms"
    // under a change that could not have caused it. Real numbers, nonsense
    // attribution — which reads as a finding rather than as noise, and is
    // therefore worse than saying nothing.
    if (!telemetryAppliesTo(target, input.repo)) {
      return {
        kind: "disabled",
        reason: `this run is not on ${target.repo}, which is the repo OBSERVE_SERVICE=${target.service} is built from`,
      };
    }
    try {
      return await compareAroundNow(target, new Date());
    } catch (error) {
      return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  });

  return verdict;
}


/**
 * Amend the pull request body with what the run measured.
 *
 * One step, gated on the run INPUT (not on how this worker is wired), so the
 * recorded step sequence is the same everywhere. The body is read before it is
 * written: Ship wrote it, but a reviewer may have edited it since, and
 * clobbering their notes to add a URL is a bad trade. If the read or the write
 * fails, the evidence falls back to a comment — worse placement, still
 * delivered — and if that fails too the run ends normally with its PR.
 *
 * Renaming the two comment steps this replaces is safe: both features landed
 * today and are unreleased, so no enqueued run has a log containing them.
 * After a release this would be a replay-breaking change.
 */
async function publishVerification(
  ctx: WorkflowContext,
  ref: RepoRef,
  token: string,
  pr: number | undefined,
  evidence: Evidence,
): Promise<void> {
  const section = verificationSection(evidence, ctx.runId);
  if (section === null || pr === undefined) return;
  await ctx.step("verification", async () => {
    const current = await readPullRequestBody({ ref, token, pr });
    if (current !== null) {
      const updated = await updatePullRequestBody({ ref, token, pr, body: spliceVerification(current, section) });
      if (updated) return "body";
    }
    await commentOnPr(ref, token, pr, section).catch(() => {});
    return "comment";
  });
}


/**
 * Run the suite, once, after the agent has stopped touching the tree.
 *
 * Before the push, deliberately: the result belongs in the evidence that goes
 * out with the pull request, and a reviewer reading "tests passed" wants it to
 * mean the code in the PR, not the code as it was two steps earlier.
 */
async function testsIfAsked(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  /**
   * A suite result already produced over this exact tree — the critic's, when
   * the run finished on the turn the critic reviewed. Reused rather than
   * re-run: it is the same command over the same bytes, and a project suite is
   * minutes, not milliseconds.
   */
  already?: TestOutcome,
): Promise<TestOutcome | undefined> {
  if (input.tests !== true) return undefined;
  // Reused, but still RECORDED under the historical `tests` key. The step is
  // what the run timeline, explain.ts and the P5-1 replay fence all look for,
  // so skipping it entirely would make a reused outcome invisible — and would
  // change the step sequence of a replay. Recording a value the caller already
  // has is free; running the suite twice over identical bytes is minutes.
  if (already !== undefined) return await ctx.step("tests", async () => already);
  return await runSuite(ctx, executor, config, input, "");
}

/**
 * Run the project's suite as a recorded step.
 *
 * `stepPrefix` keys the step. The publish gate uses "" — the historical
 * `tests` key, so every existing run replays untouched — and the critic pass
 * uses its own turn-scoped prefix, because the two are different runs of the
 * suite at different points in the run and a shared key would make the second
 * one silently replay the first.
 */
async function runSuite(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  stepPrefix: string,
): Promise<TestOutcome | undefined> {
  if (input.tests !== true) return undefined;
  return await ctx.step(`${stepPrefix}tests`, async (): Promise<TestOutcome> => {
    // Per-repo first: one worker serving many repos runs each repo's own
    // suite. The env default remains for repos with no entry and for runs
    // enqueued before per-repo evidence existed.
    const target = testTargetFromInput(input) ?? config.tests;
    if (target === undefined) {
      return { kind: "disabled", reason: "no test command configured for this repo or worker" };
    }
    return await runTests(executor, target);
  });
}

/**
 * Read one workspace file as text, for the critic's `read_file` tool.
 *
 * Paths are resolved under the run's workdir and confined to it: the reviewer
 * names a repo-relative path and a traversal out of the tree is refused rather
 * than served. Read-only by construction — the executor's getFile cannot
 * write.
 */
/**
 * What this run actually changed, as numbers the classifier can judge.
 *
 * Two git calls, not one: `--numstat` gives the counts but cannot distinguish a
 * DELETED file from a fully-rewritten one (both read as N deletions, 0
 * additions), and "deletes a file" is one of the rules that makes a change
 * serious. `--diff-filter=D` answers that directly.
 *
 * Staged, because that is what would be committed — the same thing the publish
 * screen looks at.
 */
async function changedFiles(executor: AgentExecutor): Promise<ChangedFile[]> {
  await executor.exec("git add -A", { timeoutMs: 60_000 });
  const numstat = await executor.exec("git diff --cached --numstat", { timeoutMs: 60_000 });
  if (numstat.exitCode !== 0) return [];
  const deleted = await executor.exec("git diff --cached --name-only --diff-filter=D", { timeoutMs: 60_000 });
  const deletedSet = new Set(
    deleted.exitCode === 0 ? deleted.stdout.split("\n").map((p) => p.trim()).filter((p) => p !== "") : [],
  );
  return parseNumstat(numstat.stdout).map((file) => ({ ...file, isDelete: deletedSet.has(file.path) }));
}

async function readWorkspaceFile(executor: AgentExecutor, workdir: string, path: string): Promise<string> {
  const relative = path.replace(/^\.\//, "");
  if (relative.startsWith("/") || relative.split("/").includes("..")) {
    throw new Error("path must be relative to the repository root");
  }
  const full = `${workdir.replace(/\/$/, "")}/${relative}`;
  return new TextDecoder().decode(await executor.getFile(full));
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
  /**
   * The worker-wide network tier a run gets when its project record names
   * none. Left unset here this provider names no network at all and the
   * DAEMON's default applies, which is `none` — a sandbox that cannot clone.
   * `resolveSandbox` in cli.ts is what stops that being the lived default;
   * see DEFAULT_NETWORK_TIER in egress.ts for why it is `allowlist`.
   */
  network?: NetworkTier;
  fetch?: typeof globalThis.fetch;
}): ExecutorProvider {
  const base = { baseURL: options.baseURL, token: options.token, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) };
  const create = {
    image: options.image,
    ...(options.ttlSec !== undefined ? { ttlSec: options.ttlSec } : {}),
    ...(options.network !== undefined ? { network: wireNetwork(options.network) } : {}),
  };
  const warm = warmClient(base);
  return {
    isolated: true,
    async create(overrides?: SandboxOverrides) {
      const wanted = definedOverrides(overrides);
      try {
        // Neither `warm` nor `egressAllow` is in @neutron-build/agents'
        // SandboxCreateOptions — the client posts `create` verbatim, so the
        // fields reach the daemon and the cast is the whole of the coupling.
        // A daemon that predates `egressAllow` ignores it (its decoder does not
        // reject unknown fields), which degrades to "those hosts stay blocked"
        // — visible now, as a named refusal, rather than as a mystery.
        const sandbox = await SandboxExecutor.start({ ...base, create: { ...create, ...wireOverrides(wanted) } as CreateSpec });
        return { handle: sandbox.runId };
      } catch (error) {
        // A daemon with no cache store answers the warm option with a 400.
        // Losing the run to that would make the cache a liability, so the
        // create is retried WITHOUT it — the cold path is the fallback the
        // whole feature is allowed to degrade to.
        if (wanted.warm === undefined) throw error;
        const { warm: _unavailable, ...cold } = wanted;
        const sandbox = await SandboxExecutor.start({ ...base, create: { ...create, ...wireOverrides(cold) } as CreateSpec });
        return { handle: sandbox.runId };
      }
    },
    async warmInfo(handle: string) {
      return await warm.info(handle);
    },
    async warmCommit(handle: string) {
      return await warm.commit(handle);
    },
    attach(handle: string) {
      return SandboxExecutor.attach(handle, base);
    },
    async snapshot(handle: string) {
      return SandboxExecutor.attach(handle, base).snapshot();
    },
    async createFrom(image: string, overrides?: SandboxOverrides) {
      // No warm volume on a restore: the snapshot IS the workspace, and a
      // volume mounted at the same path would hide it completely.
      const { image: _snapshotted, warm: _volume, ...rest } = definedOverrides(overrides);
      const sandbox = await SandboxExecutor.start({ ...base, create: { ...create, ...wireOverrides(rest), image } as CreateSpec });
      return { handle: sandbox.runId };
    },
    async destroy(handle: string) {
      await SandboxExecutor.attach(handle, base).destroy();
    },
  };
}

function definedOverrides(o?: SandboxOverrides): SandboxOverrides {
  return {
    ...(o?.image !== undefined ? { image: o.image } : {}),
    ...(o?.network !== undefined ? { network: o.network } : {}),
    ...(o?.egressAllow !== undefined ? { egressAllow: o.egressAllow } : {}),
    ...(o?.limits !== undefined ? { limits: o.limits } : {}),
    ...(o?.warm !== undefined ? { warm: o.warm } : {}),
  };
}

/**
 * Overrides as the daemon wants them: the tier spelled the way the wire
 * contract spells it (egress.ts wireNetwork explains why `allowlist` travels
 * as `egress`). Applied at the last possible moment so everything inside Ship
 * reasons in tiers and only this function knows the wire.
 */
/**
 * The SDK's create shape. Ship posts fields it does not declare (`warm`,
 * `egressAllow`) and a `network` value it predates (`open`); the client posts
 * `create` verbatim, so this cast IS the coupling to the daemon's wire
 * contract and is the only place it is stated.
 */
type CreateSpec = Parameters<typeof SandboxExecutor.start>[0]["create"];

function wireOverrides(o: SandboxOverrides): Omit<SandboxOverrides, "network"> & { network?: string } {
  const { network, ...rest } = o;
  return { ...rest, ...(network !== undefined ? { network: wireNetwork(network) } : {}) };
}

/**
 * The run's recorded sandbox overrides, if any — AND the point where the
 * network tier is decided.
 *
 * This is the single funnel every workspace creation goes through (`sandbox`,
 * `plan-restore`, `turn-N-restore`, `merge-restore`), which is why the
 * external-task downgrade lives here rather than at enqueue. Two reasons it
 * has to be here and not there:
 *
 *  - a run enqueued by an older binary, or by a surface that forgot, still
 *    executes under this rule; and
 *  - the log keeps the operator's DECLARED tier, so the downgrade stays
 *    visible after the fact instead of being erased at the door.
 *
 * Pure, derived from the recorded input alone, and it records nothing — so it
 * adds no step and a replay reaches the identical answer.
 */
export function sandboxOverridesOf(input: DurableAgentInput): SandboxOverrides | undefined {
  // The warm slug is a pure function of the recorded repo URL, so it is the
  // same on every replay even after the template it names has been evicted.
  const warm = input.warm === true && input.repo !== undefined ? warmSlugOf(input.repo) : null;
  // A log written before three tiers existed says "egress"; that is the alias.
  const declared = parseNetworkTier(input.sandboxNetwork) ?? undefined;
  // THE SAFETY COUPLING. A task a stranger wrote into an issue does not get
  // the open network, whatever the project record says. See networkForTrust.
  const { network } = networkForTrust(declared, input.trust);
  const egressAllow = input.sandboxEgressAllow;
  if (
    input.sandboxImage === undefined &&
    network === undefined &&
    egressAllow === undefined &&
    input.sandboxLimits === undefined &&
    warm === null
  ) {
    return undefined;
  }
  return {
    ...(input.sandboxImage !== undefined ? { image: input.sandboxImage } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(egressAllow !== undefined ? { egressAllow } : {}),
    ...(input.sandboxLimits !== undefined ? { limits: input.sandboxLimits } : {}),
    ...(warm !== null ? { warm: { repo: warm } } : {}),
  };
}

/** The policy widened by every project record's clone URL. */
export async function withProjects(policy: RepoPolicyConfig, projects?: Pick<ProjectStore, "list">): Promise<RepoPolicyConfig> {
  if (projects === undefined) return policy;
  const urls = (await projects.list()).map((p) => p.url).filter((u): u is string => u !== undefined);
  return urls.length > 0 ? { ...policy, projects: [...(policy.projects ?? []), ...urls] } : policy;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-(max - head))}`;
}
