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
import { FileSpendStore, NucleusSpendStore } from "./spend.js";
import type { SpendStore } from "./spend.js";
import { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
import type { PolicyStore } from "./policies.js";
import { FileEvidenceStore, NucleusEvidenceStore } from "./evidence.js";
import type { EvidenceStore } from "./evidence.js";
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
import { assertRepoAllowed } from "./repo-policy.js";
import type { RepoTrust } from "./repo-policy.js";
import type { RecoveryTuning } from "./durable.js";
import type { ProposeInput as IntakeProposeInput, IntakeTask as IntakeTaskType } from "./intake.js";
import { FileEventStore, RunMetaStore } from "./run-store.js";
import type { RunMeta } from "./run-store.js";

export type { RunMeta } from "./run-store.js";
export type { IntakeStore, IntakeTask, ProposeInput } from "./intake.js";
export { FileIntakeStore, NucleusIntakeStore } from "./intake.js";
export type { SpendStore, SpendEntry } from "./spend.js";
export { FileSpendStore, NucleusSpendStore, utcDay } from "./spend.js";
export type { PolicyStore, SourcePolicy } from "./policies.js";
export { FilePolicyStore, NucleusPolicyStore } from "./policies.js";
export type { EvidenceStore, RepoEvidence } from "./evidence.js";
export { FileEvidenceStore, NucleusEvidenceStore } from "./evidence.js";
export type { AttributedSpendStore, AttributedSpendEntry, SpendDimension } from "./attributed-spend.js";
export { FileAttributedSpendStore, NucleusAttributedSpendStore } from "./attributed-spend.js";
export type { FleetStore, WorkerInfo, PlacementStore } from "./fleet.js";
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
export { parseRepoToken, requesterOf, slackTaskFromMention, linearTaskFromIssue, ciFixTaskFromWorkflowRun } from "./intake-sources.js";
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
export { PLAN_EVENT } from "./plan.js";
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
      testCommand?: string;
      testTimeoutMs?: number;
      observeService?: string;
      observeRepo?: string;
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
  /** Editable per-source intake policies (dashboard-managed, env-seeded). */
  policies: PolicyStore;
  /** Per-repo evidence config (test command, Observe service). See evidence.ts. */
  evidence: EvidenceStore;
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
  return {
    kind: "file",
    store,
    intake: new FileIntakeStore(),
    spend: new FileSpendStore(),
    attributedSpend: new FileAttributedSpendStore(),
    policies: new FilePolicyStore(),
    evidence: new FileEvidenceStore(),
    fleet: new FileFleetStore(),
    placement: new FilePlacementStore(),
    memory: new FileRepoMemory(),
    steer: new FileSteerStore(),
    users: new FileUserStore(),
    deliveries: new FileDeliveryLog(),
    outbox: new FileOutbox(),
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

  return {
    kind: "nucleus",
    store,
    index,
    leases,
    owner,
    db,
    intake: new NucleusIntakeStore(db),
    spend: new NucleusSpendStore(db),
    attributedSpend: new NucleusAttributedSpendStore(db),
    policies: new NucleusPolicyStore(db),
    evidence: new NucleusEvidenceStore(db),
    fleet: new NucleusFleetStore(db),
    placement: new NucleusPlacementStore(db),
    memory: new NucleusRepoMemory(db),
    steer: new NucleusSteerStore(db),
    users: new NucleusUserStore(db),
    deliveries: new NucleusDeliveryLog(db),
    outbox: new NucleusOutbox(db),
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
  runtime: Pick<ShipRuntime, "intake">,
  input: IntakeProposeInput,
): Promise<{ created: boolean; task: IntakeTaskType }> {
  if (input.repo !== undefined && input.repo !== "") {
    assertRepoAllowed(input.repo, { trust: "external" });
  }
  return runtime.intake.propose(input);
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
    workflowName?: string;
    /** Intake source, recorded so completion can settle spend against it. */
    source?: string;
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
  const recoveryFlag = options.recovery ?? (envFlag("SHIP_RECOVERY") ? true : undefined);
  const recovery =
    recoveryFlag === true ? { ...defaultRecoveryConfig } : recoveryFlag;
  const settle = options.settle ?? (envFlag("SHIP_SETTLE") ? true : undefined);
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
  const requireEdit = options.requireEdit ?? (envFlagOff("SHIP_REQUIRE_EDIT") ? false : true);
  // Deploy the pushed branch to a preview environment and link it on the PR.
  // Opt-in for the same reason as the three above: it adds recorded steps, so
  // turning it on must never change how an already-enqueued run replays. The
  // executing worker's config decides whether a preview can actually happen —
  // this only records that the run asked.
  const preview = options.preview ?? (envFlag("SHIP_PREVIEW") ? true : undefined);
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
  // Read the affected service's telemetry around the change. Same opt-in shape.
  const telemetry = options.telemetry ?? (evidence?.observeService !== undefined || envFlag("SHIP_TELEMETRY") ? true : undefined);
  // Run the project's suite after the agent stops. Same opt-in shape.
  const tests = options.tests ?? (evidence?.testCommand !== undefined || envFlag("SHIP_TESTS") ? true : undefined);
  await runtime.store.append(options.runId, {
    v: WIRE_FORMAT_VERSION,
    seq: 0,
    type: "run-started",
    at: now,
    data: {
      workflow: options.workflowName ?? "coding-agent",
      input: {
        task: options.task,
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
        ...(options.repo !== undefined ? { trust: options.trust ?? "external" } : {}),
        ...(options.pr !== undefined ? { pr: options.pr } : {}),
        ...(options.plan === true ? { plan: true } : {}),
        ...(options.critic === true ? { critic: true } : {}),
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
        // Per-repo evidence values (see the resolution above). Absent on runs
        // enqueued before this existed, which replay and fall back to the
        // worker's env wiring exactly as before.
        ...(evidence?.testCommand !== undefined ? { testCommand: evidence.testCommand } : {}),
        ...(evidence?.testTimeoutMs !== undefined ? { testTimeoutMs: evidence.testTimeoutMs } : {}),
        ...(evidence?.observeService !== undefined ? { observeService: evidence.observeService } : {}),
        ...(evidence?.observeService !== undefined ? { observeRepo: evidence.repo } : {}),
        // Every newly-enqueued run is steerable and index-eligible; runs
        // enqueued before these flags existed replay without the extra
        // steps (input-gated in durable). The executing worker's config
        // decides whether indexing actually happens.
        steer: true,
        index: true,
        guard: true,
      },
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
