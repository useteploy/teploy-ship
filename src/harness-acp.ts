import type { ExecResult } from "@neutron-build/agents";

import { HARNESS_PACKAGES, HARNESS_VERSIONS } from "./harness.js";
import type { HarnessAdapter, HarnessResult, HarnessStatus, HarnessUsage } from "./harness.js";
import { PLAN_REVIEW_REFUSAL, refusalFor } from "./harness-capabilities.js";
import { clipDetail } from "./live.js";
import type { LiveUpdate } from "./live.js";
import {
  egressEntryForBaseURL,
  externalHarnessConfig,
  externalPrompt,
  forwardEnv,
  lineBuffered,
  mergeDerivedEgress,
  preflight as harnessPreflight,
  shq,
} from "./harness-external.js";
import type { LiveTracker } from "./harness-external.js";
import { ACP_WORKSPACE_EXCLUDES, excludeCommand } from "./git.js";
import { acpBrowserMcpServers, ensureRunBrowserSession, harnessBrowserPromptNote, harnessBrowserWiring } from "./harness-browser.js";
import { egressEntryError } from "./egress.js";
import { exactScrubber, scrubExact } from "./redact.js";
import type { KnownSecret } from "./redact.js";

/**
 * The generic ACP harness (E7 H3, SHIP_ACP_HARNESS).
 *
 * One adapter drives every ACP-speaking agent: the whole session —
 * initialize, session/new, the prompt, streaming updates, permission
 * requests, cancellation — runs inside ONE sandbox exec because Ship's exec
 * has no stdin. The bidirectional half lives in the in-sandbox driver
 * `images/acp-driver/ship-acp.mjs` (baked into the images at
 * /usr/local/bin/ship-acp): it spawns the agent over stdio, answers
 * permission requests from the fail-closed policy ported from T3 Code's
 * clientPolicy (workspace reads/writes only, symlink-safe realpath
 * containment, allow_once/reject_once only — never allow_always), and prints
 * Ship's own JSONL on stdout, which this adapter parses into the harness
 * result exactly the way the bespoke adapters parse vendor streams.
 *
 * What a bespoke adapter re-derives per vendor — session ids, resume,
 * permission handling, event shapes — the ACP session standardises, so each
 * agent here is a thin PROFILE: binary, launch args, credential env names,
 * provider egress hosts. The contracts behind the profiles are the H0
 * receipts (evals/receipts/2026-10-18-acp-*.txt): every pinned agent
 * negotiated protocolVersion 1, which is all the driver speaks.
 *
 * Same two recorded steps as the external adapters (harness-preflight,
 * harness-run), same exec-env credential delivery and exact-value scrub
 * (H1), same egress derivation shape via a per-profile host list. The
 * initialize result — protocol version negotiated, advertised auth methods,
 * loadSession — is recorded on the run step as `capabilities`: the per-run
 * capability record, durable in the log the way the preflight version is.
 *
 * Not in this slice: steering (H5, session/load at process boundaries —
 * refused in harness-capabilities.ts until then), the plan phase (H8), Pi
 * (RPC, not ACP; H6), registry-agent installs (H9).
 */

/** The ACP protocol version the driver offers and accepts (images/acp-driver/ship-acp.mjs). */
export const ACP_PROTOCOL_VERSION = 1;

export const ACP_HARNESS_FLAG = "SHIP_ACP_HARNESS";

const ACP_SPEC_PATH = ".teploy-agent/acp-run.json";
const ACP_PROMPT_PATH = ".teploy-agent/acp-prompt.md";

/** One ACP agent Ship can drive: everything agent-specific lives here. */
export interface AcpProfile {
  /** Harness id (HARNESS_VERSIONS key, project record value). */
  id: string;
  /** Executable on PATH inside the sandbox image. */
  binary: string;
  /** ACP launch args, exactly as the H0 receipts measured them. */
  args: readonly string[];
  /** K-class credential env names (forwarded, never recorded by value). */
  envNames: readonly string[];
  /**
   * Which forwarded env names are CREDENTIALS for the enqueue gate. Absent
   * means every name in envNames is one. qwen sets it: its documented
   * headless pair is a key plus QWEN_BASE_URL, and a base URL alone must
   * not admit a keyless run.
   */
  credentialEnvNames?: readonly string[];
  /**
   * Vendor env names that relocate the agent's state directory (checked
   * against each vendor's docs/receipt). The adapter also points HOME at
   * the same per-exec directory, which covers every agent that follows it;
   * these cover the ones with an explicit override.
   */
  homeEnv?: readonly string[];
  /**
   * Which forwarded key admits which provider host (egress derivation).
   * `baseEnv` names a forwarded env whose URL VALUE reroutes the provider:
   * its host replaces this group's defaults (which the agent will not dial),
   * the same rule the bespoke adapters' PROVIDER_EGRESS bases follow.
   */
  egress: ReadonlyArray<{ envs: readonly string[]; hosts: readonly string[]; baseEnv?: string }>;
  /**
   * Worker-side name -> agent-exec name for env the exec must carry under a
   * DIFFERENT name than the worker's (acpForwardEnv applies it). qwen-code
   * 0.25.2 reads OPENAI_API_KEY and OPENAI_BASE_URL for env-only auth —
   * DASHSCOPE_API_KEY works only through a settings.json
   * modelProviders.envKey entry, and the per-exec HOME this adapter pins
   * carries no settings.json — so the profile forwards its OWN worker-side
   * names and renames them at the boundary: an operator's OPENAI_* values
   * (carried on the worker for codex/opencode) never ride a qwen exec, and
   * the qwen values never masquerade as the operator's on the worker side.
   */
  envMap?: Readonly<Record<string, string>>;
  /**
   * The authenticate methodId for the profile's env key, when the agent
   * advertises one (gemini "gemini-api-key"). Absent when the agent's only
   * advertised methods are interactive logins (grok.com, cursor_login) —
   * those are H4/H6/H7 questions, and a headless authenticate attempt
   * without a method is refused by the driver rather than guessed at.
   */
  authMethodId?: string;
}

/**
 * The known ACP profiles. Binary + args + auth facts come from the H0
 * receipts at the pinned versions; egress hosts are the receipts' bundle
 * string evidence (not wire measurements — the empty-allowlist sandbox
 * measurement is the follow-up).
 *
 * gemini is the profile wired end to end in this slice. grok, cursor and
 * qwen are declared behind the same flag: their real-binary journeys are H4
 * (grok's API-key authenticate path is not an advertised method), H6
 * (cursor is a registry binary, not npm — no image bakes it until H9) and
 * H9 (qwen is the registry-agent shape). Their adapters run the same code;
 * a sandbox image that lacks the binary stops at preflight, as ever.
 *
 * grok launches in its ASKING mode (--permission-mode default, never
 * --always-approve): an agent started in always-approve never asks, and the
 * permission gate this harness exists to run would silently stop existing.
 */
export const ACP_PROFILES: Record<string, AcpProfile> = {
  gemini: {
    id: "gemini",
    binary: "gemini",
    args: ["--acp"],
    envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    homeEnv: ["GEMINI_CLI_HOME"],
    egress: [
      // GOOGLE_API_KEY is gemini-cli's documented fallback key for the SAME
      // Developer-API endpoint (GEMINI_API_KEY wins when both are set), so it
      // derives the same host. A real Vertex deployment — selected auth,
      // region-prefixed <region>-aiplatform.googleapis.com hosts — cannot be
      // enumerated here and puts the host on the project record, as ever.
      { envs: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], hosts: ["generativelanguage.googleapis.com"] },
    ],
    authMethodId: "gemini-api-key",
  },
  grok: {
    id: "grok",
    binary: "grok",
    args: ["--permission-mode", "default", "agent", "stdio"],
    envNames: ["XAI_API_KEY"],
    homeEnv: ["GROK_HOME"],
    egress: [{ envs: ["XAI_API_KEY"], hosts: ["api.x.ai"] }],
  },
  cursor: {
    id: "cursor",
    binary: "cursor-agent",
    args: ["acp"],
    envNames: ["CURSOR_API_KEY"],
    egress: [{ envs: ["CURSOR_API_KEY"], hosts: ["api2.cursor.sh"] }],
  },
  qwen: {
    id: "qwen",
    binary: "qwen",
    args: ["--acp"],
    // qwen's OWN worker-side pair — NOT OPENAI_API_KEY/OPENAI_BASE_URL,
    // which an operator carries for codex/opencode: forwarding those would
    // hand an operator's OpenAI values to a different vendor's agent and its
    // sandbox. The exec renames them to what qwen-code actually reads
    // (envMap below): qwen-code 0.25.2 authenticates env-only through
    // OPENAI_API_KEY — DASHSCOPE_API_KEY works only via a settings.json
    // modelProviders.envKey entry, and the per-exec HOME has no settings.
    envNames: ["DASHSCOPE_API_KEY", "QWEN_BASE_URL"],
    credentialEnvNames: ["DASHSCOPE_API_KEY"],
    envMap: { DASHSCOPE_API_KEY: "OPENAI_API_KEY", QWEN_BASE_URL: "OPENAI_BASE_URL" },
    homeEnv: ["QWEN_HOME"],
    egress: [
      {
        envs: ["DASHSCOPE_API_KEY"],
        hosts: ["dashscope.aliyuncs.com", "coding.dashscope.aliyuncs.com", "coding-intl.dashscope.aliyuncs.com"],
        // qwen's documented base-URL override (worker-side name; the exec
        // carries it as OPENAI_BASE_URL): its host replaces the Dashscope
        // defaults the agent will not dial when it is set.
        baseEnv: "QWEN_BASE_URL",
      },
    ],
  },
};

/** Every harness id this adapter drives (a subset of HARNESS_VERSIONS). */
export const ACP_HARNESS_IDS: readonly string[] = Object.keys(ACP_PROFILES);

export function isAcpHarness(id: string): boolean {
  return Object.hasOwn(ACP_PROFILES, id);
}

/** On only for an explicit "on" (or 1/true). Anything else, including unset, is off. */
export function acpHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true)$/i.test((env[ACP_HARNESS_FLAG] ?? "").trim());
}

/**
 * Why an ACP harness ref cannot be enqueued on this deployment, or undefined
 * when it may be. The flag first (the ids do not exist for an operator who
 * has not turned the feature on), then the profile credential: a run whose
 * agent has no key dies inside the sandbox after the clone, which is the
 * expensive way to learn it. Mirrors the H1/H2 refusal pattern — thrown at
 * enqueue, before `store.append`, so no ghost run is left explaining itself.
 */
export function acpEnqueueRefusal(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isAcpHarness(id)) return undefined;
  if (!acpHarnessEnabled(env)) {
    return (
      `harness "${id}" is an ACP harness and this deployment has SHIP_ACP_HARNESS off. ` +
      `Set SHIP_ACP_HARNESS=on on the worker (and build an image that bakes it — images/build.sh) or select another harness.`
    );
  }
  const profile = ACP_PROFILES[id]!;
  const config = externalHarnessConfig(id, env);
  // The gate asks for a CREDENTIAL (credentialEnvNames, default envNames):
  // qwen also forwards QWEN_BASE_URL, and a base URL alone must not admit
  // a keyless run — it would die inside the sandbox after the clone, the
  // expensive thing this gate exists to prevent.
  const credentials = profile.credentialEnvNames ?? profile.envNames;
  const held = config.forward.filter((name) => credentials.includes(name) && (env[name] ?? "").trim() !== "");
  if (held.length === 0) {
    return (
      `harness "${id}" has no credential to run with: none of ${credentials.join(", ")} is set on the worker ` +
      `(a sealed per-project credential store is the H2 follow-up). Set one, or adjust SHIP_HARNESS_ENV, then enqueue again.`
    );
  }
  return undefined;
}

/**
 * The enqueue gate for every harness ref a run may execute under (single
 * harness and attempts). Throws before anything is recorded when one is an
 * unadmitted ACP id — the same before-append rule the plan-review refusal
 * follows.
 */
export function assertAcpHarnessAdmitted(refs: readonly { id: string }[], env: NodeJS.ProcessEnv = process.env): void {
  for (const ref of refs) {
    const refusal = acpEnqueueRefusal(ref.id, env);
    if (refusal !== undefined) throw new Error(refusal);
  }
}

/**
 * The provider hosts a set of ACP refs will dial from inside the sandbox,
 * derived per profile from the same forwarded env the driver's agent will
 * read — hosts only, port 443, order preserved. Nothing derives without the
 * key actually held, so an unconfigured deployment's inputs are byte-identical.
 */
export function acpProviderEgressAllow(refs: readonly { id: string }[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const push = (entry: string): void => {
    if (!out.includes(entry)) out.push(entry);
  };
  for (const ref of refs) {
    const profile = ACP_PROFILES[ref.id];
    if (profile === undefined) continue;
    const config = externalHarnessConfig(ref.id, env);
    const held = (name: string): boolean => config.forward.includes(name) && (env[name] ?? "").trim() !== "";
    for (const group of profile.egress) {
      // A base-URL override reroutes the provider: its host replaces this
      // group's defaults, and even an unusable URL suppresses them — the
      // agent dials the configured value, not the vendor hosts, so guessing
      // the defaults beside it would be wrong in the other direction (the
      // rule withProviderEgress's bases follow, harness-external.ts).
      if (group.baseEnv !== undefined && held(group.baseEnv)) {
        const entry = egressEntryForBaseURL(env[group.baseEnv] ?? "");
        if (entry !== undefined) push(entry);
        continue;
      }
      if (!group.envs.some(held)) continue;
      for (const host of group.hosts) {
        const entry = `${host.toLowerCase()}:443`;
        if (egressEntryError(entry) === null) push(entry);
      }
    }
  }
  return out;
}

/**
 * A run's explicit allowlist plus the ACP profiles' derived hosts, under the
 * same merge discipline as withProviderEgress (harness-external.ts). With no
 * ACP ref or nothing derivable it returns `explicit` unchanged — the
 * byte-identical fence for every pre-ACP run.
 */
export function withAcpProviderEgress(
  explicit: string[] | undefined,
  refs: readonly { id: string }[],
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  return mergeDerivedEgress(explicit, acpProviderEgressAllow(refs, env));
}

// ---------------------------------------------------------------------------
// Parsing the driver's JSONL
// ---------------------------------------------------------------------------

/** The initialize result, recorded per run: what the agent actually negotiated. */
export interface AcpCapabilitiesRecord {
  /** What the driver offered and what the agent answered (both 1 today). */
  offered: number;
  protocolVersion: number | null;
  agentInfo: { name: string | null; version: string | null };
  loadSession: boolean | null;
  sessionCapabilities: Record<string, unknown> | null;
  /** Advertised auth method ids, verbatim — the H2 gate decides on this fact. */
  authMethodIds: string[];
}

export interface AcpPermissionTally {
  allowed: number;
  denied: number;
  /** "kind path: reason" per denial, capped — claims made inside the sandbox. */
  denials: string[];
}

/** The recorded shape of the run step. */
export interface AcpHarnessRunRecord {
  exitCode: number;
  timedOut: boolean;
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  /** Which forwarded env NAMES were present (never values). */
  forwarded: string[];
  stderrTail: string;
  /** The ACP session id (session/new's answer), for H5 steering. */
  sessionId?: string;
  /** The initialize result (the per-run capability record). */
  capabilities?: AcpCapabilitiesRecord;
  /** Paths edit/move/delete tool calls claimed, capped (a claim, not evidence). */
  fileChanges?: string[];
  /** How many execute-kind tool calls ran. */
  commands?: number;
  /** Every permission decision the driver made. */
  permissions?: AcpPermissionTally;
}

function acpStopStatus(reason: string): HarnessStatus {
  if (reason === "end_turn") return "finished";
  if (reason === "max_tokens" || reason === "max_turn_requests") return "max-steps";
  // refusal and cancelled both mean the turn produced no deliverable.
  return "error";
}

/**
 * Parse the driver's JSONL (one event per line) into the run record's facts.
 * The event vocabulary is ship-acp's own (start/capabilities/session/text/
 * tool/permission/usage/stop/error), so this parser is stable across agents
 * in a way the bespoke vendor parsers cannot be.
 */
export function parseAcpStream(stdout: string): {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  sawStop: boolean;
  sessionId?: string;
  capabilities?: AcpCapabilitiesRecord;
  fileChanges: string[];
  commands: number;
  permissions: AcpPermissionTally;
  error?: string;
} {
  let sessionId: string | undefined;
  let capabilities: AcpCapabilitiesRecord | undefined;
  let sawStop = false;
  let stopStatus: HarnessStatus = "error";
  let error: string | undefined;
  let commands = 0;
  const tools = new Set<string>();
  const fileChanges: string[] = [];
  const messages: Array<{ id: string; text: string }> = [];
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false };
  const permissions: AcpPermissionTally = { allowed: 0, denied: 0, denials: [] };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event.type) {
      case "capabilities": {
        const info = (event.agentInfo ?? {}) as Record<string, unknown>;
        const caps = (event.agentCapabilities ?? {}) as Record<string, unknown>;
        const sessionCaps = caps.sessionCapabilities;
        capabilities = {
          offered: num(event.offered),
          protocolVersion: typeof event.protocolVersion === "number" ? event.protocolVersion : null,
          agentInfo: {
            name: typeof info.name === "string" ? info.name : null,
            version: typeof info.version === "string" ? info.version : null,
          },
          loadSession: typeof caps.loadSession === "boolean" ? caps.loadSession : null,
          sessionCapabilities:
            sessionCaps !== null && typeof sessionCaps === "object" && !Array.isArray(sessionCaps)
              ? (sessionCaps as Record<string, unknown>)
              : null,
          authMethodIds: (Array.isArray(event.authMethods) ? (event.authMethods as Record<string, unknown>[]) : [])
            .map((method) => (typeof method?.id === "string" ? method.id : ""))
            .filter((id) => id !== ""),
        };
        break;
      }
      case "session":
        if (typeof event.sessionId === "string" && event.sessionId !== "") sessionId = event.sessionId;
        break;
      case "text": {
        const text = typeof event.text === "string" ? event.text : "";
        if (text === "") break;
        const id = typeof event.messageId === "string" && event.messageId !== "" ? event.messageId : "";
        const existing = messages.find((m) => m.id === id);
        if (existing === undefined) messages.push({ id, text });
        else existing.text += text; // chunks of one message accumulate
        break;
      }
      case "tool": {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (id !== "") tools.add(id);
        const kind = typeof event.kind === "string" ? event.kind : "";
        if (kind === "execute") commands += 1;
        const status = typeof event.status === "string" ? event.status : "";
        const locations = Array.isArray(event.locations) ? (event.locations as unknown[]) : [];
        if (status === "completed" && (kind === "edit" || kind === "move" || kind === "delete")) {
          for (const path of locations.slice(0, 200)) {
            if (typeof path === "string" && fileChanges.length < 200) fileChanges.push(`${kind} ${path}`);
          }
        }
        break;
      }
      case "permission": {
        const decision = event.decision === "allow" ? "allow" : "deny";
        if (decision === "allow") permissions.allowed += 1;
        else {
          permissions.denied += 1;
          if (permissions.denials.length < 50) {
            const locations = Array.isArray(event.locations) ? (event.locations as unknown[]) : [];
            const path = typeof locations[0] === "string" ? locations[0] : "(no locations)";
            permissions.denials.push(`${typeof event.kind === "string" ? event.kind : "other"} ${path}: ${typeof event.reason === "string" ? event.reason : "denied"}`);
          }
        }
        break;
      }
      case "usage": {
        const u = (event.usage ?? {}) as Record<string, unknown>;
        usage.inputTokens = num(u.inputTokens);
        usage.outputTokens = num(u.outputTokens) + num(u.thoughtTokens);
        usage.cacheReadTokens = num(u.cachedReadTokens);
        usage.cacheWriteTokens = num(u.cachedWriteTokens);
        // The agent's own total when it reports one; the sum otherwise.
        usage.totalTokens = num(u.totalTokens) > 0 ? num(u.totalTokens) : usage.inputTokens + usage.outputTokens + num(u.cachedReadTokens) + num(u.cachedWriteTokens);
        break;
      }
      case "stop":
        sawStop = true;
        stopStatus = acpStopStatus(typeof event.reason === "string" ? event.reason : "");
        break;
      case "error":
        if (error === undefined) error = typeof event.message === "string" ? event.message : JSON.stringify(event);
        break;
      default:
        break;
    }
  }
  // No ACP agent reports dollars; tokens without dollars is the unpriced
  // shape (P5-3), exactly the codex rule.
  usage.priced = false;
  const last = messages.length > 0 ? messages[messages.length - 1]! : undefined;
  const base = {
    summary: (last?.text ?? "").trim().slice(0, 4000),
    turns: tools.size,
    usage,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    fileChanges,
    commands,
    permissions,
  };
  if (error !== undefined) return { ...base, status: "error", summary: `ship-acp reported: ${error.slice(0, 800)}`, sawStop, error };
  if (!sawStop) return { ...base, status: "error", summary: "the ACP session produced no stop event", sawStop, error: "no stop" };
  return { ...base, status: stopStatus, sawStop };
}

/**
 * The live feed over the driver's JSONL, the codex-tracker shape: a new tool
 * ticks the turn, tool and permission events become one-line details.
 */
export function acpLiveTracker(): LiveTracker {
  let turns = 0;
  const seen = new Set<string>();
  return lineBuffered((event) => {
    if (event.type === "tool") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      let update: LiveUpdate | null = null;
      if (id !== "" && !seen.has(id)) {
        seen.add(id);
        turns += 1;
        update = { phase: "harness", turn: turns };
      }
      const kind = typeof event.kind === "string" && event.kind !== "" ? event.kind : "tool";
      const title = typeof event.title === "string" && event.title !== "" ? event.title : "";
      return { phase: "harness", turn: turns, detail: `${kind}${title !== "" ? ` ${clipDetail(title, 100)}` : ""}` };
    }
    if (event.type === "permission") {
      return {
        phase: "harness",
        turn: turns,
        detail: `permission ${typeof event.kind === "string" ? event.kind : "?"}: ${event.decision === "allow" ? "allowed" : "denied"}`,
      };
    }
    if (event.type === "text" && typeof event.text === "string" && event.text.trim() !== "") {
      return { phase: "harness", turn: turns, detail: clipDetail(event.text, 120) };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AcpHarnessOptions {
  /** The worker's environment — credentials to forward and tuning. */
  env?: NodeJS.ProcessEnv;
}

function tail(text: string, max = 1500): string {
  return text.length <= max ? text : text.slice(-max);
}

function errorResult(summary: string): HarnessResult {
  return {
    status: "error",
    summary,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
    incomplete: true,
  };
}

/**
 * The driver command. Inside a baked image that is /usr/local/bin/ship-acp;
 * SHIP_ACP_DRIVER overrides the whole command (tests and probes point it at
 * the repo copy, `node images/acp-driver/ship-acp.mjs`). The override is a
 * worker fact recorded in the command the step carries, never an input one.
 */
function driverCommand(env: NodeJS.ProcessEnv): string {
  const override = (env.SHIP_ACP_DRIVER ?? "").trim();
  return override !== "" ? override : "ship-acp";
}

/**
 * The agent's per-exec home: a fresh directory under /tmp, outside /work.
 *
 * The sandbox's own HOME is not writable (the same fact that pushes pnpm's
 * store into the worktree, src/git.ts), and without this every vendor keeps
 * its session store — ~/.gemini/tmp, ~/.qwen, ~/.grok: tool output, possibly
 * secrets — under whatever HOME the exec inherits, where it rests in the
 * container and in park snapshots of it. Named from the run and attempt so
 * the finally below can belt-delete one a timed-out exec left behind; the
 * command itself creates and removes it in the same shell, so no window
 * survives even a hard kill.
 */
function agentHomePath(runId: string, prefix: string): string {
  return `/tmp/ship-acp-home-${`${runId}${prefix}`.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** The shell that runs the driver with the agent's home pinned to that directory. */
function agentHomeCommand(home: string, vars: readonly string[], driver: string): string {
  const exports = ["HOME", ...vars].map((name) => `${name}=${shq(home)}`).join(" ");
  return `h=${shq(home)}; rm -rf "$h"; mkdir -m 700 "$h" || exit 1; export ${exports}; ${driver}; rc=$?; rm -rf "$h"; exit $rc`;
}

/**
 * The env one ACP exec carries, under the names the AGENT reads.
 *
 * profile.envMap renames worker-side names to agent-side ones BEFORE
 * forwardEnv builds the carriers, so a multi-line value rides the base64
 * carrier of the name the agent sees; and every mapped TARGET is deleted
 * from the copy when its source is unset — an operator's value of an
 * agent-side name (an OPENAI_API_KEY carried for codex, an OPENAI_BASE_URL
 * for opencode) can never ride a qwen exec by accident. The returned names
 * and secrets are the exec's own (agent-side): secretEnvNames must name
 * what exists inside the sandbox for the driver to scrub, and the record's
 * `forwarded` list says what the exec actually carried.
 */
export function acpForwardEnv(profile: AcpProfile, forward: readonly string[], env: NodeJS.ProcessEnv) {
  const envMap = profile.envMap ?? {};
  if (Object.keys(envMap).length === 0) return forwardEnv([...forward], env);
  const source: NodeJS.ProcessEnv = { ...env };
  for (const [from, to] of Object.entries(envMap)) {
    if (source[from] !== undefined) source[to] = source[from];
    else delete source[to]; // never the operator's value of the agent-side name
    delete source[from]; // the worker-side name does not ride along
  }
  return forwardEnv(
    forward.map((name) => envMap[name] ?? name),
    source,
  );
}

export function acpAdapter(id: string, options: AcpHarnessOptions = {}, version: string = HARNESS_VERSIONS[id]!): HarnessAdapter {
  const profile = ACP_PROFILES[id];
  if (profile === undefined) throw new Error(`no ACP profile for harness "${id}"`);
  const env = options.env ?? process.env;
  return {
    id,
    version,
    isolated: true,
    async run(task, ws, budget, onEvent): Promise<HarnessResult> {
      const p = ws.stepPrefix;
      onEvent({ kind: "started", harness: id });
      const pre = await ws.ctx.step(`${p}harness-preflight`, () => harnessPreflight(ws.executor, id, profile.binary));
      if (!pre.found) {
        const result = errorResult(`${pre.detail ?? `${profile.binary} was not found`} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      const record = await ws.ctx.step(`${p}harness-run`, async (): Promise<AcpHarnessRunRecord> => {
        const config = externalHarnessConfig(id, env);
        const forwarded = acpForwardEnv(profile, config.forward, env);
        // The driver and the agent both inherit the forwarded credentials, so
        // either printing them puts them in the output. Every value Ship
        // handed over (plus the run's forge token) is replaced before the
        // output is parsed, recorded or shown live — and the driver scrubs
        // inside the sandbox before that (H1, both sides of the boundary).
        const secrets: KnownSecret[] = [...forwarded.secrets, ...(ws.secrets ?? [])];
        const baseUsage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false };
        // Same admission guard as the external adapters: an operator's plan
        // gate is a recorded error RESULT, not a silently skipped harness.
        if (task.input.plan === true && task.input.mode !== "scan") {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: `${refusalFor(id, "plan-review") ?? PLAN_REVIEW_REFUSAL} No external agent was started.`,
            turns: 0,
            usage: baseUsage,
            forwarded: forwarded.names,
            stderrTail: "",
          };
        }
        // SHIP_HARNESS_BROWSER (harness-browser.ts): the same tier/plan gates
        // the native look action reads. Wired, the shared Chromium session
        // must be up before the driver exec — the AGENT spawns the MCP server
        // from session/new's mcpServers, and that server attaches over CDP —
        // and the spec carries the server for the driver to send. Refused,
        // the prompt says so: an agent that goes looking for browser tools
        // that were never configured burns its turns discovering it.
        const browser = harnessBrowserWiring(task.input, env);
        if (browser.kind === "wired") {
          const session = await ensureRunBrowserSession(ws.executor);
          if (!session.ok) {
            return {
              exitCode: -1,
              timedOut: false,
              status: "error",
              summary: `the browser was requested (SHIP_HARNESS_BROWSER=on) but ${session.reason} No external agent was started.`,
              turns: 0,
              usage: baseUsage,
              forwarded: forwarded.names,
              stderrTail: "",
            };
          }
        }
        try {
          await ws.executor.putFile(ACP_PROMPT_PATH, externalPrompt(task.prompt, task.input.mode) + harnessBrowserPromptNote(browser));
          // The vendor-state excludes ride the ACP run, not the checkout
          // (git.ts ACP_WORKSPACE_EXCLUDES): repos legitimately commit
          // .gemini/settings.json, so the global list must not hide them —
          // only an ACP agent writes those directories uninvited, and only
          // its runs exclude them. Best effort: a workspace with no .git has
          // no commit to keep them out of, and the per-exec home stays the
          // boundary either way.
          await ws.executor.exec(excludeCommand(ACP_WORKSPACE_EXCLUDES), { timeoutMs: 30_000 }).catch(() => {});
          const cancelGraceMs = Number(env.SHIP_ACP_CANCEL_GRACE_MS);
          await ws.executor.putFile(
            ACP_SPEC_PATH,
            JSON.stringify({
              v: 1,
              profile: id,
              binary: profile.binary,
              args: profile.args,
              cwd: ws.workdir,
              promptPath: ACP_PROMPT_PATH,
              maxSteps: budget.maxSteps,
              timeoutMs: config.timeoutMs,
              ...(Number.isFinite(cancelGraceMs) && cancelGraceMs > 0 ? { cancelGraceMs } : {}),
              secretEnvNames: forwarded.names,
              ...(profile.authMethodId !== undefined ? { authMethodId: profile.authMethodId } : {}),
              // The browser MCP server for session/new (SHIP_HARNESS_BROWSER,
              // wired above): stdio shape, every required field present.
              ...(browser.kind === "wired" ? { mcpServers: acpBrowserMcpServers() } : {}),
            }),
          );
          const execOptions = {
            timeoutMs: config.timeoutMs,
            maxOutputBytes: 16 * 1_048_576,
            ...(Object.keys(forwarded.env).length > 0 ? { env: forwarded.env } : {}),
          };
          const command = agentHomeCommand(agentHomePath(ws.ctx.runId, p), profile.homeEnv ?? [], `${forwarded.prelude}${driverCommand(env)}`);
          ws.live?.({ phase: "harness", turn: 0, detail: `${profile.binary} starting (ACP)` });
          const tracker = acpLiveTracker();
          const liveScrub = exactScrubber(secrets);
          const feedLive = (chunk: string): void => {
            if (chunk === "") return;
            const update = tracker.feed(chunk);
            if (update !== null) ws.live?.(update);
          };
          const raw =
            ws.execStream !== undefined
              ? await ws.execStream(command, execOptions, (stream, chunk) => {
                  if (stream === "stdout") feedLive(liveScrub.push(chunk));
                })
              : await ws.executor.exec(command, execOptions);
          feedLive(liveScrub.flush());
          const exec: ExecResult = { ...raw, stdout: scrubExact(raw.stdout, secrets), stderr: scrubExact(raw.stderr, secrets) };
          const parsed = parseAcpStream(exec.stdout);
          const timedOut = exec.timedOut === true;
          // The scrub above runs over the raw stream, where a credential the
          // agent streamed as two message chunks exists only as two
          // unrecognisable halves; parseAcpStream then JOINS the chunks, and
          // the joined text is what the record carries — so the joined
          // summary (and the error text inside it) is scrubbed here, after
          // the join, where the whole value finally appears.
          const summary = scrubExact(
            timedOut
              ? `the ACP session did not finish within ${Math.round(config.timeoutMs / 60_000)} minutes`
              : parsed.error !== undefined
                ? parsed.summary
                : parsed.summary === ""
                  ? `${profile.binary} finished without a message`
                  : parsed.summary,
            secrets,
          );
          return {
            exitCode: exec.exitCode,
            timedOut,
            status: timedOut ? "error" : parsed.status,
            summary,
            turns: parsed.turns,
            usage: parsed.usage,
            forwarded: forwarded.names,
            stderrTail: tail(exec.stderr),
            ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
            ...(parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {}),
            ...(parsed.fileChanges.length > 0 ? { fileChanges: parsed.fileChanges } : {}),
            commands: parsed.commands,
            permissions: parsed.permissions,
          };
        } catch (error) {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: scrubExact(`${profile.binary} could not be run: ${error instanceof Error ? error.message : String(error)}`, secrets),
            turns: 0,
            usage: baseUsage,
            forwarded: forwarded.names,
            stderrTail: "",
          };
        } finally {
          // Belt for the home teardown inside the command: a timed-out exec
          // kills the shell before its own `rm -rf` runs, and this step's
          // scratch must not outlive the attempt. The spec and prompt go too.
          await ws.executor
            .exec(`rm -f ${shq(ACP_SPEC_PATH)} ${shq(ACP_PROMPT_PATH)}; rm -rf ${shq(agentHomePath(ws.ctx.runId, p))}`, { timeoutMs: 30_000 })
            .catch(() => {});
        }
      });
      for (let turn = 0; turn < record.turns; turn++) onEvent({ kind: "turn", turn });
      onEvent({ kind: "completed", status: record.status });
      return {
        status: record.status,
        summary: record.summary,
        turns: record.turns,
        usage: record.usage,
        incomplete: record.status !== "finished",
      };
    },
  };
}

/**
 * Every ACP adapter this worker can carry, always registered: presence is
 * per-run (a run names the harness at enqueue, gated by SHIP_ACP_HARNESS
 * there) and a worker whose flag is off must still replay the runs an
 * on-flag worker recorded — selectAdapter refuses by version, never by
 * absence. A missing binary stops at preflight, as with every harness.
 */
export function acpAdapters(options: AcpHarnessOptions = {}): HarnessAdapter[] {
  return ACP_HARNESS_IDS.map((id) => acpAdapter(id, options));
}
