import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { HARNESS_ALIAS_VERSIONS, HARNESS_PACKAGES, HARNESS_VERSIONS } from "./harness.js";
import { PLAN_REVIEW_REFUSAL, refusalFor } from "./harness-capabilities.js";
import {
  CLAUDE_MCP_CONFIG_PATH,
  type HarnessBrowserWiring,
  claudeMcpConfig,
  codexMcpConfigFlags,
  ensureRunBrowserSession,
  harnessBrowserPromptNote,
  harnessBrowserWiring,
  isHarnessBrowserMcpServer,
  opencodeConfigWithBrowser,
} from "./harness-browser.js";
import type { HarnessCredentialRef, HarnessCredentialResolution } from "./harness-credentials.js";
import { HARNESS_CRED_FLAG, harnessCredEnabled, harnessDestinationCheck, resolveCredentialOverlay } from "./harness-credentials.js";
import type { SteerStore } from "./steer.js";
import { clipDetail } from "./live.js";
import type { LiveUpdate } from "./live.js";
import type { HarnessAdapter, HarnessResult, HarnessStatus, HarnessUsage } from "./harness.js";
import { MAX_EGRESS_ALLOW_ENTRIES, egressEntryError, normalizeEgressAllow } from "./egress.js";
import { exactScrubber, scrubExact } from "./redact.js";
import type { KnownSecret } from "./redact.js";

/**
 * External harness adapters (P5-2): Ship drives a vendor coding agent that is
 * installed in the sandbox image, in its headless mode, over the same executor
 * the native loop uses. Contracts and the documentation they come from are in
 * docs/adapters.md.
 *
 * Each attempt is TWO recorded steps — `harness-preflight` (is the binary
 * there, which version, and is that a version this adapter can drive) and
 * `harness-run` (the one exec, its parsed result) — plus, when the run asked
 * for steering and the binary's line supports it, a `harness-steer-N` /
 * `harness-resume-N` pair per delivered batch of operator notes (D6/D7): the
 * note is delivered by resuming the vendor session the run recorded, so the
 * operator's redirect lands in the agent's context rather than in a store
 * nobody reads. Those steps are input-gated on `steer` (step-fingerprint.ts),
 * so a run enqueued without it keeps the exact two-step sequence every earlier
 * log carries.
 *
 * The run step is a single exec because the sandbox API is request/response —
 * output arrives when the process ends — so the "coarse progress" an external
 * harness reports is started / completed plus the turn count parsed from its
 * event stream, not a live feed. A "turn boundary" for steering is therefore
 * a process exit: notes queued while a vendor process ran are delivered by
 * the next process, resuming the recorded session (opencode `--session`,
 * claude `--resume`). This is the T3 Code pattern (session-id discipline,
 * resume-as-steering) cut to Ship's one-shot exec model — the reference keeps
 * a live server/client pair per provider (packages/provider-opencode/src/server/v2),
 * which needs a bidirectional channel into the sandbox that Ship's executor
 * deliberately does not offer; the session store on the container's disk is
 * what makes one-shot resume equivalent for this purpose.
 *
 * What stays outside, deliberately: the publish gate, the evidence legs and
 * spend settle run after this returns, on whatever tree the harness left.
 * Ship records what the harness says about itself and treats none of it as
 * evidence.
 */

/** Env var names forwarded from the worker into the harness process, per adapter. */
export const DEFAULT_FORWARDED_ENV: Record<string, string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZHIPU_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENCODE_CONFIG_CONTENT"],
  // CODEX_API_KEY is what OpenAI documents for non-interactive exec; OPENAI_API_KEY
  // is the older spelling some deployments still carry. CODEX_ACCESS_TOKEN is the
  // subscription (ChatGPT) path — unpriced under P5-3, like claude's OAuth token.
  // AI_GATEWAY_URL/AI_GATEWAY_KEY route codex through teploy-gateway when both are
  // present: the adapter then declares a `teploy-gateway` model provider
  // (codexGatewayConfigFlags) instead of calling OpenAI directly.
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "AI_GATEWAY_URL", "AI_GATEWAY_KEY"],
  // The ACP profiles (E7 H3, src/harness-acp.ts ACP_PROFILES) carry the same
  // names per profile; a test there asserts the two tables agree. K-class
  // env keys only — the OAuth/subscription paths of these agents are H7.
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  grok: ["XAI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  // qwen's OWN worker-side pair (Dashscope key + base URL), never
  // OPENAI_API_KEY/OPENAI_BASE_URL, which the worker carries for
  // codex/opencode: harness-acp.ts renames them into the exec as the
  // OPENAI_* names qwen-code actually reads, so the operator's OpenAI
  // values never reach a qwen run.
  qwen: ["DASHSCOPE_API_KEY", "QWEN_BASE_URL"],
};

const PROMPT_PATH = ".teploy-agent/harness-prompt.md";
const STEER_PATH = ".teploy-agent/harness-steer.md";

/**
 * How many batches of steer notes one attempt will deliver: a steered attempt
 * runs at most `1 + STEER_ROUNDS_MAX` vendor processes (the main run plus this
 * many resumes). Each batch is one vendor process (up to SHIP_HARNESS_TIMEOUT_MS), so the bound is spend, not
 * correctness: the loop also stops on its own when no notes are pending or a
 * resume timed out. Recorded steps make the count replay-stable.
 */
export const STEER_ROUNDS_MAX = 3;

/**
 * The opencode v2 session id for one attempt: caller-chosen and deterministic,
 * because the server validates only the `ses` prefix but the id must be the
 * same string in the first exec and every resume — and a replay must rebuild
 * the identical command (evals/receipts/2026-10-14-opencode-v2-events.txt §3:
 * arbitrary ids are rejected despite the help text, `ses_`-prefixed ids
 * persist context across processes). T3's adapter mints ids the same way,
 * scoped per thread (packages/provider-opencode/src/server/v2/adapter.ts).
 */
export function opencodeSessionId(runId: string, prefix: string): string {
  const scope = `${runId}${prefix === "" ? "" : `:${prefix}`}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `ses_ship_${scope}`;
}

export interface ExternalHarnessOptions {
  /** The worker's environment — read for credentials to forward and for tuning. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where steer notes are drained from between vendor processes. Absent store
   * + steer-enabled input drains empty — the same degrade-not-break rule the
   * native loop follows (durable.ts), so the step sequence stays a function
   * of the input alone.
   */
  steer?: Pick<SteerStore, "drain">;
  /**
   * H2 (SHIP_HARNESS_CRED): the sealed store a run's recorded credential
   * references are unsealed from, at exec time (harness-credentials.ts).
   * Absent on a runtime with no store; a run whose input names references
   * then fails with a recorded refusal rather than running unauthenticated.
   */
  credentials?: HarnessCredentialResolution;
}

export interface ExternalHarnessConfig {
  /** Whole-attempt deadline in ms (SHIP_HARNESS_TIMEOUT_MS, default 30 min). */
  timeoutMs: number;
  /** Model passed to the harness, if any (SHIP_HARNESS_MODEL; the harness's own default otherwise). */
  model?: string;
  /** Names of worker env vars written into the harness's environment (SHIP_HARNESS_ENV overrides the default list). */
  forward: string[];
  /** Pass `--bare` to claude (SHIP_CLAUDE_BARE=1): API-key auth only, no host context. */
  claudeBare: boolean;
}

export function externalHarnessConfig(id: string, env: NodeJS.ProcessEnv = process.env): ExternalHarnessConfig {
  const timeout = Number(env.SHIP_HARNESS_TIMEOUT_MS);
  // One worker can drive several harnesses whose model names differ in shape
  // (claude on an Anthropic-compatible endpoint takes "glm-5.3"; opencode wants
  // "provider/model"). SHIP_HARNESS_MODEL_<ID> (id upper-cased, "-" -> "_")
  // wins for that harness; SHIP_HARNESS_MODEL stays the shared default.
  const perHarness = (env[`SHIP_HARNESS_MODEL_${id.toUpperCase().replace(/-/g, "_")}`] ?? "").trim();
  const model = perHarness !== "" ? perHarness : (env.SHIP_HARNESS_MODEL ?? "").trim();
  const forwardRaw = (env.SHIP_HARNESS_ENV ?? "").trim();
  const forward =
    forwardRaw === ""
      ? (DEFAULT_FORWARDED_ENV[id] ?? [])
      : forwardRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  return {
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30 * 60_000,
    ...(model !== "" ? { model } : {}),
    forward,
    claudeBare: /^(1|true|yes)$/i.test((env.SHIP_CLAUDE_BARE ?? "").trim()),
  };
}

/** Shell-quote one argument for POSIX sh. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Provider egress (P5-2 follow-up, 2026-10-17)
// ---------------------------------------------------------------------------

/**
 * Which vendor API endpoint an external harness dials, per forwarded
 * credential — the table behind `providerEgressAllow`.
 *
 * An external harness calls its model API from INSIDE the sandbox (the native
 * loop calls from the worker), so on the allowlist tier the vendor host has to
 * be on the run's own egress list or every call dies with the daemon's
 * `egress denied by the sandbox allowlist: <host>` — which is exactly the
 * production failure of 2026-10-17: a claude-code run under
 * `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` was refused
 * `api.z.ai:443` until the operator added the host to the project record by
 * hand. The table says, per harness, which base-URL variable reroutes the
 * provider (its host replaces the vendor default) and which key variables
 * select a vendor default.
 *
 * claude's OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, the subscription path) and
 * codex's `CODEX_ACCESS_TOKEN` are deliberately NOT key variables: a
 * subscription dials the vendor host too, but Ship cannot see which, and
 * guessing a host onto an allowlist is a security decision an env var should
 * not make. Those deployments put the host on the project record; the doctor's
 * `harness-egress` line says so.
 */
interface ProviderEgressSpec {
  /** Forwarded base-URL variables, each replacing one vendor default host. */
  bases: ReadonlyArray<{ env: string; replaces: string }>;
  /**
   * Vendor default hosts a forwarded key selects. `modelPrefixes` gates a
   * default on the model Ship will pass the harness — opencode's model ids
   * name their provider (`zai-coding-plan/glm-5.3`, `zhipu/…`), so the z.ai
   * key only means api.z.ai when the model actually routes there.
   */
  keys: ReadonlyArray<{ envs: readonly string[]; host: string; modelPrefixes?: readonly string[] }>;
}

const PROVIDER_EGRESS: Record<string, ProviderEgressSpec> = {
  "claude-code": {
    bases: [{ env: "ANTHROPIC_BASE_URL", replaces: "api.anthropic.com" }],
    keys: [{ envs: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], host: "api.anthropic.com" }],
  },
  codex: {
    // AI_GATEWAY_URL is the teploy-gateway route (codexGatewayConfigFlags);
    // OPENAI_BASE_URL is the generic OpenAI-compatible override.
    bases: [
      { env: "AI_GATEWAY_URL", replaces: "api.openai.com" },
      { env: "OPENAI_BASE_URL", replaces: "api.openai.com" },
    ],
    keys: [{ envs: ["CODEX_API_KEY", "OPENAI_API_KEY"], host: "api.openai.com" }],
  },
  opencode: {
    bases: [
      { env: "ANTHROPIC_BASE_URL", replaces: "api.anthropic.com" },
      { env: "OPENAI_BASE_URL", replaces: "api.openai.com" },
    ],
    keys: [
      // z.ai per models.dev: the zhipu key serves the zai-coding-plan and
      // zhipu provider ids, so the model has to name one of them.
      { envs: ["ZHIPU_API_KEY"], host: "api.z.ai", modelPrefixes: ["zai-coding-plan/", "zhipu"] },
      { envs: ["ANTHROPIC_API_KEY"], host: "api.anthropic.com" },
      { envs: ["OPENAI_API_KEY"], host: "api.openai.com" },
      { envs: ["OPENROUTER_API_KEY"], host: "openrouter.ai" },
    ],
  },
};

/** One base-URL value as a daemon egress entry: `host:443`, or `host:port` when the URL names one. */
export function egressEntryForBaseURL(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  const entry = `${url.hostname.toLowerCase()}${url.port !== "" ? `:${url.port}` : ":443"}`;
  return egressEntryError(entry) === null ? entry : undefined;
}

/**
 * Known opencode provider ids and the host each one's DEFAULT dial is, for a
 * config-blob provider that carries no baseURL of its own. From the provider
 * registry opencode itself reads (models.dev, 2026-10-17), cut to the
 * providers Ship's own key table (PROVIDER_EGRESS) knows the defaults of. An
 * id not here and declaring no baseURL is refused under the flag: its
 * default host is a fact of the vendor registry, and guessing a host into a
 * data-destination gate is the one thing this file must not do.
 */
const OPENCODE_PROVIDER_DEFAULT_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  openrouter: "openrouter.ai",
  zhipu: "api.z.ai",
  "zai-coding-plan": "api.z.ai",
  google: "generativelanguage.googleapis.com",
};

/**
 * opencode `api` values that move the dial to a cloud provider (Bedrock,
 * Vertex): the host then depends on the account and region no env var can
 * name, so under the flag those provider entries are refused rather than
 * approved by guess — the same rule Decision 11 applies to subscription
 * tokens.
 */
const OPENCODE_CLOUD_APIS = new Set(["bedrock", "vertex"]);

/**
 * opencode config substitutions that resolve at RUN time on the worker —
 * `{env:VAR}` reads the exec env, `{file:PATH}` and `{command:…}` the
 * container's disk. A baseURL carrying one dials a host nothing can judge at
 * enqueue, so ANY occurrence anywhere in the blob refuses it: the same blob
 * can substitute into a key harmlessly and into a URL dangerously, and
 * telling those apart would mean parsing every vendor field this reader has
 * not been told about.
 */
const OPENCODE_RUN_TIME_SUBSTITUTIONS = ["{env:", "{file:", "{command:"];

/** What an opencode config blob declares about where the harness dials. */
export interface OpencodeConfigDestinations {
  /** Every destination host the blob declares or implies (never a port — the derivation adds 443). */
  hosts: string[];
  /**
   * S3 (SHIP_HARNESS_CRED): why the blob's destinations CANNOT be derived
   * exactly. Present means the enqueue gate refuses and the worker's
   * re-check refuses; the derivation adds nothing, because an empty
   * host list read as "approved" would wave the vendor's default host
   * through while the harness dialed somewhere the blob names.
   */
  refusal?: { code: "unparseable" | "unreadable"; why: string };
}

/**
 * S3 (SHIP_HARNESS_CRED): read an opencode config blob's data destinations
 * EXACTLY, or refuse to read them at all. OPENCODE_CONFIG_CONTENT is on
 * opencode's default forward list and can route the dial for ANY provider
 * (a baseURL), pull it onto a cloud provider (the `api` field), or add
 * destinations nothing else sees (remote MCP servers, `share`, `plugin`) —
 * so under the flag every destination the blob declares or implies is
 * derived here and judged like any base URL, and anything this reader
 * cannot turn into a host is a refusal, never a silent skip.
 */
export function opencodeConfigDestinations(raw: string): OpencodeConfigDestinations {
  const refuse = (code: "unparseable" | "unreadable", why: string): OpencodeConfigDestinations => ({ hosts: [], refusal: { code, why } });
  for (const token of OPENCODE_RUN_TIME_SUBSTITUTIONS) {
    if (raw.includes(token)) {
      return refuse("unreadable", `carries a ${token}…} substitution, which resolves on the worker at run time, so the host it names cannot be judged at enqueue`);
    }
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // JSONC included: a blob a parser cannot read is a blob whose
    // destinations nobody can read.
    return refuse("unparseable", "is not JSON (comments and trailing commas are refused too)");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return refuse("unparseable", "is not a JSON object at the top level");
  const record = doc as Record<string, unknown>;
  const hosts: string[] = [];
  const push = (host: string): void => {
    if (host !== "" && !hosts.includes(host)) hosts.push(host);
  };
  const hostOf = (url: string): string | undefined => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "" ? undefined : host;
    } catch {
      return undefined;
    }
  };
  const providers = record.provider;
  if (providers !== undefined) {
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return refuse("unreadable", "has a provider table that is not a JSON object");
    for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("unreadable", `has a ${id} provider entry that is not a JSON object`);
      const entry = value as Record<string, unknown>;
      // A provider package is code opencode installs and runs inside the
      // harness; whatever it dials, no derivation reads.
      if (entry.npm !== undefined) {
        return refuse("unreadable", `has a ${id} provider that names an npm provider package, code that runs inside the harness and can dial anywhere`);
      }
      const api = typeof entry.api === "string" ? entry.api.trim().toLowerCase() : "";
      if (OPENCODE_CLOUD_APIS.has(api)) {
        return refuse("unreadable", `has a ${id} provider whose api is "${api}", a cloud-provider switch whose hosts depend on the account and region and cannot be derived`);
      }
      const options =
        entry.options !== null && typeof entry.options === "object" && !Array.isArray(entry.options) ? (entry.options as Record<string, unknown>) : {};
      const bases = [readString(options, "baseURL"), readString(options, "base_url"), readString(entry, "baseURL")].filter(
        (base): base is string => base !== undefined,
      );
      if (bases.length > 0) {
        // A baseURL the URL constructor cannot read used to be swallowed
        // (nothing derived, nothing refused) while the harness dialed it.
        for (const base of bases) {
          const host = hostOf(base);
          if (host === undefined) {
            return refuse("unreadable", `has a ${id} provider whose baseURL (${JSON.stringify(base.slice(0, 60))}) is not a URL a host can be read from`);
          }
          push(host);
        }
        continue;
      }
      // No baseURL: the provider dials its id's default — a host here for
      // the ids Ship knows, a refusal for the ones it cannot look up.
      const known = OPENCODE_PROVIDER_DEFAULT_HOSTS[id];
      if (known === undefined) {
        return refuse(
          "unreadable",
          `has a ${id} provider with no baseURL and an id whose default host Ship does not know (${Object.keys(OPENCODE_PROVIDER_DEFAULT_HOSTS).join(", ")})`,
        );
      }
      push(known);
    }
  }
  const mcp = record.mcp;
  if (mcp !== undefined) {
    if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return refuse("unreadable", "has an mcp table that is not a JSON object");
    for (const [name, value] of Object.entries(mcp as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("unreadable", `has a ${name} MCP server entry that is not a JSON object`);
      const server = value as Record<string, unknown>;
      const type = typeof server.type === "string" ? server.type.trim().toLowerCase() : "";
      const url = readString(server, "url");
      // Remote servers are derived and gated; anything else is a command
      // Ship cannot judge. The ONE exception is the local browser server
      // Ship itself injects under SHIP_HARNESS_BROWSER (harness-browser.ts):
      // it attaches to the run's own loopback CDP endpoint, so it names no
      // data destination at all — anything else that is not a remote server
      // with a readable url keeps refusing exactly as before.
      if (type === "local" && isHarnessBrowserMcpServer(name, server)) continue;
      const host = type === "remote" && url !== undefined ? hostOf(url) : undefined;
      if (host === undefined) {
        return refuse("unreadable", `has a ${name} MCP server that is not a remote server with a readable url (a local command server's egress no derivation can judge)`);
      }
      push(host);
    }
  }
  // Only an explicit off passes: `"disabled"` (the current schema) or
  // `false`. Every other value — `"manual"`, `"auto"`, anything unknown —
  // leaves a path that publishes the session to opencode's cloud service.
  if (record.share !== undefined && record.share !== false && record.share !== "disabled") {
    return refuse("unreadable", "enables opencode share, which publishes the session to opencode's cloud service");
  }
  // The legacy spelling of the same switch, still read by older builds.
  if (record.autoshare !== undefined && record.autoshare !== false) {
    return refuse("unreadable", "enables opencode autoshare, which publishes the session to opencode's cloud service");
  }
  // Instruction entries are local paths or globs — or remote URLs opencode
  // fetches at start-up, which are destinations like any other: derived and
  // judged, and anything unreadable is a refusal.
  const instructions = record.instructions;
  if (instructions !== undefined) {
    if (!Array.isArray(instructions)) return refuse("unreadable", "has an instructions entry that is not an array");
    for (const item of instructions) {
      if (typeof item !== "string") return refuse("unreadable", "has an instructions entry that is not a string");
      const trimmed = item.trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) continue;
      const host = /^https?:\/\//i.test(trimmed) ? hostOf(trimmed) : undefined;
      if (host === undefined) {
        return refuse("unreadable", `has an instructions URL (${JSON.stringify(trimmed.slice(0, 60))}) that is not an http(s) URL a host can be read from`);
      }
      push(host);
    }
  }
  const plugin = record.plugin;
  if (plugin !== undefined && (plugin === null || typeof plugin !== "object" || Array.isArray(plugin) ? true : Object.keys(plugin).length > 0)) {
    return refuse("unreadable", "declares opencode plugins, code that runs inside the harness and can dial anywhere");
  }
  return { hosts };
}

/**
 * Env names SHIP_HARNESS_ENV may ADD to a harness's forward list under
 * SHIP_HARNESS_CRED — S3's remedy, an explicit allowlist. A name heuristic
 * cannot tell which additions reroute a dial and which are inert, so nothing
 * is judged by what it looks like: an operator-chosen forward name is
 * permitted only when it is on this small, deliberate list, and everything
 * else refuses by name (refusedForwardNames below). Additions here must be
 * knobs that cannot move a data destination.
 */
const EXTRA_FORWARD_ALLOWED: Record<string, readonly string[]> = {
  // claude: model selection, spend and noise knobs. The dial stays wherever
  // ANTHROPIC_BASE_URL (gated) or the vendor default put it.
  "claude-code": [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "BASH_DEFAULT_TIMEOUT_MS",
    "BASH_MAX_TIMEOUT_MS",
    "BASH_MAX_OUTPUT_LENGTH",
    "MCP_TIMEOUT",
    "MCP_TOOL_TIMEOUT",
    "USE_BUILTIN_RIPGREP",
  ],
  // opencode: telemetry and update opt-outs, which REDUCE where data goes.
  opencode: ["OPENCODE_DISABLE_TELEMETRY", "OPENCODE_DISABLE_UPDATE"],
  codex: ["RUST_LOG"],
};

/**
 * Forward names refused wherever they appear in a forward list, each with its
 * reason: the reroutes and pointers the destination derivation cannot read
 * at all. Matched case-insensitively (forwardEnv only delivers the upper
 * spelling, but a lower-case override in SHIP_HARNESS_ENV should refuse with
 * the reason, not pass because it is inert).
 */
const FORWARD_NEVER: Record<string, string> = {
  HTTP_PROXY: "a proxy override would reroute every dial the destination gate judged",
  HTTPS_PROXY: "a proxy override would reroute every dial the destination gate judged",
  ALL_PROXY: "a proxy override would reroute every dial the destination gate judged",
  NO_PROXY: "a proxy carve-out would send dials around the route the egress list judged",
  OPENCODE_CONFIG: "a config FILE path declares destinations Ship cannot read; put the config in OPENCODE_CONFIG_CONTENT, which the gate parses",
  OPENCODE_CONFIG_DIR: "a config DIRECTORY path declares destinations Ship cannot read; put the config in OPENCODE_CONFIG_CONTENT, which the gate parses",
  CLAUDE_CODE_USE_BEDROCK: "a Bedrock switch dials cloud-provider hosts no derivation can read",
  CLAUDE_CODE_USE_VERTEX: "a Vertex switch dials cloud-provider hosts no derivation can read",
  AWS_BEARER_TOKEN_BEDROCK: "a Bedrock credential dials cloud-provider hosts no derivation can read",
  AWS_ACCESS_KEY_ID: "a cloud-provider credential dials hosts no derivation can read",
  AWS_SECRET_ACCESS_KEY: "a cloud-provider credential dials hosts no derivation can read",
  AWS_SESSION_TOKEN: "a cloud-provider credential dials hosts no derivation can read",
  GOOGLE_APPLICATION_CREDENTIALS: "a cloud-provider credential dials hosts no derivation can read",
  GOOGLE_CLOUD_PROJECT: "a cloud-provider credential dials hosts no derivation can read",
  GOOGLE_VERTEX_PROJECT: "a Vertex credential dials hosts no derivation can read",
  GOOGLE_VERTEX_LOCATION: "a Vertex credential dials hosts no derivation can read",
  ANTHROPIC_VERTEX_PROJECT_ID: "a Vertex credential dials hosts no derivation can read",
};

/** One SHIP_HARNESS_ENV name this harness may not forward under the flag, with the reason. */
export interface ForwardRefusal {
  name: string;
  why: string;
}

/** The deliberate SHIP_HARNESS_ENV additions one harness permits under the flag (S3's allowlist). */
export function permittedForwardAdditions(id: string): string[] {
  return [...(EXTRA_FORWARD_ALLOWED[id] ?? [])];
}

/**
 * S3 (SHIP_HARNESS_CRED): forward names this harness's SHIP_HARNESS_ENV list
 * may NOT carry — every name that is not on the harness's default forward
 * list, not a base-URL variable the host derivation reads, and not a
 * deliberate extra (EXTRA_FORWARD_ALLOWED). Checked at enqueue under the
 * flag and again at exec; each refused name carries its reason so the
 * refusal can say what to do instead.
 */
export function refusedForwardNames(id: string, env: NodeJS.ProcessEnv = process.env): ForwardRefusal[] {
  const spec = PROVIDER_EGRESS[id];
  if (spec === undefined) return [];
  const forward = externalHarnessConfig(id, env).forward;
  const defaults = DEFAULT_FORWARDED_ENV[id] ?? [];
  const allowed = new Set<string>([...defaults, ...spec.bases.map((base) => base.env), ...(EXTRA_FORWARD_ALLOWED[id] ?? [])]);
  return forward
    .filter((name) => !allowed.has(name))
    .map((name) => ({
      name,
      why: FORWARD_NEVER[name.toUpperCase()] ?? `is not one of ${id}'s permitted SHIP_HARNESS_ENV additions under SHIP_HARNESS_CRED`,
    }));
}

function readString(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The URL-shaped forward names whose hosts the derivation DOES read, per
 * harness — the base-URL variables a SHIP_HARNESS_ENV addition may carry
 * under the flag: forward one of these and its host is judged like any base
 * URL.
 */
export function gatedForwardedUrlNames(id: string): string[] {
  return (PROVIDER_EGRESS[id]?.bases ?? []).map((base) => base.env);
}

/**
 * The provider API hosts a set of harness refs will call from inside the
 * sandbox, derived from the worker's own environment — the same forward list
 * (`externalHarnessConfig`) and the same variables the harness will read
 * from its exec env. Hosts only, port 443 (the URL's own port
 * when it names one — the daemon's grammar admits 80 and 443 portless and
 * nothing else without it), de-duplicated, order preserved. Native and
 * unknown ids derive nothing: the native loop calls the model from the
 * worker, outside every sandbox.
 *
 * A base URL that is set but unusable (unparseable, no host) still suppresses
 * the vendor default it replaces: the harness will dial the configured URL,
 * not `api.*`, and guessing the vendor host would be wrong in the other
 * direction. Nothing is derived from it and the doctor's `harness-egress`
 * line shows the gap.
 */
export function providerEgressAllow(refs: readonly { id: string }[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const push = (entry: string): void => {
    if (!out.includes(entry)) out.push(entry);
  };
  for (const ref of refs) {
    const spec = PROVIDER_EGRESS[ref.id];
    if (spec === undefined) continue;
    const config = externalHarnessConfig(ref.id, env);
    // "Forwarded" is forwardEnv's own rule: on the harness's forward list AND
    // set to a non-empty value on the worker.
    const held = (name: string): string | undefined => {
      if (!config.forward.includes(name)) return undefined;
      const value = (env[name] ?? "").trim();
      return value === "" ? undefined : value;
    };
    const rerouted = new Set<string>();
    for (const base of spec.bases) {
      const value = held(base.env);
      if (value === undefined) continue;
      const entry = egressEntryForBaseURL(value);
      if (entry !== undefined) push(entry);
      rerouted.add(base.replaces);
    }
    const model = (config.model ?? "").toLowerCase();
    for (const key of spec.keys) {
      if (rerouted.has(key.host)) continue;
      if (key.modelPrefixes !== undefined && !key.modelPrefixes.some((prefix) => model.startsWith(prefix))) continue;
      if (key.envs.some((name) => held(name) !== undefined)) push(`${key.host}:443`);
    }
    // S3 (SHIP_HARNESS_CRED=on): an opencode config blob declares provider
    // destinations nothing above can see. Under the flag those hosts are
    // derived exactly like any base URL — the daemon allowlist admits
    // exactly the hosts the enqueue gate judges. A blob whose destinations
    // cannot be read exactly derives nothing here; the gate refuses it by
    // name instead. Flag off changes nothing: byte-identical derivations,
    // the fence every other flag-gated behaviour keeps.
    if (ref.id === "opencode" && harnessCredEnabled(env)) {
      const content = held("OPENCODE_CONFIG_CONTENT");
      if (content !== undefined) {
        for (const host of opencodeConfigDestinations(content).hosts) push(`${host}:443`);
      }
    }
  }
  return out;
}

/**
 * Merge a derived egress list into a run's explicit one, the merge discipline
 * `withProviderEgress` and `withAcpProviderEgress` (harness-acp.ts) share:
 * explicit entries always survive, derived entries skip when the explicit
 * list already carries their bare host, and when both together would fail
 * validation or pass the daemon's entry bound the derived ones are dropped
 * rather than refusing the enqueue. Nothing derived returns `explicit`
 * unchanged.
 */
export function mergeDerivedEgress(explicit: string[] | undefined, derived: readonly string[]): string[] | undefined {
  if (derived.length === 0) return explicit;
  const bare = new Set((explicit ?? []).map((entry) => entry.split(":")[0]!.trim().toLowerCase()).filter((host) => host !== ""));
  const add = derived.filter((entry) => !bare.has(entry.split(":")[0]!.toLowerCase()));
  if (add.length === 0) return explicit;
  let merged: string[] | undefined;
  try {
    merged = normalizeEgressAllow([...(explicit ?? []), ...add]);
  } catch {
    return explicit;
  }
  return merged !== undefined && merged.length <= MAX_EGRESS_ALLOW_ENTRIES ? merged : explicit;
}

/**
 * A run's explicit (project + preview) egress allowlist with the harness's
 * derived provider hosts appended — the merge discipline above, for the same
 * reason: explicit entries always survive, and when both together would fail
 * validation or pass the daemon's entry bound the derived ones are dropped
 * rather than refusing the enqueue. A derived `host:443` is also skipped when
 * the explicit list already carries the bare host: a portless entry admits 80
 * and 443 (egress.ts), so the narrower copy beside it is noise. Nothing
 * derived returns `explicit` unchanged — byte-identical, which is the fence
 * that keeps native runs' inputs exactly as they were.
 */
export function withProviderEgress(
  explicit: string[] | undefined,
  refs: readonly { id: string }[],
  /**
   * S1: the env each ref's derivation runs over, per ref. A run's sealed
   * bindings belong to ONE profile each, and the overlay that carried a
   * codex-stored OPENAI_API_KEY must not be merged into opencode's
   * derivation by env name — each attempt is derived from its own profile's
   * overlay. Defaults to the plain process env (nothing derived per profile).
   */
  envOf: (ref: { id: string }) => NodeJS.ProcessEnv = () => process.env,
): string[] | undefined {
  return mergeDerivedEgress(explicit, unionPerRef(refs, envOf));
}

/**
 * One derivation PER REF over that ref's own env, then a union of the
 * entries (S1): a single merged env would let one profile's stored base URL
 * reroute another profile's derivation — the same env-name collision the
 * per-profile overlays refuse at delivery.
 */
function unionPerRef(refs: readonly { id: string }[], envOf: (ref: { id: string }) => NodeJS.ProcessEnv): string[] {
  const entries: string[] = [];
  for (const ref of refs) entries.push(...providerEgressAllow([ref], envOf(ref)));
  return [...new Set(entries)];
}

/**
 * The credentials forwarded into one harness exec, as that exec's own env.
 *
 * They travel in the exec request (the sandbox daemon hands them to the
 * command through a private `--env-file` on the host), never as a file under
 * the workspace and never on a command line. The daemon refuses a value with
 * a line break (its env-file format is one NAME=VALUE per line), and a
 * multi-line value is legitimate here — OPENCODE_CONFIG_CONTENT is JSON — so
 * such a value rides base64-encoded under `SHIP_B64_<NAME>` and `prelude`
 * decodes it back into `<NAME>` inside the shell, then unsets the carrier.
 * A value with a NUL cannot live in an environment at all and is skipped.
 */
export function forwardEnv(forward: string[], env: NodeJS.ProcessEnv): { env: Record<string, string>; names: string[]; secrets: KnownSecret[]; prelude: string } {
  const names: string[] = [];
  const out: Record<string, string> = {};
  const secrets: KnownSecret[] = [];
  let prelude = "";
  for (const name of forward) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    const value = env[name];
    if (value === undefined || value === "" || value.includes("\0")) continue;
    names.push(name);
    secrets.push({ name, value });
    if (/[\r\n]/.test(value)) {
      const carrier = `SHIP_B64_${name}`;
      out[carrier] = Buffer.from(value, "utf8").toString("base64");
      // The trailing `x` survives command substitution's newline stripping,
      // so a value that ends in a newline arrives byte-exact.
      prelude += `${name}="$(printf %s "$${carrier}" | base64 -d; printf x)"; ${name}="\${${name}%x}"; export ${name}; unset ${carrier}; `;
    } else {
      out[name] = value;
    }
  }
  return { env: out, names, secrets, prelude };
}

/** Preflight: the binary exists in the sandbox, and which version it is. */
export interface Preflight {
  found: boolean;
  version: string;
  detail?: string;
  /** The version images/versions.json bakes for this harness, when it names one. */
  expected?: string;
  /** Does the installed binary report `expected`? Absent when nothing to compare. */
  pinned?: boolean;
  /**
   * Set when the found binary's version is one this adapter refuses to drive
   * (opencode >= 2). Same shape as a missing binary: recorded here, the run
   * stops before `harness-run`, nothing executes.
   */
  refused?: string;
}

/**
 * What to do about a harness the sandbox image does not carry.
 *
 * The old message ("not on PATH in the sandbox image") was true and useless:
 * it left an operator to work out on their own that harnesses are BAKED, which
 * image to bake them into, and how to point a repo at it. Ship owns all three
 * answers, so it says them.
 */
export function missingHarnessHelp(id: string, binary: string): string {
  const pkg = HARNESS_PACKAGES[id];
  return (
    `${binary} is not on PATH in the sandbox image. Harnesses are baked into the image, never installed per run ` +
    `(a run-time install needs sandbox egress and drifts under a running worker, which breaks replay). ` +
    `Build one that carries it — \`images/build.sh --harness ${id} go\`${pkg !== undefined ? ` (installs ${pkg.npm}@${pkg.version})` : ""} — ` +
    `then point this repo at it on the dashboard's Projects page, or the whole worker with SHIP_SANDBOX_IMAGE.`
  );
}

/**
 * The major version in a `--version` first line, when the line carries an
 * x.y.z. Undefined when it carries no such token — an unparseable version is
 * recorded, never guessed at (the same rule `pinned` follows below).
 */
export function versionMajor(version: string): number | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Why an opencode PAST the 2.x line is refused rather than run. The adapter
 * drives two measured contracts: 1.x (`--pure -- --dir`, `tool` events) and
 * 2.x (no `--pure`/`--dir`, `tool_use`, `--session`, terminal `step_finish`
 * absent) — both in evals/receipts/2026-10-14-opencode-v2-events.txt. A 3.x
 * is none of those: driving it would be guesswork about flags and events, and
 * the same receipt's history (v2 silently under-counted turns and hid tool
 * activity from the live feed under the v1 parser) says the failure mode of
 * guessing is silence, not noise.
 */
export function opencodeFutureLineRefusal(version: string, expected?: string): string {
  return (
    `opencode reports ${version}, past the 2.x line ship's opencode adapter has measured, so it refuses to run it: a future line may have removed flags or renamed events again the way 2.0 did. ` +
    (expected !== undefined
      ? `images/versions.json pins ${HARNESS_PACKAGES.opencode!.npm}@${expected} — run an image that bakes the pin (images/build.sh --harness opencode). `
      : "") +
    `The measured 1.x and 2.x contracts are in evals/receipts/2026-10-14-opencode-v2-events.txt; extending the adapter to a new line is tracked work, not a flag-patch.`
  );
}

/** Preflight an external or ACP harness's binary: present, versioned, and comparable to the baked pin. */
export async function preflight(
  executor: AgentExecutor,
  id: string,
  binary: string,
  refuseVersion?: (version: string, expected?: string) => string | undefined,
): Promise<Preflight> {
  const expected = HARNESS_PACKAGES[id]?.version;
  try {
    const probe = await executor.exec(`command -v ${binary} >/dev/null 2>&1 && ${binary} --version 2>&1 | head -n 1`, { timeoutMs: 60_000 });
    if (probe.exitCode !== 0) {
      return { found: false, version: "", detail: missingHarnessHelp(id, binary), ...(expected !== undefined ? { expected } : {}) };
    }
    const version = probe.stdout.trim().slice(0, 120);
    const refusal = refuseVersion?.(version, expected);
    return {
      found: true,
      version,
      ...(expected !== undefined ? { expected } : {}),
      // Recorded, NOT enforced. Refusing here would take a working deployment
      // offline the moment images/versions.json moved ahead of the image on
      // the box; what an operator actually needs is the log to say which binary
      // wrote the tree, which this gives them. The one exception is a major
      // the adapter cannot drive at all (refuseVersion): that binary cannot
      // run the invocation, so refusing beats a run that dies in flag-parse.
      ...(expected !== undefined ? { pinned: version.includes(expected) } : {}),
      ...(refusal !== undefined ? { refused: refusal } : {}),
    };
  } catch (error) {
    return { found: false, version: "", detail: error instanceof Error ? error.message : String(error), ...(expected !== undefined ? { expected } : {}) };
  }
}

/** The recorded shape of the run step. */
export interface HarnessRunRecord {
  exitCode: number;
  timedOut: boolean;
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  /** Which forwarded env NAMES were present (never values). */
  forwarded: string[];
  stderrTail: string;
  /**
   * The vendor session codex reports (`thread.started` → `thread_id`), recorded
   * so a log can name the program's own continuation handle
   * (`codex exec resume <id>`) without re-running it. codex only.
   */
  threadId?: string;
  /**
   * The paths codex says it changed (`file_change` items, `kind path` per
   * entry, capped). A claim by the harness, not evidence: the publish gate
   * diffs the tree itself. codex only.
   */
  fileChanges?: string[];
  /** How many commands codex reported executing (`command_execution` items). codex only. */
  commands?: number;
  /**
   * The vendor session this exec ran (D6/D7): opencode's `ses_…` id, claude's
   * `session_id`. Recorded on the step, so it is durable in the log and a
   * replay reads it back rather than re-deriving it — and steering resumes
   * exactly the session the binary reported, not the one Ship asked for.
   */
  sessionId?: string;
  /**
   * S4: credential bindings whose resolved version differs from the version
   * the run's input recorded — rotation between enqueue and exec. Rotation
   * is allowed (that is what references are for) and the run used the
   * current value; this note is how the record says so instead of silently
   * delivering a different value than admission recorded.
   */
  credentialRotation?: string[];
}

/**
 * Sum usage across the execs of one steered attempt. `priced` is conjunctive:
 * a run is priced only if every exec's usage could be priced, and a mixed run
 * keeps its token counts but never reports dollars it cannot account for.
 */
export function addUsage(a: HarnessUsage, b: HarnessUsage): HarnessUsage {
  const priced = a.priced !== false && b.priced !== false;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    priced,
    ...(priced ? { costUSD: (a.costUSD ?? 0) + (b.costUSD ?? 0) } : {}),
  };
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
 * The prompt an external harness works from. The native loop's system prompt
 * describes Ship's own action protocol, which means nothing to a vendor
 * agent; this states the contract those agents need: the tree is the
 * deliverable, git is not theirs.
 */
export function externalPrompt(prompt: string, mode?: "fix" | "scan"): string {
  return (
    `${prompt}\n\n` +
    "You are running unattended inside a sandbox with no one to answer questions. " +
    (mode === "scan"
      ? "This is a read-only investigation. Your deliverable is findings and verification results; do not edit tracked files, commit, push, stash, create branches or change git configuration. Nothing will be published. "
      : "Work in the current directory. Your deliverable is the EDITED WORKING TREE: do not commit, push, stash, create branches or change git configuration — the change is published after you stop. ") +
    "Do not ask for confirmation; if something is ambiguous, pick the smallest reasonable interpretation and say so in your final message. " +
    (mode === "scan" ? "Finish with findings in the requested format and the commands and results you verified." : "Finish with a short plain-text summary of what you changed and how you verified it.")
  );
}

/**
 * Parse claude's `--output-format stream-json` (one JSON object per line; the
 * last is `{"type":"result",...}`). Documented fields: docs/adapters.md.
 */
export function parseClaudeStream(
  stdout: string,
  priced: boolean,
): { status: HarnessStatus; summary: string; turns: number; usage: HarnessUsage; sawResult: boolean; sessionId?: string } {
  let result: Record<string, unknown> | undefined;
  let assistantTurns = 0;
  // The session every event names; `--resume` steering (D7) needs it. Taken
  // preferentially from the terminal result, which is the one claude vends as
  // authoritative, with the first event that carries one as the fallback (a
  // crashed run prints no result but has printed its init by then).
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (sessionId === undefined && typeof event.session_id === "string" && event.session_id !== "") sessionId = event.session_id;
    if (event.type === "assistant") assistantTurns += 1;
    if (event.type === "result") result = event;
  }
  if (result !== undefined && typeof result.session_id === "string" && result.session_id !== "") sessionId = result.session_id;
  if (result === undefined) {
    return {
      status: "error",
      summary: "claude produced no result event",
      turns: assistantTurns,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
      sawResult: false,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }
  const u = (result.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadTokens = num(u.cache_read_input_tokens);
  const cacheWriteTokens = num(u.cache_creation_input_tokens);
  const usage: HarnessUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    priced,
    // total_cost_usd is a client-side estimate. It is the honest number under an
    // API key (the same list-price arithmetic pricing.ts does); under a
    // subscription it is an estimate of a bill that does not exist, so it is
    // not recorded as spend at all — the run is counted, not priced.
    ...(priced && typeof result.total_cost_usd === "number" ? { costUSD: result.total_cost_usd } : {}),
  };
  const subtype = typeof result.subtype === "string" ? result.subtype : "";
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const turns = num(result.num_turns) > 0 ? num(result.num_turns) : assistantTurns;
  const withSession = <T extends object>(value: T): T => ({ ...value, ...(sessionId !== undefined ? { sessionId } : {}) });
  if (subtype === "success" && result.is_error !== true) {
    return withSession({ status: "finished", summary: text === "" ? "claude finished without a summary" : text.slice(0, 4000), turns, usage, sawResult: true });
  }
  if (subtype === "error_max_turns") {
    return withSession({ status: "max-steps", summary: `claude reached its ${turns}-turn limit.`, turns, usage, sawResult: true });
  }
  if (subtype === "error_max_budget_usd") {
    return withSession({ status: "budget-exhausted", summary: "claude stopped at its per-run budget.", turns, usage, sawResult: true });
  }
  const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).map(String).join("; ") : "";
  return withSession({
    status: "error",
    summary: `claude ended with ${subtype || "an error"}${errors !== "" ? `: ${errors}` : text !== "" ? `: ${text.slice(0, 800)}` : ""}`,
    turns,
    usage,
    sawResult: true,
  });
}

/**
 * Parse opencode's `--format json` event stream: `step_finish` parts carry
 * `tokens` and `cost`; the last `text` part is the agent's final message;
 * there is no terminal result object (docs/adapters.md).
 */
export function parseOpencodeStream(stdout: string): { summary: string; turns: number; usage: HarnessUsage; error?: string } {
  let turns = 0;
  let lastText = "";
  let cost = 0;
  let error: string | undefined;
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") lastText = part.text.trim();
    if (event.type === "step_finish") {
      turns += 1;
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      usage.inputTokens += num(tokens.input);
      usage.outputTokens += num(tokens.output) + num(tokens.reasoning);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + num(cache.read);
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + num(cache.write);
      cost += num(part.cost);
    }
    if (event.type === "error") {
      const e = event.error as Record<string, unknown> | string | undefined;
      error = typeof e === "string" ? e : typeof e?.message === "string" ? (e.message as string) : JSON.stringify(e ?? "unknown error");
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  // opencode reports cost 0 for models it cannot price and for subscription
  // providers alike. Tokens with no dollars is exactly the unpriced shape.
  if (cost > 0) {
    usage.priced = true;
    usage.costUSD = cost;
  } else {
    usage.priced = false;
  }
  return { summary: lastText, turns, usage, ...(error !== undefined ? { error } : {}) };
}

/**
 * Parse opencode **v2**'s `--format json` event stream (D6). The contract,
 * measured against real 2.0.26 streams on 2026-10-14
 * (evals/receipts/2026-10-14-opencode-v2-events.txt §2/§4):
 *
 *   step_start — carries `part.messageID`; a NEW messageID is a new model
 *                step, and this is where turns are counted, because…
 *   step_finish — …is emitted only after tool-calling steps. The terminal
 *                text step emits none, so a pure reply reports no usage and
 *                counting here (as the 1.x parser does) under-counts. The
 *                payload shape on tool steps is 1.x-compatible
 *                (tokens.{input,output,reasoning}, tokens.cache.{read,write},
 *                cost), so usage is summed wherever it does appear.
 *   text — the final text lands in the LAST `text` part, as on 1.x.
 *   tool_use — 1.x's `tool` event renamed (part shape otherwise compatible).
 *   error — same role as 1.x, richer fields.
 *
 * Every event names the session (`sessionID`, `ses`-prefixed) — recorded so
 * steering can resume exactly the session the binary actually ran, not the
 * one Ship asked for.
 */
export function parseOpencode2Stream(stdout: string): { summary: string; turns: number; usage: HarnessUsage; error?: string; sessionId?: string } {
  let turns = 0;
  let stepFinishes = 0;
  let lastText = "";
  let cost = 0;
  let error: string | undefined;
  let sessionId: string | undefined;
  const messages = new Set<string>();
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
    if (sessionId === undefined && typeof event.sessionID === "string" && event.sessionID.startsWith("ses")) sessionId = event.sessionID;
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_start" && typeof part.messageID === "string" && !messages.has(part.messageID)) messages.add(part.messageID);
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") lastText = part.text.trim();
    if (event.type === "step_finish") {
      stepFinishes += 1;
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      usage.inputTokens += num(tokens.input);
      usage.outputTokens += num(tokens.output) + num(tokens.reasoning);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + num(cache.read);
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + num(cache.write);
      cost += num(part.cost);
    }
    if (event.type === "error") {
      const e = event.error as Record<string, unknown> | string | undefined;
      error = typeof e === "string" ? e : typeof e?.message === "string" ? (e.message as string) : JSON.stringify(e ?? "unknown error");
    }
  }
  // Turn counting: messageIDs when the stream carries them (measured v2), the
  // 1.x step_finish count as the fallback for a 2.x patch level that stops
  // naming messageIDs — zero turns on a pure reply was one of the measured
  // degradations this parser exists to fix.
  turns = messages.size > 0 ? messages.size : stepFinishes;
  usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  // Same cost-honesty rule as the 1.x parser: opencode reports cost 0 for
  // models it cannot price and for subscription providers alike, and tokens
  // with no dollars is exactly the unpriced shape (P5-3).
  //
  // v2 adds a second way to be unpriced: step_finish is emitted only after
  // tool-calling steps, so the terminal text step carries no usage at all
  // (receipt §4). When the stream names more model steps than it finished,
  // the tokens AND the dollars are a lower bound, and summing them as if
  // complete would report a confident, wrong figure — so the run is
  // unpriced (tokens kept, no dollars), never priced-but-short.
  const incomplete = messages.size > 0 && stepFinishes < messages.size;
  if (cost > 0 && !incomplete) {
    usage.priced = true;
    usage.costUSD = cost;
  } else {
    usage.priced = false;
  }
  return { summary: lastText, turns, usage, ...(error !== undefined ? { error } : {}), ...(sessionId !== undefined ? { sessionId } : {}) };
}

/**
 * Parse codex's `exec --json` JSONL stream (one event per line; the contract
 * is `codex-rs/exec/src/exec_events.rs` at the pinned tag, see
 * docs/adapters.md "codex"): `thread.started` names the session, each
 * `turn.started` is a turn, `item.completed` carries the agent's messages,
 * commands and file changes, and `turn.completed` carries the turn's usage.
 * `turn.failed` / `error` are terminal errors.
 *
 * Usage nesting follows the vendor's own accounting (and T3's reader,
 * apps/server/src/provider/CodexTurnTokenUsage.ts:164): cached input and
 * reasoning output are counted INSIDE input_tokens / output_tokens, so
 * totalTokens is their sum, not a sum of every field.
 */
export function parseCodexExecStream(stdout: string): {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  threadId?: string;
  fileChanges: string[];
  commands: number;
  sawCompletion: boolean;
  error?: string;
} {
  let threadId: string | undefined;
  let turns = 0;
  let commands = 0;
  let lastText = "";
  let sawCompletion = false;
  let error: string | undefined;
  const fileChanges: string[] = [];
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, priced: false };
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
      case "thread.started":
        if (typeof event.thread_id === "string" && event.thread_id !== "") threadId = event.thread_id;
        break;
      case "turn.started":
        turns += 1;
        break;
      case "item.completed":
      case "item.updated": {
        const item = (event.item ?? {}) as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") lastText = item.text.trim();
        if (event.type === "item.completed" && item.type === "command_execution") commands += 1;
        if (event.type === "item.completed" && item.type === "file_change") {
          const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
          for (const change of changes.slice(0, 200)) {
            if (typeof change.path !== "string") continue;
            fileChanges.push(`${typeof change.kind === "string" && change.kind !== "" ? change.kind : "update"} ${change.path}`);
          }
        }
        break;
      }
      case "turn.completed": {
        sawCompletion = true;
        const u = (event.usage ?? {}) as Record<string, unknown>;
        usage.inputTokens = num(u.input_tokens);
        usage.outputTokens = num(u.output_tokens);
        usage.cacheReadTokens = num(u.cached_input_tokens);
        usage.cacheWriteTokens = num(u.cache_write_input_tokens);
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
        break;
      }
      case "turn.failed": {
        const e = (event.error ?? {}) as Record<string, unknown>;
        error = typeof e.message === "string" && e.message !== "" ? e.message : JSON.stringify(event.error ?? "turn failed");
        break;
      }
      case "error":
        error = typeof event.message === "string" ? event.message : JSON.stringify(event);
        break;
      default:
        break;
    }
  }
  const base = {
    summary: lastText === "" ? "codex finished without a summary" : lastText.slice(0, 4000),
    turns,
    usage,
    ...(threadId !== undefined ? { threadId } : {}),
    fileChanges: fileChanges.slice(0, 200),
    commands,
    sawCompletion,
  };
  if (error !== undefined) return { ...base, status: "error", summary: `codex reported: ${error.slice(0, 800)}`, error };
  if (!sawCompletion) {
    return { ...base, status: "error", summary: "codex produced no turn.completed event", error: "no turn.completed" };
  }
  return { ...base, status: "finished" };
}

/**
 * What a harness is doing right now, read off its event stream as it
 * arrives (live.ts). Line-buffered: a chunk may end mid-object. Returns the
 * update to publish when the picture changed, null otherwise, so a busy
 * stream does not write the store per byte.
 */
export interface LiveTracker {
  feed(chunk: string): LiveUpdate | null;
}

/** Line-buffered tracker plumbing, shared by every external-harness tracker (and the ACP one). */
export function lineBuffered(onLine: (event: Record<string, unknown>) => LiveUpdate | null): LiveTracker {
  let buffer = "";
  return {
    feed(chunk) {
      buffer += chunk;
      let update: LiveUpdate | null = null;
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line.startsWith("{")) continue;
        try {
          const next = onLine(JSON.parse(line) as Record<string, unknown>);
          if (next !== null) update = next;
        } catch {
          // torn or non-JSON line
        }
      }
      return update;
    },
  };
}

/** claude's stream-json: assistant messages carry tool_use / text blocks. */
export function claudeLiveTracker(): LiveTracker {
  let turns = 0;
  return lineBuffered((event) => {
    if (event.type !== "assistant") return null;
    turns += 1;
    const message = (event.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
    let detail = "";
    for (const block of content) {
      if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target = [input.file_path, input.command, input.pattern, input.query, input.description].find((v) => typeof v === "string" && v !== "");
        detail = `${String(block.name ?? "tool")}${typeof target === "string" ? ` ${clipDetail(target, 100)}` : ""}`;
      } else if (block.type === "text" && detail === "" && typeof block.text === "string") {
        detail = clipDetail(block.text, 120);
      }
    }
    return { phase: "harness", turn: turns, ...(detail !== "" ? { detail } : {}) };
  });
}

/**
 * opencode's `--format json` live feed. 1.x: `tool` parts name the tool,
 * `step_finish` counts a turn. 2.x (D6, measured in
 * evals/receipts/2026-10-14-opencode-v2-events.txt §4/§5): the tool event is
 * renamed `tool_use` — the one rename that made the v1 tracker blind to all
 * tool activity — and the terminal text step emits no `step_finish`, so the
 * turn ticks at each NEW `step_start` messageID instead. Streams that carry
 * no messageIDs (1.x, and any 2.x that drops them) keep the step_finish
 * tick, which preserves 1.x behaviour exactly.
 */
export function opencodeLiveTracker(): LiveTracker {
  let turns = 0;
  let message: string | null = null;
  return lineBuffered((event) => {
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_start" && typeof part.messageID === "string") {
      if (message === part.messageID) return null;
      message = part.messageID;
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    if (event.type === "step_finish") {
      if (message !== null) return null; // v2: this step already ticked at its step_start
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    if (event.type === "tool" || event.type === "tool_use") {
      const state = (part.state ?? {}) as Record<string, unknown>;
      const input = (state.input ?? part.input ?? {}) as Record<string, unknown>;
      const target = [input.filePath, input.command, input.pattern, input.query].find((v) => typeof v === "string" && v !== "");
      return { phase: "harness", turn: turns, detail: `${String(part.tool ?? "tool")}${typeof target === "string" ? ` ${clipDetail(target, 100)}` : ""}` };
    }
    if (event.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      return { phase: "harness", turn: turns, detail: clipDetail(part.text, 120) };
    }
    return null;
  });
}

/** What parsing one vendor exec produced. `sessionId` is the durable handle steering resumes. */
interface ParsedRun {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  sessionId?: string;
  threadId?: string;
  fileChanges?: string[];
  commands?: number;
}

interface ExecOpts {
  config: ExternalHarnessConfig;
  maxSteps: number;
  maxRunCostUSD: number;
  priced: boolean;
  forwarded: string[];
  /**
   * SHIP_HARNESS_BROWSER=on and the tier gates passed (harness-browser.ts):
   * wire the baked browser MCP server into THIS invocation — the --mcp-config
   * file for claude, the mcp_servers TOML overrides for codex (opencode rides
   * the merged OPENCODE_CONFIG_CONTENT, not a flag).
   */
  browser?: true;
}

/**
 * One invocation contract for a vendor line. opencode has two (1.x and 2.x
 * differ in flags AND events); claude has one. A line that can be resumed
 * with a steering note carries `steerResume` (D6/D7).
 */
interface LineSpec {
  /** Build the shell command; the prompt is read from a file the adapter wrote. */
  command: (opts: ExecOpts & { session?: string }) => string;
  parse: (exec: ExecResult, priced: boolean) => ParsedRun;
  /**
   * The session id Ship passes UP FRONT, when the line takes a caller-chosen
   * one (opencode `--session`). Absent means the session is whatever the
   * binary assigns and `parse` must fish out of the stream (claude
   * `session_id`).
   */
  sessionFor?: (ids: { runId: string; prefix: string }) => string;
  /** Deliver one batch of steer notes by resuming the recorded session. */
  steerResume?: (opts: ExecOpts & { session: string; notePath: string }) => string;
}

/**
 * codex's exec --json: `turn.started` counts a turn; item events name the
 * command being run, the files being changed, or the agent's message
 * (exec_events.rs — file_change items only ever arrive as `item.completed`).
 */
export function codexLiveTracker(): LiveTracker {
  let turns = 0;
  return lineBuffered((event) => {
    if (event.type === "turn.started") {
      turns += 1;
      return { phase: "harness", turn: turns };
    }
    const item = (event.item ?? {}) as Record<string, unknown>;
    if ((event.type === "item.started" || event.type === "item.completed") && item.type === "command_execution") {
      return typeof item.command === "string"
        ? { phase: "harness", turn: turns, detail: `exec ${clipDetail(item.command, 100)}` }
        : { phase: "harness", turn: turns, detail: "exec" };
    }
    if (event.type === "item.completed" && item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
      const paths = changes.map((c) => (typeof c.path === "string" ? c.path : "")).filter((p) => p !== "");
      return paths.length > 0 ? { phase: "harness", turn: turns, detail: `edit ${clipDetail(paths.join(", "), 100)}` } : null;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
      return { phase: "harness", turn: turns, detail: clipDetail(item.text, 120) };
    }
    return null;
  });
}

/**
 * The `--config` flags that point codex at teploy-gateway: a `teploy-gateway`
 * model provider whose base_url comes from the AI_GATEWAY_URL (exec env)
 * and whose key codex reads itself from AI_GATEWAY_KEY (`env_key`), then
 * `model_provider` selecting it. Values are TOML on the far side of `-c
 * key=value` (codex parses the value as TOML with a raw-string fallback —
 * codex-rs/utils/cli/src/config_override.rs), so literals are quoted and the
 * URL rides in single quotes inside a shell double-quoted arg so `$AI_GATEWAY_URL`
 * still expands from the exec's env.
 *
 * codex speaks the Responses wire API only (`wire_api = "chat"` was removed
 * upstream), so the gateway endpoint must be Responses-compatible — see
 * docs/adapters.md "codex".
 */
export function codexGatewayConfigFlags(forwarded: readonly string[]): string {
  if (!forwarded.includes("AI_GATEWAY_URL")) return "";
  return (
    ` --config ${shq('model_providers.teploy-gateway.name="teploy-gateway"')}` +
    ` --config "model_providers.teploy-gateway.base_url='$AI_GATEWAY_URL'"` +
    ` --config ${shq('model_providers.teploy-gateway.env_key="AI_GATEWAY_KEY"')}` +
    ` --config ${shq('model_provider="teploy-gateway"')}`
  );
}

interface CommandSpec {
  binary: string;
  /** The live tracker for this harness's event stream. */
  live: () => LiveTracker;
  /** Pick the invocation for the binary's resolved major line (an unparseable version = the 1 line, as before D6). */
  line: (major: number | undefined) => LineSpec;
  /** Is the usage this harness reports billed per token under the forwarded credentials? */
  priced: (forwarded: string[]) => boolean;
  /**
   * Refuse a found binary whose resolved version this adapter cannot drive,
   * returning the reason (undefined = run it). The recorded preflight value
   * carries the refusal, so replay takes the same branch.
   */
  refuseVersion?: (version: string, expected?: string) => string | undefined;
}

const claudeLine: LineSpec = {
  // claude refuses bypassPermissions as root unless it is told it is in a
  // sandbox; the sandbox image runs as root and IS a sandbox.
  command: ({ config, maxSteps, maxRunCostUSD, priced, browser }) =>
    `IS_SANDBOX=1 claude -p "$(cat ${shq(PROMPT_PATH)})" --output-format stream-json --verbose ` +
    `--permission-mode bypassPermissions --max-turns ${maxSteps}` +
    (config.claudeBare ? " --bare" : "") +
    (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
    (priced && maxRunCostUSD > 0 ? ` --max-budget-usd ${maxRunCostUSD.toFixed(2)}` : "") +
    (browser === true ? ` --mcp-config ${shq(CLAUDE_MCP_CONFIG_PATH)}` : ""),
  parse: (exec, priced) => {
    const parsed = parseClaudeStream(exec.stdout, priced);
    if (!parsed.sawResult && exec.exitCode !== 0) {
      return { ...parsed, summary: `claude exited ${exec.exitCode} before producing a result: ${tail(exec.stderr, 600).trim() || "(no stderr)"}` };
    }
    return parsed;
  },
  // D7: `--resume <id>` makes the next `-p` process a continuation of the
  // recorded session — the same session-resume steering T3's Claude adapter
  // does through the Agent SDK (apps/server/src/orchestration-v2/Adapters/
  // ClaudeAdapterV2.ts: resume + a user message), on the CLI Ship drives.
  steerResume: ({ config, maxSteps, maxRunCostUSD, priced, session, notePath, browser }) =>
    `IS_SANDBOX=1 claude -p "$(cat ${shq(notePath)})" --output-format stream-json --verbose ` +
    `--permission-mode bypassPermissions --max-turns ${maxSteps} --resume ${shq(session)}` +
    (config.claudeBare ? " --bare" : "") +
    (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
    (priced && maxRunCostUSD > 0 ? ` --max-budget-usd ${maxRunCostUSD.toFixed(2)}` : "") +
    (browser === true ? ` --mcp-config ${shq(CLAUDE_MCP_CONFIG_PATH)}` : ""),
};

function opencodeParse(using: (stdout: string) => ReturnType<typeof parseOpencodeStream> | ReturnType<typeof parseOpencode2Stream>) {
  return (exec: ExecResult): ParsedRun => {
    const parsed = using(exec.stdout);
    const sessionId = "sessionId" in parsed && typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    if (parsed.error !== undefined || exec.exitCode !== 0) {
      return {
        status: "error",
        summary: `opencode ${parsed.error !== undefined ? `reported: ${parsed.error}` : `exited ${exec.exitCode}: ${tail(exec.stderr, 600).trim() || "(no stderr)"}`}`,
        turns: parsed.turns,
        usage: parsed.usage,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    }
    return {
      status: "finished",
      summary: parsed.summary === "" ? "opencode finished without a summary" : parsed.summary.slice(0, 4000),
      turns: parsed.turns,
      usage: parsed.usage,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  };
}

/** opencode 1.x: `--pure`/`--dir` invocation, `tool` events, `step_finish` turns. Kept for the images that still bake the 1.x pin and for the runs they recorded (D6). */
const opencodeV1Line: LineSpec = {
  command: ({ config }) =>
    `opencode run --format json --auto --pure --dir . ` +
    (config.model !== undefined ? `--model ${shq(config.model)} ` : "") +
    `"$(cat ${shq(PROMPT_PATH)})"`,
  parse: opencodeParse(parseOpencodeStream),
};

/** opencode 2.x (D6): flags and events per the measured 2.0.26 contract. */
const opencodeV2Line: LineSpec = {
  // --pure and --dir are GONE (the v1 invocation fails flag-parse here).
  // There is no --pure replacement: plugin policy moved to config. The
  // sandbox remains the isolation boundary — default-deny egress, ephemeral
  // container — and the 2.x background service `run` talks to lives inside
  // that container and dies with it. --session is caller-chosen so the id is
  // a function of the run, not of stream parsing (receipt §3).
  command: ({ config, session }) =>
    `opencode run --format json --auto` +
    (session !== undefined ? ` --session ${shq(session)}` : "") +
    (config.model !== undefined ? ` --model ${shq(config.model)} ` : " ") +
    `"$(cat ${shq(PROMPT_PATH)})"`,
  parse: opencodeParse(parseOpencode2Stream),
  sessionFor: ({ runId, prefix }) => opencodeSessionId(runId, prefix),
  steerResume: ({ config, session, notePath }) =>
    `opencode run --format json --auto --session ${shq(session)} ` +
    (config.model !== undefined ? `--model ${shq(config.model)} ` : "") +
    `"$(cat ${shq(notePath)})"`,
};

const codexLine: LineSpec = {
  // `codex exec --json` is the one-shot headless mode: JSONL on stdout, one
  // exec, parse at exit — the same shape as claude's `-p --output-format
  // stream-json`. NOT `codex app-server`: that is a long-lived JSON-RPC
  // stdio server (initialize → thread/start → turn/start → notifications),
  // which needs interactive stdin the sandbox exec API does not have —
  // output is request/response and execStream is read-only. docs/adapters.md
  // "codex" carries the full argument.
  //
  // --dangerously-bypass-approvals-and-sandbox = approval_policy never +
  // sandbox_mode danger-full-access in one flag, and its own help text says
  // it is "intended solely for running in environments that are externally
  // sandboxed" — which a Ship run is: the sandbox container IS the isolation
  // boundary (default-deny egress, disposable FS), and codex's nested
  // Landlock sandbox would be a second sandbox inside it, one that also
  // denies network egress under workspace-write.
  command: ({ config, forwarded, browser }) =>
    `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` +
    (config.model !== undefined ? ` --model ${shq(config.model)}` : "") +
    codexGatewayConfigFlags(forwarded) +
    (browser === true ? codexMcpConfigFlags() : "") +
    ` - < ${shq(PROMPT_PATH)}`,
  parse: (exec) => {
    const parsed = parseCodexExecStream(exec.stdout);
    if (!parsed.sawCompletion && exec.exitCode !== 0) {
      return { ...parsed, status: "error", summary: `codex exited ${exec.exitCode} before completing a turn: ${tail(exec.stderr, 600).trim() || "(no stderr)"}` };
    }
    return parsed;
  },
};

const SPECS: Record<string, CommandSpec> = {
  "claude-code": {
    binary: "claude",
    live: claudeLiveTracker,
    line: () => claudeLine,
    // An API key bills per token; an OAuth token draws on a subscription. A
    // custom auth token / base URL is a proxy whose billing Ship cannot see.
    priced: (forwarded) => forwarded.includes("ANTHROPIC_API_KEY") && !forwarded.includes("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  opencode: {
    binary: "opencode",
    live: opencodeLiveTracker,
    // Version-aware since D6: 1.x drives the 1.x contract, 2.x the measured
    // v2 one. An unparseable version takes the 1.x line, exactly as before.
    line: (major) => (major !== undefined && major >= 2 ? opencodeV2Line : opencodeV1Line),
    // Decided per run from the cost opencode reports (parseOpencodeStream / parseOpencode2Stream).
    priced: () => true,
    // S13 major-version guard, continued: 1.x and 2.x are measured; anything
    // PAST 2.x is refused rather than guessed at. An unparseable version
    // stays a recorded `pinned: false`, never a refusal.
    refuseVersion: (version, expected) => {
      const major = versionMajor(version);
      return major !== undefined && major >= 3 ? opencodeFutureLineRefusal(version, expected) : undefined;
    },
  },
  codex: {
    binary: "codex",
    live: codexLiveTracker,
    line: () => codexLine,
    // codex exec reports tokens and never dollars — there is no total_cost_usd
    // equivalent in the exec event stream — so every codex run is counted in
    // the unpriced ledger with its tokens recorded (P5-3). Under
    // CODEX_ACCESS_TOKEN that is exactly right (a subscription quota); under
    // an API key the bill exists but Ship has no figure for it, and $0 would
    // be the dishonest answer.
    priced: () => false,
  },
};

export function externalAdapter(
  id: "claude-code" | "opencode" | "codex",
  options: ExternalHarnessOptions = {},
  version: string = HARNESS_VERSIONS[id]!,
): HarnessAdapter {
  const spec = SPECS[id]!;
  const env = options.env ?? process.env;
  // Contract 1 never recorded the steer steps. An alias registered under "1"
  // (HARNESS_ALIAS_VERSIONS) is this same adapter with the loop off, so a
  // log recorded before the steer contract replays step-for-step.
  const steerLoop = version !== "1";
  return {
    id,
    version,
    isolated: true,
    async run(task, ws, budget, onEvent): Promise<HarnessResult> {
      const p = ws.stepPrefix;
      onEvent({ kind: "started", harness: id });
      const pre = await ws.ctx.step(`${p}harness-preflight`, () => preflight(ws.executor, id, spec.binary, spec.refuseVersion));
      if (!pre.found) {
        const result = errorResult(`${pre.detail ?? `${spec.binary} was not found`} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      // A version this adapter refuses (an opencode past the measured 2.x
      // line) is the same shape as a missing binary: the reason is on the
      // recorded preflight step, the run stops here, and the binary never
      // executes.
      if (pre.refused !== undefined) {
        const result = errorResult(`${pre.refused} Nothing ran.`);
        onEvent({ kind: "completed", status: result.status });
        return result;
      }
      // Version-aware since D6: the line the resolved major selects decides
      // the invocation, the parser, and whether the session can be resumed.
      const line = spec.line(versionMajor(pre.version));
      const sessionFor = line.sessionFor?.({ runId: ws.ctx.runId, prefix: p });
      // H2 (SHIP_HARNESS_CRED): unseal the run's recorded credential
      // references into the env this attempt's execs deliver. Store values WIN
      // over the worker's own env of the same name — the enqueue gate judged
      // the destination with exactly this precedence — and a reference that
      // cannot be resolved stops the exec with a recorded, named refusal: the
      // run was admitted on that credential, and proceeding without it would
      // be a silently unauthenticated vendor call.
      // B1: EVERY delivered binding is a reference, a stored base URL or
      // config blob included, so the exec env is exactly the env the gate
      // judged — a base URL that stopped at the gate would dial the vendor's
      // default host with the token while the policy approved the stored one.
      // S1: only THIS profile's references; a binding sealed for another
      // attempt's profile is not this one's to receive by name-collision.
      const credentials = await resolveCredentialOverlay(task.input.harnessCredentials, options.credentials, id);
      const credentialFailure = credentials.failure;
      let runEnv: NodeJS.ProcessEnv =
        credentialFailure === undefined && Object.keys(credentials.overlay).length > 0 ? { ...env, ...credentials.overlay } : env;
      // SHIP_HARNESS_BROWSER (harness-browser.ts): decide this attempt's
      // browser wiring from the worker's flag and the recorded input — the
      // same tier/plan gates the native look action reads — and, for opencode
      // only, merge the server into the config blob this exec will deliver.
      // The merge runs BEFORE the armed secret set and the destination
      // re-check below, so both judge exactly the bytes the harness reads;
      // a blob the merge cannot read downgrades to a refused wiring (a note
      // in the prompt, never a silently missing server), and the injected
      // local entry derives no destination at all (opencodeConfigWithBrowser
      // / isHarnessBrowserMcpServer).
      const browserGate = harnessBrowserWiring(task.input, env);
      let browser: HarnessBrowserWiring = browserGate;
      if (browserGate.kind === "wired" && id === "opencode") {
        const merged = opencodeConfigWithBrowser(runEnv.OPENCODE_CONFIG_CONTENT);
        if ("refusal" in merged) browser = { kind: "refused", reason: merged.refusal };
        else runEnv = { ...runEnv, OPENCODE_CONFIG_CONTENT: merged.content };
      }
      // H2 hardening: arm the workspace's live secret set OUTSIDE every
      // recorded step. The step body below used to be the only place the
      // delivered values reached it, and a replayed or resumed run replays
      // the RECORDED harness-run value without executing the body — so the
      // publish gate and the snapshot hygiene scans after the resume would
      // judge a tree with no needles at all. Runtime state, never recorded.
      const armed = forwardEnv(externalHarnessConfig(id, runEnv).forward, runEnv);
      if (ws.secrets !== undefined) {
        for (const secret of armed.secrets) {
          if (!ws.secrets.some((known) => known.name === secret.name && known.value === secret.value)) ws.secrets.push(secret);
        }
      }
      // S2: re-judge the destination over the env this exec will really
      // deliver — the gate at enqueue judged the enqueue host's env, and a
      // worker whose env or store moved the dial elsewhere refuses by name
      // rather than send data where admission never approved. Runs on every
      // flag-ON worker: an input that records no destinations at all was
      // enqueued before the gate judged any (flag off, or older code), and
      // this worker refuses it rather than skip the re-check — inheriting
      // "nobody looked" is not the same as being approved. The flag is
      // forced on inside the derivation env so it reads the config blob
      // exactly as the enqueue's derivation did; the routing policy and the
      // data class are read from the WORKER's own env (policyEnv) — the
      // overlaid run env carries unsealed store values, and a binding must
      // not steer the judgment of its own delivery.
      const destinationFailure =
        harnessCredEnabled(env) && credentialFailure === undefined
          ? harnessDestinationCheck({
              id,
              approved: task.input.harnessDestinations?.[id],
              env: { ...runEnv, [HARNESS_CRED_FLAG]: "on" },
              policyEnv: env,
            })
          : undefined;
      const startupFailure = credentialFailure ?? destinationFailure;
      /**
       * One vendor exec: the command with its credentials in the exec's own
       * env, the output scrubbed of them, the parsed record. `startDetail` is
       * the live hint before the stream opens; the resume execs pass none
       * because the steer round already announced itself.
       */
      const execRecord = async (
        commandFor: (opts: ExecOpts & { session?: string }) => string,
        writeFiles: () => Promise<void>,
        startDetail?: string,
      ): Promise<HarnessRunRecord> => {
        if (startupFailure !== undefined) {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: startupFailure,
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
            forwarded: [],
            stderrTail: "",
          };
        }
        // The wired browser's session has to be up before the vendor exec:
        // the MCP server the harness spawns attaches to the run's own
        // Chromium over CDP (the same session look drives), and a harness
        // that finds no endpoint would only log a dead tool. A failed start
        // is a recorded refusal — the operator asked for a browser, and a
        // silent downgrade would read as "the browser is flaky".
        if (browser.kind === "wired") {
          const session = await ensureRunBrowserSession(ws.executor);
          if (!session.ok) {
            return {
              exitCode: -1,
              timedOut: false,
              status: "error",
              summary: `the browser was requested (SHIP_HARNESS_BROWSER=on) but ${session.reason} Nothing ran.`,
              turns: 0,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
              forwarded: [],
              stderrTail: "",
            };
          }
          // claude's config file is (re)written per exec: the finally below
          // deletes it after EVERY exec, and a steering resume exec carries
          // --mcp-config too — it must find the file there.
          if (id === "claude-code") await ws.executor.putFile(CLAUDE_MCP_CONFIG_PATH, claudeMcpConfig());
        }
        const config = externalHarnessConfig(id, runEnv);
        const forwarded = forwardEnv(config.forward, runEnv);
        const priced = spec.priced(forwarded.names);
        // The vendor process and every tool it spawns inherit the forwarded
        // credentials, so an agent that prints `env` prints them. Every value
        // Ship handed over rides the workspace's live secret set (armed
        // above, OUTSIDE the step, so a replayed run keeps the scan too)
        // plus the run's own forge tokens, and is replaced in the output
        // BEFORE it is parsed, recorded or shown live.
        const secrets: KnownSecret[] = [...forwarded.secrets, ...(ws.secrets ?? [])];
        try {
          await writeFiles();
          const command =
            forwarded.prelude +
            commandFor({ config, maxSteps: budget.maxSteps, maxRunCostUSD: budget.maxRunCostUSD, priced, forwarded: forwarded.names, ...(browser.kind === "wired" ? { browser: true as const } : {}), ...(sessionFor !== undefined ? { session: sessionFor } : {}) });
          const execOptions = {
            timeoutMs: config.timeoutMs,
            maxOutputBytes: 16 * 1_048_576,
            ...(Object.keys(forwarded.env).length > 0 ? { env: forwarded.env } : {}),
          };
          // Streamed when the executor can (the sandbox daemon), so the run
          // page shows the harness's turns and tool calls as they happen
          // instead of a thirty-minute blank. Same result either way; the
          // recorded step is the exit, never the chunks.
          if (startDetail !== undefined) ws.live?.({ phase: "harness", turn: 0, detail: startDetail });
          const tracker = spec.live();
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
          const parsed = line.parse(exec, priced);
          const timedOut = exec.timedOut === true;
          const sessionId = parsed.sessionId ?? sessionFor;
          return {
            exitCode: exec.exitCode,
            timedOut,
            status: timedOut ? "error" : parsed.status,
            summary: timedOut ? `${spec.binary} did not finish within ${Math.round(config.timeoutMs / 60_000)} minutes` : parsed.summary,
            turns: parsed.turns,
            usage: parsed.usage,
            forwarded: forwarded.names,
            stderrTail: tail(exec.stderr),
            // The session the binary actually ran (parsed) — or, on a line
            // with a caller-chosen id, the one we told it to. Recorded so
            // steering resumes exactly what the log says ran.
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
            ...(parsed.fileChanges !== undefined ? { fileChanges: parsed.fileChanges } : {}),
            ...(parsed.commands !== undefined ? { commands: parsed.commands } : {}),
          };
        } catch (error) {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: scrubExact(`${spec.binary} could not be run: ${error instanceof Error ? error.message : String(error)}`, secrets),
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
            forwarded: forwarded.names,
            stderrTail: "",
          };
        } finally {
          await ws.executor.exec(`rm -f ${shq(PROMPT_PATH)} ${shq(STEER_PATH)} ${shq(CLAUDE_MCP_CONFIG_PATH)}`, { timeoutMs: 30_000 }).catch(() => {});
        }
      };
      const record = await ws.ctx.step(`${p}harness-run`, async (): Promise<HarnessRunRecord> => {
        const config = externalHarnessConfig(id, runEnv);
        // Admission covers the UI/queue; direct CLI workflow execution also
        // must not silently skip an operator's requested plan gate. Kept as a
        // recorded `error` RESULT, not a thrown step — the contract every
        // earlier log carries, so prior completed runs replay the same value.
        if (task.input.plan === true && task.input.mode !== "scan") {
          return {
            exitCode: -1,
            timedOut: false,
            status: "error",
            summary: `${refusalFor(id, "plan-review") ?? PLAN_REVIEW_REFUSAL} No external agent was started.`,
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false },
            forwarded: forwardEnv(config.forward, runEnv).names,
            stderrTail: "",
          };
        }
        const run = await execRecord(
          (opts) => line.command(opts),
          async () => {
            await ws.executor.putFile(PROMPT_PATH, externalPrompt(task.prompt, task.input.mode) + harnessBrowserPromptNote(browser));
          },
          `${spec.binary} starting`,
        );
        // S4: rotation is allowed and delivered at the current value, but the
        // record says so — a version that moved past the one the input
        // recorded is a fact the run's log should carry, not absorb.
        return credentials.rotation !== undefined ? { ...run, credentialRotation: credentials.rotation } : run;
      });
      // D6/D7 — steering by session resume, at process boundaries. Gated on
      // the input flag set at enqueue (the same gate the step fingerprint
      // admits these steps by) and on the contract (version "1" never records
      // them), and bounded by STEER_ROUNDS_MAX. The loop's control flow reads
      // recorded facts alone — the drain's turn-claimed notes, the recorded
      // session id, the line the recorded preflight resolved, the recorded
      // timeout flag, recorded spend — so a replay walks exactly the rounds
      // the log carries and never starts a vendor process. A note that cannot
      // be delivered is consumed into a recorded refusal rather than left
      // pending forever, and the final step records whatever the loop never
      // read.
      let status = record.status;
      let summary = record.summary;
      let turns = record.turns;
      let usage = record.usage;
      if (steerLoop && task.input.steer === true) {
        const undelivered: string[] = [];
        let session = record.sessionId;
        // A plan-review refusal / could-not-run record (exitCode -1) started
        // nothing, and a timed-out main run has no session worth resuming:
        // neither steers. The final drain below still runs.
        let steerable = record.exitCode !== -1 && !record.timedOut;
        for (let round = 0; steerable && round < STEER_ROUNDS_MAX; round++) {
          const notes = await ws.ctx.step(`${p}harness-steer-${round}`, async () => {
            // Keyed by attempt prefix + round so the drain is idempotent and
            // no two attempts of one run claim each other's notes (the same
            // stamp-then-read discipline the native loop's turn key gives it).
            if (options.steer === undefined) return [];
            return await options.steer.drain(ws.ctx.runId, `${p}ext-${round}`).catch(() => []);
          });
          if (notes.length === 0) break;
          // What is left of the run's caps. Each resume is a fresh vendor
          // process that would otherwise get the FULL --max-turns and
          // --max-budget-usd again, so a steered run could spend several
          // times its ceiling.
          const remainingTurns = budget.maxSteps - turns;
          // A cost cap bounds a resume only if spend so far is KNOWN. Unknown
          // (unpriced) spend on a harness that is billed per token (opencode
          // on a model it cannot price) would otherwise count as $0 and let
          // every resume run uncapped, so the resume is refused with a reason.
          // A harness that is unpriced by design (a subscription: claude with
          // an OAuth token, codex) has no dollar cap to honour and stays
          // bounded by its turn limit.
          const spendUnknown = budget.maxRunCostUSD > 0 && usage.priced === false && spec.priced(forwardEnv(externalHarnessConfig(id, runEnv).forward, runEnv).names);
          const spent = usage.priced === false ? 0 : (usage.costUSD ?? 0);
          const remainingCost = budget.maxRunCostUSD - spent;
          const resumed = await ws.ctx.step(`${p}harness-resume-${round}`, async (): Promise<HarnessRunRecord | { delivered: false; reason: string }> => {
            if (line.steerResume === undefined || session === undefined) {
              // A note the gate accepted but this run cannot deliver — a 2.x
              // contract on a 1.x binary (no --session, no recorded id).
              // Consumed with the reason on the record, never silently
              // dropped and never left pending after the run ends.
              return {
                delivered: false,
                reason:
                  `steering was accepted for this run, but its ${spec.binary} cannot take it: ` +
                  (line.steerResume === undefined
                    ? `the 1.x line records no session to resume`
                    : `the run recorded no session id to resume`) +
                    `. The note was not delivered; send a follow-up instead.`,
              };
            }
            if (budget.maxSteps > 0 && remainingTurns <= 0) {
              return { delivered: false, reason: `the run has used its ${budget.maxSteps}-turn limit, so there is no budget left to act on the note. The note was not delivered; send a follow-up instead.` };
            }
            if (spendUnknown) {
              return { delivered: false, reason: `the run's spend is unpriced, so its $${budget.maxRunCostUSD.toFixed(2)} cost limit cannot be enforced across a resume. The note was not delivered; send a follow-up instead.` };
            }
            if (budget.maxRunCostUSD > 0 && remainingCost < 0.01) {
              return { delivered: false, reason: `the run has spent its $${budget.maxRunCostUSD.toFixed(2)} cost limit, so there is no budget left to act on the note. The note was not delivered; send a follow-up instead.` };
            }
            const resumeSession = session;
            return await execRecord(
              (opts) =>
                line.steerResume!({
                  ...opts,
                  maxSteps: budget.maxSteps > 0 ? remainingTurns : opts.maxSteps,
                  maxRunCostUSD: budget.maxRunCostUSD > 0 ? remainingCost : opts.maxRunCostUSD,
                  session: resumeSession,
                  notePath: STEER_PATH,
                }),
              async () => {
                await ws.executor.putFile(STEER_PATH, notes.map((note) => `Operator steering — adjust course accordingly: ${note}`).join("\n\n"));
              },
              `steering note → ${spec.binary}`,
            );
          });
          if ("delivered" in resumed) {
            undelivered.push(...notes);
            summary += `\n\nSteering not delivered: ${resumed.reason}`;
            break;
          }
          // exitCode -1 is the "could not be run" record: its zero-usage
          // `priced: false` means "no data", not "unpriced", and must not
          // flip the run's accounting.
          if (resumed.exitCode >= 0) {
            turns += resumed.turns;
            usage = addUsage(usage, resumed.usage);
          }
          if (resumed.status === "finished" && !resumed.timedOut) {
            // The resume completed: its work stands. Its account is appended,
            // never substituted — the main run's summary is part of the result.
            status = "finished";
            summary += `\n\nAfter steering: ${resumed.summary}`;
            if (resumed.sessionId !== undefined) session = resumed.sessionId;
          } else {
            // A failed delivery is a refusal on the record, not a verdict on
            // the work the main run already did: the attempt keeps its
            // status, and the notes it consumed are accounted as undelivered.
            undelivered.push(...notes);
            summary += `\n\nSteering not delivered: the resume ${resumed.timedOut ? "timed out" : `ended with ${resumed.status}`} (${resumed.summary.slice(0, 300)})`;
            break;
          }
        }
        // Notes accepted after the last drain (during the final resume, or
        // while the publish gate ran) would otherwise be accepted, answered
        // "sent" and never read. Drain them into an explicit record.
        const leftovers = await ws.ctx.step(`${p}harness-steer-undelivered`, async () => {
          const late = options.steer === undefined ? [] : await options.steer.drain(ws.ctx.runId, `${p}ext-final`).catch(() => []);
          return [...undelivered, ...late];
        });
        if (leftovers.length > 0) summary += `\n\nSteering notes that were NOT delivered to the agent (${leftovers.length}): ${leftovers.join(" | ").slice(0, 1500)}`;
      }
      for (let turn = 0; turn < turns; turn++) onEvent({ kind: "turn", turn });
      onEvent({ kind: "completed", status });
      return {
        status,
        summary,
        turns,
        usage,
        incomplete: status !== "finished",
      };
    },
  };
}

/** Every external adapter this worker can carry. Presence of the binary is checked per run, as a recorded step. */
export function externalAdapters(options: ExternalHarnessOptions = {}): HarnessAdapter[] {
  const adapters = [externalAdapter("claude-code", options), externalAdapter("opencode", options), externalAdapter("codex", options)];
  for (const [id, versions] of Object.entries(HARNESS_ALIAS_VERSIONS)) {
    for (const version of versions) adapters.push(externalAdapter(id as "claude-code" | "opencode", options, version));
  }
  return adapters;
}
