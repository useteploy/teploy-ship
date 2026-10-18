import { ScopedRepoMemory } from "./scoped-repo-memory.js";
import { KnowledgeProvenance, knowledgeProvenanceMode } from "./knowledge-provenance.js";
import { FileKnowledgeStore, NucleusKnowledgeStore } from "./knowledge-store.js";
import { canonicalRepositoryURL, repoSlug } from "./repository-reference.js";
import { ScopedRepoStatsStore } from "./scoped-repo-stats.js";
import { finishReviewReplacement } from "./revision-launch.js";
import { projectReadinessRecord } from "./project-readiness.js";
import { stackDetectEnabled } from "./stack-propose.js";
import { taskRootRunId } from "./task-session.js";
import { threadWarmForEnqueue, warmThreadEnabled, type ThreadWarmDecision } from "./thread-warm.js";
import { FileLaunchJournal, NucleusLaunchJournal, assertSameLaunch, launchRequestHash, type LaunchJournal } from "./launch-journal.js";
import { parseJourney, journeyInstruction, type Journey } from "./journeys.js";
import { FileArtifacts, NucleusArtifacts, type ArtifactStore } from "./artifacts.js";
import { FileWorkspaceContent, NucleusWorkspaceContent, type WorkspaceContentStore } from "./workspace-content.js";
import type { RunOrigin } from "./notify.js";
import { resolveTestTarget } from "./test-detect.js";
import {
  LeaseManager,
  NucleusEventStore,
  RunIndex,
  WIRE_FORMAT_VERSION,
  executeRun,
  executeRunExclusive,
} from "@neutron-build/workflow";
import type { EventStore, RunOutcome, WorkflowDefinition, WorkflowEvent } from "@neutron-build/workflow";

import { defaultRecoveryConfig } from "./recovery.js";
import { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
import type { IntakeStore } from "./intake.js";
import { FileSpendStore, NucleusSpendStore, FileUnpricedRunStore, NucleusUnpricedRunStore, defaultDailyBudgetUSD, estimatedRunCostUSD, utcDay as spendDay } from "./spend.js";
import type { SpendStore, UnpricedRunStore } from "./spend.js";
import { resolveBudgetGate } from "./budget-gate.js";
import type { BudgetGate } from "./budget-gate.js";
import { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
import type { PolicyStore } from "./policies.js";
import { FileEvidenceStore, NucleusEvidenceStore } from "./evidence.js";
import { FileRuntimeConfig, NucleusRuntimeConfig } from "./runtime-config.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import { FileConnectRequests, NucleusConnectRequests } from "./connect-requests.js";
import type { ConnectRequestStore } from "./connect-requests.js";
import { FileAkirooCursor, NucleusAkirooCursor } from "./akiroo.js";
import type { AkirooCursorStore } from "./akiroo.js";
import { FileRepoStatsStore, NucleusRepoStatsStore } from "./repo-stats.js";
import type { RepoStatsStore } from "./repo-stats.js";
import { attemptsCount, harnessAttempts, harnessRef } from "./harness.js";
import { PLAN_REVIEW_REFUSAL, refusalFor } from "./harness-capabilities.js";
import { assertAcpHarnessAdmitted, withAcpProviderEgress } from "./harness-acp.js";
import { harnessIdentity, harnessRecordEnabled } from "./harness-identity.js";
import { withProviderEgress } from "./harness-external.js";
import type { HarnessRef } from "./harness.js";
import type { EvidenceStore } from "./evidence.js";
import { FileProjectStore, NucleusProjectStore, ProjectEvidenceStore } from "./projects.js";
import type { ProjectStore } from "./projects.js";
import { effectiveAuthority } from "./ladder.js";
import { withPreviewEgress } from "./deploy.js";
import { FileBulletinStore, NucleusBulletinStore } from "./bulletin.js";
import type { BulletinStore } from "./bulletin.js";
import { FileGovernanceStore, NucleusGovernanceStore, reviewersFor } from "./governance.js";
import type { GovernanceStore } from "./governance.js";
import { FileAttributedSpendStore, NucleusAttributedSpendStore } from "./attributed-spend.js";
import type { AttributedSpendStore, AttributedSpendEntry, SpendDimension } from "./attributed-spend.js";
import { FileFleetStore, NucleusFleetStore, FilePlacementStore, NucleusPlacementStore } from "./fleet.js";
import type { FleetStore, PlacementStore } from "./fleet.js";
import { FileRepoMemory, NucleusRepoMemory } from "./repo-memory.js";
import type { RepoMemoryStore } from "./repo-memory.js";
import { FileSteerStore, NucleusSteerStore } from "./steer.js";
import type { SteerStore } from "./steer.js";
import { FileLiveStore, NucleusLiveStore } from "./live.js";
import type { LiveStore } from "./live.js";
import { FileUserStore, NucleusUserStore } from "./users.js";
import type { UserStore } from "./users.js";
import { FileDeliveryLog, NucleusDeliveryLog } from "./deliveries.js";
import type { DeliveryLog } from "./deliveries.js";
import type { Actor } from "./actor.js";
import type { NetworkTier } from "./egress.js";
import { withFileLock } from "./file-store.js";
import {
  DELEGATION_INDEX_KEY,
  childTaskPrompt,
  clampDelegateTask,
  delegateCapMessage,
  delegateMaxChildren,
  delegatedChildRunId,
  delegationKey,
  parseDelegationRecord,
  registerDelegateControl,
  transferFromEvents,
} from "./delegate.js";
import type { DelegateControl, DelegateSpawnOutcome, DelegationEntry, DelegationRecord } from "./delegate.js";
import { effectiveDelegateTargets, gateDelegateTarget, parseDelegateTargets } from "./delegate-targets.js";
import type { DelegateTarget, RecordedDelegateTarget } from "./delegate-targets.js";
import { NucleusSegmentSink } from "./model-routing-wire.js";
import type { SegmentSink } from "./model-routing-wire.js";
import type { RoutingMode } from "./model-routing-policy.js";
import type { Segment } from "./model-routing.js";
import { steerReplyEnabled } from "./steer-reply.js";
import { FileOutbox, NucleusOutbox } from "./outbox.js";
import { FileDeliveryStore, NucleusDeliveryStore, type DeliveryStore } from "./delivery.js";
import type { Outbox } from "./outbox.js";
import { NucleusPgwire, type PgwireDialect } from "./nucleus-pgwire.js";
import { migrate } from "./migrations.js";
import { stepFingerprint } from "./step-fingerprint.js";
import { warmCacheEnabled, warmSlugOf } from "./warm.js";
import { assertRepoAllowed, policyFromEnv } from "./repo-policy.js";
import { forkEnabled, forkNote, resolveForkSource } from "./fork.js";
import type { ForkSourceRecord } from "./fork.js";
import { resolveStackBase, stackedPrsEnabled, stackNote } from "./stacked-pr.js";
import type { StackOnRecord, StackRebaseRequest } from "./stacked-pr.js";
import { effectiveRunCap, sandboxOverridesOf, withProjects } from "./durable.js";
import { costUSD } from "./pricing.js";
import type { RepoTrust } from "./repo-policy.js";
import type { DurableAgentInput, RecoveryTuning, RunUsage } from "./durable.js";
import type { ProposeInput as IntakeProposeInput, IntakeTask as IntakeTaskType } from "./intake.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import { askEnv, readDeploymentAsks } from "./deployment-asks.js";
import { installPolicyShadowFromEnv } from "./policy-shadow.js";
import { shadowObserve } from "./shadow-hook.js";
import { materialiseMcp } from "./mcp.js";
import { FileSkillStore, NucleusSkillStore, materialiseSkills } from "./skills.js";
import type { SkillStore } from "./skills.js";
export type { RepoSkillsMode, SkillPin, SkillRunInput, SkillSource, SkillStore, SkillVersion } from "./skills.js";
export { FileSkillStore, NucleusSkillStore, importSkill, normalizeRepoSkills, normalizeSkillPins, skillsEnabled } from "./skills.js";
import type { RunMeta } from "./run-store.js";

export type { RunMeta } from "./run-store.js";
export { checkRecordDirsAtStartup } from "./record-dirs.js";
export type { IntakeStore, IntakeTask, ProposeInput } from "./intake.js";
export { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
export type { SpendStore, SpendEntry, UnpricedRunStore, UnpricedRunEntry } from "./spend.js";
export type { FindingSeverity, ParsedFindings, ScanFinding } from "./findings.js";
export { MAX_FINDINGS, findingsSummary, parseFindings } from "./findings.js";
export { FileSpendStore, NucleusSpendStore, FileUnpricedRunStore, NucleusUnpricedRunStore, utcDay } from "./spend.js";
export type { PolicyStore, SourcePolicy } from "./policies.js";
export { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
export type { EvidenceStore, RepoEvidence } from "./evidence.js";
export { FileEvidenceStore, NucleusEvidenceStore } from "./evidence.js";
export { effectiveAuthority } from "./ladder.js";
export type { ProjectVerification, Rung } from "./ladder.js";
export type { ConfigSource, ResolvedValue, RuntimeConfigEntry, RuntimeConfigStore } from "./runtime-config.js";
export {
  FileRuntimeConfig,
  MemoryRuntimeConfig,
  NucleusRuntimeConfig,
  SEALED_KEYS,
  resolveConfigValue,
  sealingStatus,
} from "./runtime-config.js";
export type { AkirooConfigStatus, AkirooCursorStore, AkirooResolution, AkirooTarget } from "./akiroo.js";
export {
  AKIROO_TOKEN_KEY,
  AKIROO_URL_KEY,
  FileAkirooCursor,
  NucleusAkirooCursor,
  akirooSourceLabel,
  akirooTokenPrint,
  akirooTrailersFrom,
  akirooWorkspaceKey,
  normalizeAkirooBase,
  resolveAkirooTarget,
} from "./akiroo.js";
export type { ProjectRow, RegisterProjectResult } from "./akiroo-project.js";
export {
  PROJECT_WEBHOOK_EVENTS,
  ensureProjectWebhook,
  parseProjectRow,
  projectHookUrl,
  registerProject,
} from "./akiroo-project.js";
export type { RevertSignal, ForgeMerge, RevertWatchDeps } from "./revert-watch.js";
export {
  mergeFromPullRequestEvent,
  recordForgeMerge,
  recordRevert,
  revertsFromPushEvent,
} from "./revert-watch.js";
export type { ProjectAckPayload, ProjectNotifier, RevertPayload } from "./notify.js";
export { projectNotifier } from "./notify.js";
export type { AuthoritySuggestion, RepoCounts, RepoStatEntry, RepoStatKind, RepoStatsStore } from "./repo-stats.js";
export {
  FileRepoStatsStore,
  NucleusRepoStatsStore,
  SUGGEST_MIN_SENT,
  costPerMerge,
  emptyCounts,
  suggestAuthority,
  summarizeRepoStats,
} from "./repo-stats.js";
export type { ManagedBy, ManagedDrift, ManagedFields } from "./projects.js";
export { managedDrift, managedFieldsOf } from "./projects.js";
export { authorityCap, minAuthority } from "./ladder.js";
export type { ExchangeFailure, ExchangeOutcome } from "./akiroo-connect.js";
export {
  AKIROO_ORG_ID_KEY,
  AKIROO_ORG_NAME_KEY,
  exchangeConnectRequest,
  requestIsSpent,
} from "./akiroo-connect.js";
export type { ClaimFailure, ClaimOutcome, ConnectRequest, ConnectRequestStore } from "./connect-requests.js";
export {
  CLAIM_MESSAGES,
  CONNECT_REQUEST_TTL_MS,
  DELIVERY_CODE_PARAM,
  FileConnectRequests,
  MemoryConnectRequests,
  NucleusConnectRequests,
  approveUrl,
  challengeFor,
  describeWorkspace,
  newRequestId,
  newVerifier,
  sameWorkspace,
  validDeliveryCode,
  workspaceIdentity,
} from "./connect-requests.js";
export type { Project, ProjectStore } from "./projects.js";
export type { EgressRefusal, NetworkTier } from "./egress.js";
export {
  DEFAULT_NETWORK_TIER,
  NETWORK_TIERS,
  NETWORK_TIER_HELP,
  egressEntryError,
  networkForTrust,
  parseNetworkTier,
  splitEgressAllow,
} from "./egress.js";
export type { BulletinBoard, BulletinPost, BulletinStore } from "./bulletin.js";
export { FileBulletinStore, NucleusBulletinStore, changeClassRequired, sweepBulletin } from "./bulletin.js";
export { FileProjectStore, NucleusProjectStore, ProjectEvidenceStore, normalizeProject } from "./projects.js";
export type { GovernanceStore, Governance, Grant, Authority, AuthorityAction, AutoWindow, Windows, ReviewerRule } from "./governance.js";
export {
  FileGovernanceStore,
  NucleusGovernanceStore,
  AUTHORITY_ACTIONS,
  DEFAULT_AUTHORITY,
  GLOBAL_WINDOW,
  autoAllowedNow,
  formatWindow,
  insideWindow,
  mayDo,
  normalizeGrant,
  parseDays,
  reviewersFor,
  validateWindow,
  windowFor,
} from "./governance.js";
export type { AttributedSpendStore, AttributedSpendEntry, SpendDimension } from "./attributed-spend.js";
export { FileAttributedSpendStore, NucleusAttributedSpendStore } from "./attributed-spend.js";
export type { FleetStore, WorkerInfo, PlacementStore } from "./fleet.js";
// Sensing and the derived ceiling (B1). Re-exported for the dashboard, which
// renders `capacityBinding`/`terms` and needs the same names the worker uses.
export type { HostLoad, HostDisk, HostLimits, HostHold, HostProbes, Capacity, CapacityBinding, CapacityInput } from "./host-load.js";
export {
  BASE_RESERVE_MB,
  DEFAULT_MAX_INODE_USED_PCT,
  DEFAULT_MAX_LOAD_PER_CPU,
  DEFAULT_MIN_FREE_DISK_MB,
  DEFAULT_MIN_FREE_MB,
  DERIVED_CEILING_CAP,
  PER_RUN_DISK_MB,
  PER_RUN_MB,
  capacityPlan,
  describeCapacity,
  hostHold,
  hostLoad,
  sandboxLimitsFor,
} from "./host-load.js";
export { FileFleetStore, NucleusFleetStore, FilePlacementStore, NucleusPlacementStore } from "./fleet.js";
export type { RepoMemoryStore, RepoNote } from "./repo-memory.js";
export { FileRepoMemory, NucleusRepoMemory, loadRepoContext, runNote } from "./repo-memory.js";
export type { SteerStore, SteerNote, SteerMode, HeldKind, HeldNote } from "./steer.js";
export { FileSteerStore, NucleusSteerStore } from "./steer.js";
export type { LiveStore, LiveState, LivePhase } from "./live.js";
export { askAnswerMessage, askEvent, isAskEvent, pendingQuestion } from "./ask.js";
export type { AskDecisionPayload } from "./ask.js";
export { FileLiveStore, NucleusLiveStore } from "./live.js";
export type { DeliveryLog } from "./deliveries.js";
export type { Outbox, OutboxEntry } from "./outbox.js";
export { FileOutbox, NucleusOutbox, flushOutbox, notificationId } from "./outbox.js";
export { FileDeliveryLog, NucleusDeliveryLog, DELIVERY_TTL_S } from "./deliveries.js";
export type { UserStore, ShipUser, UserView, Role } from "./users.js";
export { validatePassword, validateUsername } from "./users.js";
export { BOOTSTRAP_ADMIN_CLAIM_KEY, bootstrapAdmin } from "./bootstrap-admin.js";
export type { BootstrapAdminResult, BootstrapAdminOutcome, BootstrapRuntime } from "./bootstrap-admin.js";
export type { Actor, ActorKind } from "./actor.js";
export {
  UNKNOWN_ACTOR,
  actorFromMeta,
  actorFromPrincipal,
  cliActor,
  formatActor,
  intakeActor,
  isAttributable,
} from "./actor.js";
export {
  FileUserStore,
  NucleusUserStore,
  normalizeRole,
  roleAllows,
  hashPassword,
  verifyPassword,
  ROLE_ADMIN,
  ROLE_EDITOR,
  ROLE_VIEWER,
} from "./users.js";
export type { CodeSearch, CodeSearchHit, RefreshStats } from "./code-index.js";
export { NucleusCodeIndex } from "./code-index.js";
export {
  parseRepoToken,
  requesterOf,
  reviewGateSatisfied,
  reviewRound,
  reviewTaskFromReviewEvent,
  shipAuthored,
  slackTaskFromMention,
  linearTaskFromIssue,
  ciFixTaskFromWorkflowRun,
} from "./intake-sources.js";
// E7 EV3 — the built-in sources' shadow over the EV2 rule engine. The web
// receivers import these from ./runtime (the proposeFromWebhook import block);
// everything else (tests, doctor, the sweep) imports src/event-builtin.js.
export {
  builtinShadowEnabled,
  builtinTaskSource,
  readBuiltinShadowCounters,
  shadowBuiltinIntake,
  BUILTIN_SHADOW_COUNTER_KEY,
  type BuiltinShadowCounters,
  type BuiltinSourceId,
} from "./event-builtin.js";
export type { RepoTrust, RepoPolicyConfig, RepoAllowEntry } from "./repo-policy.js";
export {
  RepoNotAllowedError,
  assertRepoAllowed,
  credentialFor,
  effectiveAllowlist,
  isAllowed,
  parseAllowlist,
  parseOriginTokens,
  policyFromEnv,
} from "./repo-policy.js";
export type { Notifier, RunNotification } from "./notify.js";
export { formatRunNotification, notifiable, slackNotifier } from "./notify.js";
export { PLAN_EVENT, MERGE_EVENT } from "./plan.js";
export type { PlanDecisionPayload } from "./plan.js";
export type { ModelPricing, UsageLike } from "./pricing.js";
export { costUSD, pricingFor, isPricedModel, UNKNOWN_MODEL_PRICING } from "./pricing.js";

/**
 * Where durable runs live. The file runtime keeps everything on this
 * machine (~/.local/state/teploy-ship); the nucleus runtime keeps event
 * logs, run metadata, and executor leases in a shared Nucleus, so any
 * machine — including a resident `teploy-ship worker` — can list,
 * continue, or complete a run.
 */
export interface ShipRuntime {
  /** Present on both built-in runtimes; optional for legacy injected adapters. */
  launches?: LaunchJournal;
  kind: "file" | "nucleus" | "postgres";
  store: EventStore;
  /**
   * One execution pass. Returns null when another executor holds the
   * run's lease (nucleus only) — the run continues there, not here.
   */
  execute(
    workflow: WorkflowDefinition<{ task: string }, unknown>,
    runId: string,
    input?: {
      task: string;
      repo?: string;
      repositoryScopeVersion?: 2;
      trust?: RepoTrust;
      pr?: number;
      plan?: boolean;
      steer?: boolean;
      ask?: boolean;
      index?: boolean;
      guard?: boolean;
      critic?: boolean;
      recovery?: boolean | RecoveryTuning;
      settle?: boolean;
      requireEdit?: boolean;
      preview?: boolean;
      telemetry?: boolean;
      tests?: boolean;
      /** Read-only scan run (L2 / D3) — see DurableAgentInput.mode. */
      mode?: "fix" | "scan";
      testCommand?: string;
      testTimeoutMs?: number;
      observeService?: string;
      observeRepo?: string;
      harness?: HarnessRef;
      harnessAttempts?: HarnessRef[];
      mergeGate?: boolean;
    },
  ): Promise<RunOutcome | null>;
  saveMeta(meta: RunMeta): Promise<void>;
  loadMeta(runId: string): Promise<RunMeta | null>;
  /**
   * Recent runs, newest first.
   *
   * Bounded on purpose. Every dashboard page, the SSE change poller (every two
   * seconds, per web process) and the health probe called this with no limit,
   * so the cost of each grew with the total number of runs Ship had ever done —
   * fine for a demo, a latency and memory problem for a service that is
   * supposed to run unattended for months.
   */
  listMeta(options?: { limit?: number; offset?: number }): Promise<RunMeta[]>;
  /** Flag a parked run due so a resident worker picks it up (nucleus only). */
  markWake?(runId: string): Promise<void>;
  /**
   * Constant-time reachability probe for the health endpoint. Deliberately not
   * a data read: the check has to stay cheap as history grows, and cheapest
   * exactly when the system is struggling.
   */
  ping(): Promise<void>;
  /** The intake queue: proposed tasks awaiting launch. */
  intake: IntakeStore;
  /** Per-source, per-UTC-day spend ledger backing the worker's budget cap. */
  spend: SpendStore;
  /**
   * The same settled cost as `spend`, cut by repository and by actor —
   * reporting only, the budget cap never reads it. See attributed-spend.ts.
   */
  attributedSpend: AttributedSpendStore;
  /**
   * Runs that consumed a quota Ship cannot price (P5-3): counted per source
   * and day, never added to `spend`, never reported as $0. See spend.ts.
   */
  unpricedRuns: UnpricedRunStore;
  /** Editable per-source intake policies (dashboard-managed, env-seeded). */
  policies: PolicyStore;
  /** One record per repo: allowlist, sandbox image, evidence, policy. See projects.ts. */
  projects: ProjectStore;
  /**
   * The skills registry (Q4-a): immutable, content-addressed versions an
   * operator imported, read at ENQUEUE to resolve the versions a project
   * pinned (materialiseSkills). Optional like `launches` so a legacy
   * injected adapter still satisfies the interface; both built-in runtimes
   * carry one. A project with pins and no registry is an enqueue-time
   * refusal, never a silent skills-off run. See skills.ts.
   */
  skills?: SkillStore;
  /** Public request boards and their notes (L6). See bulletin.ts. */
  bulletin: BulletinStore;
  /** Per-repo evidence config — a view of `projects`, legacy rows read through. See projects.ts. */
  evidence: EvidenceStore;
  /**
   * Settings an operator changes while Ship runs — no redeploy, no secret set.
   * A non-empty value here OUTRANKS the environment variable of the same name.
   * See runtime-config.ts.
   */
  config: RuntimeConfigStore;
  artifacts?: ArtifactStore;
  workspaceContent?: WorkspaceContentStore;
  /**
   * Handshakes THIS Ship started, with the PKCE verifier for each. The control
   * that closes the phish: a /connect/return that names no row here is refused.
   * See connect-requests.ts.
   */
  connectRequests: ConnectRequestStore;
  /**
   * Per-workspace position in Akiroo's outbox. On the runtime rather than
   * private to the worker because completing a connect resets it — a reconnect
   * that inherited the previous position would collect nothing and look fine.
   */
  akirooCursor: AkirooCursorStore;
  /** Who may do what, auto windows, required reviewers. See governance.ts. */
  governance: GovernanceStore;
  /** Live registry of workers in the fleet (heartbeat + capacity/load). */
  fleet: FleetStore;
  /** Which worker host executed each run (fleet placement). */
  placement: PlacementStore;
  /** Per-repo playbook memory (notes Ship records about its own runs). */
  memory: RepoMemoryStore;
  /** Mid-run steering notes the dashboard sends into running runs. */
  steer: SteerStore;
  /** What each executing run is doing right now (live.ts) — the dashboard's "Now" line. */
  live: LiveStore;
  /** Local dashboard accounts + roles (Teploy RBAC contract). */
  users: UserStore;
  /** Seen webhook deliveries — replay protection for the public hook routes. */
  deliveries: DeliveryLog;
  /**
   * The four per-repo numbers (sent/merged/reverted/parked), L8 D4 — one row
   * per (repo, kind, run), idempotent under every at-least-once path that
   * feeds it. Written by the worker (sent/parked/merged) and by the web
   * process (merged/reverted off forge webhooks); read by the Projects page,
   * which turns them into the suggested authority. See repo-stats.ts.
   */
  repoStats: RepoStatsStore;
  /** Durable notification outbox (see outbox.ts). */
  outbox: Outbox;
  /** Delivery records for merged changes (see delivery.ts). */
  deliveryRecords?: DeliveryStore;
  /**
   * Atomically take ownership of the decision a parked run is waiting on.
   * True iff THIS caller won: the run's eventName is cleared as part of the
   * same conditional write, so two operators submitting opposite decisions on
   * the same park cannot both deliver. Losers must not call deliverEvent.
   */
  claimDecision(runId: string, eventName: string, revisionOwner?: string): Promise<boolean>;
  /** Put back an eventName after a claim whose delivery then failed. */
  releaseDecision(runId: string, eventName: string): Promise<void>;
  close(): Promise<void>;
}

export function fileRuntime(): ShipRuntime {
  installPolicyShadowFromEnv(); // no-op unless SHIP_POLICY_SHADOW=on
  const store = new FileEventStore();
  const meta = new RunMetaStore();
  const projects = new FileProjectStore();
  let runtime: ShipRuntime;
  // Delegation (S20/S22): register this process's control BEFORE the runtime
  // is handed back, so a worker built on it can spawn children immediately.
  // The registration seam — rather than a `delegate:` field in worker.ts's
  // durableAgent config — keeps this branch off the worker/cli dirty lane;
  // see docs/COORDINATOR_DESIGN.md. registerDelegateControl is idempotent per
  // process and the slot is read only on runs whose input admits the action.
  const built: ShipRuntime = {
    kind: "file",
    launches: new FileLaunchJournal(store, meta, undefined, intent => finishReviewReplacement(runtime, intent)),
    bulletin: new FileBulletinStore(),
    store,
    intake: new FileIntakeStore(),
    spend: new FileSpendStore(),
    attributedSpend: new FileAttributedSpendStore(),
    unpricedRuns: new FileUnpricedRunStore(),
    policies: new FilePolicyStore(),
    projects,
    skills: new FileSkillStore(),
    evidence: new ProjectEvidenceStore(projects, new FileEvidenceStore()),
    config: new FileRuntimeConfig(),
    artifacts: new FileArtifacts(),
    workspaceContent: new FileWorkspaceContent(),
    connectRequests: new FileConnectRequests(),
    akirooCursor: new FileAkirooCursor(),
    governance: new FileGovernanceStore(),
    fleet: new FileFleetStore(),
    placement: new FilePlacementStore(),
    memory: new ScopedRepoMemory(new FileRepoMemory(),store,knowledgeProvenanceMode()==='off'?undefined:new KnowledgeProvenance({mode:knowledgeProvenanceMode(),store:new FileKnowledgeStore()})),
    steer: new FileSteerStore(),
    live: new FileLiveStore(),
    users: new FileUserStore(),
    deliveries: new FileDeliveryLog(),
    outbox: new FileOutbox(),
    deliveryRecords: new FileDeliveryStore(),
    repoStats: new ScopedRepoStatsStore(new FileRepoStatsStore(),store),
    claimDecision: (runId, eventName, owner) => meta.claimDecision(runId, eventName, owner),
    releaseDecision: (runId, eventName) => meta.releaseDecision(runId, eventName),
    execute: (workflow, runId, input) =>
      executeRun({ workflow, runId, store, ...(input !== undefined ? { input } : {}) }),
    saveMeta: (m) => meta.save(m),
    loadMeta: (runId) => meta.load(runId),
    listMeta: (options) => meta.list(options),
    ping: async () => {
      // File mode is reachable if its state directory is.
      await meta.list({ limit: 1 });
    },
    close: async () => {},
  };
  runtime = built;
  registerDelegateControl(delegateControlFromRuntime(runtime));
  return runtime;
}

const META_COLLECTION = "ship_meta";

/** Runs returned when a caller does not say. Enough for every dashboard view. */
export const DEFAULT_LIST_LIMIT = 200;

/** The nucleus runtime plus the raw pieces the worker's scheduler needs. */
export interface NucleusShipRuntime extends ShipRuntime {
  index: RunIndex;
  leases: LeaseManager;
  owner: string;
  /** The raw pgwire adapter — the code index builds on it directly. */
  db: NucleusPgwire;
}

export async function nucleusRuntime(
  url: string,
  owner: string,
  options?: { log?: (line: string) => void; db?: NucleusPgwire; dialect?: PgwireDialect },
): Promise<NucleusShipRuntime> {
  // `db` is a seam, not a feature: NucleusPgwire already takes a PoolLike so a
  // test can watch the statements it emits, and the reads this runtime issues
  // (listMeta above all) are worth asserting on rather than trusting.
  installPolicyShadowFromEnv(); // no-op unless SHIP_POLICY_SHADOW=on
  const db = options?.db ?? new NucleusPgwire(url, owner, { dialect: options?.dialect });
  // Bring the shared schema to the shape this binary expects BEFORE handing
  // back a runtime. A rolling deploy runs old and new processes against one
  // Nucleus, so this must be safe to call concurrently (it takes a KV lock)
  // and safe to call when nothing is pending (it is a no-op then).
  // Default to stderr rather than silence: a migration rewrites a populated
  // table, and an operator reading deploy output must be able to see that it
  // happened. Silence is only correct for the (usual) case where nothing is
  // pending, and migrate() emits nothing then anyway.
  await migrate(db, options?.log ?? ((line) => console.error(line)));
  const store = new NucleusEventStore(db.streams, { prefix: "ship" });
  const index = new RunIndex(db.document, { collection: "ship_runs" });
  const leases = new LeaseManager(db.kv, { prefix: "ship:lease", ttlSeconds: 60 });

  const saveMeta = async (m: RunMeta): Promise<void> => {
    const doc = { ...m } as Record<string, unknown>;
    const updated = await db.document.update(META_COLLECTION, { runId: m.runId }, doc);
    if (updated > 0) return;
    // ship_docs has no unique index (Nucleus cannot add one to a populated
    // table), so two concurrent first-saves could both update zero rows and
    // both insert — after which loadMeta returns whichever row comes back first
    // and every later update writes to both. The KV claim is the identity the
    // schema cannot express.
    const guard = `ship:meta:${m.runId}`;
    if (await db.kv.setNX(guard, "1", { ttl: 30 })) {
      if ((await db.document.update(META_COLLECTION, { runId: m.runId }, doc)) === 0) {
        await db.document.insert(META_COLLECTION, doc);
      }
      return;
    }
    // Someone else is creating this run's row; their insert is the one that
    // counts, so apply our fields on top of it.
    await db.document.update(META_COLLECTION, { runId: m.runId }, doc);
  };
  // The index is status-authoritative: the worker records outcomes there
  // (not in ship_meta), so reads overlay index status onto the meta doc.
  const toMeta = (doc: Record<string, unknown>, rec?: Record<string, unknown>): RunMeta => {
    const m = doc as unknown as RunMeta;
    if (rec === undefined || typeof rec.status !== "string") return m;
    const overlaid: RunMeta = { ...m, status: rec.status };
    if (rec.status === "waiting" && typeof rec.eventName === "string") {
      overlaid.eventName = rec.eventName;
    } else {
      delete overlaid.eventName;
    }
    if (typeof rec.updatedAt === "string" && rec.updatedAt > m.updatedAt) {
      overlaid.updatedAt = rec.updatedAt;
    }
    return overlaid;
  };

  const projects = new NucleusProjectStore(db);
  let runtime: NucleusShipRuntime;
  // Same registration seam as fileRuntime above (S20/S22): the worker runs in
  // this process, so its runs find the control without worker.ts wiring.
  const built: NucleusShipRuntime = {
    kind: "nucleus",
    launches: new NucleusLaunchJournal(db, store, intent => finishReviewReplacement(runtime, intent)),
    bulletin: new NucleusBulletinStore(db),
    store,
    index,
    leases,
    owner,
    db,
    intake: new NucleusIntakeStore(db),
    spend: new NucleusSpendStore(db),
    attributedSpend: new NucleusAttributedSpendStore(db),
    unpricedRuns: new NucleusUnpricedRunStore(db),
    policies: new NucleusPolicyStore(db),
    projects,
    skills: new NucleusSkillStore(db),
    evidence: new ProjectEvidenceStore(projects, new NucleusEvidenceStore(db)),
    config: new NucleusRuntimeConfig(db),
    artifacts: new NucleusArtifacts(db),
    workspaceContent: new NucleusWorkspaceContent(db),
    connectRequests: new NucleusConnectRequests(db),
    akirooCursor: new NucleusAkirooCursor(db),
    governance: new NucleusGovernanceStore(db),
    fleet: new NucleusFleetStore(db),
    placement: new NucleusPlacementStore(db),
    memory: new ScopedRepoMemory(new NucleusRepoMemory(db),store,knowledgeProvenanceMode()==='off'?undefined:new KnowledgeProvenance({mode:knowledgeProvenanceMode(),store:new NucleusKnowledgeStore(db)})),
    steer: new NucleusSteerStore(db),
    live: new NucleusLiveStore(db),
    users: new NucleusUserStore(db),
    deliveries: new NucleusDeliveryLog(db),
    outbox: new NucleusOutbox(db),
    deliveryRecords: new NucleusDeliveryStore(db),
    repoStats: new ScopedRepoStatsStore(new NucleusRepoStatsStore(db),store),
    /**
     * One conditional UPDATE decides the winner: the filter includes the
     * eventName the caller believes is parked, so a stale tab (or a second
     * admin) updates zero rows and is told to look again. Clearing eventName
     * in the same statement is what makes it a claim rather than a check.
     */
    async claimDecision(runId, eventName, owner) {
      const updated = await db.document.update(
        META_COLLECTION,
        { runId, eventName },
        { eventName: owner ? `revision:${owner}` : null, status: "wake", updatedAt: new Date().toISOString() },
      );
      if (updated > 0) return true;
      return owner !== undefined && (await db.document.find(META_COLLECTION, {runId, eventName:`revision:${owner}`})).length === 1;
    },
    async releaseDecision(runId, eventName) {
      // The document filter stringifies null; use SQL IS NULL for a held
      // generic decision, and never overwrite a revision owner token.
      await db.exec("UPDATE ship_docs SET event_name = $1, status = 'waiting' WHERE collection = $2 AND run_id = $3 AND event_name IS NULL AND status = 'wake'", [eventName, META_COLLECTION, runId]);
    },
    async execute(workflow, runId, input) {
      const outcome = await executeRunExclusive({
        workflow,
        runId,
        store,
        leases,
        owner,
        ...(input !== undefined ? { input } : {}),
      });
      if (outcome !== null) await index.record(runId, workflow.name, outcome);
      return outcome;
    },
    saveMeta,
    async loadMeta(runId) {
      const docs = await db.document.find(META_COLLECTION, { runId });
      if (docs.length === 0) return null;
      const records = await db.document.find("ship_runs", { runId });
      return toMeta(docs[0]!, records[0]);
    },
    /**
     * The two reads behind this used to be `SELECT * FROM ship_docs WHERE
     * collection = …` with no bound at all, once for the metas and once for the
     * run index, sorted and cut in JavaScript afterwards. That is a cost that
     * grows with every run Ship has ever done — 213 rows per collection on the
     * deployed worker on 2026-08-30 — for a page that shows two hundred. The
     * upgrade-hold sweep calls this on a timer, so the whole history crossed
     * the wire twice a sweep, forever.
     *
     * Both sides are bounded now, and neither bound changes the answer:
     *
     *   - The METAS are ranked in SQL on the same key this function sorts on:
     *     the later of the meta doc's `updatedAt` and its `ship_runs` record's.
     *     Ranking on the meta stamp alone would NOT have been the same query —
     *     see FindOptions.newest, where the measurement is written down.
     *   - The RUN RECORDS are then fetched by `run_id IN (…)` over exactly the
     *     metas we are about to return. `byRun` was only ever read with keys
     *     taken from `docs`, so every record this drops is one no lookup could
     *     have reached.
     *
     * The JavaScript sort and slice below stay, deliberately. SQL is being used
     * to choose the candidate SET; the ordering the caller sees is still decided
     * here, by the comparator that has always decided it. (One residual, and it
     * predates this change: `ship_docs` has no unique index, so if a runId ever
     * has two `ship_runs` rows, which one wins `byRun` is whichever Nucleus
     * returns last — unspecified before and unspecified now.)
     */
    async listMeta(options) {
      const limit = Math.max(1, Math.trunc(options?.limit ?? DEFAULT_LIST_LIMIT));
      // `offset` pages below the newest window (the PR watch's discovery).
      // The page is cut in SQL wide enough to cover it, then trimmed here —
      // same ranked read as before, just a deeper slice of it.
      const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
      const docs = (await db.document.find(
        META_COLLECTION,
        {},
        { newest: { limit: limit + offset, freshenedBy: "ship_runs" } },
      )).slice(offset);
      const runIds = docs.map((doc) => (doc as { runId?: string }).runId ?? "");
      const records = await db.document.find("ship_runs", {}, { runIds });
      const byRun = new Map(records.map((r) => [r.runId as string, r]));
      return docs
        .map((doc) => toMeta(doc, byRun.get((doc as { runId?: string }).runId ?? "")))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit);
    },
    markWake: (runId) => index.markWake(runId),
    ping: async () => {
      await db.query("SELECT 1");
    },
    close: () => db.close(),
  };
  runtime = built;
  registerDelegateControl(delegateControlFromRuntime(runtime));
  return runtime;
}

/**
 * Propose a task whose repository binding came from OUTSIDE Ship — a webhook
 * body, a chat message, an issue description. Every public intake surface must
 * go through this rather than calling `intake.propose` directly, because the
 * repository URL in those payloads is attacker-influenced and would otherwise
 * become a run that points a deploy token at an arbitrary origin (see
 * repo-policy.ts).
 *
 * Throws RepoNotAllowedError for a repo the policy refuses; the caller turns
 * that into a 403 so the sender learns the hook is configured too narrowly
 * rather than silently getting no run.
 */
export async function proposeExternal(
  runtime: Pick<ShipRuntime, "intake" | "projects">,
  input: IntakeProposeInput,
): Promise<{ created: boolean; task: IntakeTaskType }> {
  if (input.repo !== undefined && input.repo !== "") {
    assertRepoAllowed(input.repo, { trust: "external", config: await withProjects(policyFromEnv(), runtime.projects) });
  }
  return runtime.intake.propose(input);
}

/**
 * The repository allowlist, as an operator-typed URL sees it.
 *
 * `proposeExternal` above is the same check at "external" trust for a URL that
 * came out of a payload. This is its counterpart for a surface where an
 * authenticated human (or their cron, holding their token) named the repo: the
 * allowlist still binds, and the project records still widen it, but an
 * operator may also name a repo when no allowlist is configured at all.
 *
 * Exists so an API surface can refuse at the door with a 403 rather than
 * enqueueing a run that dies at `repo-setup` twenty seconds later with the same
 * message buried in a step. Throws RepoNotAllowedError.
 */
export async function assertRepoAllowedForOperator(
  runtime: Pick<ShipRuntime, "projects">,
  repo: string,
): Promise<void> {
  assertRepoAllowed(repo, { trust: "operator", config: await withProjects(policyFromEnv(), runtime.projects) });
}

/**
 * A run refused at enqueue because its source has spent its daily budget.
 *
 * Its own class so a caller can answer it properly: the CLI prints it, the API
 * returns 429, and the intake sweep never sees it (it holds a reservation
 * already — see assertDailyBudget).
 */
export class DailyBudgetExceededError extends Error {
  readonly source: string;
  readonly budgetUSD: number;
  readonly committedUSD: number;
  constructor(source: string, budgetUSD: number, committedUSD: number) {
    super(
      `${source} has spent its daily budget ($${budgetUSD.toFixed(2)}; $${committedUSD.toFixed(2)} committed today) — ` +
        "the run was not enqueued. Raise SHIP_DAILY_BUDGET_USD, set a per-source budget on the Policies page, or wait for the UTC day to roll over.",
    );
    this.name = "DailyBudgetExceededError";
    this.source = source;
    this.budgetUSD = budgetUSD;
    this.committedUSD = committedUSD;
  }
}

/**
 * THE DAILY BUDGET, ENFORCED AT ENQUEUE.
 *
 * It used to be enforced only at intake (worker.ts:282-296), against an intake
 * TASK. `enqueueRun` creates a run directly and never makes one, so every
 * surface that calls it — the CLI, the dashboard's launch and quick-run forms,
 * the scan API — was outside the cap entirely. That is not theoretical: the
 * 2026-08-26 nightly scan cron enqueued seven runs a night through the CLI and
 * spent $24.15 against a $10/day cap, for zero findings, on its way to about
 * $720/month.
 *
 * NOT DOUBLE-COUNTING THE SWEEP. `sweepIntake` reserves against the budget
 * BEFORE it calls `launch` (worker.ts:286), and `launch` is what calls
 * `enqueueRun` (worker.ts:996) — with the very runId the reservation is keyed
 * on. So an outstanding hold under this runId means "somebody already admitted
 * this run", and this function returns without touching the ledger. Two
 * independent guards make that safe:
 *
 *  - `held()` skips the whole check, so the sweep's admission decision is never
 *    re-made here. Re-deciding it would be worse than double-counting: a
 *    refusal thrown out of `launch` propagates through sweepIntake's rethrow
 *    and out of the worker tick.
 *  - `reserve()` is idempotent by id in both stores (spend.ts), so even a store
 *    that does not implement `held` holds one estimate per run rather than two.
 *
 * The hold taken here is released at settlement by the same line that releases
 * the sweep's (worker.ts:615), whatever launched the run.
 */
export async function assertDailyBudget(
  runtime: Pick<ShipRuntime, "spend" | "policies" | "projects">,
  options: { runId: string; source?: string; repo?: string; now?: Date; budgetGate?: BudgetGate },
): Promise<void> {
  const source = options.source ?? "";
  // An unsourced run is never SETTLED against a budget either (worker.ts:617
  // returns early on it), so holding budget for one would leak an estimate that
  // nothing ever releases. Nothing on the product path is unsourced.
  if (source === "") return;
  // Capture-only test doubles cast themselves to ShipRuntime without a spend
  // store (see the captureRuntime helpers in evidence.test.ts and
  // projects.test.ts). Typed non-optional, so this is a runtime lie rather than
  // a type hole — but a budget check that throws a TypeError instead of
  // enqueueing is a worse failure than one that no-ops on a fake.
  const spend = (runtime as { spend?: SpendStore }).spend;
  if (spend === undefined) return;
  if ((await spend.held?.(options.runId)) === true) return;

  const budget = await dailyBudgetForSource(runtime, source, options.repo);
  const estimate = estimatedRunCostUSD();
  const shadowProject = async () => (options.repo === undefined ? null : await runtime.projects.forRepo(options.repo));
  if (!(budget > 0)) {
    // <= 0 disables the cap for that source, as in the worker
    shadowObserve({ point: "budget", source, ...(options.repo !== undefined ? { repo: options.repo } : {}), budget, committed: null, estimate, existingAllowed: true, loadProject: shadowProject });
    return;
  }

  const day = spendDay(options.now ?? new Date());
  // Reserve BEFORE reading the total, exactly as the sweep does: two surfaces
  // admitting at once must see each other's commitment rather than both reading
  // the same room. Over-reserving briefly is the safe direction.
  await spend.reserve(options.runId, source, day, estimate);
  const committed = await spend.get(source, day);
  shadowObserve({ point: "budget", source, ...(options.repo !== undefined ? { repo: options.repo } : {}), budget, committed, estimate, existingAllowed: !(committed > budget), loadProject: shadowProject });
  // SHIP_BUDGET_RESERVATION: the ledger judges the same admission; it denies
  // only in `on` mode (see budget-gate.ts). Off => gate undefined => unchanged.
  const gate = options.budgetGate ?? resolveBudgetGate(runtime as { kind?: string });
  const gated = gate
    ? await gate.admit({ runId: options.runId, source, day, budgetUSD: budget, estimateUSD: estimate, existingAllowed: !(committed > budget), existingCommittedUSD: committed })
    : undefined;
  if (committed > budget || gated?.allow === false) {
    await spend.release(options.runId).catch(() => {});
    await gate?.release(options.runId);
    throw new DailyBudgetExceededError(source, budget, Math.max(committed, gated?.ledgerCommittedUSD ?? 0));
  }
}

/**
 * The cap this run is judged against: the repo's own budget if it has one, then
 * the source's, then the global default. Same precedence the worker uses
 * (worker.ts:282 and :988), so one run does not get two different answers
 * depending on which surface enqueued it.
 */
async function dailyBudgetForSource(
  runtime: Pick<ShipRuntime, "policies" | "projects">,
  source: string,
  repo?: string,
): Promise<number> {
  if (repo !== undefined) {
    const project = await runtime.projects.forRepo(repo);
    if (project?.dailyBudgetUSD !== undefined) return project.dailyBudgetUSD;
  }
  // A policy store that cannot be read must not silently mean "no cap" — that
  // is the failure the cap exists to prevent — so fall through to the default.
  const policies = await runtime.policies.list().catch(() => []);
  const entry = policies.find((p) => p.source === source);
  return entry?.dailyBudgetUSD ?? defaultDailyBudgetUSD();
}

/** A boolean environment switch, read at use so it stays testable. */
function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[name] ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Explicitly turned OFF — distinct from unset, which leaves a default alone.
 * Only needed for the flags that default ON, where "absent" and "disabled" are
 * different answers.
 */
function envFlagOff(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[name] ?? "").toLowerCase();
  return raw === "0" || raw === "false" || raw === "no";
}

/**
 * A non-negative integer environment knob. Unset or garbage is undefined —
 * the caller's default — never a silent 0, because for a bound like
 * SHIP_FIX_RETRIES a misread 0 would quietly remove the loop it names.
 */
function envCount(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Enqueue a run without executing it: append the run-started event
 * (exactly the shape executeRun writes on an empty log) and flag the run
 * due. A resident worker picks it up on its next tick; with the file
 * runtime there is no worker, so the caller resumes it explicitly. This
 * is how surfaces that must never run the agent in-process (the web UI)
 * commission work.
 */
/** What an enqueue resolved about its test evidence. */
export interface EnqueueReport {
  /** The run will run the project's suite (the ask is in its input). */
  tests: boolean;
  /** The command recorded at enqueue; absent = the worker resolves it from its checkout. */
  testCommand?: string;
  testCommandSource?: "project" | "detected";
  /**
   * D4-c: whether a follow-up will boot from its thread's snapshot, and —
   * when it will not — the recorded reason (expired, repo or sandbox-shape
   * mismatch, none recorded). Present only on a run that went looking, so
   * first turns and flag-off deployments report exactly what they did before
   * this field existed.
   */
  threadWarm?: { used: boolean; reason?: string };
}

/**
 * EV6 (SHIP_INCIDENT_FIX): appended to a repro-gated remediation's task at
 * enqueue and frozen into the recorded input. The gate holds the pull
 * request unless the change carries a reproducing test, so the agent has to
 * know that is the deliverable — without this the gate would hold nearly
 * every remediation and teach an operator to ignore it.
 */
const REPRO_REMEDIATION_TASK_NOTE =
  "\n\nThis remediation is gated on a reproducing test: include a test that FAILS on the revision you started from and PASSES with your change. Ship runs this check itself (the repro-test gate), and the pull request is held at the merge boundary until it passes.";

export async function enqueueRun(
  runtime: ShipRuntime,
  options: {
    runId: string;
    /** Server-computed hash of authenticated user intent, excluding resolved
     * defaults. Enables a lost-response retry to reuse the accepted config.
     * Do not accept this value verbatim from an HTTP client. */
    requestIdentity?: string;
    /** Authorized replacement of a pending merge review, outside workflow input. */
    reviewParent?: string;
    /** Conversation lineage only; never gates a workflow step. */
    parentRunId?: string;
    userMessage?: string;
    journey?: Journey;
    environmentCheck?: boolean;
    /** Digest of the manifests/recipe a person reviewed (stack-propose.ts); recorded only with SHIP_STACK_DETECT on. */
    environmentInputsDigest?: string;
    /** Deterministic setup probe: no model turns or publication. */
    environmentCheckOnly?: boolean;
    task: string;
    model: string;
    repo?: string;
    pr?: number;
    plan?: boolean;
    /** Post-finish critic pass (see DurableAgentInput.critic in durable.ts). Opt-in, default off. */
    critic?: boolean;
    /**
     * Stuck detection and deliberate termination (see DurableAgentInput in
     * durable.ts). Opt-in, default off. Both are baked into the run's
     * `run-started` input HERE, at enqueue — never read from a worker's
     * config at execution time, because the thresholds decide which turn the
     * run terminates on and a worker that disagreed with the log would trip
     * NondeterminismError.
     *
     * Absent from the call, they fall back to SHIP_RECOVERY / SHIP_SETTLE so
     * an operator has one knob across every enqueue surface (the worker's
     * intake sweep, the dashboard's launch button, the dashboard's quick run).
     * Unset env = off, which is the whole product-path default.
     */
    recovery?: boolean | RecoveryTuning;
    settle?: boolean;
    /** Hold a finish whose working tree is unchanged. See durable.ts. */
    requireEdit?: boolean;
    /** Deploy the pushed branch to a preview environment. See deploy.ts. */
    preview?: boolean;
    /** Put the service's measured before/after on the PR. See observe.ts. */
    telemetry?: boolean;
    /** Run the project's suite after the agent stops. See tests.ts. */
    tests?: boolean;
    /**
     * Baseline the suite before the agent edits, and send a red finish back to
     * work (C4). Materialised here because it adds recorded steps — see
     * DurableAgentInput.testsFeedback in durable.ts.
     */
    testsFeedback?: boolean;
    /**
     * Iterate-until-green bound (D3 / Phase 1): how many times a red suite at
     * the finish gate sends the run back to work before the bound runs out and
     * the run publishes what it has with the last failure attached. Only
     * meaningful with `testsFeedback`; absent falls back to SHIP_FIX_RETRIES,
     * default 2 — the historical bound, now written into the log. See
     * DurableAgentInput.fixRetries in durable.ts.
     */
    fixRetries?: number;
    /**
     * The critic advises instead of vetoing wherever a suite is recorded
     * (D3): its disapproval becomes risk notes on the run and the pull
     * request, never a second work loop. Absent follows critic+tests, with
     * SHIP_CRITIC_ADVISORY=0 restoring the old retry. See
     * DurableAgentInput.criticAdvisory in durable.ts.
     */
    criticAdvisory?: boolean;
    /**
     * Classify the change before pushing and park when it is `serious` (L3).
     * Materialised here because it adds a recorded step AND a waitForEvent —
     * see DurableAgentInput.changeClass in durable.ts.
     */
    changeClass?: boolean;
    /**
     * Move the `serious` park to the merge boundary (C1): the run publishes a
     * draft pull request with all its verification, then parks once on
     * "approve-merge". Materialised HERE, like changeClass, because it adds
     * steps and a waitForEvent the log must carry from the start — a run
     * enqueued before this field exists replays under the old mid-run park,
     * which is exactly what the separate flag (rather than keying the new
     * steps on changeClass) preserves.
     *
     * Follows changeClass wherever it is on, with SHIP_MERGE_GATE=0 as the
     * routing kill switch: moving the park strictly REDUCES mid-run human
     * blocking, so there is no opt-in condition to wait for. Without the
     * class gate the flag means nothing (no verdict, no park), and it is
     * never set then. See DurableAgentInput.mergeGate in durable.ts.
     */
    mergeGate?: boolean;
    /**
     * EV6 (SHIP_INCIDENT_FIX): this enqueue is an AUTHORISED incident
     * remediation (incidents.ts authorizeRemediation — explicit human
     * approval only in v1, per Decision 13), gated on a reproducing test.
     * The option is present on every remediation enqueue; THIS module reads
     * the flag, because incidents.ts must not touch env (its header). Under
     * SHIP_INCIDENT_FIX=on the run's recorded input carries
     * `requireReproTest` and the repro-test step gates its publish; with the
     * flag off the option is dropped and the run enqueues byte-identically
     * to pre-EV6 — no field, no step.
     *
     * Implies the change-class and merge gates (the outcome holds at the
     * merge boundary, and a run without one has nowhere to hold), so an
     * explicit changeClass/mergeGate false alongside it is refused rather
     * than silently overridden.
     */
    requireReproTest?: boolean;
    /**
     * Merge a `trivial` change without a human (L5). Absent falls back to the
     * repo's project record; there is no env default, because "which repos may
     * merge themselves" is a per-repo decision by construction.
     */
    autoMerge?: boolean;
    /**
     * Judge the service's before/after and record what should happen about a
     * regression (P1-4). Absent follows preview+telemetry; `SHIP_ROLLBACK=0`
     * turns the watch off for a deployment.
     */
    rollback?: boolean;
    /**
     * `"scan"` makes this a read-only audit run (L2 / D3): the agent reports
     * findings and Ship publishes nothing. Materialised here, like every other
     * optional feature, because it both adds a recorded step (`scan-findings`)
     * and removes several (`repo-push` and everything after it) — see
     * DurableAgentInput.mode in durable.ts for why either direction is a
     * NondeterminismError if a worker decides it at execution time.
     *
     * It also SUPPRESSES the flags that only make sense for a change: see the
     * resolution below, where a scan overrides them rather than merging with
     * them.
     */
    mode?: "fix" | "scan";
    /**
     * Which harness executes the run (see harness.ts). Absent falls back to
     * `SHIP_HARNESS`, and that to native. Resolved to an id+version HERE and
     * materialised into the recorded input: a run must replay under the program
     * that wrote its log, never under whatever the worker's env says today.
     */
    harness?: string;
    /**
     * How many independent attempts to make of the task (P6-1), ranked by the
     * project's own executable verification. Absent falls back to
     * `SHIP_ATTEMPTS` (default 3, max 5) on repo runs that classify normal or
     * serious; a run with no such field — every log written before this
     * existed — makes one attempt and replays exactly as before.
     */
    attempts?: number;
    workflowName?: string;
    /** Intake source, recorded so completion can settle spend against it. */
    source?: string;
    /**
     * Where the task came from (L7): the intake source, its dedupe key and,
     * for work that arrived from a workspace, the originating item ref.
     * Materialised into the recorded input below and read back when the run's
     * notification is built, so the outcome can find its way home without
     * anything re-deriving it at delivery time. Gates no step.
     */
    origin?: RunOrigin;
    /**
     * Who asked for this run. Recorded on the run's META, deliberately NOT in
     * the workflow input below.
     *
     * That placement is the whole safety argument. Every field in the recorded
     * `input` gates which steps a replay expects, so adding one there changes
     * how an in-flight run replays and risks a NondeterminismError that leaves
     * it permanently unrunnable (see the requireEdit note further down). The
     * actor decides nothing the agent does — it is a fact ABOUT the run, not an
     * instruction TO it — so metadata is both the safer and the more honest
     * home for it, and attribution can be added to a deployment with runs in
     * flight.
     */
    actor?: Actor;
    /**
     * Where `repo` came from. Defaults to "external" — the safe assumption for
     * a queued run, since the surfaces that KNOW a human typed the URL (the CLI
     * and the dashboard's new-run form) can say so explicitly.
     */
    trust?: RepoTrust;
    /**
     * The DECLARED network tier for this run's sandbox, overriding the
     * project record's. Delegation-only in practice (delegate.ts): a child
     * copies its parent's recorded tier so it can never be looser, and the
     * copy has to ride the enqueue like every other fact a replay reads.
     */
    sandboxNetwork?: NetworkTier;
    /**
     * Marks a run spawned by a ```delegate action (S20/S22). Internal to the
     * delegation control — never a surface option. Suppresses `delegate`
     * below (children do not delegate) and records the lineage marker the
     * loop's one-level refusal reads.
     */
    delegateChild?: boolean;
    /**
     * The model this run EXECUTES on (DT1), when it is not the worker's own:
     * materialised as `input.model` ONLY when set (the `lookImage` shape), and
     * recorded as the meta's model so the run is priced on what ran. Absent,
     * the input and the meta are exactly what they were before the option
     * existed. Internal to the delegation control today (a delegate target).
     */
    runModel?: string;
    /**
     * The delegate target a CHILD was spawned on, with the policy decision
     * that admitted it (DT2, delegate-targets.ts). Internal to the delegation
     * control; recorded verbatim, gates no step.
     */
    delegateTarget?: RecordedDelegateTarget;
    /**
     * A per-run cost cap carried in the INPUT (DT3): a delegated child's
     * min(per-run cap, parent remaining). Narrow only at execution
     * (durable.ts effectiveRunCap). Internal to the delegation control.
     */
    maxRunCostUSD?: number;
    /**
     * DF1 (SHIP_FORK): fork the named source run. The source must be settled
     * (or parked at its merge review) and SHIP_FORK must be on — both checked
     * HERE, at enqueue, so every surface gets the same named refusal and no
     * worker ever re-derives lineage. The resolution (the source's recorded
     * pushed sha and the transport facts) is materialised into the input as
     * `forkOf` and its Recorded line into the task, only when set: a run
     * without a fork enqueues byte-identically. A fork is a new task root —
     * pass no parentRunId. See fork.ts.
     */
    forkOf?: string;
    /**
     * DS1 (SHIP_STACKED_PRS): open this run's pull request ON TOP of the named
     * base run's open pull request. The base must be a run that OPENED a Ship
     * pull request and pushed (stacked-pr.ts refuses by name otherwise) and
     * the flag must be on — both checked HERE, at enqueue, so every surface
     * gets the same refusal and no worker re-derives the stack. The base's
     * branch and recorded head are materialised into the input as `stack`,
     * which admits no step: the repo-setup step reads it to decide where to
     * stand and against which branch the PR opens. Never with `pr`, `forkOf`
     * or a scan.
     */
    stackOn?: string;
    /**
     * DS1 (SHIP_STACKED_PRS): the revision pr-watch wakes when the stack's
     * base pull request squash-merged, carried from the intake task's `stack`
     * by the launch. Internal to that path — never a surface option. Admits
     * exactly one step (`stack-rebase`), so a run without it replays
     * byte-identically.
     */
    stackRebase?: StackRebaseRequest;
  },
): Promise<EnqueueReport | undefined> {
  const journey = options.journey === undefined ? undefined : parseJourney(options.journey);
  if (options.maxRunCostUSD !== undefined && !(Number.isFinite(options.maxRunCostUSD) && options.maxRunCostUSD > 0)) throw new Error("maxRunCostUSD must be a positive number");
  if (options.runModel !== undefined && (options.runModel.trim() === "" || options.runModel !== options.runModel.trim())) throw new Error("runModel must name a model");
  const requestHash = options.requestIdentity ?? launchRequestHash(options);
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Invalid request identity");
  const accepted = await runtime.launches?.get(options.runId);
  if (accepted) {
    assertSameLaunch(accepted, requestHash);
    await runtime.launches!.publish(accepted);
    return undefined;
  }
  if (options.reviewParent && (options.reviewParent !== options.parentRunId || !runtime.launches)) throw new Error("Review replacement requires a journal and matching parent");
  if (options.forkOf !== undefined && options.parentRunId !== undefined) throw new Error("A fork is a new task root and records its lineage as forkOf, not parentRunId");
  const taskRoot = options.parentRunId === undefined ? options.runId : await taskRootRunId(runtime.store, options.parentRunId);
  const now = new Date().toISOString();
  // DF1 (SHIP_FORK): resolve the fork's source ONCE, here. The forkable check
  // and the recorded-sha read are part of the enqueue, so a refused fork never
  // exists as a run, every surface gets the same named refusal, and a replay
  // reads the materialised record rather than a source log that moved on.
  // Deliberately after the launch-journal recovery above: retrying an already
  // accepted fork republishes it and must not re-resolve mutable facts.
  let fork: ForkSourceRecord | undefined;
  if (options.forkOf !== undefined) {
    if (!forkEnabled()) throw new Error("fork refused (SHIP_FORK off): run forking is not enabled on this deployment");
    const resolved = await resolveForkSource(runtime, options.forkOf);
    if (!resolved.ok) throw new Error(resolved.reason);
    fork = resolved.record;
  }
  // DS1 (SHIP_STACKED_PRS): same contract as the fork above — resolve ONCE,
  // here, so a refused stack never exists as a run and a replay reads the
  // materialised record rather than a base log that moved on. The mutual
  // exclusions are structural: a stacked run opens its own PR (never `pr`),
  // stands on the base's head (never also a fork), and is a change run.
  let stack: StackOnRecord | undefined;
  if (options.stackOn !== undefined) {
    if (!stackedPrsEnabled()) throw new Error("stack refused (SHIP_STACKED_PRS off): stacked pull requests are not enabled on this deployment");
    if (options.pr !== undefined) throw new Error("stack refused: a stacked run opens its own pull request; pass no pr");
    if (options.forkOf !== undefined) throw new Error("stack refused: a run stands on either a fork's commit or a stack base, not both");
    if (options.mode === "scan" || (journey !== undefined && journey !== "change") || options.delegateChild === true) {
      throw new Error("stack refused: a stacked run is a change run, not a scan or a delegation child");
    }
    if (options.repo === undefined) throw new Error("stack refused: a stacked run needs a repository");
    const resolved = await resolveStackBase(runtime, options.stackOn, options.repo);
    if (!resolved.ok) throw new Error(resolved.reason);
    stack = resolved.record;
  }
  if (options.stackRebase !== undefined) {
    const { oldBaseHeadSha, defaultBranch } = options.stackRebase;
    if (!/^[a-f0-9]{40}$/.test(oldBaseHeadSha)) throw new Error("stackRebase.oldBaseHeadSha must be a full commit sha");
    if (defaultBranch.trim() === "" || defaultBranch !== defaultBranch.trim()) throw new Error("stackRebase.defaultBranch must name a branch");
  }
  // The fork's Recorded line rides the task (fork.ts) ahead of any journey
  // instruction, so the run's own log says what it inherited and from where.
  // The stack's line (stacked-pr.ts) rides with it for the same reason.
  const recorded = [fork !== undefined ? forkNote(fork) : "", stack !== undefined ? stackNote(stack) : ""].filter((n) => n !== "");
  const baseTask = recorded.length === 0 ? options.task : `${options.task}\n\n${recorded.join("\n\n")}`;
  // Materialise the thresholds at ENQUEUE, never leave a bare `true` in the
  // log. durable.ts's contract is that the thresholds are fixed at enqueue,
  // because they decide which turn the run terminates on: a worker replaying
  // under tighter thresholds returns early, leaves recorded steps unconsumed,
  // and `leftoverCursorEvent()` raises a NondeterminismError that executeRun
  // THROWS rather than records — the run becomes permanently unrunnable, not
  // merely failed.
  //
  // A bare `true` broke that contract silently, because durable.ts would then
  // resolve thresholds from the `defaultRecoveryConfig` CODE CONSTANT at run
  // time. Editing that constant — an ordinary-looking change — would brick
  // every in-flight run enqueued before it. Reproduced end to end: enqueue
  // with `recovery: true`, change noProgressThreshold 6 -> 2, replay, and the
  // run is unrecoverable. Expanding here means the log carries the numbers.
  // SCAN MODE (L2 / D3). A scan reads a repository and reports findings; it
  // makes no change. Every optional feature resolved below is ABOUT a change —
  // hold a finish that edited nothing, run the suite over the edit, measure the
  // service around it, classify it before pushing, review the diff — so a scan
  // forces them off HERE rather than leaving each caller to remember.
  //
  // Forced at enqueue and not in durable.ts's branches, for the reason the
  // block below spells out at length: the recorded input is what gates step
  // presence, so "off for a scan" has to be a fact in the log, not a decision a
  // worker makes while replaying one.
  const scan = options.mode === "scan" || (journey !== undefined && journey !== "change") ||
    // Belt for the 2026-10-17 live finding: a DELEGATION CHILD is read-only,
    // ALWAYS, whatever its caller said. The spawn (delegateControlFromRuntime)
    // states `mode: "scan"` itself; this line is the enforcement that makes a
    // writable child un-enqueueable even if a future caller forgets — the
    // option is internal to the delegation control, so nobody else can be
    // relying on the old behaviour.
    options.delegateChild === true;
  if(options.environmentCheckOnly === true && (!options.repo || options.environmentCheck !== true || !scan))throw new Error("A setup-only check requires a repository and read-only environment verification");
  // Stuck detection (recovery.ts) is ON by default since 2026-09-15. It had
  // been opt-in (`SHIP_RECOVERY=1`) on the product path while the live loop
  // had it on unconditionally, and run-a3d15f43 showed the cost of the gap:
  // thirty-plus turns re-verifying a finished change with nothing to stop
  // it. `SHIP_RECOVERY=0` turns it off for a deployment; `recovery: false`
  // for one run. Materialised as the full tuning so a later change to the
  // defaults cannot alter a replay.
  const recoveryFlag = options.recovery ?? (envFlagOff("SHIP_RECOVERY") ? undefined : true);
  const recovery =
    recoveryFlag === true ? { ...defaultRecoveryConfig } : recoveryFlag;
  const settle = scan ? undefined : (options.settle ?? (envFlag("SHIP_SETTLE") ? true : undefined));
  // Hold a finish over an unchanged tree. ON by default, unlike the knobs
  // above, because it is not a tuning knob: without it a webhook-launched run
  // can finish "fixed" having written nothing and open a pull request that
  // makes a false claim to a human reviewer. Set SHIP_REQUIRE_EDIT=0 to turn it
  // off for a deployment, or pass requireEdit: false for one run.
  //
  // Measured cost, so nobody has to re-derive it: forcing this on for the
  // 2026-08-20 parity sweep turned 8 deliberate finishes into cap-outs and cost
  // ~30% more wall-clock. It did NOT measurably change the score, and at n=49
  // it could not have — the point is what a run CLAIMS, not what it scores.
  // The hold-grace exit in durable.ts is what pays back most of that cost.
  //
  // Flipped HERE and never in durable.ts's branch condition, deliberately: the
  // flag is materialised into the recorded input, so a run enqueued before this
  // change carries no `requireEdit` and replays through exactly the steps its
  // log contains. Changing the branch instead would make every in-flight run
  // look for a step its log does not have, which is a NondeterminismError and
  // leaves the run permanently unrunnable rather than merely failed.
  // ...and OFF for a scan: the hold exists to catch a finish that changed
  // nothing, which is precisely what a correct scan does.
  const requireEdit = scan ? undefined : (options.requireEdit ?? (envFlagOff("SHIP_REQUIRE_EDIT") ? false : true));
  // Browser perception (S12): the ```look action, default OFF behind
  // SHIP_LOOK. Materialised HERE like every step-adding flag — it admits a
  // `turn-N-look` step, and a replay must know from its log alone whether
  // the action was offered. Off for scans, which read a repository rather
  // than a web page.
  const look = scan ? undefined : (envFlag("SHIP_LOOK") ? true : undefined);
  // Bounded child work (S20/S22): the ```delegate action, default OFF behind
  // SHIP_DELEGATE. Materialised HERE like every step-adding flag — the
  // delegate branch records `turn-N-delegate-*` steps and parks on sleeps, so
  // a replay must know from its log alone whether the action was offered.
  // Suppressed on scans (a scan holds no publish authority to hand down) and
  // on delegation CHILDREN: one level is the whole v1 bound, and the child's
  // refusal has to be a fact of its recorded input, not a worker's env.
  const delegate = scan || options.delegateChild === true ? undefined : (envFlag("SHIP_DELEGATE") ? true : undefined);
  // Image mode for ```look (S12 gated slice), materialised beside `look` and
  // only when `look` itself is on: SHIP_LOOK_IMAGE_MODEL names the
  // vision-capable model image looks route to (the 2026-10-15 owner call:
  // glm-5.3-flash on the zai plan; Anthropic/OpenAI the fallback), and
  // SHIP_LOOK_IMAGE_MAX caps screenshots per run (default 3). UNSET model
  // means image looks refuse at execution with a message naming the env var
  // — never a blind pixel call to a model that cannot see. Recorded in the
  // input for the standing replay reason: it admits the
  // `turn-N-look-image` step.
  const lookImageModel = look === true ? (process.env.SHIP_LOOK_IMAGE_MODEL ?? "").trim() : "";
  const lookImage =
    lookImageModel !== ""
      ? {
          model: lookImageModel,
          max: (() => {
            const raw = Number(process.env.SHIP_LOOK_IMAGE_MAX);
            return Number.isInteger(raw) && raw >= 1 ? raw : 3;
          })(),
        }
      : undefined;
  // Look-session recording (Q3b): SHIP_LOOK_RECORD, default off, and only
  // when `look` itself is on — a run that was never offered the action has no
  // session to record. Materialised for the standing replay reason: it admits
  // the `look-record` step, and a replay must know from its log alone whether
  // the session was recorded. Unset keeps the input byte-identical to a
  // pre-Q3b run's.
  const lookRecord = look === true && envFlag("SHIP_LOOK_RECORD") ? true : undefined;
  // Per-repo evidence, resolved HERE so every enqueue surface (CLI, dashboard,
  // webhook, intake sweep) gets the same treatment without each knowing about
  // the store. Materialised into the recorded input below, never re-read at
  // execution: the store is editable, and a replay must run the command the
  // log was written under, not whatever the store says today.
  //
  // An entry's presence is also the ASK: a repo with a testCommand configured
  // gets its suite run (and one with an observeService gets telemetry) even on
  // a worker whose env never set SHIP_TESTS/SHIP_TELEMETRY. The config is the
  // operator saying what evidence this repo owes a reviewer.
  const evidence = options.repo !== undefined ? await runtime.evidence.forRepo(options.repo) : null;
  // The repo's project record (projects.ts): its sandbox image, network and
  // limits are copied into the input so the run boots the image the log was
  // written under, whatever the worker's SHIP_SANDBOX_IMAGE says today.
  const project = options.repo !== undefined ? await runtime.projects.forRepo(options.repo) : null;
  // The MCP client (D1): SHIP_MCP plus at least one server on the project
  // record, materialised with the deployment facts its gates read (data
  // class, SHIP_MCP_REMOTE_HOSTS, SHIP_TOOL_MANIFEST mode, the Decision 6
  // switch). It admits the `mcp-tools` / `turn-N-mcp` steps, so it rides the
  // input like every step-adding flag — and the record is editable, so the
  // log must carry the servers the run was offered. Off for scans, like look.
  const mcp = scan ? undefined : materialiseMcp(project?.mcp);
  // Skills (Q4-a, SHIP_SKILLS): the registry versions this project pinned,
  // resolved HERE — the registry is editable, and the run input has to carry
  // the bodies the log was written under, never a live lookup (the same
  // reason evidence and the ladder are copied at enqueue). Suppressed on
  // scans, like look/mcp/delegate. Absent on every run that does not admit
  // them, so those inputs stay byte-identical to pre-skills ones.
  const skills = scan ? undefined : await materialiseSkills(project?.skills, runtime.skills);
  // Delegate targets (DT2): what this run may name with ```delegate target=,
  // materialised beside `delegate` and only when it is on — the deployment's
  // SHIP_DELEGATE_TARGETS narrowed by the project's list. Recorded so the
  // prompt and the spawn read the offer the log was written under; the spawn
  // still re-checks today's lists (narrow only). An unset, unparseable or
  // empty result records nothing: such a run's input is byte-identical to a
  // pre-target one, and a target= block on it is refused by name at spawn.
  const delegateTargets = delegate === true ? offeredDelegateTargets(project?.delegateTargets) : undefined;
  // The evidence asks below read the enqueueing process's env, falling back
  // to what the deployment's worker published (deployment-asks.ts, F9): a CLI
  // enqueue from an operator's shell otherwise records no ask at all.
  const asks = askEnv(await readDeploymentAsks(runtime.config));
  // Deploy the pushed branch to a preview environment and link it on the PR.
  // Opt-in for the same reason as the three above: it adds recorded steps, so
  // turning it on must never change how an already-enqueued run replays. The
  // executing worker's config decides whether a preview can actually happen —
  // this only records that the run asked. A project that declares a preview
  // rung (C4) asks by that declaration.
  const preview = scan ? undefined : (options.preview ?? (envFlag("SHIP_PREVIEW", asks) || project?.verification?.preview !== undefined ? true : undefined));
  // Read the affected service's telemetry around the change. Same opt-in shape.
  const telemetry = scan ? undefined : (options.telemetry ?? (evidence?.observeService !== undefined || envFlag("SHIP_TELEMETRY", asks) ? true : undefined));
  const globalObserveRepo=process.env.OBSERVE_REPO?.trim();
  if(telemetry===true&&evidence?.observeService===undefined&&options.repo&&globalObserveRepo&&!canonicalRepositoryURL(globalObserveRepo)&&repoSlug(globalObserveRepo)===repoSlug(options.repo)) {
    throw new Error("The Observe repository mapping needs a full credential-free clone URL. Set OBSERVE_REPO or configure Observe on this project before starting work.");
  }
  // Run the project's suite after the agent stops. Same opt-in shape.
  const tests = scan ? undefined : (options.tests ?? (evidence?.testCommand !== undefined || envFlag("SHIP_TESTS", asks) ? true : undefined));
  // On by default wherever the suite itself is on, with an env off-switch —
  // the same shape as requireEdit above. Without a baseline, "Tests: FAILED"
  // cannot separate a regression from inherited breakage, and without the
  // finish gate a red suite ends the run instead of being fixed. Both are
  // strictly better defaults; the switch exists for a repo whose suite is too
  // expensive to run twice.
  const testsFeedback =
    options.testsFeedback ?? (tests === true && !envFlagOff("SHIP_TESTS_FEEDBACK") ? true : undefined);
  // Iterate-until-green (D3): the bound rides the finish gate it bounds, and
  // is materialised for the standard replay reason — the exhausting finish
  // records a `turn-N-fix-exhausted` step an older log must not be expected
  // to produce. A run enqueued before this field existed keeps the historical
  // two-nudge bound and replays through exactly the steps it holds.
  const fixRetries =
    testsFeedback === true
      ? (options.fixRetries ?? envCount("SHIP_FIX_RETRIES") ?? 2)
      : undefined;
  // The critic is ADVISORY wherever a suite is recorded (D3): the suite is
  // the trust boundary, and one model's opinion of a diff is not. Only a run
  // with NO suite keeps the bounded critic retry, which is then the only
  // in-loop check it has. Off-switch for deployments that want the veto back.
  const criticAdvisory =
    options.criticAdvisory ??
    (options.critic === true && !scan && tests === true && !envFlagOff("SHIP_CRITIC_ADVISORY") ? true : undefined);
  // WHICH command the suite is (B5), resolved here for the same reason as
  // everything else in this block: evidence is materialised at enqueue so a
  // replay runs the command the log was written under. An explicit per-repo
  // entry always wins; detection only answers a question nobody answered.
  //
  // Deliberately does NOT flip `tests` above. Detection says which command, not
  // whether to run one — flipping it would silently start baseline and retry
  // suites on a deployment that never opted in.
  //
  // Only DETECTION is gated on `tests`; the explicit per-repo command is
  // recorded either way. A run that declined to run the suite should still say
  // WHICH suite it declined — evidence.test.ts asserts exactly that, and it
  // caught this wiring getting it wrong.
  const testTarget =
    tests === true
      ? await resolveTestTarget(options.repo, evidence, { projects: runtime.projects })
      : evidence?.testCommand !== undefined
        ? {
            command: evidence.testCommand,
            ...(evidence.testTimeoutMs !== undefined ? { timeoutMs: evidence.testTimeoutMs } : {}),
            source: "project" as const,
          }
        : undefined;
  // The change-class gate is OPT-IN, unlike testsFeedback above, because it can
  // PARK a run — and a park with nobody to answer it is a hang. It is turned on
  // per deployment once someone is watching the inbox, which is exactly the
  // condition L5 and L6 also depend on.
  const changeClass = scan ? undefined : (options.changeClass ?? (options.repo !== undefined && envFlag("SHIP_CHANGE_CLASS") ? true : undefined));
  // The boundary park (C1). On wherever the class gate is (see the option
  // comment above), off for scans, and SHIP_MERGE_GATE=0 restores the old
  // mid-run routing without disturbing anything else about the run.
  const mergeGate = scan ? undefined : (options.mergeGate ?? (changeClass === true && !envFlagOff("SHIP_MERGE_GATE") ? true : undefined));
  // EV6 (SHIP_INCIDENT_FIX): the reproducing-test gate on an authorised
  // remediation, materialised HERE like every step-adding flag — it admits
  // the `repro-test` step (repro-test.ts), so a run whose log predates the
  // flag must not find a step it does not contain. The option comes from
  // authorizeRemediation's enqueue (incidents.ts); only "on" counts, the
  // same strict spelling EV5's worker-side read uses, so a bare "1" cannot
  // turn a gate that holds remediations on by accident.
  const requireReproTest =
    !scan && options.requireReproTest === true && (process.env.SHIP_INCIDENT_FIX ?? "").trim().toLowerCase() === "on"
      ? true
      : undefined;
  if (requireReproTest === true && (options.changeClass === false || options.mergeGate === false)) {
    throw new Error(
      "A remediation gated on a reproducing test parks at the merge boundary; it cannot be enqueued with the change-class or merge gate disabled",
    );
  }
  // AUTO-MERGE (L5 / D5). Per repo, off unless the project record says on, and
  // additionally requires the change-class gate: `trivial` is the entire
  // authority for merging without a human (see change-class.ts), and with the
  // gate off there is no verdict for the merge step to read — it would hold
  // every time and the flag would be a silent no-op.
  //
  // Materialised HERE for the standard replay reason (it adds an `auto-merge`
  // step) and for one sharper than usual: the project record is editable from
  // the dashboard, so a worker re-reading it mid-replay could merge a pull
  // request the log says was left open. The log has to carry the permission.
  //
  // SHIP_AUTO_MERGE=0 is a deployment-wide kill switch — the one knob an
  // operator wants at 3am does not belong behind a per-repo edit.
  //
  // THE LADDER CAPS AUTHORITY (C4 / contract 1). Where the record DECLARES
  // anything authority-shaped — an authority, a ladder, neverAuto — the
  // EFFECTIVE authority (setting, capped by the declared rungs, floored by
  // neverAuto; ladder.ts) is what the run carries, and `autoMerge` means that
  // authority reaches an auto rung: a declared repo with tests but no
  // preview rung lands on `send` and holds, which is the whole of C4.
  //
  // A record with ONLY the legacy autoMerge flag keeps the legacy gate
  // verbatim (no authority is materialised, so the merge step reads the
  // historical conditions). Deliberate: this lane lands before contract 1's
  // ingestion does, and freezing every legacy-flagged repo at `send` —
  // silently, because the flag still says on — would be a behaviour change
  // no record edit asked for. Declaring a ladder is the edit that opts a
  // repo into the capped world. PRE-DECIDED here; the hard line (bare
  // autoMerge also caps) is the one addition of `|| project.autoMerge ===
  // true` to the set below, taken the day every repo has had its chance to
  // declare.
  const authority =
    project !== null && (project.authority !== undefined || project.neverAuto === true || project.verification !== undefined)
      ? effectiveAuthority(project)
      : undefined;
  const wantsAuto =
    options.autoMerge ??
    (authority !== undefined ? authority === "auto_trivial" || authority === "auto_normal" : project?.autoMerge === true);
  const autoMerge =
    !scan && changeClass === true && !envFlagOff("SHIP_AUTO_MERGE") && wantsAuto === true
      ? true
      : undefined;
  // AUTO-ROLLBACK WATCH (P1-4 / L4). On wherever both of its inputs are on,
  // with an off-switch: the step is a pure judgement over two verdicts that
  // were going to be recorded anyway, so watching costs nothing, and the whole
  // point of building the observation half first is to collect the recorded
  // outcomes before anything acts on them.
  const rollback =
    scan ? undefined : (options.rollback ?? (preview === true && telemetry === true && !envFlagOff("SHIP_ROLLBACK") ? true : undefined));
  // The authority to ACT on that watch, per repo. Never set without the watch:
  // permission to roll back with nothing judging when to is not a feature.
  const autoDeploy = rollback === true && project?.autoDeploy === true ? true : undefined;
  // The harness, as id + contract version. Recorded on EVERY new run, native
  // included, so the log says which program wrote it; a run enqueued before
  // this field existed has none and is native by definition.
  // The project record's declared harness (B5) sits between an explicit
  // request and the worker's env: the repo says what its image was baked with,
  // and a caller naming one explicitly still wins.
  const harness = harnessRef(options.environmentCheckOnly === true ? "native" : options.harness ?? project?.harness ?? process.env.SHIP_HARNESS);
  // Multi-harness attempts (P5-4): repo runs only, two or more ids, off unless
  // SHIP_HARNESS_ATTEMPTS says so. Materialised like everything else here.
  // Not on a scan: N harnesses producing N sets of findings is N times the
  // cost for an answer the critic picks between on the strength of a DIFF,
  // which a scan does not have.
  const attempts = options.repo !== undefined && !scan ? harnessAttempts(process.env.SHIP_HARNESS_ATTEMPTS) : [];
  // E7 H3 (SHIP_ACP_HARNESS): the ACP harness ids are admitted at enqueue
  // only when the flag is on and the profile's credential is present. Same
  // before-append rule as the plan-review refusal — a refusal after
  // `store.append` would leave a ghost run no surface can explain.
  assertAcpHarnessAdmitted([harness, ...attempts]);
  // A project requirement is a floor, never a heuristic based on prompt size.
  // Resolve only for new runs; accepted launches and parked histories retain
  // the recorded checkpoint so changing policy cannot change their replay.
  const planReview = !scan && (project?.requirePlanReview === true || options.plan === true);
  if (planReview && (harness.id !== "native" || attempts.some(h => h.id !== "native"))) {
    throw new Error(`${refusalFor([harness.id, ...attempts.map(h => h.id)].find(i => i !== "native") ?? "", "plan-review") ?? PLAN_REVIEW_REFUSAL} Select native in Project settings. A required project checkpoint cannot be disabled for an individual task.`);
  }
  // Independent attempts of one task, ranked by the project's own verification
  // (P6-1). Repo runs only — a second attempt is a second checkout — and never
  // on a scan, which produces findings rather than a tree to rank. Only where
  // the change-class gate is on, which is the never-trivial half of the rule:
  // `trivial` is a verdict about a diff that does not exist yet, and a run that
  // can classify is the one whose class will be recorded. Recorded HERE like
  // every other capability: K decides how many `attempt-N-*` groups the log
  // carries, so it is a fact of the admission, not of the worker that happens
  // to pick the run up.
  const attemptsK =
    options.attempts !== undefined
      ? options.attempts
      : options.repo !== undefined && !scan && changeClass === true
        ? attemptsCount(process.env.SHIP_ATTEMPTS)
        : undefined;
  // Required reviewers for this repo (governance.ts), resolved HERE for the
  // same reason as evidence: it adds a recorded step (`repo-reviewers`), so
  // its presence must be a function of the recorded input, and the rule is
  // editable, so a replay must request the reviewers the log was written
  // under. Absent on runs enqueued before the rule existed.
  const reviewers = options.repo !== undefined ? reviewersFor((await runtime.governance.get()).reviewers, options.repo, await runtime.projects.list()) : null;
  // Warm cache eligibility: a repo run with a cacheable origin, never a PR
  // run (its checkout resolves a head branch that may live in a fork, so the
  // volume would not be the repository's steady state).
  const warmRun =
    options.environmentCheckOnly !== true && options.repo !== undefined && options.pr === undefined && warmCacheEnabled() && warmSlugOf(options.repo) !== null;
  // Warm threads (D4-c): which runs may leave a snapshot behind for the
  // thread's next turn. Repo runs, single attempt (a multi-attempt run has
  // no ONE workspace to hand forward), never a delegation child (its spawn
  // owns the child's shape) and never a setup-only check. The FLAG pair is
  // the operator's assertion that the daemon bakes warm-volume bytes into
  // snapshots (SHIP_WARM_PARKS, teploy-sandbox 2a89f72) — without it a
  // snapshot restores an empty workspace and warmth would be a lie.
  const warmThreadEligible =
    warmThreadEnabled() &&
    options.environmentCheckOnly !== true &&
    options.repo !== undefined &&
    attempts.length < 2 &&
    options.delegateChild !== true;
  // The spend cap, checked BEFORE the run exists. Order matters: a refusal
  // after `store.append` would leave a `run-started` event for a run no worker
  // is allowed to execute — a ghost in the runs list that no surface can
  // explain. Throwing here means the caller's enqueue simply did not happen.
  await assertDailyBudget(runtime, {
    runId: options.runId,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
  });
  // The project's allowlist plus the entries its declared preview needs
  // (deploy.ts previewEgressAllow). Scans preview nothing. On top of both,
  // the harness's provider hosts (harness-external.ts providerEgressAllow):
  // an external harness calls its model API from INSIDE the sandbox — the
  // native loop calls from the worker — so on the allowlist tier the vendor
  // host has to be on the run's own list or every model call dies at the
  // proxy (production, 2026-10-17: `api.z.ai:443` refused under
  // ANTHROPIC_BASE_URL). Derived from the same forwarded env the harness will
  // read, materialised HERE for the standard replay reason: the log has to
  // say which hosts the container was actually allowed. Native (and an
  // external run with nothing derivable) records exactly what it did before
  // this existed — byte-identical inputs, and no step is admitted by the
  // field, so fingerprints do not move. The ACP profiles' hosts ride the same
  // merge (harness-acp.ts withAcpProviderEgress), derived per profile.
  const sandboxEgressAllow = withAcpProviderEgress(
    withProviderEgress(
      scan ? project?.sandboxEgressAllow : withPreviewEgress(project?.sandboxEgressAllow, project?.verification),
      [harness, ...attempts],
    ),
    [harness, ...attempts],
  );
  // EV6: the gate only passes when the agent writes the reproducing test, so
  // the task must SAY so — appended here, frozen into the recorded input's
  // task text, which is what a replay reads.
  const reproTask = requireReproTest === true ? `${baseTask}${REPRO_REMEDIATION_TASK_NOTE}` : baseTask;
  // Hoisted out of the append below so the upgrade fence can fingerprint the
  // exact object the log will carry, rather than a reconstruction of it.
  const inputBase = {
        restoreValidation: 1 as const,
        task: journey ? `${reproTask}\n\n${journeyInstruction(journey)}` : reproTask,
        ...(journey ? { journey, userMessage: options.userMessage ?? options.task } : {}),
        ...(options.environmentCheckOnly === true ? { environmentCheckOnly: true } : {}),
        ...(options.environmentCheck === true ? { environmentCheck: true, ...projectReadinessRecord(project, options.environmentInputsDigest, stackDetectEnabled()) } : {}),
        ...(options.userMessage !== undefined ? { userMessage: options.userMessage } : {}),
        ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
        ...(options.parentRunId !== undefined && options.pr !== undefined ? { requireOpenPr: true } : {}),
        // DF1 (SHIP_FORK): lineage and the checkout facts, materialised only
        // when this run was forked. Admits no step — the repo-setup step reads
        // it to decide where to stand — so runs without it stay byte-identical
        // and the fingerprint does not move (fork.ts).
        ...(fork !== undefined ? { forkOf: fork } : {}),
        // DS1 (SHIP_STACKED_PRS): the base's branch and recorded head,
        // materialised only when this run was enqueued with stackOn. Admits no
        // step — repo-setup reads it for where to stand and repo-pr echoes it
        // at open — so runs without it stay byte-identical and the fingerprint
        // does not move (stacked-pr.ts).
        ...(stack !== undefined ? { stack } : {}),
        // DS1: the woken revision's two facts. Admits exactly one step
        // (`stack-rebase`), absent on every run enqueued before this field.
        ...(options.stackRebase !== undefined ? { stackRebase: options.stackRebase } : {}),
        ...(options.repo !== undefined ? { repo: options.repo, repositoryScopeVersion: 2 as const } : {}),
        // Provenance, recorded whenever the caller stated it — not only on
        // repo runs. A chat message or an issue comment with no repository
        // still came from outside, and two rules read this field: the
        // isolated-executor refusal and the network downgrade below. Recording
        // it only for repo runs left both blind to exactly the tasks they
        // exist for. Absent still means operator-launched (an eval, a CLI
        // invocation, a workspace run), so nothing that used to run starts
        // being refused.
        ...(options.trust !== undefined ? { trust: options.trust } : options.repo !== undefined ? { trust: "external" as const } : {}),
        ...(options.pr !== undefined ? { pr: options.pr } : {}),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
        // Both suppressed on a scan: the plan park asks an operator to approve
        // work that will not happen, and the critic reviews a diff there is none of.
        ...(planReview ? { plan: true } : {}),
        ...(options.critic === true && !scan ? { critic: true } : {}),
        ...(scan ? { mode: "scan" as const } : {}),
        // Deliberately NOT in the unconditional block below: stuck detection
        // costs an extra sandbox round trip per executing turn and can end a
        // run earlier than it would have ended, so it stays opt-in until it is
        // measured on the product path.
        ...(recovery !== undefined ? { recovery } : {}),
        ...(settle === true ? { settle: true } : {}),
        ...(requireEdit === true ? { requireEdit: true } : {}),
        ...(preview === true ? { preview: true } : {}),
        // A follow-up on an existing pull request removes the previews of the
        // older runs on it once its own is up (preview-supersede.ts). Only
        // where a preview step will run: the flag adds a recorded step.
        ...(!scan && options.pr !== undefined && (preview === true || project?.verification?.preview !== undefined) ? { supersedePreviews: true } : {}),
        ...(telemetry === true ? { telemetry: true } : {}),
        ...(tests === true ? { tests: true } : {}),
        ...(testsFeedback === true ? { testsFeedback: true } : {}),
        ...(fixRetries !== undefined ? { fixRetries } : {}),
        ...(criticAdvisory === true ? { criticAdvisory: true } : {}),
        ...(changeClass === true || requireReproTest === true ? { changeClass: true } : {}),
        // EV6: a repro-gated remediation always carries the boundary park
        // (the `||` above and below), whatever the deployment's gate
        // defaults — the outcome has to hold somewhere.
        ...(mergeGate === true || requireReproTest === true ? { mergeGate: true } : {}),
        ...(requireReproTest === true ? { requireReproTest: true } : {}),
        ...(autoMerge === true ? { autoMerge: true } : {}),
        ...(rollback === true ? { rollback: true } : {}),
        ...(autoDeploy === true ? { autoDeploy: true } : {}),
        // The verification ladder (C4 / contract 1), copied from the project
        // record at enqueue for the standard replay reason: the ladder steps
        // (build, preview-smoke, visual-diff, observe-window, ladder) are
        // gated on it, and the record is editable, so a replay must run the
        // rungs the log was written under — not whatever the record says
        // today. `authority` is the EFFECTIVE authority (capped, floored)
        // for the same reason autoMerge is: the permission to merge has to
        // live in the log, and the merge gate reads it, never the store.
        ...(project?.verification !== undefined ? { verification: project.verification } : {}),
        ...(authority !== undefined ? { authority } : {}),
        // Per-repo evidence values (see the resolution above). Absent on runs
        // enqueued before this existed, which replay and fall back to the
        // worker's env wiring exactly as before.
        ...(testTarget !== undefined ? { testCommand: testTarget.command } : {}),
        ...(testTarget?.timeoutMs !== undefined ? { testTimeoutMs: testTarget.timeoutMs } : {}),
        ...(evidence?.observeService !== undefined ? { observeService: evidence.observeService } : {}),
        ...(evidence?.observeService !== undefined ? { observeRepo: project?.url ?? options.repo ?? evidence.repo } : {}),
        ...(reviewers !== null ? { reviewers: { users: reviewers.users, teams: reviewers.teams } } : {}),
        ...(project?.preparation !== undefined ? { preparation: project.preparation } : {}),
        ...(project?.sandboxImage !== undefined ? { sandboxImage: project.sandboxImage } : {}),
        // The network tier and this repo's extra allowlist entries, copied
        // from the record for the same reason as everything else here: the
        // record is editable and a replay must boot the container the log was
        // written under, not the one the record describes today. What the log
        // records is the DECLARED tier; `sandboxOverridesOf` applies the
        // external-task downgrade at execution, so the declaration and the
        // downgrade both stay readable.
        ...(project?.sandboxNetwork !== undefined ? { sandboxNetwork: project.sandboxNetwork } : {}),
        // A delegation child's inherited tier (see the option): recorded
        // AFTER the project line so an explicit copy always wins, and absent
        // whenever the caller did not state one — the project default then
        // resolves exactly as it did for the parent.
        ...(options.sandboxNetwork !== undefined ? { sandboxNetwork: options.sandboxNetwork } : {}),
        // Plus, for a project that declares a preview, the preview target's
        // host derived from this deployment's SHIP_PREVIEW_TAILNET_IP (and
        // main's host for the visual rung): the preview rungs run behind the
        // same allowlist, and no per-project hand entry should be needed. And
        // for an external harness, the provider API hosts it will call from
        // inside the sandbox (see the sandboxEgressAllow resolution above) —
        // same principle: no per-project hand entry for a host this
        // deployment itself configured the harness to dial.
        ...(sandboxEgressAllow !== undefined ? { sandboxEgressAllow } : {}),
        ...(project?.sandboxLimits !== undefined ? { sandboxLimits: project.sandboxLimits } : {}),
        // Every newly-enqueued run is steerable and index-eligible; runs
        // enqueued before these flags existed replay without the extra
        // steps (input-gated in durable). The executing worker's config
        // decides whether indexing actually happens.
        steer: true,
        // Every newly-enqueued run may ask the operator a question (```ask,
        // durable.ts). Materialised like steer so the log says the run was
        // offered the action; a worker that predates it feeds the block back
        // as unknown, which is the pre-feature behaviour exactly. The one
        // exception is a DELEGATION CHILD (2026-10-17 live finding): an ask
        // parks the child on a human whose eye is on the parent, and the
        // parent's delegate-wait must never block behind that — so the action
        // is never offered, and the loop's belt refuses a stray block BY NAME
        // (DELEGATE_CHILD_ASK_REFUSED) for hand-crafted and pre-fix inputs.
        ...(options.delegateChild === true ? {} : { ask: true }),
        // ```look (S12), from SHIP_LOOK above: default off, so the runs that
        // do not set it enqueue exactly as they did before the action
        // existed.
        ...(look === true ? { look: true } : {}),
        // ...and its image mode (SHIP_LOOK_IMAGE_MODEL above), absent on any
        // run that does not admit it — including look-off runs, whose inputs
        // stay byte-identical to pre-image ones.
        ...(lookImage !== undefined ? { lookImage } : {}),
        // ...and the session recording (SHIP_LOOK_RECORD above), absent on
        // every run that does not admit it, so those inputs stay
        // byte-identical to pre-Q3b ones.
        ...(lookRecord === true ? { lookRecord: true } : {}),
        ...(look === true || skills !== undefined ? { inlineFences: true } : {}),
        // ```delegate (S20/S22), from SHIP_DELEGATE above: default off, so a
        // run that does not set it enqueues exactly as it did before the
        // action existed — and the child marker, recorded only on spawned
        // children, whose own inputs never admit delegation.
        ...(delegate === true ? { delegate: true } : {}),
        ...(options.delegateChild === true ? { delegateChild: true } : {}),
        ...(delegateTargets !== undefined ? { delegateTargets } : {}),
        ...(options.delegateTarget !== undefined ? { delegateTarget: options.delegateTarget } : {}),
        ...(options.maxRunCostUSD !== undefined ? { maxRunCostUSD: options.maxRunCostUSD } : {}),
        // The run's own model (DT1), absent unless the caller named one.
        ...(options.runModel !== undefined ? { model: options.runModel } : {}),
        // Two-way steering (D2), from SHIP_STEER_REPLY=on (only `on`; the
        // SHIP_THREAD_VIEW grammar): default off, so a run that does not set
        // it enqueues exactly as before. Materialised for the standing
        // reason — it admits the turn-N-held / turn-N-finish-held steps.
        ...(steerReplyEnabled() ? { steerReply: true } : {}),
        // The MCP client (D1), from SHIP_MCP + the project record above:
        // absent on every run that does not admit it, so those inputs stay
        // byte-identical to pre-MCP ones.
        ...(mcp !== undefined ? { mcp } : {}),
        // Skills (Q4-a), from SHIP_SKILLS + the project's pins above: same
        // rule — absent on every run that does not admit them.
        ...(skills !== undefined ? { skills } : {}),
        index: true,
        guard: true,
        // The warm repo cache (SB-A). Repo runs that are not PR runs, on
        // unless SHIP_WARM_CACHE says otherwise, and materialised HERE for
        // the usual reason — it adds a recorded step and asks the daemon for
        // a volume, so the log has to say the run wanted one. A worker whose
        // daemon has no cache store degrades to the cold path.
        // warmParks needs the sandbox daemon's volume-aware snapshots
        // (teploy-sandbox 2a89f72, 2026-09-22): an older daemon's commit
        // skips the warm volume, so a warm park snapshot would restore an
        // EMPTY workspace and the run would continue from it. Capability is
        // an operator assertion (SHIP_WARM_PARKS=1 after the daemon is
        // upgraded — see docs/UPGRADING.md), recorded HERE so a replay
        // under a mixed fleet stays exactly what its log says.
        ...(warmRun ? { warm: true, ...(envFlag("SHIP_WARM_PARKS") ? { warmParks: true } : {}) } : {}),
        harness,
        ...(attempts.length >= 2 ? { harnessAttempts: attempts } : {}),
        // K, clamped and defaulted at enqueue so a replay launches exactly the
        // attempts the log was written under. Never recorded on a scan or a
        // workspace run (see attemptsK above), which keeps those runs' step
        // sequences — and therefore their fingerprints — untouched.
        ...(attemptsK !== undefined && attemptsK > 1 ? { attempts: attemptsK } : {}),
  };
  // The follow-up half of D4-c, resolved from the thread's record AFTER the
  // rest of the input exists (the shape match is against the input this run
  // will actually carry) and BEFORE anything is appended, so the recorded
  // input and its fingerprint include it. Decided HERE, never inside a step:
  // the record is live host state, the same reason `warm` is materialised
  // (warm.ts). A refusal names itself — the report below carries it so a
  // cold follow-up is a stated fact rather than a mystery.
  const warmFollowUp: ThreadWarmDecision | undefined =
    warmThreadEligible && options.parentRunId !== undefined && options.repo !== undefined
      ? await threadWarmForEnqueue(runtime.config, taskRoot, options.repo, sandboxOverridesOf(inputBase))
      : undefined;
  const input: DurableAgentInput = {
    ...inputBase,
    ...(warmThreadEligible ? { warmThread: true } : {}),
    ...(warmFollowUp !== undefined && "ref" in warmFollowUp ? { threadWarm: warmFollowUp.ref } : {}),
  };
  const started: WorkflowEvent = {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: now,
    data: {
      workflow: options.workflowName ?? "coding-agent",
      taskRootRunId: taskRoot,
      input,
      // The upgrade fence (step-fingerprint.ts): what step sequence the build
      // that enqueued this run would replay it through. A SIBLING of `input`,
      // never a field inside it — the recorded input is what gates step
      // presence, so a fingerprint stored there would change how in-flight
      // runs replay and could cause the exact failure it exists to prevent.
      // The engine reads `workflow` and `input` and ignores everything else on
      // this event, so this key is inert to replay.
      stepFingerprint: stepFingerprint(input),
      // Who ran it (S13): model, harness, expected revision, configuration
      // identity. A sibling like the fingerprint, and only under
      // SHIP_HARNESS_RECORD=on; off writes no key at all.
      ...(harnessRecordEnabled() ? { harnessIdentity: harnessIdentity({ harness, attempts, shipModel: options.runModel ?? options.model }) } : {}),
    },
  };
  const meta: RunMeta = {
    runId: options.runId,
    task: options.userMessage ?? options.task,
    // What the worker prices the run on (worker.ts settle): the model that
    // executes it.
    model: options.runModel ?? options.model,
    status: "queued",
    ...(options.source !== undefined ? { source: options.source } : {}),
    // Flat columns, never a nested object: the Nucleus doc store maps scalars.
    // An unattributable run records the unknown actor rather than nothing, so
    // "we could not name anyone" and "this predates attribution" stay
    // distinguishable in the export.
    ...(options.actor !== undefined
      ? { actor: options.actor.id, actorKind: options.actor.kind }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  // What the enqueuing surface can say back about the evidence it asked for —
  // the CLI prints it, because a silent "no suite will run" is how F9 hid.
  const report: EnqueueReport = {
    tests: tests === true,
    ...(testTarget !== undefined ? { testCommand: testTarget.command, testCommandSource: testTarget.source } : {}),
    ...(warmFollowUp !== undefined
      ? "ref" in warmFollowUp
        ? { threadWarm: { used: true } }
        : { threadWarm: { used: false, reason: warmFollowUp.reason } }
      : {}),
  };
  if (runtime.launches) {
    const intent = await runtime.launches.prepare({runId:options.runId,requestHash,started,meta,...(options.reviewParent ? {reviewParent:options.reviewParent} : {})});
    await runtime.launches.publish(intent);
    return report;
  }
  await runtime.store.append(options.runId, started);
  await runtime.saveMeta(meta);
  // markWake only updates an existing index record; a freshly enqueued
  // run has none, so the scheduler would never see it. record() is the
  // insert-or-update path — "wake" makes the run due immediately.
  if (runtime.kind !== "file") {
    const nucleus = runtime as NucleusShipRuntime;
    await nucleus.index.record(
      options.runId,
      options.workflowName ?? "coding-agent",
      { status: "wake" } as unknown as RunOutcome,
    );
  }
  return report;
}

// ------------------------------------------------------------- delegation (S20/S22)

/**
 * The runtime half of the delegate control (delegate.ts holds the pure half).
 * spawn claims a child in the task root's ledger and enqueues an ORDINARY SCAN
 * run carrying the parent's lineage and gates; outcome projects a child's log
 * into a transfer. Everything here runs INSIDE the parent's recorded
 * `turn-N-delegate-spawn` / `-wait` steps, so every store read it makes is
 * replay-safe by the same contract those steps already carry.
 *
 * GATES: the child copies trust and the declared network tier from the
 * parent's RECORDED input, and its spend settles into the parent's (source,
 * day) bucket because the source is copied too — the cap sees delegation
 * without a second ledger. The repo hint from the fence is verified against
 * the parent's own repo; a workspace run cannot grant one. Everything the
 * parent holds that is ABOUT making a change — plan review, the change-class
 * and merge gates, requireEdit — is NOT copied and would not survive the scan
 * mode anyway: a child is a READ-ONLY researcher (2026-10-17 live finding,
 * run-request-1032fa9d…), the parent stays the only writer, and the single
 * pull request is the parent's. The scan mode is materialised HERE, on the
 * enqueue: it is part of the child's recorded input, so the child's whole
 * step sequence is a fact of its own log before any worker touches it.
 */
/**
 * A delegated child's cost cap (DT3): min(per-run cap, the parent's
 * remaining), where the parent's cap is the per-run cap narrowed by any cap
 * its own input recorded and its spend is priced from its recorded steps on
 * its model. `cap` undefined = no ceiling configured, nothing to share. The
 * cap is floored to a millionth of a dollar, the narrowing direction.
 */
export function childCostShare(args: {
  perRunCap: number;
  parentRecordedCap: number | undefined;
  parentModel: string;
  events: ReadonlyArray<{ type: string; data?: unknown }>;
  env?: NodeJS.ProcessEnv;
}): { ok: true; cap?: number } | { ok: false; reason: string } {
  const perRun = Number.isFinite(args.perRunCap) && args.perRunCap > 0 ? args.perRunCap : 0;
  const parentCap = effectiveRunCap(perRun, args.parentRecordedCap);
  if (parentCap <= 0) return { ok: true };
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let harnessCost = 0;
  for (const event of args.events) {
    if (event.type !== "step-completed") continue;
    const u = (event.data as { result?: { usage?: Partial<RunUsage> } } | undefined)?.result?.usage;
    if (u === undefined || u === null || typeof u !== "object") continue;
    // A leg that priced itself (an external harness) is counted at its own
    // figure; everything else is tokens on the parent's model.
    if (typeof u.costUSD === "number" && Number.isFinite(u.costUSD) && u.costUSD >= 0) {
      harnessCost += u.costUSD;
      continue;
    }
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.totalTokens += u.totalTokens ?? 0;
    usage.cacheReadTokens += u.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  }
  const spent = harnessCost + costUSD(args.parentModel, usage, args.env);
  const remaining = parentCap - spent;
  if (!(remaining > 0)) {
    return {
      ok: false,
      reason: `delegation refused (budget-insufficient): this run has spent ~$${spent.toFixed(2)} of its $${parentCap.toFixed(2)} per-run cost ceiling, so a child would have nothing to run on. Do the remaining work yourself.`,
    };
  }
  const cap = Math.floor(Math.min(perRun > 0 ? perRun : remaining, remaining) * 1e6) / 1e6;
  if (!(cap > 0)) return { ok: false, reason: `delegation refused (budget-insufficient): this run has under $0.000001 of its per-run cost ceiling left. Do the remaining work yourself.` };
  return { ok: true, cap };
}

/** The targets a new run is offered (DT2): SHIP_DELEGATE_TARGETS ∩ the project's list, or undefined for none. */
function offeredDelegateTargets(projectIds: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env): DelegateTarget[] | undefined {
  const parsed = parseDelegateTargets(env.SHIP_DELEGATE_TARGETS);
  if (!parsed.ok) return undefined;
  const effective = effectiveDelegateTargets(parsed.targets, projectIds);
  return effective.length > 0 ? effective : undefined;
}

/** A recorded offer read back off a parent's input, shape-checked: anything malformed offers nothing. */
function recordedOffer(raw: unknown): DelegateTarget[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DelegateTarget[] = [];
  for (const t of raw) {
    const e = t as Partial<DelegateTarget> | null;
    if (e === null || typeof e !== "object" || typeof e.id !== "string" || typeof e.harness !== "string" || typeof e.model !== "string") return undefined;
    out.push({ id: e.id, harness: e.harness, model: e.model });
  }
  return out;
}

export interface DelegateControlDeps {
  /** Where a targeted spawn's routing segment is recorded. Default: the store's ship_model_segments table; none on a file runtime. */
  segments?: SegmentSink;
  /** The deployment env the target gate reads. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export function delegateControlFromRuntime(runtime: ShipRuntime, deps: DelegateControlDeps = {}): DelegateControl {
  const env = deps.env ?? process.env;
  const segments = deps.segments ?? (runtime.kind !== "file" ? new NucleusSegmentSink((runtime as NucleusShipRuntime).db) : undefined);
  return {
    async spawn(request): Promise<DelegateSpawnOutcome> {
      // The parent's own log is the authority for lineage and gates: it was
      // recorded by the enqueue this run came from, so it is immutable for
      // the run's whole life.
      const events = (await runtime.store.load(request.parentRunId)) as Array<{ type: string; data?: unknown }>;
      const started = events.find((e) => e.type === "run-started")?.data as
        | { taskRootRunId?: unknown; input?: { repo?: unknown; trust?: unknown; sandboxNetwork?: unknown; delegateTargets?: unknown; maxRunCostUSD?: unknown } }
        | undefined;
      if (started === undefined) return { ok: false, reason: `delegation unavailable: run ${request.parentRunId} has no recorded input` };
      const input = started.input ?? {};
      const taskRootRunId = typeof started.taskRootRunId === "string" && started.taskRootRunId !== "" ? started.taskRootRunId : request.parentRunId;
      const meta = await runtime.loadMeta(request.parentRunId);
      const model = meta?.model ?? "";
      if (model === "") return { ok: false, reason: "delegation unavailable: the parent run's model could not be resolved from its meta" };
      // Scope hints are narrowed, never widened: repo= must name exactly the
      // parent's repository, and a parent with no repository cannot grant one.
      const parentRepo = typeof input.repo === "string" && input.repo !== "" ? input.repo : undefined;
      if (request.repoHint !== undefined) {
        if (parentRepo === undefined) {
          return { ok: false, reason: "delegation refused: this run has no repository, so it cannot scope a child to one — leave repo= off" };
        }
        const canonical = canonicalRepositoryURL(request.repoHint);
        const parentCanonical = canonicalRepositoryURL(parentRepo);
        if (canonical === null || canonical !== parentCanonical) {
          return { ok: false, reason: "delegation refused: repo= must name this run's own repository (a delegation cannot target another repository)" };
        }
      }
      // The child's cost cap (DT3): min(per-run cap, what the parent has
      // left), read off the parent's own recorded steps inside this recorded
      // spawn step, so a replay reads the recorded outcome. Narrow only: the
      // child's loop takes min(its worker's cap, this). With no per-run cap
      // configured there is nothing to share and nothing is recorded. A
      // parent with nothing left gets a refusal, never a child that would
      // stop on its first turn.
      const share = childCostShare({
        perRunCap: Number(env.SHIP_MAX_RUN_COST_USD),
        parentRecordedCap: typeof input.maxRunCostUSD === "number" ? input.maxRunCostUSD : undefined,
        parentModel: model,
        events,
        env,
      });
      if (!share.ok) return { ok: false, reason: share.reason };
      const childCap = share.cap;
      // A NAMED target (DT2) is a new destination for this task's data, so it
      // is gated here, before the ledger claim: allowlisted for this run and
      // project, a harness that can run a read-only child, and admitted by the
      // routing policy's data-class check whatever SHIP_MODEL_ROUTING says.
      // Every refusal is an observation naming its code. No target = the
      // child inherits exactly as before, and none of this runs.
      let target: RecordedDelegateTarget | undefined;
      let targetSegment: { mode: RoutingMode; segment: Segment } | undefined;
      if (request.target !== undefined) {
        const project = parentRepo !== undefined ? await runtime.projects.forRepo(parentRepo) : null;
        const gate = gateDelegateTarget({
          id: request.target,
          offered: recordedOffer(input.delegateTargets),
          projectIds: project?.delegateTargets,
          env,
          ...(childCap !== undefined ? { reservedBudgetUSD: childCap } : {}),
        });
        if (!gate.ok) return { ok: false, reason: gate.reason };
        target = gate.target;
        targetSegment = { mode: gate.mode, segment: gate.segment };
      }
      const task = childTaskPrompt({
        parentRunId: request.parentRunId,
        turn: request.turn,
        task: request.task,
        ...(parentRepo !== undefined ? { repo: parentRepo } : {}),
        ...(request.pathHint !== undefined ? { path: request.pathHint } : {}),
      });
      const max = delegateMaxChildren();
      const key = delegationKey(taskRootRunId);
      // Idempotency first: a step re-run after a crash before it recorded
      // finds its OWN entry and republishes the same child (the launch
      // journal turns the re-enqueue into a republish), never a second run.
      let existing: DelegationEntry | undefined;
      await withFileLock(key, async () => {
        const record = parseDelegationRecord(await runtime.config.get(key), taskRootRunId) ?? { taskRootRunId, entries: [] };
        existing = record.entries.find((e) => e.parentRunId === request.parentRunId && e.turn === request.turn);
        if (existing !== undefined) return;
        if (record.entries.length >= max) return;
        const entry: DelegationEntry = {
          index: record.entries.length + 1,
          parentRunId: request.parentRunId,
          turn: request.turn,
          childRunId: delegatedChildRunId(taskRootRunId, record.entries.length + 1),
          task: clampDelegateTask(request.task),
          at: new Date().toISOString(),
        };
        const next: DelegationRecord = { taskRootRunId, entries: [...record.entries, entry] };
        await runtime.config.set(key, JSON.stringify(next), "delegation");
        const ids = readDelegationIndex(await runtime.config.get(DELEGATION_INDEX_KEY));
        if (!ids.includes(taskRootRunId)) {
          await runtime.config.set(DELEGATION_INDEX_KEY, JSON.stringify([...ids, taskRootRunId]), "delegation");
        }
        existing = entry;
      });
      if (existing === undefined) {
        return { ok: false, reason: delegateCapMessage(max) };
      }
      const entry = existing;
      try {
        await enqueueRun(runtime, {
          runId: entry.childRunId,
          task,
          model,
          ...(parentRepo !== undefined ? { repo: parentRepo } : {}),
          // Conversation lineage (task-session.ts): the child threads under
          // the parent, inherits the task root, and shows in the thread view.
          parentRunId: request.parentRunId,
          ...(typeof input.trust === "string" && (input.trust === "operator" || input.trust === "external") ? { trust: input.trust } : {}),
          ...(typeof input.sandboxNetwork === "string" && input.sandboxNetwork !== "" ? { sandboxNetwork: input.sandboxNetwork as NetworkTier } : {}),
          ...(meta?.source !== undefined && meta.source !== "" ? { source: meta.source } : {}),
          ...(meta?.actor !== undefined && meta.actor !== "" && meta.actorKind !== undefined
            ? { actor: { id: meta.actor, kind: meta.actorKind } as Actor }
            : {}),
          // READ-ONLY, ALWAYS (2026-10-17 live finding): the child is a scan,
          // whatever journey the parent is on. A scan edits nothing, pushes
          // nothing and opens no pull request — its publish gate is disabled
          // and its finish deliverable is the findings/answer write-up the
          // parent consumes as the context transfer — and the change-shaped
          // flags (plan, change-class, merge gate, auto-merge) are forced off
          // by the scan resolution below, so the child can never park at a
          // human decision the parent's wait would block behind. The parent
          // remains the only writer and produces the single PR.
          mode: "scan",
          delegateChild: true,
          // The target's harness and model (DT2), with the decision recorded on
          // the child: `runModel` makes the native loop execute on it (DT1)
          // and prices the child on it; for an external harness the gate
          // proved it is the model that harness is configured with.
          ...(target !== undefined ? { harness: target.harness, runModel: target.model, delegateTarget: target } : {}),
          ...(childCap !== undefined ? { maxRunCostUSD: childCap } : {}),
        });
      } catch (error) {
        // The enqueue refused (budget, allowlist): give the claim back so the
        // SAME index is retried, exactly coordination.ts's launchChild revert.
        const message = error instanceof Error ? error.message : String(error);
        await withFileLock(key, async () => {
          const record = parseDelegationRecord(await runtime.config.get(key), taskRootRunId);
          if (record === null) return;
          if (!record.entries.some((e) => e.childRunId === entry.childRunId && e.parentRunId === request.parentRunId && e.turn === request.turn)) return;
          await runtime.config.set(key, JSON.stringify({ taskRootRunId, entries: record.entries.filter((e) => e.childRunId !== entry.childRunId) }), "delegation");
        }).catch(() => {});
        return { ok: false, reason: `delegation refused: the child run could not be enqueued (${message})` };
      }
      if (target !== undefined && targetSegment !== undefined && segments !== undefined) {
        // The routing segment for the child (enforced: this choice is what
        // runs). Evidence, never a dependency: a failed append does not
        // un-spawn a child the ledger and the launch journal already hold.
        await segments
          .append({
            id: `${entry.childRunId}:delegate-target`,
            at: new Date().toISOString(),
            scope: entry.childRunId,
            mode: targetSegment.mode,
            kind: "selection",
            policyVersion: target.policyVersion,
            policyDigest: target.policyDigest,
            actualModel: target.model,
            segment: targetSegment.segment,
            enforced: true,
            note: `delegate target ${target.id} (${target.harness}) spawned by ${request.parentRunId} at turn ${request.turn}`,
          })
          .catch(() => {});
      }
      return { ok: true, childRunId: entry.childRunId };
    },
    async outcome(childRunId) {
      const events = (await runtime.store.load(childRunId)) as Array<{ type: string; data?: unknown }>;
      if (events.length === 0) return null;
      return transferFromEvents(childRunId, events);
    },
  };
}

/** The delegation index: roots with a ledger. Same tolerant shape as coordination.ts's readIndex. */
function readDelegationIndex(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id));
  } catch {
    return [];
  }
}
