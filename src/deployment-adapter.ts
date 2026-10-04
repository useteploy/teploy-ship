/**
 * Deployment and telemetry adapter contract (S27): what a delivery journey
 * needs from a deployment system, stated without Teploy's types, plus the
 * provider-blind orchestration that enforces the invariants and a conformance
 * suite any adapter can run against itself.
 *
 * WHY a contract and not an interface alone. delivery.ts already holds the
 * hard-won rules for Teploy (read the target back, never trust an exit code;
 * unreadable is unknown, never failed; a rollback must not undo a newer
 * delivery; "previous" is not a recovery target). Every one of those was found
 * live, once. An adapter for another CI/CD or Kubernetes system must not have
 * to rediscover them, and Ship must not trust an adapter to have done so. So
 * the rules live in `runDeliveryJourney` / `runRecovery` / `runProvisioning`
 * (provider-blind, they only see the adapter's answers) and `conformanceSuite`
 * checks the adapter's own answers against an independent ground truth.
 *
 * Three result shapes, never collapsed: `ok`, `unknown` (a first-class answer:
 * "I could not tell"), `refused` (a deliberate no). An adapter that cannot read
 * must say `unknown`; the orchestrator never turns unknown into success,
 * failure or "not deployed".
 *
 * Nothing here deploys anything or touches delivery.ts. The Teploy mapping at
 * the bottom is documentation-as-data of how the native implementation would
 * fill the contract and where it does not yet.
 */

// ------------------------------------------------------------------ results

export interface Ok<T> { kind: "ok"; value: T }
/** "I could not tell." Never an error to retry blindly, never a pass. */
export interface Unknown { kind: "unknown"; reason: string }
export interface Refused { kind: "refused"; reason: string }
export type AdapterResult<T> = Ok<T> | Unknown | Refused;

export const ok = <T>(value: T): Ok<T> => ({ kind: "ok", value });
export const unknown = (reason: string): Unknown => ({ kind: "unknown", reason });
export const refused = (reason: string): Refused => ({ kind: "refused", reason });

// ------------------------------------------------------------------ identity

/** What is being delivered TO: attribution is a property of every answer. */
export interface TargetRef { service: string; destination: string }

/** The approved tuple the journey must prove, never a branch or tag alone. */
export interface DeliveryIdentity extends TargetRef {
  /** Immutable artifact identity (image digest, build id). */
  artifact: string;
  /** Source revision the artifact was built from / version the target reports. */
  revision: string;
}

/**
 * What a target reports. `generation` is an opaque token that MUST change
 * whenever the target's served release changes by any hand — it is the fence.
 */
export interface TargetState extends TargetRef {
  serving: boolean;
  revision?: string;
  artifact?: string;
  generation: string;
}

export type RecoveryMode = "rollback-to-version" | "redeploy-previous-artifact" | "roll-forward";
export type FencingMode = "compare-and-set" | "lease";

export interface AdapterCapabilities {
  adapter: string;
  /** Can the target be read back with artifact + revision identity? */
  readback: boolean;
  logs: boolean;
  observe: boolean;
  /** plan() is a provider-side validation (server-side dry-run), not just a description. */
  dryRun: boolean;
  provisioning: boolean;
  /** At least one is required to deploy; the orchestrator refuses an unfenced adapter. */
  fencing: readonly FencingMode[];
  /** Recovery modes actually supported. Anything else must be refused, never approximated. */
  recovery: readonly RecoveryMode[];
  /**
   * What this adapter knows it cannot honestly provide, stated so a report can
   * list it (an adapter that cannot do X must say so, never approximate X).
   * Additive and optional: adapters that predate it declare nothing.
   */
  unsupported?: readonly { capability: string; reason: string }[];
}

// ------------------------------------------------------------------ authority

/** A grant is for ONE kind, ONE service, ONE destination. Deploy authority never provisions. */
export interface Authorisation {
  kind: "deploy" | "recover" | "provision";
  actor: string;
  service: string;
  destination: string;
  /** ISO time; absent means no expiry (callers should set one). */
  expiresAt?: string;
}

export function authorisationCovers(
  auth: Authorisation | undefined,
  kind: Authorisation["kind"],
  target: TargetRef,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (auth === undefined) return { ok: false, reason: `no ${kind} authorisation supplied` };
  if (auth.kind !== kind) return { ok: false, reason: `the authorisation is for ${auth.kind}, not ${kind}` };
  if (auth.actor.trim() === "") return { ok: false, reason: "the authorisation names no actor" };
  if (auth.service !== target.service || auth.destination !== target.destination) {
    return { ok: false, reason: `the authorisation covers ${auth.service}@${auth.destination}, not ${target.service}@${target.destination}` };
  }
  if (auth.expiresAt !== undefined) {
    const t = Date.parse(auth.expiresAt);
    if (!Number.isFinite(t)) return { ok: false, reason: "the authorisation expiry is unreadable" };
    if (t <= now.getTime()) return { ok: false, reason: "the authorisation has expired" };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ operations

export interface DeliveryPlan {
  planId: string;
  identity: DeliveryIdentity;
  /** The target state the plan was made against; the deploy is conditional on it. */
  baseline: { generation: string; revision?: string; artifact?: string };
  steps: string[];
  /** True only when the provider itself validated the plan without acting. */
  validatedByProvider: boolean;
}

/**
 * `applied` means the target converged on the plan; `rejected` means NOTHING
 * changed; `partial` means something changed but not all; `indeterminate`
 * means the adapter cannot say. `stale-generation` is the compare-and-set
 * refusal. The orchestrator verifies all of these by reading back.
 */
export interface DeployReceipt {
  outcome: "applied" | "rejected" | "partial" | "indeterminate";
  rejection?: "stale-generation" | "unauthorised" | "other";
  detail: string;
}

export interface Lease { target: TargetRef; token: string; holder: string }

export interface DeployInput {
  plan: DeliveryPlan;
  authorisation: Authorisation;
  /** Compare-and-set: refuse (rejected/stale-generation) if the target generation differs. */
  expectGeneration: string;
  lease?: Lease;
}

export interface RecoveryPlan {
  mode: RecoveryMode;
  target: TargetRef;
  /** The delivery being recovered from. */
  delivered: DeliveryIdentity;
  /** The retained release to restore. Explicit; "previous" is not a target. */
  to: { revision: string; artifact?: string };
  /** The generation observed when this plan was made. */
  baselineGeneration: string;
  madeAt: string;
}

export interface RecoverInput {
  plan: RecoveryPlan;
  authorisation: Authorisation;
  expectGeneration: string;
  lease?: Lease;
}

export interface HealthReading {
  service: string;
  health: "healthy" | "degraded" | "unknown";
  reason: string;
}

export interface LogReading { service: string; lines: string[] }

export interface DeploymentAdapter {
  capabilities(): AdapterCapabilities;
  /** Describe the target and its generation. */
  inspect(target: TargetRef): Promise<AdapterResult<TargetState>>;
  /** Side-effect-free. Must bind the plan to the requested identity and the inspected baseline. */
  plan(identity: DeliveryIdentity, baseline: TargetState): Promise<AdapterResult<DeliveryPlan>>;
  /** The authorised act. Conditional on `expectGeneration`. */
  deploy(input: DeployInput): Promise<DeployReceipt>;
  /** What the target is serving NOW, read from the target, not from the deploy command. */
  readback(target: TargetRef): Promise<AdapterResult<TargetState>>;
  /** Recovery: must refuse any mode not declared in capabilities. */
  recover(input: RecoverInput): Promise<DeployReceipt>;
  observe?(target: TargetRef): Promise<AdapterResult<HealthReading>>;
  logs?(target: TargetRef, limit: number): Promise<AdapterResult<LogReading>>;
  acquireLease?(target: TargetRef, holder: string): Promise<AdapterResult<Lease>>;
  releaseLease?(lease: Lease): Promise<void>;
}

/** Every operation the contract names, for mapping/coverage checks. */
export const ADAPTER_OPERATIONS = [
  "capabilities", "inspect", "plan", "deploy", "readback", "recover", "observe", "logs", "acquireLease", "releaseLease",
] as const;

// ------------------------------------------------------------------ serialisation

/** In-process per-destination serialisation. Cross-process fencing is the adapter's (CAS/lease). */
export class DestinationLocks {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
const sharedLocks = new DestinationLocks();
const lockKey = (t: TargetRef): string => `${t.service}@${t.destination}`;

// ------------------------------------------------------------------ helpers

const sameTarget = (a: TargetRef, b: TargetRef): boolean => a.service === b.service && a.destination === b.destination;

/** Adapters may throw; the orchestrator treats a throw as `unknown`, never as a result. */
async function guarded<T>(label: string, fn: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return unknown(`${label} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Matches =
  | { kind: "match" }
  | { kind: "wrong-target"; reason: string }
  | { kind: "mismatch"; reason: string }
  | { kind: "opaque"; reason: string };

/** The approved-identity comparison. Both halves of the pair must be VISIBLE and equal. */
export function compareToIdentity(state: TargetState, identity: DeliveryIdentity): Matches {
  if (!sameTarget(state, identity)) {
    return { kind: "wrong-target", reason: `the readback describes ${state.service}@${state.destination}, not ${identity.service}@${identity.destination}` };
  }
  if (!state.serving) return { kind: "mismatch", reason: "the target is readable and serves nothing" };
  if (state.revision === undefined || state.artifact === undefined) {
    return { kind: "opaque", reason: "the readback did not expose both revision and artifact identity" };
  }
  if (state.revision !== identity.revision || state.artifact !== identity.artifact) {
    return { kind: "mismatch", reason: `the target serves revision ${state.revision} / artifact ${state.artifact}, not the approved ${identity.revision} / ${identity.artifact}` };
  }
  return { kind: "match" };
}

// ------------------------------------------------------------------ delivery journey

export interface JourneyRequest {
  identity: DeliveryIdentity;
  authorisation: Authorisation | undefined;
  /** Inspect and plan only; never calls deploy. */
  dryRun?: boolean;
  /** Deploy even though the adapter cannot read back; the outcome is then `unknown`, never `confirmed`. */
  allowUnverifiable?: boolean;
  now?: () => Date;
  locks?: DestinationLocks;
  holder?: string;
}

export type JourneyOutcome = "planned" | "confirmed" | "held" | "unknown" | "failed";

export interface JourneyResult {
  outcome: JourneyOutcome;
  /** True once deploy() was invoked. Held with acted=false means the target was not touched. */
  acted: boolean;
  reason: string;
  steps: string[];
  baseline?: TargetState;
  plan?: DeliveryPlan;
  observed?: TargetState;
  health?: HealthReading;
  logs?: LogReading;
}

/**
 * The release journey with the provider's invariants enforced from outside:
 * authority, fence, plan bound to identity, act, READ BACK. `confirmed` is
 * reachable only through a readback matching the approved identity exactly.
 */
export async function runDeliveryJourney(adapter: DeploymentAdapter, request: JourneyRequest): Promise<JourneyResult> {
  const locks = request.locks ?? sharedLocks;
  return locks.run(lockKey(request.identity), () => journey(adapter, request));
}

async function journey(adapter: DeploymentAdapter, request: JourneyRequest): Promise<JourneyResult> {
  const { identity } = request;
  const now = request.now ?? (() => new Date());
  const steps: string[] = [];
  const result = (outcome: JourneyOutcome, reason: string, acted: boolean, extra: Partial<JourneyResult> = {}): JourneyResult =>
    ({ outcome, acted, reason, steps, ...extra });
  const caps = adapter.capabilities();

  const authority = authorisationCovers(request.authorisation, "deploy", identity, now());
  if (!authority.ok) return result("held", authority.reason, false);
  const auth = request.authorisation!;
  if (caps.fencing.length === 0) {
    return result("held", `${caps.adapter} declares no fencing (compare-and-set or lease); a competing release could not be refused`, false);
  }
  if (!caps.readback && request.allowUnverifiable !== true && request.dryRun !== true) {
    return result("held", `${caps.adapter} cannot read the target back, so success could never be asserted; refusing to act unverifiably`, false);
  }

  let lease: Lease | undefined;
  if (caps.fencing.includes("lease") && adapter.acquireLease !== undefined) {
    const got = await guarded("acquireLease", () => adapter.acquireLease!(identity, request.holder ?? auth.actor));
    steps.push("lease");
    if (got.kind !== "ok") return result("held", `another release may hold ${identity.service}@${identity.destination}: ${got.reason}`, false);
    lease = got.value;
  }
  try {
    return await withLease(adapter, request, auth, caps, steps, result, lease);
  } finally {
    if (lease !== undefined && adapter.releaseLease !== undefined) {
      try { await adapter.releaseLease(lease); } catch { /* a lease that expires is the adapter's TTL */ }
    }
  }
}

async function withLease(
  adapter: DeploymentAdapter,
  request: JourneyRequest,
  auth: Authorisation,
  caps: AdapterCapabilities,
  steps: string[],
  result: (o: JourneyOutcome, r: string, acted: boolean, e?: Partial<JourneyResult>) => JourneyResult,
  lease: Lease | undefined,
): Promise<JourneyResult> {
  const { identity } = request;

  const inspected = await guarded("inspect", () => adapter.inspect(identity));
  steps.push("inspect");
  if (inspected.kind !== "ok") return result("held", `the target could not be inspected (${inspected.reason}); never act on an unread target`, false);
  const baseline = inspected.value;
  if (!sameTarget(baseline, identity)) {
    return result("held", `the inspection describes ${baseline.service}@${baseline.destination}, not ${identity.service}@${identity.destination}; wrong-service attribution refused`, false, { baseline });
  }

  const planned = await guarded("plan", () => adapter.plan(identity, baseline));
  steps.push("plan");
  if (planned.kind !== "ok") return result("held", `no plan: ${planned.reason}`, false, { baseline });
  const plan = planned.value;
  if (plan.identity.service !== identity.service || plan.identity.destination !== identity.destination ||
      plan.identity.artifact !== identity.artifact || plan.identity.revision !== identity.revision) {
    return result("held", "the plan is for a different identity than the one approved", false, { baseline, plan });
  }
  if (plan.baseline.generation !== baseline.generation) {
    return result("held", "the plan was made against a different target generation than was inspected", false, { baseline, plan });
  }
  if (request.dryRun === true) {
    return result("planned", plan.validatedByProvider ? "plan validated by the provider; nothing was changed" : "plan made without provider validation; nothing was changed", false, { baseline, plan });
  }

  // Orchestrator-side pre-check: narrows the race window; the adapter's
  // compare-and-set closes it.
  const again = await guarded("inspect", () => adapter.inspect(identity));
  steps.push("re-inspect");
  if (again.kind !== "ok") return result("held", `the target could not be re-read before acting (${again.reason})`, false, { baseline, plan });
  if (again.value.generation !== baseline.generation) {
    return result("held", "the target changed after the plan was made (racing release or out-of-band change); re-plan required", false, { baseline, plan, observed: again.value });
  }

  let receipt: DeployReceipt;
  steps.push("deploy");
  try {
    receipt = await adapter.deploy({ plan, authorisation: auth, expectGeneration: baseline.generation, ...(lease !== undefined ? { lease } : {}) });
  } catch (error) {
    receipt = { outcome: "indeterminate", detail: `deploy threw: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (receipt.outcome === "rejected" && (receipt.rejection === "stale-generation" || receipt.rejection === "unauthorised")) {
    // Refused by the fence or the authority: still verify nothing moved.
    const check = await guarded("readback", () => adapter.readback(identity));
    steps.push("readback");
    const moved = check.kind === "ok" && check.value.generation !== baseline.generation;
    return result("held", `deploy refused (${receipt.rejection}): ${receipt.detail}${moved ? "; the target changed meanwhile (not by this release)" : ""}`, true, { baseline, plan, ...(check.kind === "ok" ? { observed: check.value } : {}) });
  }

  if (!caps.readback) {
    return result("unknown", `deploy receipt ${receipt.outcome}; the adapter cannot read back, so the outcome is unverified`, true, { baseline, plan });
  }
  const read = await guarded("readback", () => adapter.readback(identity));
  steps.push("readback");
  if (read.kind !== "ok") {
    return result("unknown", `deploy receipt ${receipt.outcome} but the target could not be read back (${read.reason}); unknown never records as failed or confirmed`, true, { baseline, plan, ...(await logsFor(adapter, caps, identity)) });
  }
  const observed = read.value;
  const verdict = compareToIdentity(observed, identity);
  if (verdict.kind === "match") {
    const health = await healthFor(adapter, caps, identity);
    return result("confirmed", `target read back on the approved identity (deploy receipt: ${receipt.outcome})`, true, { baseline, plan, observed, health });
  }
  if (verdict.kind === "opaque") {
    return result("unknown", verdict.reason, true, { baseline, plan, observed });
  }
  if (receipt.outcome === "rejected" && observed.generation === baseline.generation) {
    return result("failed", `deploy rejected (${receipt.detail}); the target is readable and unchanged`, true, { baseline, plan, observed, ...(await logsFor(adapter, caps, identity)) });
  }
  const why = receipt.outcome === "rejected" ? "adapter reported rejected but the target changed" : `receipt ${receipt.outcome}`;
  return result("held", `${verdict.reason} (${why}); hold for a human, nothing is approximated as success`, true, { baseline, plan, observed, ...(await logsFor(adapter, caps, identity)) });
}

async function healthFor(adapter: DeploymentAdapter, caps: AdapterCapabilities, target: TargetRef): Promise<HealthReading> {
  if (!caps.observe || adapter.observe === undefined) return { service: target.service, health: "unknown", reason: "the adapter declares no telemetry" };
  const got = await guarded("observe", () => adapter.observe!(target));
  if (got.kind !== "ok") return { service: target.service, health: "unknown", reason: got.reason };
  if (got.value.service !== target.service) {
    // The wrong-service guard (incidents.ts): never attach another service's RED metrics.
    return { service: target.service, health: "unknown", reason: `telemetry answered for ${got.value.service}, not ${target.service}; discarded` };
  }
  return got.value;
}

async function logsFor(adapter: DeploymentAdapter, caps: AdapterCapabilities, target: TargetRef): Promise<{ logs?: LogReading }> {
  if (!caps.logs || adapter.logs === undefined) return {};
  const got = await guarded("logs", () => adapter.logs!(target, 20));
  if (got.kind !== "ok" || got.value.service !== target.service) return {};
  return { logs: got.value };
}

// ------------------------------------------------------------------ recovery

/** Make a recovery plan against the target as it stands, bound to what it serves. */
export async function makeRecoveryPlan(
  adapter: DeploymentAdapter,
  delivered: DeliveryIdentity,
  mode: RecoveryMode,
  to: RecoveryPlan["to"],
  now: () => Date = () => new Date(),
): Promise<AdapterResult<RecoveryPlan>> {
  if (to.revision.trim() === "") return refused("recovery needs an explicit retained revision; \"previous\" is not a stable recovery target");
  const read = await guarded("readback", () => adapter.readback(delivered));
  if (read.kind !== "ok") return read;
  const verdict = compareToIdentity(read.value, delivered);
  if (verdict.kind !== "match") return refused(`the target is not serving the delivery to recover from: ${verdict.reason}`);
  return ok({ mode, target: { service: delivered.service, destination: delivered.destination }, delivered, to, baselineGeneration: read.value.generation, madeAt: now().toISOString() });
}

export type RecoveryOutcome = "recovered" | "held" | "unknown" | "failed";
export interface RecoveryResult {
  outcome: RecoveryOutcome;
  acted: boolean;
  reason: string;
  observed?: TargetState;
  /** Which identity halves the readback was checked against. */
  verifiedAgainst: ("revision" | "artifact")[];
}

export interface RecoveryRequest {
  plan: RecoveryPlan;
  authorisation: Authorisation | undefined;
  now?: () => Date;
  locks?: DestinationLocks;
}

/**
 * Supported recovery only. Refuses when the mode is not declared (never
 * substituting another mode), when authority does not cover it, or when the
 * target changed since the plan was made (rolling back would also undo
 * whatever replaced the delivery).
 */
export async function runRecovery(adapter: DeploymentAdapter, request: RecoveryRequest): Promise<RecoveryResult> {
  const locks = request.locks ?? sharedLocks;
  return locks.run(lockKey(request.plan.target), () => recovery(adapter, request));
}

async function recovery(adapter: DeploymentAdapter, request: RecoveryRequest): Promise<RecoveryResult> {
  const { plan } = request;
  const now = request.now ?? (() => new Date());
  const caps = adapter.capabilities();
  const out = (outcome: RecoveryOutcome, reason: string, acted: boolean, observed?: TargetState): RecoveryResult => ({
    outcome, acted, reason, verifiedAgainst: plan.to.artifact !== undefined ? ["revision", "artifact"] : ["revision"], ...(observed !== undefined ? { observed } : {}),
  });

  if (!caps.recovery.includes(plan.mode)) {
    return out("held", `${caps.adapter} does not support recovery mode ${plan.mode} (supports: ${caps.recovery.join(", ") || "none"}); refusing rather than approximating`, false);
  }
  const authority = authorisationCovers(request.authorisation, "recover", plan.target, now());
  if (!authority.ok) return out("held", authority.reason, false);
  if (!caps.readback) return out("held", `${caps.adapter} cannot read back; recovery could not be verified`, false);
  if (caps.fencing.length === 0) return out("held", `${caps.adapter} declares no fencing`, false);

  const before = await guarded("readback", () => adapter.readback(plan.target));
  if (before.kind !== "ok") return out("held", `the target could not be read before recovery (${before.reason}); refusing to act on an unread target`, false);
  const state = before.value;
  if (!sameTarget(state, plan.target)) return out("held", "the pre-recovery readback describes a different service; wrong-service attribution refused", false, state);
  const onRecovery = (s: TargetState): boolean =>
    s.serving && s.revision === plan.to.revision && (plan.to.artifact === undefined || s.artifact === plan.to.artifact);
  if (onRecovery(state)) return out("recovered", "the target already serves the retained release; no recovery command was needed", false, state);
  if (state.generation !== plan.baselineGeneration) {
    return out("held", "the target changed since the recovery plan was made (out-of-band or newer delivery); recovery would also undo it, re-plan from what is serving", false, state);
  }
  const verdict = compareToIdentity(state, plan.delivered);
  if (verdict.kind !== "match") return out("held", `the target no longer serves the delivery being recovered: ${verdict.reason}`, false, state);

  let lease: Lease | undefined;
  if (caps.fencing.includes("lease") && adapter.acquireLease !== undefined) {
    const got = await guarded("acquireLease", () => adapter.acquireLease!(plan.target, request.authorisation!.actor));
    if (got.kind !== "ok") return out("held", `the destination is held by another operation: ${got.reason}`, false, state);
    lease = got.value;
  }
  try {
    let receipt: DeployReceipt;
    try {
      receipt = await adapter.recover({ plan, authorisation: request.authorisation!, expectGeneration: state.generation, ...(lease !== undefined ? { lease } : {}) });
    } catch (error) {
      receipt = { outcome: "indeterminate", detail: `recover threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (receipt.outcome === "rejected" && (receipt.rejection === "stale-generation" || receipt.rejection === "unauthorised")) {
      return out("held", `recovery refused (${receipt.rejection}): ${receipt.detail}`, true);
    }
    const after = await guarded("readback", () => adapter.readback(plan.target));
    if (after.kind !== "ok") return out("unknown", `recovery receipt ${receipt.outcome} but the target could not be read back (${after.reason})`, true);
    if (!sameTarget(after.value, plan.target)) return out("held", "the post-recovery readback describes a different service", true, after.value);
    if (onRecovery(after.value)) return out("recovered", `target read back on the retained release (receipt ${receipt.outcome})`, true, after.value);
    if (receipt.outcome === "rejected" && after.value.generation === state.generation) {
      return out("failed", `recovery rejected (${receipt.detail}); the target is readable and unchanged`, true, after.value);
    }
    return out("held", `after recovery the target serves revision ${after.value.revision ?? "(none)"}, not the retained ${plan.to.revision} (receipt ${receipt.outcome})`, true, after.value);
  } finally {
    if (lease !== undefined && adapter.releaseLease !== undefined) {
      try { await adapter.releaseLease(lease); } catch { /* adapter TTL */ }
    }
  }
}

// ------------------------------------------------------------------ provisioning

/**
 * Provisioning is NOT deployment: separate interface, separate authority,
 * dry-run first, and the identity of what it would spend and where.
 */
export interface ProvisioningIdentity {
  account: string;
  region: string;
  resource: string;
  /** Estimated monthly cost in USD; `unknown` is first-class and is refused by default. */
  estimatedMonthlyUsd: number | "unknown";
}

export interface ProvisioningPlan {
  planId: string;
  identity: ProvisioningIdentity;
  /** IaC change summary the dry-run produced (e.g. "2 to add, 0 to destroy"). */
  changes: string[];
  destructive: boolean;
  /** Application migrations the change entails; unknown migration risk is not "none". */
  migrationRisk: "none" | "reversible" | "irreversible" | "unknown";
}

export interface ProvisioningAdapter {
  dryRun(identity: ProvisioningIdentity): Promise<AdapterResult<ProvisioningPlan>>;
  apply(plan: ProvisioningPlan, authorisation: Authorisation): Promise<DeployReceipt>;
  /** Read what exists for the identity. */
  readback(identity: ProvisioningIdentity): Promise<AdapterResult<{ identity: ProvisioningIdentity; exists: boolean }>>;
}

export interface ProvisioningRequest {
  identity: ProvisioningIdentity;
  authorisation: Authorisation | undefined;
  /** The most the operator will accept per month; required to apply. */
  costCeilingUsd?: number;
  /** Destructive or irreversible/unknown-migration plans need this explicitly. */
  acceptDestructive?: boolean;
  dryRunOnly?: boolean;
  now?: () => Date;
}

export interface ProvisioningResult {
  outcome: "planned" | "provisioned" | "held" | "unknown" | "failed";
  acted: boolean;
  reason: string;
  plan?: ProvisioningPlan;
}

const sameProvisioning = (a: ProvisioningIdentity, b: ProvisioningIdentity): boolean =>
  a.account === b.account && a.region === b.region && a.resource === b.resource;

export async function runProvisioning(adapter: ProvisioningAdapter, request: ProvisioningRequest): Promise<ProvisioningResult> {
  const { identity } = request;
  const now = request.now ?? (() => new Date());
  const result = (outcome: ProvisioningResult["outcome"], reason: string, acted: boolean, plan?: ProvisioningPlan): ProvisioningResult =>
    ({ outcome, acted, reason, ...(plan !== undefined ? { plan } : {}) });

  const dry = await guarded("dryRun", () => adapter.dryRun(identity));
  if (dry.kind !== "ok") return result("held", `no dry-run: ${dry.reason}`, false);
  const plan = dry.value;
  if (!sameProvisioning(plan.identity, identity)) {
    return result("held", `the dry-run is for ${plan.identity.account}/${plan.identity.region}/${plan.identity.resource}, not the requested ${identity.account}/${identity.region}/${identity.resource}`, false, plan);
  }
  if (request.dryRunOnly === true) return result("planned", "dry-run only; nothing was changed", false, plan);

  // Provisioning authority is its own kind and names account/region/resource
  // through service/destination: a deploy grant never matches.
  const authority = authorisationCovers(request.authorisation, "provision", { service: identity.resource, destination: `${identity.account}/${identity.region}` }, now());
  if (!authority.ok) return result("held", authority.reason, false, plan);
  if (plan.identity.estimatedMonthlyUsd === "unknown") return result("held", "the cost of this change is unknown; refusing to spend without an estimate", false, plan);
  if (request.costCeilingUsd === undefined) return result("held", "no cost ceiling was approved", false, plan);
  if (plan.identity.estimatedMonthlyUsd > request.costCeilingUsd) {
    return result("held", `estimated ${plan.identity.estimatedMonthlyUsd} USD/month exceeds the approved ceiling ${request.costCeilingUsd}`, false, plan);
  }
  if ((plan.destructive || plan.migrationRisk === "irreversible" || plan.migrationRisk === "unknown") && request.acceptDestructive !== true) {
    return result("held", `the plan is destructive or carries ${plan.migrationRisk} migration risk and was not explicitly accepted`, false, plan);
  }

  let receipt: DeployReceipt;
  try {
    receipt = await adapter.apply(plan, request.authorisation!);
  } catch (error) {
    receipt = { outcome: "indeterminate", detail: `apply threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  const read = await guarded("readback", () => adapter.readback(identity));
  if (read.kind !== "ok") return result("unknown", `apply receipt ${receipt.outcome}; the resource could not be read back (${read.reason})`, true, plan);
  if (!sameProvisioning(read.value.identity, identity)) return result("held", "the readback describes a different account/region/resource", true, plan);
  if (read.value.exists && receipt.outcome === "applied") return result("provisioned", "resource read back under the approved identity", true, plan);
  if (!read.value.exists && receipt.outcome === "rejected") return result("failed", `apply rejected (${receipt.detail}); nothing exists`, true, plan);
  return result("held", `receipt ${receipt.outcome} but the resource ${read.value.exists ? "exists" : "does not exist"}; partial provider failure, reconcile by hand`, true, plan);
}

// ------------------------------------------------------------------ conformance

export type TargetChange = { revision: string; artifact: string } | { unreadable: true };

/**
 * What a conformance run needs besides the adapter: an INDEPENDENT ground
 * truth (so a lying readback is detectable) and a way to make the world
 * change behind the adapter's back.
 */
export interface AdapterHarness {
  adapter: DeploymentAdapter;
  seed(target: TargetRef, state: { revision: string; artifact: string }): Promise<void> | void;
  /** What the target really serves, read around the adapter. */
  truth(target: TargetRef): Promise<{ serving: boolean; revision?: string; artifact?: string }> | { serving: boolean; revision?: string; artifact?: string };
  /** A rival (another process, a human) changes the target now. */
  outOfBand(target: TargetRef, change: TargetChange): Promise<void> | void;
  /** Apply `change` during the NEXT deploy: before it acts, or after it applied but before any readback. */
  interfere(when: "before-deploy" | "after-deploy", change: TargetChange): Promise<void> | void;
  /** Restore readability after an unreadable change. */
  restoreReads(target: TargetRef): Promise<void> | void;
  stats(): { deployCalls: number; maxInFlightDeploys: number };
}

export interface ConformanceCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}
export interface ConformanceReport {
  adapter: string;
  checks: ConformanceCheck[];
  failed: string[];
  skipped: string[];
  /** True only when nothing failed. Skipped checks are listed, never counted as passes. */
  conformant: boolean;
}

export const CONFORMANCE_CHECK_NAMES = [
  "capabilities-coherent",
  "inspect-attributes-service",
  "readback-attributes-service",
  "readback-truthful",
  "unreadable-is-unknown",
  "generation-advances-on-change",
  "plan-binds-identity",
  "plan-is-side-effect-free",
  "rejected-means-unchanged",
  "applied-means-converged",
  "deploy-fenced-on-generation",
  "lease-is-exclusive",
  "undeclared-recovery-refused",
  "observe-attributes-service",
  "logs-attribute-service",
  "journey-confirms-faithful-deploy",
  "journey-no-false-confirm",
  "journey-requires-authority",
  "journey-dry-run-does-not-act",
  "journey-refuses-stale-plan",
  "journey-holds-on-readable-mismatch",
  "journey-unknown-on-unreadable",
  "journey-serialises-competing-releases",
  "no-readback-never-confirms",
  "recovery-succeeds-when-supported",
  "recovery-refused-when-changed-out-of-band",
  "recovery-refuses-unsupported-mode",
] as const;
export type ConformanceCheckName = (typeof CONFORMANCE_CHECK_NAMES)[number];

class Skip extends Error {}
class Fail extends Error {}
const must = (cond: boolean, message: string): void => { if (!cond) throw new Fail(message); };

const T: TargetRef = { service: "svc-a", destination: "prod" };
const R0 = { revision: "rev-0", artifact: "img:0" };
const R1 = { revision: "rev-1", artifact: "img:1" };
const RIVAL = { revision: "rev-9", artifact: "img:9" };
const ident = (r: { revision: string; artifact: string }): DeliveryIdentity => ({ ...T, ...r });
const AUTH: Authorisation = { kind: "deploy", actor: "conformance", ...T };
const RAUTH: Authorisation = { ...AUTH, kind: "recover" };

/**
 * Run every applicable check against fresh adapters from `makeAdapter`. Each
 * check gets its own harness so one adapter fault cannot hide behind another.
 * Checks the adapter's declared capabilities make inapplicable are reported
 * `skipped` with the reason; they are never silently passed.
 */
export async function conformanceSuite(
  makeAdapter: () => Promise<AdapterHarness> | AdapterHarness,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  let adapterName = "(unknown)";

  const fresh = async (): Promise<AdapterHarness> => {
    const h = await makeAdapter();
    await h.seed(T, R0);
    return h;
  };
  const needs = (caps: AdapterCapabilities, ...what: ("readback" | "logs" | "observe" | "lease" | "cas")[]): void => {
    for (const w of what) {
      if (w === "readback" && !caps.readback) throw new Skip("capability readback not declared");
      if (w === "logs" && !caps.logs) throw new Skip("capability logs not declared");
      if (w === "observe" && !caps.observe) throw new Skip("capability observe not declared");
      if (w === "lease" && !caps.fencing.includes("lease")) throw new Skip("fencing lease not declared");
      if (w === "cas" && !caps.fencing.includes("compare-and-set")) throw new Skip("fencing compare-and-set not declared");
    }
  };
  const check = async (name: ConformanceCheckName, body: (h: AdapterHarness, caps: AdapterCapabilities) => Promise<string | void>): Promise<void> => {
    try {
      const h = await fresh();
      const caps = h.adapter.capabilities();
      adapterName = caps.adapter;
      const detail = await body(h, caps);
      checks.push({ name, status: "pass", detail: detail ?? "ok" });
    } catch (error) {
      if (error instanceof Skip) checks.push({ name, status: "skipped", detail: error.message });
      else if (error instanceof Fail) checks.push({ name, status: "fail", detail: error.message });
      else checks.push({ name, status: "fail", detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const readOk = async (h: AdapterHarness): Promise<TargetState> => {
    const r = await h.adapter.readback(T);
    must(r.kind === "ok", `readback was ${r.kind} on a readable target`);
    return (r as Ok<TargetState>).value;
  };
  const truthMatches = async (h: AdapterHarness, r: { revision: string; artifact: string }): Promise<boolean> => {
    const t = await h.truth(T);
    return t.serving && t.revision === r.revision && t.artifact === r.artifact;
  };
  const journeyOf = (h: AdapterHarness, r: { revision: string; artifact: string }, extra: Partial<JourneyRequest> = {}): Promise<JourneyResult> =>
    runDeliveryJourney(h.adapter, { identity: ident(r), authorisation: AUTH, locks: new DestinationLocks(), ...extra });

  await check("capabilities-coherent", async (_h, caps) => {
    must(typeof caps.adapter === "string" && caps.adapter !== "", "capabilities name no adapter");
    must(caps.logs === (_h.adapter.logs !== undefined), "capability logs does not match the presence of logs()");
    must(caps.observe === (_h.adapter.observe !== undefined), "capability observe does not match the presence of observe()");
    if (caps.fencing.includes("lease")) must(_h.adapter.acquireLease !== undefined && _h.adapter.releaseLease !== undefined, "fencing lease declared without acquireLease/releaseLease");
  });

  await check("inspect-attributes-service", async (h) => {
    const r = await h.adapter.inspect(T);
    must(r.kind === "ok", `inspect was ${r.kind} on a readable target`);
    const s = (r as Ok<TargetState>).value;
    must(s.service === T.service && s.destination === T.destination, `inspect for ${T.service}@${T.destination} described ${s.service}@${s.destination}`);
  });

  await check("readback-attributes-service", async (h, caps) => {
    needs(caps, "readback");
    const s = await readOk(h);
    must(s.service === T.service && s.destination === T.destination, `readback for ${T.service}@${T.destination} described ${s.service}@${s.destination}`);
  });

  await check("readback-truthful", async (h, caps) => {
    needs(caps, "readback");
    let s = await readOk(h);
    must(s.revision === R0.revision && s.artifact === R0.artifact, "readback disagrees with the seeded target");
    await h.outOfBand(T, RIVAL);
    s = await readOk(h);
    must(s.revision === RIVAL.revision && s.artifact === RIVAL.artifact, `after an out-of-band change the target serves ${RIVAL.revision} but readback said ${s.revision}`);
    // A rival lands after the deploy applied: readback must report the target, not the request.
    await h.outOfBand(T, R0);
    await h.interfere("after-deploy", RIVAL);
    const plan = await h.adapter.inspect(T);
    must(plan.kind === "ok", "inspect failed");
    const p = await h.adapter.plan(ident(R1), (plan as Ok<TargetState>).value);
    must(p.kind === "ok", "plan failed");
    await h.adapter.deploy({ plan: (p as Ok<DeliveryPlan>).value, authorisation: AUTH, expectGeneration: (plan as Ok<TargetState>).value.generation });
    s = await readOk(h);
    const truth = await h.truth(T);
    must(s.revision === truth.revision && s.artifact === truth.artifact, `readback says ${s.revision}/${s.artifact} but the target serves ${truth.revision}/${truth.artifact}`);
  });

  await check("unreadable-is-unknown", async (h, caps) => {
    needs(caps, "readback");
    await h.outOfBand(T, { unreadable: true });
    const r = await h.adapter.readback(T);
    must(r.kind === "unknown", `an unreadable target produced ${r.kind === "ok" ? `an ok readback (serving=${(r as Ok<TargetState>).value.serving})` : r.kind}; unreadable must be unknown`);
  });

  await check("generation-advances-on-change", async (h) => {
    const a = await h.adapter.inspect(T);
    must(a.kind === "ok", "inspect failed");
    await h.outOfBand(T, RIVAL);
    const b = await h.adapter.inspect(T);
    must(b.kind === "ok", "inspect failed after change");
    must((a as Ok<TargetState>).value.generation !== (b as Ok<TargetState>).value.generation, "the target changed but its generation did not; fencing cannot work");
  });

  await check("plan-binds-identity", async (h) => {
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    const p = await h.adapter.plan(ident(R1), (s as Ok<TargetState>).value);
    must(p.kind === "ok", `plan was ${p.kind}`);
    const plan = (p as Ok<DeliveryPlan>).value;
    must(plan.identity.service === T.service && plan.identity.destination === T.destination && plan.identity.revision === R1.revision && plan.identity.artifact === R1.artifact, "the plan names a different identity than was asked");
    must(plan.baseline.generation === (s as Ok<TargetState>).value.generation, "the plan is not bound to the inspected generation");
  });

  await check("plan-is-side-effect-free", async (h) => {
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    await h.adapter.plan(ident(R1), (s as Ok<TargetState>).value);
    const after = await h.adapter.inspect(T);
    must(after.kind === "ok" && after.value.generation === (s as Ok<TargetState>).value.generation, "planning changed the target");
    must(await truthMatches(h, R0), "planning changed what the target serves");
  });

  await check("rejected-means-unchanged", async (h) => {
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    const base = (s as Ok<TargetState>).value;
    const p = await h.adapter.plan(ident(R1), base);
    must(p.kind === "ok", "plan failed");
    // An unauthorised deploy must be rejected and leave the target alone.
    const receipt = await h.adapter.deploy({ plan: (p as Ok<DeliveryPlan>).value, authorisation: { ...AUTH, destination: "elsewhere" }, expectGeneration: base.generation });
    if (receipt.outcome === "applied") throw new Fail("a deploy under an authorisation for another destination was applied");
    if (receipt.outcome === "rejected") must(await truthMatches(h, R0), "the adapter reported rejected but the target changed (a partial failure reported as nothing happened)");
  });

  await check("applied-means-converged", async (h, caps) => {
    needs(caps, "readback");
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    const base = (s as Ok<TargetState>).value;
    const p = await h.adapter.plan(ident(R1), base);
    must(p.kind === "ok", "plan failed");
    const receipt = await h.adapter.deploy({ plan: (p as Ok<DeliveryPlan>).value, authorisation: AUTH, expectGeneration: base.generation });
    must(receipt.outcome === "applied", `an uncontested deploy ended ${receipt.outcome}: ${receipt.detail}`);
    must(await truthMatches(h, R1), "the receipt says applied but the target does not serve the approved revision and artifact");
  });

  await check("deploy-fenced-on-generation", async (h, caps) => {
    needs(caps, "cas");
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    const base = (s as Ok<TargetState>).value;
    const p = await h.adapter.plan(ident(R1), base);
    must(p.kind === "ok", "plan failed");
    await h.outOfBand(T, RIVAL);
    const receipt = await h.adapter.deploy({ plan: (p as Ok<DeliveryPlan>).value, authorisation: AUTH, expectGeneration: base.generation });
    must(receipt.outcome === "rejected" && receipt.rejection === "stale-generation", `a deploy on a stale generation was ${receipt.outcome}${receipt.rejection ? `/${receipt.rejection}` : ""}, not rejected/stale-generation`);
    must(await truthMatches(h, RIVAL), "a stale deploy overwrote the rival release");
  });

  await check("lease-is-exclusive", async (h, caps) => {
    needs(caps, "lease");
    const a = await h.adapter.acquireLease!(T, "one");
    must(a.kind === "ok", `the first lease was ${a.kind}`);
    const b = await h.adapter.acquireLease!(T, "two");
    must(b.kind !== "ok", "a second holder acquired the lease while the first held it");
    await h.adapter.releaseLease!((a as Ok<Lease>).value);
    const c = await h.adapter.acquireLease!(T, "two");
    must(c.kind === "ok", "the lease was not reacquirable after release");
    await h.adapter.releaseLease!((c as Ok<Lease>).value);
  });

  await check("undeclared-recovery-refused", async (h, caps) => {
    const all: RecoveryMode[] = ["rollback-to-version", "redeploy-previous-artifact", "roll-forward"];
    const mode = all.find((m) => !caps.recovery.includes(m));
    if (mode === undefined) throw new Skip("every recovery mode is declared");
    const s = await h.adapter.inspect(T);
    must(s.kind === "ok", "inspect failed");
    const receipt = await h.adapter.recover({
      plan: { mode, target: T, delivered: ident(R0), to: R1, baselineGeneration: (s as Ok<TargetState>).value.generation, madeAt: new Date().toISOString() },
      authorisation: RAUTH,
      expectGeneration: (s as Ok<TargetState>).value.generation,
    });
    must(receipt.outcome === "rejected", `undeclared mode ${mode} produced ${receipt.outcome}; unsupported recovery must be refused, not approximated`);
    must(await truthMatches(h, R0), `undeclared mode ${mode} changed the target`);
  });

  await check("observe-attributes-service", async (h, caps) => {
    needs(caps, "observe");
    const r = await h.adapter.observe!(T);
    if (r.kind !== "ok") return;
    must(r.value.service === T.service, `telemetry for ${T.service} was attributed to ${r.value.service}`);
  });

  await check("logs-attribute-service", async (h, caps) => {
    needs(caps, "logs");
    const r = await h.adapter.logs!(T, 5);
    if (r.kind !== "ok") return;
    must(r.value.service === T.service, `logs for ${T.service} were attributed to ${r.value.service}`);
  });

  await check("journey-confirms-faithful-deploy", async (h, caps) => {
    needs(caps, "readback");
    const r = await journeyOf(h, R1);
    must(r.outcome === "confirmed", `an uncontested journey ended ${r.outcome}: ${r.reason}`);
    must(await truthMatches(h, R1), "the journey confirmed but the target does not serve the approved identity");
  });

  await check("journey-no-false-confirm", async (h, caps) => {
    needs(caps, "readback");
    await h.interfere("after-deploy", RIVAL);
    const r = await journeyOf(h, R1);
    must(r.outcome !== "confirmed", "the journey confirmed a release the target is not serving");
    const t = await h.truth(T);
    must(t.revision === RIVAL.revision, "the interference did not take effect (harness fault)");
  });

  await check("journey-requires-authority", async (h) => {
    const r = await journeyOf(h, R1, { authorisation: { ...AUTH, kind: "provision" } });
    must(r.outcome === "held" && !r.acted, `a journey without deploy authority ended ${r.outcome}${r.acted ? " after acting" : ""}`);
    must(h.stats().deployCalls === 0, "deploy was called without authority");
  });

  await check("journey-dry-run-does-not-act", async (h) => {
    const r = await journeyOf(h, R1, { dryRun: true });
    must(r.outcome === "planned" && !r.acted, `a dry run ended ${r.outcome}`);
    must(h.stats().deployCalls === 0 && (await truthMatches(h, R0)), "a dry run deployed");
  });

  await check("journey-refuses-stale-plan", async (h, caps) => {
    needs(caps, "cas", "readback");
    await h.interfere("before-deploy", RIVAL);
    const r = await journeyOf(h, R1);
    must(r.outcome === "held", `a release racing a rival ended ${r.outcome}: ${r.reason}`);
    must(await truthMatches(h, RIVAL), "the racing release overwrote the rival without noticing");
  });

  await check("journey-holds-on-readable-mismatch", async (h, caps) => {
    needs(caps, "readback");
    await h.interfere("after-deploy", RIVAL);
    const r = await journeyOf(h, R1);
    must(r.outcome === "held", `a readable mismatch ended ${r.outcome}: ${r.reason}`);
  });

  await check("journey-unknown-on-unreadable", async (h, caps) => {
    needs(caps, "readback");
    await h.interfere("after-deploy", { unreadable: true });
    const r = await journeyOf(h, R1);
    must(r.outcome === "unknown", `an unreadable target ended ${r.outcome}: ${r.reason}`);
  });

  await check("journey-serialises-competing-releases", async (h, caps) => {
    needs(caps, "readback");
    const locks = new DestinationLocks();
    const [a, b] = await Promise.all([
      journeyOf(h, R1, { locks }),
      journeyOf(h, RIVAL, { locks }),
    ]);
    must(h.stats().maxInFlightDeploys <= 1, `${h.stats().maxInFlightDeploys} deploys to one destination ran at once`);
    for (const [r, id] of [[a, R1], [b, RIVAL]] as const) {
      if (r.outcome === "confirmed") must(r.observed?.revision === id.revision, "a confirmed journey's own readback disagrees with its identity");
    }
    must([a, b].some((r) => r.outcome === "confirmed"), "neither serialised release confirmed");
    const last = [a, b].filter((r) => r.outcome === "confirmed").length === 2 ? RIVAL : null;
    if (last !== null) must(await truthMatches(h, RIVAL), "the last release to confirm is not what the target serves");
  });

  await check("no-readback-never-confirms", async (h, caps) => {
    if (caps.readback) throw new Skip("adapter declares readback; applies only to adapters without it");
    const r = await journeyOf(h, R1, { allowUnverifiable: true });
    must(r.outcome !== "confirmed", "an adapter that cannot read back produced a confirmation");
    const refusing = await journeyOf(h, R1);
    must(refusing.outcome === "held" && !refusing.acted, "an unverifiable deploy was not refused by default");
  });

  await check("recovery-succeeds-when-supported", async (h, caps) => {
    needs(caps, "readback");
    if (!caps.recovery.includes("rollback-to-version")) throw new Skip("recovery mode rollback-to-version not declared");
    const j = await journeyOf(h, R1);
    must(j.outcome === "confirmed", `setup journey ended ${j.outcome}`);
    const plan = await makeRecoveryPlan(h.adapter, ident(R1), "rollback-to-version", R0);
    must(plan.kind === "ok", `recovery plan was ${plan.kind}`);
    const r = await runRecovery(h.adapter, { plan: (plan as Ok<RecoveryPlan>).value, authorisation: RAUTH, locks: new DestinationLocks() });
    must(r.outcome === "recovered", `supported recovery ended ${r.outcome}: ${r.reason}`);
    must(await truthMatches(h, R0), "recovery reported done but the target does not serve the retained release");
  });

  await check("recovery-refused-when-changed-out-of-band", async (h, caps) => {
    needs(caps, "readback");
    if (!caps.recovery.includes("rollback-to-version")) throw new Skip("recovery mode rollback-to-version not declared");
    const j = await journeyOf(h, R1);
    must(j.outcome === "confirmed", `setup journey ended ${j.outcome}`);
    const plan = await makeRecoveryPlan(h.adapter, ident(R1), "rollback-to-version", R0);
    must(plan.kind === "ok", `recovery plan was ${plan.kind}`);
    await h.outOfBand(T, RIVAL);
    const r = await runRecovery(h.adapter, { plan: (plan as Ok<RecoveryPlan>).value, authorisation: RAUTH, locks: new DestinationLocks() });
    must(r.outcome === "held" && !r.acted, `recovery on a changed target ended ${r.outcome}`);
    must(await truthMatches(h, RIVAL), "recovery overwrote an out-of-band change");
  });

  await check("recovery-refuses-unsupported-mode", async (h, caps) => {
    needs(caps, "readback");
    const all: RecoveryMode[] = ["rollback-to-version", "redeploy-previous-artifact", "roll-forward"];
    const mode = all.find((m) => !caps.recovery.includes(m));
    if (mode === undefined) throw new Skip("every recovery mode is declared");
    const j = await journeyOf(h, R1);
    must(j.outcome === "confirmed", `setup journey ended ${j.outcome}`);
    const base = await readOk(h);
    const r = await runRecovery(h.adapter, {
      plan: { mode, target: T, delivered: ident(R1), to: R0, baselineGeneration: base.generation, madeAt: new Date().toISOString() },
      authorisation: RAUTH,
      locks: new DestinationLocks(),
    });
    must(r.outcome === "held" && !r.acted, `unsupported mode ${mode} ended ${r.outcome}; it must be held without acting`);
    must(await truthMatches(h, R1), "an unsupported recovery changed the target");
  });

  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const skipped = checks.filter((c) => c.status === "skipped").map((c) => c.name);
  return { adapter: adapterName, checks, failed, skipped, conformant: failed.length === 0 };
}

/** For an adapter's own test file: throws listing every failed check. */
export function assertConformant(report: ConformanceReport): void {
  if (report.conformant) return;
  const lines = report.checks.filter((c) => c.status === "fail").map((c) => `  ${c.name}: ${c.detail}`);
  throw new Error(`${report.adapter} is not conformant:\n${lines.join("\n")}`);
}

// ------------------------------------------------------------------ Teploy mapping

/**
 * How the native Teploy implementation fills this contract, as data so it can
 * be checked for completeness. `today` names the delivery.ts / deploy.ts code
 * that already behaves this way; `gap` is what an adapter would still need.
 * Documentation only: nothing here is wired, and delivery.ts is unchanged.
 */
export interface TeployMappingEntry {
  operation: (typeof ADAPTER_OPERATIONS)[number];
  today: string;
  gap?: string;
}

export const TEPLOY_ADAPTER_MAPPING: readonly TeployMappingEntry[] = [
  {
    operation: "capabilities",
    today: "readback: true (readBackDelivery); logs: via teploy logs; observe: true (observeHealthFor, Observe RED metrics); dryRun: false; provisioning: false; recovery: [rollback-to-version]; fencing: record-level only",
    gap: "dryRun: no teploy command validates a deploy without acting",
  },
  {
    operation: "inspect",
    today: "`teploy status --json` -> state.current_hash (revision) + containers[].Image/State; attribution is the trusted copy's teploy.yml (server, app)",
    gap: "no generation token; derive one from current_hash + container IDs, which does not change on an out-of-band redeploy of the same hash",
  },
  {
    operation: "plan",
    today: "executeDelivery's preconditions (trusted dir, merged SHA proven, recheckApprovingActor) before any command; no provider-side plan",
    gap: "plan is a description only; validatedByProvider must stay false",
  },
  {
    operation: "deploy",
    today: "executeDelivery: proposed->approved->executing (conditional UPDATE) -> `teploy deploy` via argv -> artifactDigest recorded; receipt maps exit code to applied/rejected/indeterminate",
    gap: "the CAS is on the delivery record, not on the target: two records for one destination, or a human running teploy by hand, are not fenced. The adapter needs a destination lease (store row) or a status re-read immediately before the command",
  },
  {
    operation: "readback",
    today: "readBackDelivery: both halves required (state.current_hash == mergedSha[:7] AND a running container whose image is the artifact or an ID resolving to its RepoTags); mismatch vs unreadable already distinguished",
  },
  {
    operation: "recover",
    today: "executeDeliveryRollback: `teploy rollback --to <recoveryVersion>`; refuses when the target no longer runs THIS delivery; target already on recovery version = done",
    gap: "recovery artifact digest is not recorded (version + a live container is the bar), so verifiedAgainst is [revision] only; no redeploy-previous or roll-forward mode, correctly declared unsupported (rollbackDeploy: \"previous\" is not a stable recovery target)",
  },
  {
    operation: "observe",
    today: "observeHealthFor over readServiceHealth; the service is the repo's project record observeService (incidents.ts attributeServiceMatch rules: unique match or refuse)",
  },
  {
    operation: "logs",
    today: "none in delivery.ts; `teploy logs` exists in the CLI",
    gap: "an adapter method over argv-array exec; unwired",
  },
  {
    operation: "acquireLease",
    today: "none at destination level",
    gap: "needs a destination-scoped row with conditional UPDATE and TTL",
  },
  {
    operation: "releaseLease",
    today: "none at destination level",
    gap: "as acquireLease",
  },
];

/** Where this would be wired (documentation; nothing is wired by this module). */
export const WIRING_POINTS: readonly string[] = [
  "delivery.ts executeDelivery/readBackDelivery/executeDeliveryRollback -> a TeployAdapter implementing DeploymentAdapter over the same argv runner",
  "worker.ts delivery sweep -> runDeliveryJourney(adapter, ...) once the Teploy adapter exists; record transitions mirror JourneyOutcome",
  "incidents.ts remediation recovery -> runRecovery with a RecoveryPlan taken at diagnosis time",
  "observe.ts readServiceHealth -> DeploymentAdapter.observe, attribution via attributeServiceMatch",
  "a second adapter's own test: assertConformant(await conformanceSuite(() => makeHarness()))",
];
