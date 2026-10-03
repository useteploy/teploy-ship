/**
 * What each harness actually does with a run's recorded input.
 *
 * Dependency-free on purpose (like plan.ts / ask.ts): the web dashboard imports
 * it to decide what to OFFER, and the server routes import it to decide what to
 * ACCEPT, from the same table.
 *
 * Why it exists: every new run records `steer: true`, and the run page offered
 * a steer box on that flag alone. But only the native loop drains steering
 * notes — external adapters read nothing but `prompt` (harness.ts HarnessTask).
 * A note sent to an external-harness run was stored, acknowledged ("sent"), and
 * never read. An instruction nobody will read must be refused, not accepted.
 *
 * S13: the table is now a full declaration (DECLARATIONS below) — every
 * capability carries a status and a stated reason that cites the source it
 * rests on. `harnessSupports` keeps its old meaning and is derived from it.
 * Unknown harness ids support nothing.
 *
 * A declaration is a CLAIM. `conformanceCheck` compares it with what a harness
 * was observed to do, so a claim that drifts from behaviour is a finding rather
 * than a surprise. Line citations drift; treat them as pointers.
 */

export type HarnessCapability = "steer";

/** The S13 capability set a harness publishes. */
export type CapabilityName =
  | "investigation"
  | "planning"
  | "steering"
  | "tools"
  | "browser"
  | "interruption"
  | "approvals"
  | "recovery"
  | "accounting";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "investigation", "planning", "steering", "tools", "browser", "interruption", "approvals", "recovery", "accounting",
];

export interface CapabilityDeclaration {
  status: "supported" | "refused" | "partial";
  /** Why, in a sentence, with the source it rests on. Never empty. */
  reason: string;
}

/**
 * How a harness's spend can be known. `unknown` is a first-class answer: Ship
 * never turns it into $0 (harness.ts HarnessUsage.priced).
 */
export type AccountingHonesty = "priced" | "unpriced-under-oauth" | "unknown";

export interface HarnessDeclaration {
  id: string;
  capabilities: Record<CapabilityName, CapabilityDeclaration>;
  accounting: AccountingHonesty;
}

const EXTERNAL_BYPASS =
  "permissions are bypassed inside the sandbox (harness-external.ts:406 claude --permission-mode bypassPermissions; :450 opencode run --auto)";

const DECLARATIONS: Record<string, HarnessDeclaration> = {
  native: {
    id: "native",
    accounting: "priced",
    capabilities: {
      investigation: { status: "supported", reason: "scan mode runs in the loop (durable.ts input.mode)" },
      planning: { status: "supported", reason: "plan park with snapshot (durable.ts:1777-1790)" },
      steering: { status: "supported", reason: "notes drained at the top of every turn when input.steer (durable.ts:1831-1843)" },
      tools: { status: "supported", reason: "Ship's own tools, run through the recorded step sequence" },
      browser: { status: "partial", reason: "browser tool is offered only when verification.preview is configured (durable.ts:1678)" },
      interruption: {
        status: "partial",
        reason: "bounded by steps, budget and stuck detection (harness.ts HarnessBudget); mid-turn interruption is not shown by the source",
      },
      approvals: { status: "supported", reason: "parks on approval, snapshots and restores when the executor can (durable.ts:703-717, 2249-2255)" },
      recovery: { status: "supported", reason: "stuck/settled detector via input.recovery (durable.ts:2300-2325)" },
      accounting: { status: "supported", reason: "step-level token and dollar accounting (harness.ts HarnessUsage)" },
    },
  },
  "claude-code": {
    id: "claude-code",
    accounting: "unpriced-under-oauth",
    capabilities: {
      investigation: { status: "supported", reason: "scan prompt framing (harness-external.ts:177-185)" },
      planning: { status: "refused", reason: "plan review requires the native harness (harness-external.ts:475)" },
      steering: { status: "refused", reason: "reads only its starting prompt (harness.ts HarnessTask.input comment)" },
      tools: { status: "partial", reason: `vendor tools inside the sandbox, not Ship's tool layer; ${EXTERNAL_BYPASS}` },
      browser: { status: "refused", reason: "no browser wiring in the adapter (harness-external.ts)" },
      interruption: {
        status: "partial",
        reason: "only the exec timeout (harness-external.ts:66,481,502, default 30 min) and --max-turns/--max-budget-usd (:406-410)",
      },
      approvals: { status: "refused", reason: `no park; ${EXTERNAL_BYPASS}` },
      recovery: { status: "refused", reason: "no stuck detection or settle for external runs" },
      accounting: {
        status: "partial",
        reason: "priced only with ANTHROPIC_API_KEY and no OAuth token (harness-external.ts:420); otherwise counted, not priced",
      },
    },
  },
  opencode: {
    id: "opencode",
    accounting: "unknown",
    capabilities: {
      investigation: { status: "supported", reason: "scan prompt framing (harness-external.ts:177-185)" },
      planning: { status: "refused", reason: "plan review requires the native harness (harness-external.ts:475)" },
      steering: { status: "refused", reason: "reads only its starting prompt (harness.ts HarnessTask.input comment)" },
      tools: { status: "partial", reason: `vendor tools inside the sandbox, not Ship's tool layer; ${EXTERNAL_BYPASS}` },
      browser: { status: "refused", reason: "no browser wiring in the adapter (harness-external.ts)" },
      interruption: { status: "partial", reason: "only the exec timeout (harness-external.ts:66,481,502, default 30 min); no turn or budget flag is passed" },
      approvals: { status: "refused", reason: `no park; ${EXTERNAL_BYPASS}` },
      recovery: { status: "refused", reason: "no stuck detection or settle for external runs" },
      accounting: {
        status: "partial",
        reason: "priced or unpriced is decided per run from the reported cost; 0 means unpriced (harness-external.ts:300-306)",
      },
    },
  },
};

/** The declaration for a harness id, or undefined for an unknown one. */
export function declarationFor(harnessId: string): HarnessDeclaration | undefined {
  return Object.hasOwn(DECLARATIONS, harnessId) ? DECLARATIONS[harnessId] : undefined;
}

/** Ids that publish a declaration. */
export const DECLARED_HARNESS_IDS: readonly string[] = Object.keys(DECLARATIONS);

/** An unknown harness supports nothing: every capability is refused. */
export function capabilityOf(harnessId: string, capability: CapabilityName): CapabilityDeclaration {
  return (
    declarationFor(harnessId)?.capabilities[capability] ?? {
      status: "refused",
      reason: `unknown harness "${harnessId}" declares no capabilities`,
    }
  );
}

/** Operations a caller can ask of a harness, each governed by one capability. */
export type HarnessOperation =
  | "investigate"
  | "plan-review"
  | "steer"
  | "use-tools"
  | "browser"
  | "interrupt"
  | "approval-park"
  | "recovery";

export const OPERATION_CAPABILITY: Record<HarnessOperation, CapabilityName> = {
  investigate: "investigation",
  "plan-review": "planning",
  steer: "steering",
  "use-tools": "tools",
  browser: "browser",
  interrupt: "interruption",
  "approval-park": "approvals",
  recovery: "recovery",
};

/** Stem of the plan-review refusal; call sites append their own consequence. */
export const PLAN_REVIEW_REFUSAL = "Plan review requires the native harness.";

/** Message shown when a steer is refused on a run that cannot consume it. */
export const STEER_UNSUPPORTED_MESSAGE =
  "This run uses an external harness, which reads only its starting prompt and cannot take mid-run messages. Cancel it and start a follow-up instead.";

const REFUSALS: Record<HarnessOperation, string> = {
  "plan-review": PLAN_REVIEW_REFUSAL,
  steer: STEER_UNSUPPORTED_MESSAGE,
  "approval-park":
    "This harness cannot pause for an approval; it runs with permissions bypassed inside the sandbox. Use the native harness for runs that need approvals.",
  recovery: "This harness has no stuck detection or recovery. Use the native harness, or cancel the run and start a follow-up.",
  browser: "This harness has no browser access in Ship. Use the native harness with a preview configured.",
  interrupt: "This harness cannot be interrupted mid-run; it stops only at its time or turn limit. Cancel the run to discard it.",
  "use-tools": "This harness does not use Ship's tool layer.",
  investigate: "This harness cannot run investigations.",
};

/**
 * The exact user-facing refusal when `harnessId` declares `operation` refused,
 * or undefined when it does not. `partial` is not a refusal: the operation is
 * accepted and the declaration's reason qualifies it. An unknown harness is
 * refused everything.
 */
export function refusalFor(harnessId: string, operation: HarnessOperation): string | undefined {
  if (capabilityOf(harnessId, OPERATION_CAPABILITY[operation]).status !== "refused") return undefined;
  if (declarationFor(harnessId) === undefined) {
    return `Unknown harness "${harnessId}" declares no capabilities, so ${operation} is refused.`;
  }
  return REFUSALS[operation];
}

/** What a harness was observed to do when asked for an operation. */
export interface ObservedBehaviour {
  operation: HarnessOperation;
  accepted: boolean;
  /** Did any work start or any state change (an agent launched, a note stored)? */
  sideEffects: boolean;
  /** For an accepted operation: was it actually acted on (the note read, the park taken)? */
  honoured?: boolean;
  /** For a refusal: the message the user saw. */
  refusalMessage?: string;
}

export type MismatchKind =
  | "accepted-unsupported"
  | "refused-with-side-effects"
  | "refusal-unexplained"
  | "refused-supported"
  | "silently-dropped"
  | "accepted-unverified";

export interface ConformanceMismatch {
  kind: MismatchKind;
  operation: HarnessOperation;
  detail: string;
}

/**
 * Declared-versus-observed, pure. Empty `mismatches` means the claim held for
 * this one observation, nothing more.
 */
export function conformanceCheck(
  declaration: HarnessDeclaration,
  observed: ObservedBehaviour,
): { ok: boolean; mismatches: ConformanceMismatch[] } {
  const op = observed.operation;
  const declared = declaration.capabilities[OPERATION_CAPABILITY[op]];
  const mismatches: ConformanceMismatch[] = [];
  const flag = (kind: MismatchKind, detail: string) =>
    mismatches.push({ kind, operation: op, detail: `${declaration.id}: ${detail}` });
  if (declared.status === "refused") {
    if (observed.accepted) flag("accepted-unsupported", "declares the operation refused but accepted it");
    else {
      if (observed.sideEffects) flag("refused-with-side-effects", "refused but already started work or changed state");
      if ((observed.refusalMessage ?? "").trim() === "") flag("refusal-unexplained", "refused with no user-facing message");
    }
  } else if (!observed.accepted) {
    if (declared.status === "supported") flag("refused-supported", "declares the operation supported but refused it");
    if (observed.sideEffects) flag("refused-with-side-effects", "refused but already started work or changed state");
  } else if (observed.honoured === false) {
    flag("silently-dropped", "accepted the operation and did not act on it");
  } else if (observed.honoured === undefined && declared.status === "supported") {
    flag("accepted-unverified", "accepted, but nothing shows it was acted on");
  }
  return { ok: mismatches.length === 0, mismatches };
}

interface RecordedHarness {
  harness?: { id?: unknown } | undefined;
  harnessAttempts?: readonly { id?: unknown }[] | undefined;
}

/** Harness ids a recorded run input commits to (single harness and/or attempts). */
export function recordedHarnessIds(input: RecordedHarness | undefined): string[] {
  const ids: string[] = [];
  // Runs recorded before harnesses were pluggable carry no `harness`: native.
  if (input?.harness === undefined) ids.push("native");
  else ids.push(typeof input.harness.id === "string" ? input.harness.id : "");
  for (const attempt of input?.harnessAttempts ?? []) ids.push(typeof attempt.id === "string" ? attempt.id : "");
  return ids;
}

/** True only when EVERY harness the run may execute under supports the capability. */
export function harnessSupports(input: RecordedHarness | undefined, capability: HarnessCapability): boolean {
  void capability; // only "steer" exists today; it maps to the declared steering capability
  return recordedHarnessIds(input).every((id) => capabilityOf(id, "steering").status === "supported");
}
