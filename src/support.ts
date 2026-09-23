/**
 * S19: the redacted support bundle — `teploy-ship support`.
 *
 * Until this existed there was no way for an operator to assemble a
 * diagnostic bundle a vendor could read. The only options were the raw event
 * logs (hundreds of events per run, everything the agent ever saw) or the
 * config file (every credential Ship runs on). What a remote supporter needs
 * is version/config/image identities, bounded recent logs, and run-state
 * summaries — and nothing that carries credentials.
 *
 * Four invariants, all enforced here rather than asked of the operator:
 *
 * 1. **Whitelist, never blacklist.** The config summary emits known-safe keys
 *    only (CONFIG_WHITELIST below). A key that does not appear in that list
 *    cannot reach the bundle, so a future env var cannot leak by forgetting to
 *    exclude it. The store's raw config file is never read, copied, or
 *    archived by this module — only the parsed, whitelisted projection.
 * 2. **Everything textual passes the gate.** Every file this module writes —
 *    JSON included, by walking string values so the JSON stays parseable —
 *    goes through RedactionGate, which shares its credential pattern set with
 *    scripts/scan-secrets.mjs (src/secret-patterns.ts) and adds the shapes the
 *    scan deliberately does not model: userinfo URLs, bearer tokens, full
 *    private-key blocks, and TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL-named
 *    assignments.
 * 3. **Bounded reads.** Recent runs are capped (20 by default), the counts
 *    window is capped, container logs are tail-capped twice — once in the
 *    `--tail` flag and once locally, because the local clamp is the one a
 *    misbehaving docker cannot defeat. A support tool that reads unbounded
 *    history is a second incident.
 * 4. **Degrade honestly.** No docker, no selfwatch store, no tar: the bundle
 *    still assembles and says exactly what it could not collect, in a note
 *    file where the content would have been.
 *
 * What is deliberately absent, forever: credential material, full event
 * histories, and file contents from workspaces. See docs/SUPPORT.md.
 *
 * Every dependency is injected (fs, docker CLI, store reader, clock), so the
 * whole assembly is unit-testable against a fake store — this has never run
 * against a real deployment, and the tests are the only proof that exists.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { auditRow } from "./audit.js";
import type { RunMeta } from "./run-store.js";
import type { WorkerInfo } from "./fleet.js";
import { buildFingerprint } from "./step-fingerprint.js";
import { computeHealth, healthWarnings } from "./selfwatch.js";
import { SECRET_PATTERNS, redactionMarker } from "./secret-patterns.js";

/** Version of this bundle format. Bump when a file is added or a field changes meaning. */
export const SUPPORT_SCRIPT_VERSION = 1;

/** Default and hard cap for --log-lines. The cap is applied here, not trusted to the CLI. */
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;

/** How many of the most recent runs get a row (and an event-log read) each. */
export const DEFAULT_RECENT_RUNS = 20;

/**
 * Ceiling on the store read for counts. Unbounded history over a Nucleus with
 * months of runs would make the support tool itself the load it is diagnosing;
 * the window is recorded in the emitted JSON so nobody mistakes it for all
 * history.
 */
export const RUNS_WINDOW_LIMIT = 1000;

// ---------------------------------------------------------------------------
// the redaction gate
// ---------------------------------------------------------------------------

interface GateRule {
  /** Counting category in REDACTION-REPORT.txt. */
  kind: string;
  /** Global-flagged detection. Order below is load-bearing (see comments). */
  global: RegExp;
  /** Replacement from the whole match and its capture groups. */
  render: (match: string, groups: string[]) => string;
}

/**
 * The gate's rules, in the order they must run.
 *
 * The full private-key block runs FIRST so a complete block is consumed
 * before the scan's BEGIN-line pattern can replace just the header and leave
 * the key body sitting in the output. URL userinfo runs before the
 * credential-assignment rule so a NUCLEUS_URL value is rewritten as a URL,
 * not mangled as an assignment. Bearer runs before the provider-token scans
 * so a printed Authorization header counts once, as one redaction, instead of
 * twice. The char classes deliberately exclude quotes and brackets: the gate
 * must be idempotent (its own markers cannot re-match) and must never eat a
 * JSON quoting character out of a payload that was not JSON-aware.
 */
const GATE_RULES: GateRule[] = [
  {
    kind: "private key block",
    global: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    render: () => redactionMarker("private key block"),
  },
  {
    kind: "url-userinfo",
    global: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'[\]]+:[^\s/@:"'[\]]{1,}@/gi,
    render: (_m, g) => `${g[0] ?? ""}[REDACTED]@`,
  },
  {
    kind: "url-userinfo",
    global: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'[\]]+@/gi,
    render: (_m, g) => `${g[0] ?? ""}[REDACTED]@`,
  },
  {
    kind: "bearer-token",
    global: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    render: () => "Bearer [REDACTED:bearer-token]",
  },
  // The shared scan set (src/secret-patterns.ts), global-flagged for rewriting.
  ...SECRET_PATTERNS.map((p) => ({
    kind: p.name,
    global: new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`),
    render: () => redactionMarker(p.name),
  })),
  {
    kind: "credential-assignment",
    global: /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)("[^"\n]*"?|'[^'\n]*'?|[^\s,;&"']+)/g,
    render: (_m, g) => {
      // Quoting survives: an operator grepping SHIP_WEB_TOKEN=... in a log
      // still sees where the value was, wrapped the way the log wrapped it.
      const value = g[2] ?? "";
      const quote = value.startsWith('"') || value.startsWith("'") ? value.slice(0, 1) : "";
      return `${g[0] ?? ""}${g[1] ?? ""}${quote}[REDACTED]${quote}`;
    },
  },
];

/**
 * The redaction every text payload passes before it is written into a bundle.
 * Counts every rewrite by category so REDACTION-REPORT.txt can say what was
 * removed rather than merely that something was.
 */
export class RedactionGate {
  #counts: Record<string, number> = {};

  get counts(): Readonly<Record<string, number>> {
    return this.#counts;
  }

  get total(): number {
    return Object.values(this.#counts).reduce((a, b) => a + b, 0);
  }

  /** Rewrite recognisable credentials in free text. Safe on any string, including "". */
  redact(text: string): string {
    if (text === "") return text;
    let out = text;
    for (const rule of GATE_RULES) {
      out = out.replace(rule.global, (...args: unknown[]) => {
        this.#tally(rule.kind);
        const match = typeof args[0] === "string" ? args[0] : "";
        const groups = (args.slice(1, -2) as unknown[]).map((g) => (typeof g === "string" ? g : ""));
        return rule.render(match, groups);
      });
    }
    return out;
  }

  /**
   * Redact every STRING inside a JSON-shaped value and return a value of the
   * same shape. Redacting the serialized text instead would let a rule eat a
   * quoting character and hand the vendor a bundle that does not parse.
   */
  redactJson(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactJson(v));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactJson(v);
      return out;
    }
    return value;
  }

  #tally(kind: string): void {
    this.#counts[kind] = (this.#counts[kind] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// config summary — the whitelist
// ---------------------------------------------------------------------------

/**
 * The ONLY Ship settings a bundle may carry. All are booleans, numbers, model
 * ids, policy maps, or URL hosts. Anything not on this list — tokens, URLs
 * with credentials, paths — is absent because it was never considered, not
 * because it was filtered out; that is the difference between a whitelist and
 * a blacklist that forgot a key.
 */
const CONFIG_WHITELIST = [
  "SHIP_MODEL",
  "SHIP_HARNESS_MODEL",
  "SHIP_MAX_STEPS",
  "SHIP_SANDBOX_TTL_SEC",
  "SHIP_WARM_PARKS",
  "SHIP_PUBLIC_URL",
  "SHIP_TELEMETRY",
  "SHIP_INTAKE_POLICIES",
  "SHIP_MIN_FREE_MB",
  "SHIP_MAX_CONCURRENT_RUNS",
] as const;

/** A key name that must never appear as a key (or a value's key) in a bundle. */
export const FORBIDDEN_KEY = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/;

/** The parsed config file's fields that map onto whitelist keys. The raw file is never included. */
export interface SupportConfigInput {
  model?: string;
  intake?: Record<string, string>;
  maxConcurrentRuns?: number;
  nucleusUrl?: string;
}

/** Host (hostname:port) of a URL, or undefined when it does not parse. Credentials never survive this. */
export function urlHost(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.host;
  } catch {
    return undefined;
  }
}

function envFlag(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined) return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function envNum(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the whitelisted config summary. Env wins over the config file, which
 * is how the worker itself resolves settings. Unparseable values are OMITTED
 * (not emitted raw) — a value this function cannot type is a value the
 * whitelist never promised.
 */
export function configSummary(env: NodeJS.ProcessEnv, config?: SupportConfigInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (key: string): string | undefined => {
    const v = env[key];
    return v !== undefined && v !== "" ? v : undefined;
  };
  const put = (key: (typeof CONFIG_WHITELIST)[number], value: unknown): void => {
    if (value === undefined) return;
    out[key] = value;
  };

  put("SHIP_MODEL", str("SHIP_MODEL") ?? config?.model);
  put("SHIP_HARNESS_MODEL", str("SHIP_HARNESS_MODEL"));
  put("SHIP_MAX_STEPS", envNum(env, "SHIP_MAX_STEPS"));
  put("SHIP_SANDBOX_TTL_SEC", envNum(env, "SHIP_SANDBOX_TTL_SEC"));
  put("SHIP_WARM_PARKS", envFlag(env.SHIP_WARM_PARKS));
  put("SHIP_PUBLIC_URL", urlHost(env.SHIP_PUBLIC_URL ?? ""));
  put("SHIP_TELEMETRY", envFlag(env.SHIP_TELEMETRY));
  const rawPolicies = str("SHIP_INTAKE_POLICIES");
  if (rawPolicies !== undefined) {
    // Invalid JSON here would fail the worker at startup; for the bundle it is
    // simply not a boolean/number/host the whitelist can type — omit it.
    try {
      const parsed: unknown = JSON.parse(rawPolicies);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        put("SHIP_INTAKE_POLICIES", parsed);
      }
    } catch {
      // omitted by design
    }
  } else if (config?.intake !== undefined && Object.keys(config.intake).length > 0) {
    put("SHIP_INTAKE_POLICIES", config.intake);
  }
  put("SHIP_MIN_FREE_MB", envNum(env, "SHIP_MIN_FREE_MB"));
  put("SHIP_MAX_CONCURRENT_RUNS", envNum(env, "SHIP_MAX_CONCURRENT_RUNS") ?? config?.maxConcurrentRuns);

  // The whitelist's own future: if someone adds a key that matches the
  // forbidden shape, fail HERE, at build time of the summary, rather than
  // shipping a bundle whose "safe keys" include a credential.
  for (const key of Object.keys(out)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`config summary whitelist leaked key "${key}" — remove it from CONFIG_WHITELIST resolution`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// bundle assembly
// ---------------------------------------------------------------------------

/**
 * The store reads the bundle needs, structural (like selfwatch's HealthDeps)
 * so tests pass a fake and the CLI passes the real runtime without either
 * depending on the other's full shape.
 */
export interface SupportStoreReader {
  listMeta(options?: { limit?: number }): Promise<RunMeta[]>;
  store: { load(runId: string): Promise<WorkflowEvent[]> };
  fleet: { list(): Promise<WorkerInfo[]> };
}

/** Docker access, injectable so tests never need the daemon. */
export interface SupportDocker {
  /** Running container names. Rejects when docker is absent or unreachable. */
  containers(): Promise<string[]>;
  /** Last `tail` lines of one container's logs. */
  logs(name: string, tail: number): Promise<string>;
}

/** File writes, injectable the same way. */
export interface SupportFiles {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface SupportDeps {
  /** Directory to assemble the bundle into (created; caller chooses where). */
  outDir: string;
  logLines?: number;
  /** Restrict runs-summary (rows and counts) to runs created in the last N days. */
  days?: number;
  recentRuns?: number;
  runsWindowLimit?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  hostname?: () => string;
  processUptimeSec?: () => number;
  nodeVersion?: () => string;
  /** The package.json identity to report. Defaults to the one beside dist/. */
  readPackage?: () => { version: string; dependencies: Record<string, string> } | undefined;
  /** Pinned teploy CLI version, when the box records one. */
  teployVersion?: () => string | undefined;
  config?: SupportConfigInput;
  store: SupportStoreReader;
  /** Undefined or rejecting means: no logs, note file instead. */
  docker?: SupportDocker;
  /** Container-name prefix that identifies this app's containers (default "ship-"). */
  containerPrefix?: string;
  /** Create the .tgz next to the bundle dir. Returns its path, or undefined when tar is unavailable. */
  makeTgz?: (dir: string) => Promise<string | undefined>;
  files?: SupportFiles;
}

export interface SupportBundleResult {
  dir: string;
  tgz?: string;
  redactions: Readonly<Record<string, number>>;
  redactionTotal: number;
  /** Every file written, relative to the bundle dir. */
  files: string[];
}

/** Run a command and capture stdout, rejecting on any failure (ENOENT included). */
function run(bin: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr !== "" && stderr !== undefined ? `${bin}: ${String(stderr).trim()}` : error.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** Default docker access: the host's docker CLI. */
export function defaultDocker(bin = "docker"): SupportDocker {
  return {
    async containers() {
      const out = await run(bin, ["ps", "--format", "{{.Names}}"]);
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    },
    async logs(name: string, tail: number) {
      return run(bin, ["logs", "--tail", String(tail), name], 60_000);
    },
  };
}

/** Default tar step: shell out to tar, which every supported host ships. */
export function defaultMakeTgz(dir: string): Promise<string | undefined> {
  const tgz = `${dir}.tgz`;
  return run("tar", ["-czf", tgz, "-C", dirname(dir), basename(dir)], 120_000).then(() => tgz);
}

/** Default package identity: the package.json beside this module's compiled output. */
export function defaultReadPackage(): { version: string; dependencies: Record<string, string> } | undefined {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string; dependencies?: Record<string, string> };
    if (typeof pkg.version !== "string") return undefined;
    return { version: pkg.version, dependencies: pkg.dependencies ?? {} };
  } catch {
    return undefined;
  }
}

/** One line, at most `max` chars, from a free-text error field. */
function firstLine(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const line = value.split("\n")[0]!.trim();
  return line === "" ? undefined : (line.length > max ? `${line.slice(0, max)}…` : line);
}

/**
 * The terminal error of a failed run: the last `run-failed` wins, else the
 * most recent `step-failed` (a run can fail outright after a step failed, and
 * the outright failure is the more terminal fact). Structural events — the
 * same read-only fields the workflow log carries, so a fake store can feed it.
 */
export function terminalError(events: ReadonlyArray<{ type: string; name?: string; data?: unknown }>): string | undefined {
  let stepError: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const data = typeof e.data === "object" && e.data !== null ? (e.data as Record<string, unknown>) : undefined;
    if (e.type === "run-failed") return firstLine(data?.error);
    if (stepError === undefined && e.type === "step-failed") {
      const line = firstLine(data?.error);
      if (line !== undefined) stepError = `${e.name ?? "(step)"}: ${line}`;
    }
  }
  return stepError;
}

/** Keep the LAST n lines — the local clamp that bounds what docker reports, whatever it reports. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

/**
 * Assemble the bundle. See the module header for the invariants; the one that
 * matters to a caller is that this never throws for want of docker, selfwatch
 * or tar — only for want of the store or the output directory.
 */
export async function assembleSupportBundle(deps: SupportDeps): Promise<SupportBundleResult> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const logLines = Math.min(Math.max(1, Math.trunc(deps.logLines ?? DEFAULT_LOG_LINES)), MAX_LOG_LINES);
  const recentRuns = Math.max(1, Math.trunc(deps.recentRuns ?? DEFAULT_RECENT_RUNS));
  const windowLimit = Math.max(1, Math.trunc(deps.runsWindowLimit ?? RUNS_WINDOW_LIMIT));
  const files = deps.files ?? {
    mkdir: (dir: string) => fsMkdir(dir, { recursive: true }),
    writeFile: (path: string, text: string) => fsWriteFile(path, text, "utf8"),
  };
  const gate = new RedactionGate();
  const written: string[] = [];
  const write = async (rel: string, text: string): Promise<void> => {
    await files.writeFile(join(deps.outDir, rel), text);
    written.push(rel);
  };
  const writeJson = async (rel: string, value: unknown): Promise<void> => write(rel, `${JSON.stringify(gate.redactJson(value), null, 2)}\n`);

  await files.mkdir(deps.outDir);
  await files.mkdir(join(deps.outDir, "logs"));

  // --- manifest ------------------------------------------------------------
  const pkg = (deps.readPackage ?? defaultReadPackage)();
  await writeJson("manifest.json", {
    date: now().toISOString(),
    hostname: (deps.hostname ?? osHostname)(),
    shipVersion: pkg?.version,
    buildFingerprint: buildFingerprint(),
    nodeVersion: (deps.nodeVersion ?? (() => process.version))(),
    processUptimeSec: Number((deps.processUptimeSec ?? (() => process.uptime()))().toFixed(3)),
    scriptVersion: SUPPORT_SCRIPT_VERSION,
    logLines,
    recentRuns,
    runsWindowLimit: windowLimit,
    ...(deps.days !== undefined ? { days: deps.days } : {}),
  });

  // --- versions ------------------------------------------------------------
  await writeJson("versions.json", {
    shipVersion: pkg?.version,
    dependencies: Object.entries(pkg?.dependencies ?? {})
      .map(([name, version]) => `${name}@${version}`)
      .sort(),
    teployCli: (deps.teployVersion ?? (() => env.SHIP_TEPLOY_VERSION))(),
    // HOST ONLY: the URL is parsed and one field kept; credentials cannot
    // survive that, which is the point of not emitting the raw string.
    nucleusHost: urlHost(env.NUCLEUS_URL ?? deps.config?.nucleusUrl ?? ""),
  });

  // --- config summary ------------------------------------------------------
  await writeJson("config-summary.json", configSummary(env, deps.config));

  // --- runs summary --------------------------------------------------------
  const metas = await deps.store.listMeta({ limit: windowLimit });
  const cutoff = deps.days !== undefined ? new Date(now().getTime() - deps.days * 86_400_000).toISOString() : undefined;
  const windowed = metas.filter((m) => cutoff === undefined || m.createdAt >= cutoff);
  const countsByState: Record<string, number> = {};
  for (const m of windowed) countsByState[m.status] = (countsByState[m.status] ?? 0) + 1;
  const recent = [];
  for (const meta of windowed.slice(0, recentRuns)) {
    let events: WorkflowEvent[] = [];
    try {
      events = await deps.store.store.load(meta.runId);
    } catch {
      // An unreadable log leaves the row thinner, not the bundle emptier;
      // the audit row already tolerates an empty event list.
    }
    const row = auditRow(meta, events);
    recent.push({
      id: row.runId,
      state: row.status,
      repo: row.repo !== "" ? row.repo : undefined,
      createdAt: row.createdAt,
      ...(row.costUSD > 0 ? { costUsd: row.costUSD, costEstimated: row.costEstimated || undefined } : {}),
      ...(row.status === "failed" ? { error: terminalError(events) } : {}),
    });
  }
  await writeJson("runs-summary.json", {
    window: { limit: windowLimit, ...(cutoff !== undefined ? { since: cutoff } : {}) },
    totalInWindow: windowed.length,
    countsByState,
    recent,
  });

  // --- selfwatch -----------------------------------------------------------
  // The module exposes a runnable summary (computeHealth), so the bundle runs
  // it against the same store it just read. A store that answers listMeta but
  // not the health pass still gets a bundle — with the failure named.
  try {
    const snapshot = await computeHealth({
      runtime: { listMeta: deps.store.listMeta, store: deps.store.store },
      fleet: deps.store.fleet,
      owner: "support",
      activeRuns: 0,
      now,
    });
    const warnings = healthWarnings(snapshot);
    await write(
      "selfwatch.txt",
      gate.redact(
        `# selfwatch health snapshot (src/selfwatch.ts, computed ${snapshot.at})\n` +
          (warnings.length > 0 ? warnings.map((w) => `warning: ${w}`).join("\n") + "\n" : "no warnings\n") +
          `\n${JSON.stringify(gate.redactJson(snapshot), null, 2)}\n`,
      ),
    );
  } catch (error) {
    await write("selfwatch.txt", gate.redact(`selfwatch unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
  }

  // --- container logs ------------------------------------------------------
  const prefix = deps.containerPrefix ?? "ship-";
  if (deps.docker === undefined) {
    await write("logs/docker-unavailable.txt", "docker access was not available (no docker CLI on PATH from this process); container logs were not collected.\n");
  } else {
    let names: string[];
    try {
      names = (await deps.docker.containers()).filter((n) => n.startsWith(prefix));
    } catch (error) {
      names = [];
      await write(
        "logs/docker-unavailable.txt",
        gate.redact(`docker unavailable: ${error instanceof Error ? error.message : String(error)}\ncontainer logs were not collected.\n`),
      );
    }
    if (names.length === 0 && written.every((f) => f !== "logs/docker-unavailable.txt")) {
      await write("logs/docker-unavailable.txt", `no running containers matched the prefix "${prefix}"; nothing to collect.\n`);
    }
    for (const name of names) {
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
      try {
        // Tail-capped twice: the --tail flag asks docker for the bound, and
        // the local clamp enforces it even if a daemon ignores the flag.
        const raw = await deps.docker.logs(name, logLines);
        await write(`logs/${safe}.log`, gate.redact(tailLines(raw, logLines)));
      } catch (error) {
        await write(`logs/${safe}.error.txt`, gate.redact(`logs unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
  }

  // --- redaction report ----------------------------------------------------
  const entries = Object.entries(gate.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const report =
    entries.length === 0
      ? "0 redactions. No payload matched any credential pattern.\n"
      : `${gate.total} redaction(s):\n${entries.map(([kind, n]) => `  ${kind}: ${n}`).join("\n")}\n`;
  await write("REDACTION-REPORT.txt", report);

  // --- tgz -----------------------------------------------------------------
  let tgz: string | undefined;
  try {
    tgz = await (deps.makeTgz ?? defaultMakeTgz)(deps.outDir);
  } catch {
    tgz = undefined; // the directory bundle is still complete without it
  }

  return { dir: deps.outDir, ...(tgz !== undefined ? { tgz } : {}), redactions: gate.counts, redactionTotal: gate.total, files: written };
}
