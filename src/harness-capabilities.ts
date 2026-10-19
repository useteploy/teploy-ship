/**
 * What each harness actually does with a run's recorded input.
 *
 * Dependency-free on purpose (like plan.ts / ask.ts): the web dashboard imports
 * it to decide what to OFFER, and the server routes import it to decide what to
 * ACCEPT, from the same table.
 *
 * Why it exists: every new run records `steer: true`, and the run page offered
 * a steer box on that flag alone. But for a long time only the native loop
 * drained steering notes — external adapters read nothing but `prompt`
 * (harness.ts HarnessTask), so a note sent to one was stored, acknowledged
 * ("sent"), and never read. An instruction nobody will read must be refused,
 * not accepted. Since D6/D7 the external contracts steer too (session
 * resume), but only from adapter contract 2 on — a 1-contract run is still
 * refused everything it cannot read.
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

/**
 * The ACP harnesses' declaration (E7 H3, src/harness-acp.ts). One shape for
 * every profile: the permission gate is the driver's fail-closed policy, not
 * a vendor bypass flag — the material difference from the bespoke adapters.
 */
function acpDeclaration(id: string): HarnessDeclaration {
  return {
    id,
    accounting: "unknown",
    capabilities: {
      investigation: { status: "supported", reason: "scan prompt framing (harness-external.ts externalPrompt)" },
      planning: { status: "refused", reason: "plan review requires the native harness (H8 tracks the ACP read-only plan phase)" },
      // Deliberately refused until H5 lands session/load steering: the H3
      // adapter runs exactly one prompt per exec, so a note accepted now
      // would be stored, answered "sent" and never read — the exact bug
      // this table exists to prevent.
      steering: {
        status: "refused",
        reason: "the ACP adapter runs one prompt per exec; steering by session/load lands with H5 (SHIP_ACP_CONTROL)",
      },
      tools: {
        status: "partial",
        reason:
          "vendor tools inside the sandbox, not Ship's tool layer; file-tool requests are workspace-gated — the ship-acp driver answers every permission request fail-closed (locations and path-like rawInput fields alike, symlink-safe, never allow-always) and records each decision; shell execution is unrestricted inside the sandbox container, where gVisor and the egress allowlist are the boundary",
      },
      browser: {
        status: "partial",
        reason:
          "a browser only under SHIP_HARNESS_BROWSER=on: session/new carries the baked Playwright MCP server over ACP's own mcpServers (harness-acp.ts, ship-acp driver >= 1.2), attached with --cdp-endpoint to the same per-run Chromium session the native ```look path drives; sealed tiers and the open tier without plan review are refused exactly like look (harness-browser.ts); support still depends on the individual agent honouring mcpServers; flag off (the default) there is no browser",
      },
      interruption: {
        status: "partial",
        reason: "the exec timeout and the driver's tool-call budget (session/cancel past maxSteps); an operator interrupt needs H5's control file",
      },
      approvals: { status: "refused", reason: "no park: the driver answers permission requests inside the sandbox and records the decision (H8's plan phase turns ask into a park)" },
      recovery: { status: "refused", reason: "no stuck detection or settle for external runs" },
      accounting: {
        status: "partial",
        reason: "tokens recorded from the agent's reported usage; no ACP agent reports dollars, so every run is counted, not priced (P5-3)",
      },
    },
  };
}

const DECLARATIONS: Record<string, HarnessDeclaration> = {
  native: {
    id: "native",
    accounting: "priced",
    capabilities: {
      investigation: { status: "supported", reason: "scan mode runs in the loop (durable.ts input.mode)" },
      planning: { status: "supported", reason: "plan park with snapshot (durable.ts:1777-1790)" },
      steering: { status: "supported", reason: "notes drained at the top of every turn when input.steer (durable.ts:1831-1843)" },
      tools: { status: "supported", reason: "Ship's own tools, run through the recorded step sequence" },
      browser: { status: "partial", reason: "```look a11y observation when input.look (SHIP_LOOK, on unless explicitly off); pixel screenshots on an image look when input.lookImage (SHIP_LOOK_IMAGE_MODEL) — refused without it; a run-page screencast recording of the look session when input.lookRecord (SHIP_LOOK_RECORD), withheld when the captured page text carries a configured secret; the agent-authored browser flow only when verification.preview is configured (durable.ts, ladder-steps.ts)" },
      interruption: {
        status: "partial",
        reason: "bounded by steps, budget and stuck detection (harness.ts HarnessBudget); with input.steerReply (SHIP_STEER_REPLY) an operator interrupt stops an action before it starts and cancels a running python kernel cell — a running bash command cannot be cancelled (no abort in the executor contract) and runs to completion (steer-reply.ts)",
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
      steering: {
        status: "supported",
        reason:
          "session resume (D7): the run records claude's session_id and pending notes are delivered into it as `--resume` execs at process boundaries (harness-external.ts harness-steer/harness-resume)",
      },
      tools: { status: "partial", reason: `vendor tools inside the sandbox, not Ship's tool layer; ${EXTERNAL_BYPASS}` },
      browser: {
        status: "partial",
        reason:
          "a browser only under SHIP_HARNESS_BROWSER=on: the adapter wires the baked Playwright MCP server into claude's own --mcp-config and starts the same per-run Chromium session the native ```look path drives (--cdp-endpoint, harness-browser.ts); sealed tiers and the open tier without plan review are refused exactly like look (LOOK_SEALED/LOOK_OPEN_PLAN), and --bare (SHIP_CLAUDE_BARE=1) skips MCP entirely; flag off (the default) there is no browser",
      },
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
      steering: {
        status: "supported",
        reason:
          "v2 line only (D6): the run drives a caller-chosen `--session` and pending notes are resumed into it at process boundaries (harness-external.ts harness-steer/harness-resume); the 1.x line records no session — a note on such a run is consumed with a recorded delivery refusal, never silently dropped",
      },
      tools: { status: "partial", reason: `vendor tools inside the sandbox, not Ship's tool layer; ${EXTERNAL_BYPASS}` },
      browser: {
        status: "partial",
        reason:
          "a browser only under SHIP_HARNESS_BROWSER=on: the adapter merges the baked Playwright MCP server into the config blob it delivers (OPENCODE_CONFIG_CONTENT's mcp section, harness-browser.ts) and starts the same per-run Chromium session the native ```look path drives (--cdp-endpoint); sealed tiers and the open tier without plan review are refused exactly like look (LOOK_SEALED/LOOK_OPEN_PLAN); flag off (the default) there is no browser",
      },
      interruption: { status: "partial", reason: "only the exec timeout (harness-external.ts:66,481,502, default 30 min); no turn or budget flag is passed" },
      approvals: { status: "refused", reason: `no park; ${EXTERNAL_BYPASS}` },
      recovery: { status: "refused", reason: "no stuck detection or settle for external runs" },
      accounting: {
        status: "partial",
        reason: "priced or unpriced is decided per run from the reported cost; 0 means unpriced (parseOpencodeStream / parseOpencode2Stream)",
      },
    },
  },
  codex: {
    id: "codex",
    accounting: "unknown",
    capabilities: {
      investigation: { status: "supported", reason: "scan prompt framing (harness-external.ts externalPrompt)" },
      planning: { status: "refused", reason: "plan review requires the native harness (harness-external.ts:544)" },
      steering: {
        status: "refused",
        reason:
          "reads only its starting prompt (harness.ts HarnessTask.input comment); codex's continuation path is `codex exec resume <thread-id>`, which a note cannot reach inside the one exec that IS the run step",
      },
      tools: {
        status: "partial",
        reason:
          "vendor tools inside the sandbox, not Ship's tool layer; --dangerously-bypass-approvals-and-sandbox (harness-external.ts SPECS.codex), the vendor's flag for externally-sandboxed environments",
      },
      browser: {
        status: "partial",
        reason:
          "a browser only under SHIP_HARNESS_BROWSER=on: the adapter passes the baked Playwright MCP server as --config mcp_servers.browser.* TOML overrides and starts the same per-run Chromium session the native ```look path drives (--cdp-endpoint, harness-browser.ts); sealed tiers and the open tier without plan review are refused exactly like look (LOOK_SEALED/LOOK_OPEN_PLAN); flag off (the default) there is no browser",
      },
      interruption: {
        status: "partial",
        reason: "only the exec timeout (harness-external.ts externalHarnessConfig, default 30 min); codex exec has no turn- or dollar-cap flag to pass",
      },
      approvals: { status: "refused", reason: "no park; approvals are `never` by the one flag the command sets" },
      recovery: { status: "refused", reason: "no stuck detection or settle for external runs" },
      accounting: {
        status: "partial",
        reason:
          "tokens recorded from turn.completed, never dollars — codex exec reports no cost, so every run is counted, not priced (harness-external.ts parseCodexExecStream)",
      },
    },
  },
  gemini: acpDeclaration("gemini"),
  grok: acpDeclaration("grok"),
  cursor: acpDeclaration("cursor"),
  qwen: acpDeclaration("qwen"),
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
  "This run's harness cannot take mid-run messages: it is on the 1.x external contract, which reads only its starting prompt (the 2.x contracts steer by session resume). Cancel it and start a follow-up instead.";

/**
 * A queued message or an interrupt sent to a run whose recorded input never
 * admitted two-way steering (D2, SHIP_STEER_REPLY=on at enqueue). The run
 * still takes plain steering; only the new modes are refused.
 */
export const STEER_REPLY_UNSUPPORTED_MESSAGE =
  "This run was started without two-way steering, so it cannot queue a message or be interrupted. Send the message without a mode instead.";

/** Queue and interrupt on an external-harness run: the adapter drains plain notes only and never claims held notes, so they would sit unread. */
export const STEER_REPLY_EXTERNAL_MESSAGE =
  "This run's agent is an external harness, which takes plain steering messages only. Queued messages and interrupts are native-harness features; send the message without a mode instead.";

const REFUSALS: Record<HarnessOperation, string> = {
  "plan-review": PLAN_REVIEW_REFUSAL,
  steer: STEER_UNSUPPORTED_MESSAGE,
  "approval-park":
    "This harness cannot pause for an approval; it runs with permissions bypassed inside the sandbox. Use the native harness for runs that need approvals.",
  recovery: "This harness has no stuck detection or recovery. Use the native harness, or cancel the run and start a follow-up.",
  browser:
    "This harness has no browser access in this deployment: the external-harness browser needs SHIP_HARNESS_BROWSER=on on the worker and an image that bakes @playwright/mcp. Use the native harness, or ask the operator to turn the flag on.",
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
  /** The enqueue-time steer flag (input.steer): what admits the steer steps. */
  steer?: boolean | undefined;
  /** D2 two-way steering flag (input.steerReply). */
  steerReply?: boolean | undefined;
  harness?: { id?: unknown; version?: unknown } | undefined;
  harnessAttempts?: readonly { id?: unknown; version?: unknown }[] | undefined;
}

/** Harness refs a recorded run input commits to (single harness and/or attempts). */
function recordedHarnessRefs(input: RecordedHarness | undefined): Array<{ id: string; version: string }> {
  const refs: Array<{ id: string; version: string }> = [];
  // Runs recorded before harnesses were pluggable carry no `harness`: native.
  if (input?.harness === undefined) refs.push({ id: "native", version: "1" });
  else
    refs.push({
      id: typeof input.harness.id === "string" ? input.harness.id : "",
      version: typeof input.harness.version === "string" ? input.harness.version : "",
    });
  for (const attempt of input?.harnessAttempts ?? [])
    refs.push({ id: typeof attempt.id === "string" ? attempt.id : "", version: typeof attempt.version === "string" ? attempt.version : "" });
  return refs;
}

/** Harness ids a recorded run input commits to (single harness and/or attempts). */
export function recordedHarnessIds(input: RecordedHarness | undefined): string[] {
  return recordedHarnessRefs(input).map((ref) => ref.id);
}

/**
 * True only when EVERY harness the run may execute under supports the capability.
 *
 * For steering (the one capability today), an external harness supports it
 * only from adapter contract 2 on: the @1 adapters read nothing but the
 * starting prompt, and a note accepted for one of their runs would be stored,
 * acknowledged and never read — the exact bug this gate exists to prevent. A
 * missing version means a pre-contract log (or a hand-built input), which is
 * refused: the safe answer for a run whose program is unknown.
 */
export function harnessSupports(input: RecordedHarness | undefined, capability: HarnessCapability): boolean {
  void capability; // only "steer" exists today; it maps to the declared steering capability
  return recordedHarnessRefs(input).every((ref) => {
    if (ref.id === "native") return capabilityOf(ref.id, "steering").status === "supported";
    return ref.version !== "" && ref.version !== "1" && capabilityOf(ref.id, "steering").status === "supported";
  });
}

/** Shown when an external-harness run was enqueued without the steer flag: the adapter records no steer steps, so no note would ever be read. */
export const STEER_NOT_ENABLED_MESSAGE =
  "This run was started without mid-run steering enabled, so its harness would never read a message. Cancel it and start a follow-up instead.";

/** Shown once an external harness has stopped reading steering: a note accepted now would be stored, acknowledged and never delivered. */
export const STEER_CLOSED_MESSAGE =
  "This run's agent has stopped taking mid-run messages (its steering window closed). Start a follow-up instead.";

/**
 * Why the steer route must refuse a note for this run, or undefined when it
 * may be queued. `loopExited` is true once the external adapter recorded its
 * final steer step (`harness-steer-undelivered`): nothing drains after that.
 * Native runs drain on every turn, so the closed-window arm is external-only.
 */
export function steerRefusal(input: RecordedHarness | undefined, loopExited = false): string | undefined {
  if (!harnessSupports(input, "steer")) return STEER_UNSUPPORTED_MESSAGE;
  const external = recordedHarnessIds(input).some((id) => id !== "native");
  if (external && input?.steer !== true) return STEER_NOT_ENABLED_MESSAGE;
  if (external && loopExited) return STEER_CLOSED_MESSAGE;
  return undefined;
}

/**
 * Why a queued message or an interrupt must be refused for this run, or
 * undefined when it may be held. Needs the D2 enqueue flag AND an all-native
 * run: the external adapter never claims held notes.
 */
export function steerReplyRefusal(input: RecordedHarness | undefined): string | undefined {
  if (recordedHarnessIds(input).some((id) => id !== "native")) return STEER_REPLY_EXTERNAL_MESSAGE;
  if (input?.steerReply !== true) return STEER_REPLY_UNSUPPORTED_MESSAGE;
  return undefined;
}

/**
 * True once an external adapter's steer loop has finished. A single-harness
 * run is done at its `harness-steer-undelivered` step; a multi-attempt run is
 * done once the FINAL attempt recorded its own closing step (earlier attempts'
 * windows ending says nothing about the attempt still running).
 */
export function steerLoopExited(
  input: RecordedHarness | undefined,
  events: readonly { type: string; name?: string | undefined }[],
): boolean {
  const attempts = input?.harnessAttempts?.length ?? 0;
  const closing = attempts >= 2 ? `attempt-${attempts - 1}-harness-steer-undelivered` : "harness-steer-undelivered";
  return events.some((e) => e.type === "step-completed" && e.name === closing);
}
