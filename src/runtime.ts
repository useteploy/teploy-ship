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
import type { EventStore, RunOutcome, WorkflowDefinition } from "@neutron-build/workflow";

import { defaultRecoveryConfig } from "./recovery.js";
import { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
import type { IntakeStore } from "./intake.js";
import { FileSpendStore, NucleusSpendStore, FileUnpricedRunStore, NucleusUnpricedRunStore, defaultDailyBudgetUSD, estimatedRunCostUSD, utcDay as spendDay } from "./spend.js";
import type { SpendStore, UnpricedRunStore } from "./spend.js";
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
import { harnessAttempts, harnessRef } from "./harness.js";
import type { HarnessRef } from "./harness.js";
import type { EvidenceStore } from "./evidence.js";
import { FileProjectStore, NucleusProjectStore, ProjectEvidenceStore } from "./projects.js";
import type { ProjectStore } from "./projects.js";
import { effectiveAuthority } from "./ladder.js";
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
import { FileUserStore, NucleusUserStore } from "./users.js";
import type { UserStore } from "./users.js";
import { FileDeliveryLog, NucleusDeliveryLog } from "./deliveries.js";
import type { DeliveryLog } from "./deliveries.js";
import type { Actor } from "./actor.js";
import { FileOutbox, NucleusOutbox } from "./outbox.js";
import type { Outbox } from "./outbox.js";
import { NucleusPgwire } from "./nucleus-pgwire.js";
import { migrate } from "./migrations.js";
import { stepFingerprint } from "./step-fingerprint.js";
import { warmCacheEnabled, warmSlugOf } from "./warm.js";
import { assertRepoAllowed, policyFromEnv } from "./repo-policy.js";
import { withProjects } from "./durable.js";
import type { RepoTrust } from "./repo-policy.js";
import type { RecoveryTuning } from "./durable.js";
import type { ProposeInput as IntakeProposeInput, IntakeTask as IntakeTaskType } from "./intake.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import type { RunMeta } from "./run-store.js";

export type { RunMeta } from "./run-store.js";
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
export type { SteerStore, SteerNote } from "./steer.js";
export { FileSteerStore, NucleusSteerStore } from "./steer.js";
export type { DeliveryLog } from "./deliveries.js";
export type { Outbox, OutboxEntry } from "./outbox.js";
export { FileOutbox, NucleusOutbox, flushOutbox, notificationId } from "./outbox.js";
export { FileDeliveryLog, NucleusDeliveryLog, DELIVERY_TTL_S } from "./deliveries.js";
export type { UserStore, ShipUser, UserView, Role } from "./users.js";
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
  reviewTaskFromReviewEvent,
  shipAuthored,
  slackTaskFromMention,
  linearTaskFromIssue,
  ciFixTaskFromWorkflowRun,
} from "./intake-sources.js";
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
  kind: "file" | "nucleus";
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
      trust?: RepoTrust;
      pr?: number;
      plan?: boolean;
      steer?: boolean;
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
  listMeta(options?: { limit?: number }): Promise<RunMeta[]>;
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
  /**
   * Atomically take ownership of the decision a parked run is waiting on.
   * True iff THIS caller won: the run's eventName is cleared as part of the
   * same conditional write, so two operators submitting opposite decisions on
   * the same park cannot both deliver. Losers must not call deliverEvent.
   */
  claimDecision(runId: string, eventName: string): Promise<boolean>;
  /** Put back an eventName after a claim whose delivery then failed. */
  releaseDecision(runId: string, eventName: string): Promise<void>;
  close(): Promise<void>;
}

export function fileRuntime(): ShipRuntime {
  const store = new FileEventStore();
  const meta = new RunMetaStore();
  const projects = new FileProjectStore();
  return {
    kind: "file",
    bulletin: new FileBulletinStore(),
    store,
    intake: new FileIntakeStore(),
    spend: new FileSpendStore(),
    attributedSpend: new FileAttributedSpendStore(),
    unpricedRuns: new FileUnpricedRunStore(),
    policies: new FilePolicyStore(),
    projects,
    evidence: new ProjectEvidenceStore(projects, new FileEvidenceStore()),
    config: new FileRuntimeConfig(),
    connectRequests: new FileConnectRequests(),
    akirooCursor: new FileAkirooCursor(),
    governance: new FileGovernanceStore(),
    fleet: new FileFleetStore(),
    placement: new FilePlacementStore(),
    memory: new FileRepoMemory(),
    steer: new FileSteerStore(),
    users: new FileUserStore(),
    deliveries: new FileDeliveryLog(),
    outbox: new FileOutbox(),
    repoStats: new FileRepoStatsStore(),
    // File mode is single-process by construction, so read-check-write is the
    // honest implementation; the Nucleus path below is the real atomic one.
    claimDecision: async (runId, eventName) => {
      const current = await meta.load(runId);
      if (current === null || current.eventName !== eventName) return false;
      const { eventName: _drop, ...rest } = current;
      await meta.save({ ...rest, updatedAt: new Date().toISOString() });
      return true;
    },
    releaseDecision: async (runId, eventName) => {
      const current = await meta.load(runId);
      if (current === null) return;
      await meta.save({ ...current, eventName, updatedAt: new Date().toISOString() });
    },
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
  options?: { log?: (line: string) => void },
): Promise<NucleusShipRuntime> {
  const db = new NucleusPgwire(url, owner);
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
  return {
    kind: "nucleus",
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
    evidence: new ProjectEvidenceStore(projects, new NucleusEvidenceStore(db)),
    config: new NucleusRuntimeConfig(db),
    connectRequests: new NucleusConnectRequests(db),
    akirooCursor: new NucleusAkirooCursor(db),
    governance: new NucleusGovernanceStore(db),
    fleet: new NucleusFleetStore(db),
    placement: new NucleusPlacementStore(db),
    memory: new NucleusRepoMemory(db),
    steer: new NucleusSteerStore(db),
    users: new NucleusUserStore(db),
    deliveries: new NucleusDeliveryLog(db),
    outbox: new NucleusOutbox(db),
    repoStats: new NucleusRepoStatsStore(db),
    /**
     * One conditional UPDATE decides the winner: the filter includes the
     * eventName the caller believes is parked, so a stale tab (or a second
     * admin) updates zero rows and is told to look again. Clearing eventName
     * in the same statement is what makes it a claim rather than a check.
     */
    async claimDecision(runId, eventName) {
      const updated = await db.document.update(
        META_COLLECTION,
        { runId, eventName },
        { eventName: null, status: "wake", updatedAt: new Date().toISOString() },
      );
      return updated > 0;
    },
    async releaseDecision(runId, eventName) {
      await db.document.update(META_COLLECTION, { runId }, { eventName, status: "waiting" });
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
    async listMeta(options) {
      const limit = Math.max(1, Math.trunc(options?.limit ?? DEFAULT_LIST_LIMIT));
      const docs = await db.document.find(META_COLLECTION, {});
      const records = await db.document.find("ship_runs", {});
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
  options: { runId: string; source?: string; repo?: string; now?: Date },
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
  if (!(budget > 0)) return; // <= 0 disables the cap for that source, as in the worker

  const day = spendDay(options.now ?? new Date());
  const estimate = estimatedRunCostUSD();
  // Reserve BEFORE reading the total, exactly as the sweep does: two surfaces
  // admitting at once must see each other's commitment rather than both reading
  // the same room. Over-reserving briefly is the safe direction.
  await spend.reserve(options.runId, source, day, estimate);
  const committed = await spend.get(source, day);
  if (committed > budget) {
    await spend.release(options.runId).catch(() => {});
    throw new DailyBudgetExceededError(source, budget, committed);
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
    const project = await runtime.projects.forRepo(repo).catch(() => null);
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
export async function enqueueRun(
  runtime: ShipRuntime,
  options: {
    runId: string;
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
  },
): Promise<void> {
  const now = new Date().toISOString();
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
  const scan = options.mode === "scan";
  const recoveryFlag = options.recovery ?? (envFlag("SHIP_RECOVERY") ? true : undefined);
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
  // Deploy the pushed branch to a preview environment and link it on the PR.
  // Opt-in for the same reason as the three above: it adds recorded steps, so
  // turning it on must never change how an already-enqueued run replays. The
  // executing worker's config decides whether a preview can actually happen —
  // this only records that the run asked. A project that declares a preview
  // rung (C4) asks by that declaration.
  const preview = scan ? undefined : (options.preview ?? (envFlag("SHIP_PREVIEW") || project?.verification?.preview !== undefined ? true : undefined));
  // Read the affected service's telemetry around the change. Same opt-in shape.
  const telemetry = scan ? undefined : (options.telemetry ?? (evidence?.observeService !== undefined || envFlag("SHIP_TELEMETRY") ? true : undefined));
  // Run the project's suite after the agent stops. Same opt-in shape.
  const tests = scan ? undefined : (options.tests ?? (evidence?.testCommand !== undefined || envFlag("SHIP_TESTS") ? true : undefined));
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
  const harness = harnessRef(options.harness ?? project?.harness ?? process.env.SHIP_HARNESS);
  // Multi-harness attempts (P5-4): repo runs only, two or more ids, off unless
  // SHIP_HARNESS_ATTEMPTS says so. Materialised like everything else here.
  // Not on a scan: N harnesses producing N sets of findings is N times the
  // cost for an answer the critic picks between on the strength of a DIFF,
  // which a scan does not have.
  const attempts = options.repo !== undefined && !scan ? harnessAttempts(process.env.SHIP_HARNESS_ATTEMPTS) : [];
  // Required reviewers for this repo (governance.ts), resolved HERE for the
  // same reason as evidence: it adds a recorded step (`repo-reviewers`), so
  // its presence must be a function of the recorded input, and the rule is
  // editable, so a replay must request the reviewers the log was written
  // under. Absent on runs enqueued before the rule existed.
  const reviewers = options.repo !== undefined ? reviewersFor((await runtime.governance.get()).reviewers, options.repo) : null;
  // Warm cache eligibility: a repo run with a cacheable origin, never a PR
  // run (its checkout resolves a head branch that may live in a fork, so the
  // volume would not be the repository's steady state).
  const warmRun =
    options.repo !== undefined && options.pr === undefined && warmCacheEnabled() && warmSlugOf(options.repo) !== null;
  // The spend cap, checked BEFORE the run exists. Order matters: a refusal
  // after `store.append` would leave a `run-started` event for a run no worker
  // is allowed to execute — a ghost in the runs list that no surface can
  // explain. Throwing here means the caller's enqueue simply did not happen.
  await assertDailyBudget(runtime, {
    runId: options.runId,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
  });
  // Hoisted out of the append below so the upgrade fence can fingerprint the
  // exact object the log will carry, rather than a reconstruction of it.
  const input = {
        task: options.task,
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
        ...(options.repo !== undefined ? { trust: options.trust ?? "external" } : {}),
        ...(options.pr !== undefined ? { pr: options.pr } : {}),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
        // Both suppressed on a scan: the plan park asks an operator to approve
        // work that will not happen, and the critic reviews a diff there is none of.
        ...(options.plan === true && !scan ? { plan: true } : {}),
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
        ...(telemetry === true ? { telemetry: true } : {}),
        ...(tests === true ? { tests: true } : {}),
        ...(testsFeedback === true ? { testsFeedback: true } : {}),
        ...(fixRetries !== undefined ? { fixRetries } : {}),
        ...(criticAdvisory === true ? { criticAdvisory: true } : {}),
        ...(changeClass === true ? { changeClass: true } : {}),
        ...(mergeGate === true ? { mergeGate: true } : {}),
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
        ...(evidence?.observeService !== undefined ? { observeRepo: evidence.repo } : {}),
        ...(reviewers !== null ? { reviewers: { users: reviewers.users, teams: reviewers.teams } } : {}),
        ...(project?.sandboxImage !== undefined ? { sandboxImage: project.sandboxImage } : {}),
        ...(project?.sandboxNetwork !== undefined ? { sandboxNetwork: project.sandboxNetwork } : {}),
        ...(project?.sandboxLimits !== undefined ? { sandboxLimits: project.sandboxLimits } : {}),
        // Every newly-enqueued run is steerable and index-eligible; runs
        // enqueued before these flags existed replay without the extra
        // steps (input-gated in durable). The executing worker's config
        // decides whether indexing actually happens.
        steer: true,
        index: true,
        guard: true,
        // The warm repo cache (SB-A). Repo runs that are not PR runs, on
        // unless SHIP_WARM_CACHE says otherwise, and materialised HERE for
        // the usual reason — it adds a recorded step and asks the daemon for
        // a volume, so the log has to say the run wanted one. A worker whose
        // daemon has no cache store degrades to the cold path.
        ...(warmRun ? { warm: true } : {}),
        harness,
        ...(attempts.length >= 2 ? { harnessAttempts: attempts } : {}),
  };
  await runtime.store.append(options.runId, {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: now,
    data: {
      workflow: options.workflowName ?? "coding-agent",
      input,
      // The upgrade fence (step-fingerprint.ts): what step sequence the build
      // that enqueued this run would replay it through. A SIBLING of `input`,
      // never a field inside it — the recorded input is what gates step
      // presence, so a fingerprint stored there would change how in-flight
      // runs replay and could cause the exact failure it exists to prevent.
      // The engine reads `workflow` and `input` and ignores everything else on
      // this event, so this key is inert to replay.
      stepFingerprint: stepFingerprint(input),
    },
  });
  await runtime.saveMeta({
    runId: options.runId,
    task: options.task,
    model: options.model,
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
  });
  // markWake only updates an existing index record; a freshly enqueued
  // run has none, so the scheduler would never see it. record() is the
  // insert-or-update path — "wake" makes the run due immediately.
  if (runtime.kind === "nucleus") {
    const nucleus = runtime as NucleusShipRuntime;
    await nucleus.index.record(
      options.runId,
      options.workflowName ?? "coding-agent",
      { status: "wake" } as unknown as RunOutcome,
    );
  }
}
