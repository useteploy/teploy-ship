/**
 * S19: `teploy-ship doctor` — is this machine ready to run Ship?
 *
 * A fresh install fails in boring ways (old Node, a state directory the
 * service user cannot write, the web port already taken, a missing token, a
 * store URL pasted wrong, a clock that has drifted) and each one currently
 * surfaces later, as a confusing runtime error. This module checks them up
 * front and says exactly what it did and did not establish.
 *
 * Rules enforced here rather than asked of the caller:
 *
 * 1. **Three outcomes, and unknown is not pass.** Every check reports
 *    pass | fail | unknown. A probe that is absent, throws something
 *    unexpected, or returns nothing yields "unknown". The overall verdict is
 *    "ready" only when EVERY check passed; any fail is "not-ready", and
 *    unknowns without fails are "incomplete". A doctor that rounds unknown up
 *    to pass tells a fresh operator they are ready when nobody looked.
 * 2. **Shape is not connectivity.** The store-url check parses NUCLEUS_URL and
 *    never opens a socket; the separate store-connectivity check is "unknown"
 *    unless a connect probe was injected and answered. The CLI injects the
 *    read-only `nucleusProbes` when NUCLEUS_URL is set; with no configured
 *    store there is nothing to ask and connectivity honestly stays unknown.
 *    Passing the first must not read as passing the second.
 *    The store KIND (file | nucleus | postgres — `--store`, SHIP_STORE, or
 *    config) is resolved by the caller: both shared stores read their URL
 *    from NUCLEUS_URL, so the URL alone cannot say which dialect the runtime
 *    will speak. With a stated shared-store kind the `store-engine` check asks
 *    the engine its identity (`SELECT version()`) and fails a mismatch (a
 *    postgres-dialect runtime pointed at Nucleus, or the reverse); an engine
 *    that does not identify itself stays unknown.
 * 3. **Values never leave.** Env checks report presence only, never the value
 *    or its length, and the whole report passes the support RedactionGate
 *    before it is emitted (`renderDoctor`), so even a detail string that
 *    accidentally quotes an error carrying a credential is rewritten.
 *
 * Every probe is injected, so the logic is unit-tested against fakes; the
 * real probes (`defaultProbes`) have only been exercised on this machine's
 * own filesystem and loopback, never on a fresh supported host.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { NucleusPgwire, type PgwireDialect } from "./nucleus-pgwire.js";
import { chownHint, uidOf } from "./record-writes.js";
import { RedactionGate } from "./support.js";
import { NATIVE_HARNESS_ID, harnessAttempts, harnessRef } from "./harness.js";
import { providerEgressAllow } from "./harness-external.js";
import { acpProviderEgressAllow } from "./harness-acp.js";
import { eventRulesMode } from "./event-rules.js";
import { BUILTIN_SHADOW_COUNTER_KEY, parseBuiltinShadowCounters, readBuiltinShadowCounters, type BuiltinShadowCounters } from "./event-builtin.js";
import { FileRuntimeConfig } from "./runtime-config.js";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  /** What was observed. Never contains an env VALUE. */
  detail: string;
  /** What to do next, present on fail and unknown. */
  remedy?: string;
}

export type DoctorVerdict = "ready" | "not-ready" | "incomplete";

export interface DoctorReport {
  version: 1;
  verdict: DoctorVerdict;
  counts: Record<CheckStatus, number>;
  checks: DoctorCheck[];
}

export type DoctorStoreKind = "file" | "nucleus" | "postgres";

export interface DoctorProbes {
  nodeVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The store the runtime will use (flag > SHIP_STORE > config). Unset = not stated. */
  storeKind?: DoctorStoreKind;
  /** The resolved store URL (flag > NUCLEUS_URL > config). Unset falls back to env.NUCLEUS_URL. */
  storeUrl?: string;
  stateDir: string;
  /** Directories the file-backed shadows/records write into (record-dirs.ts). Absent: the state dir alone. */
  recordDirs?: string[];
  webPort: number;
  /** Real write+remove of a scratch file in the state dir. Throws on failure. */
  writeProbe?: (dir: string) => Promise<void>;
  /** Free megabytes on the state dir's filesystem. */
  freeMb?: (dir: string) => Promise<number | undefined>;
  /** Whether something is already bound on the port. */
  portState?: (port: number) => Promise<"free" | "in-use" | undefined>;
  /** Try to reach the store. Resolves true only when it answered. */
  storeReachable?: (url: string) => Promise<boolean | undefined>;
  /** The engine's self-reported identity (`SELECT version()`), undefined when it did not say. */
  storeEngine?: () => Promise<string | undefined>;
  /** This host's clock, ms since epoch. */
  nowMs: number;
  /** An independent clock reading (e.g. the store's), ms since epoch. */
  referenceMs?: () => Promise<number | undefined>;
  /**
   * E7 EV3: the built-in shadow's match/diff counters, or null when none are
   * recorded. Absent → the check reports the flag state without counts.
   */
  shadowCounters?: () => Promise<BuiltinShadowCounters | null>;
}

export const MIN_NODE_MAJOR = 20;
export const MIN_STATE_FREE_MB = 1024;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A clock earlier than this is unset or reset, whatever any reference says. */
export const CLOCK_FLOOR_MS = Date.UTC(2025, 0, 1);

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isSet = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

function check(id: string, status: CheckStatus, detail: string, remedy?: string): DoctorCheck {
  return { id, status, detail, ...(remedy !== undefined && status !== "pass" ? { remedy } : {}) };
}

export function checkNode(version: string): DoctorCheck {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (m === null) return check("node-version", "unknown", "could not parse the Node version", `install Node ${MIN_NODE_MAJOR} or newer`);
  const major = Number(m[1]);
  return major >= MIN_NODE_MAJOR
    ? check("node-version", "pass", `Node ${version}`)
    : check("node-version", "fail", `Node ${version} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer`);
}

export async function checkStateWritable(p: DoctorProbes): Promise<DoctorCheck> {
  if (p.writeProbe === undefined) return check("state-dir-writable", "unknown", "no write probe available", "check the state directory by hand");
  try {
    await p.writeProbe(p.stateDir);
    return check("state-dir-writable", "pass", `wrote and removed a scratch file in ${p.stateDir}`);
  } catch (e) {
    return check("state-dir-writable", "fail", `cannot write to ${p.stateDir} as uid ${uidOf()}: ${errMessage(e)}`, `create the directory and give the service user write access (TEPLOY_SHIP_STATE): ${chownHint(p.stateDir)}`);
  }
}

/**
 * The data dir as the shadows see it: every directory a file-backed shadow or
 * record writes into. A root-owned volume made every shadow write fail for 12
 * days (2026-10-16) while nothing said so. Any probe failure is fail; no probe
 * is unknown, never pass.
 */
export async function checkRecordDirsWritable(p: DoctorProbes): Promise<DoctorCheck> {
  const dirs = p.recordDirs !== undefined && p.recordDirs.length > 0 ? p.recordDirs : [p.stateDir];
  if (p.writeProbe === undefined) return check("data-dir-writable", "unknown", "no write probe available", `check by hand that uid ${uidOf()} can write ${dirs.join(", ")}`);
  const failed: string[] = [];
  for (const dir of dirs) {
    try {
      await p.writeProbe(dir);
    } catch (e) {
      failed.push(`${dir} (${errMessage(e)})`);
    }
  }
  if (failed.length > 0) {
    return check(
      "data-dir-writable",
      "fail",
      `shadows and records cannot write: ${failed.join("; ")} as uid ${uidOf()}; every file-backed shadow there records nothing`,
      chownHint(dirs.length === 1 ? dirs[0]! : "<each dir above>"),
    );
  }
  return check("data-dir-writable", "pass", `wrote and removed a scratch file in ${dirs.join(", ")}`);
}

export async function checkStateSpace(p: DoctorProbes): Promise<DoctorCheck> {
  let mb: number | undefined;
  try {
    mb = p.freeMb === undefined ? undefined : await p.freeMb(p.stateDir);
  } catch {
    mb = undefined;
  }
  if (mb === undefined || !Number.isFinite(mb)) return check("state-dir-space", "unknown", "free space could not be read", "check free disk space by hand");
  return mb >= MIN_STATE_FREE_MB
    ? check("state-dir-space", "pass", `${Math.floor(mb)} MB free (minimum ${MIN_STATE_FREE_MB})`)
    : check("state-dir-space", "fail", `${Math.floor(mb)} MB free, below the ${MIN_STATE_FREE_MB} MB minimum`, "free disk space or point TEPLOY_SHIP_STATE at a larger volume");
}

export async function checkPort(p: DoctorProbes): Promise<DoctorCheck> {
  let s: "free" | "in-use" | undefined;
  try {
    s = p.portState === undefined ? undefined : await p.portState(p.webPort);
  } catch {
    s = undefined;
  }
  if (s === undefined) return check("web-port", "unknown", `could not tell whether port ${p.webPort} is free`, "check the port by hand");
  return s === "free"
    ? check("web-port", "pass", `port ${p.webPort} is free`)
    : check("web-port", "fail", `port ${p.webPort} is already in use`, "stop the other listener or set SHIP_WEB_PORT");
}

/** Presence only. The value, and even its length, stay out of the report. */
export function checkEnv(env: DoctorProbes["env"]): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  out.push(
    isSet(env.SHIP_WEB_TOKEN)
      ? check("env-web-token", "pass", "SHIP_WEB_TOKEN is set")
      : check("env-web-token", "fail", "SHIP_WEB_TOKEN is not set", "set SHIP_WEB_TOKEN (the browser login uses it)"),
  );
  const model = ["ANTHROPIC_API_KEY", "AI_GATEWAY_URL"].filter((k) => isSet(env[k]));
  out.push(
    model.length > 0
      ? check("env-model-credential", "pass", `model access configured via ${model.join(" and ")}`)
      : check("env-model-credential", "fail", "neither ANTHROPIC_API_KEY nor AI_GATEWAY_URL is set", "set ANTHROPIC_API_KEY or AI_GATEWAY_URL"),
  );
  return out;
}

/**
 * The doctor line for provider egress under an external harness
 * (docs/adapters.md "Egress for external harnesses"): an external harness
 * calls its model vendor from INSIDE the sandbox, and since 2026-10-17
 * `enqueueRun` derives the vendor hosts from the same forwarded env the
 * harness will read and adds them to every run's sandboxEgressAllow. This
 * check NAMES what this machine's SHIP_HARNESS configuration derives, so the
 * operator can see the list without enqueueing a run.
 *
 * Native records no check at all: it calls the model from the worker. An
 * external harness with nothing derivable (no base URL, no recognised API
 * key — e.g. claude under an OAuth subscription token, whose host this
 * derivation deliberately does not guess) is UNKNOWN, not pass: whether its
 * runs can reach the vendor depends on the project allowlist or
 * SBX_EGRESS_ALLOW, which this check cannot see.
 */
export function checkHarnessEgress(env: DoctorProbes["env"]): DoctorCheck | undefined {
  let refs: { id: string }[];
  try {
    refs = [harnessRef(env.SHIP_HARNESS), ...harnessAttempts(env.SHIP_HARNESS_ATTEMPTS)];
  } catch (error) {
    return check(
      "harness-egress",
      "fail",
      `harness configuration is not usable: ${errMessage(error)}`,
      "fix SHIP_HARNESS / SHIP_HARNESS_ATTEMPTS — every enqueue on this machine refuses them (see docs/adapters.md)",
    );
  }
  const external = [...new Set(refs.filter((r) => r.id !== NATIVE_HARNESS_ID).map((r) => r.id))];
  if (external.length === 0) return undefined;
  // Bespoke adapters derive from base-URL/key variables (harness-external),
  // the ACP profiles from their per-profile host lists (harness-acp).
  const derived = [...providerEgressAllow(refs, env), ...acpProviderEgressAllow(refs, env)];
  if (derived.length > 0) {
    return check("harness-egress", "pass", `harness ${external.join(", ")}: provider egress derived at enqueue and added to each run's allowlist: ${derived.join(", ")}`);
  }
  return check(
    "harness-egress",
    "unknown",
    `harness ${external.join(", ")}: no provider host could be derived from the forwarded credentials (no base URL, no recognised API key)`,
    "external harness runs still need their vendor host on the sandbox allowlist — add it to the project's egress allowlist or SBX_EGRESS_ALLOW on the daemon (docs/adapters.md \"Egress for external harnesses\")",
  );
}

/**
 * The store doctor checks, resolved the way the runtime resolves it
 * (`makeRuntime` in cli.ts): kind = --store > SHIP_STORE > config.store,
 * url = --nucleus-url > NUCLEUS_URL > config.nucleusUrl. Both shared stores
 * read NUCLEUS_URL, so the kind is the only thing that says which dialect the
 * runtime will speak; unstated stays unstated (no engine check), never a guess.
 * Throws on a kind the runtime would also reject.
 */
export function resolveDoctorStore(
  flags: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
  config: { store?: string; nucleusUrl?: string } = {},
): { kind?: DoctorStoreKind; url?: string } {
  const kind = (typeof flags.store === "string" ? flags.store : undefined) ?? (isSet(env.SHIP_STORE) ? env.SHIP_STORE : undefined) ?? config.store;
  if (kind !== undefined && kind !== "file" && kind !== "nucleus" && kind !== "postgres") {
    throw new Error(`unknown --store: ${kind} (expected file, nucleus, or postgres)`);
  }
  const url = (typeof flags["nucleus-url"] === "string" ? flags["nucleus-url"] : undefined) ?? (isSet(env.NUCLEUS_URL) ? env.NUCLEUS_URL : undefined) ?? config.nucleusUrl;
  return { ...(kind !== undefined ? { kind } : {}), ...(isSet(url) ? { url } : {}) };
}

/** The URL the store checks look at: the resolved one, else the env's. */
function storeUrlOf(p: Pick<DoctorProbes, "env" | "storeUrl">): string | undefined {
  return isSet(p.storeUrl) ? p.storeUrl : p.env.NUCLEUS_URL;
}

/**
 * Parse only. Absent NUCLEUS_URL is a legitimate local-file install — unless
 * a shared store (nucleus or postgres) was stated, which cannot run without one.
 */
export function checkStoreShape(env: DoctorProbes["env"], store: { kind?: DoctorStoreKind; url?: string } = {}): DoctorCheck {
  if (store.kind === "file") return check("store-url", "pass", "store file: local file store selected, no store URL used (shape only, nothing connected)");
  const raw = isSet(store.url) ? store.url : env.NUCLEUS_URL;
  if (!isSet(raw)) {
    if (store.kind !== undefined) {
      return check("store-url", "fail", `store ${store.kind} selected but no store URL is set`, "set NUCLEUS_URL (both shared stores read it) or pass --nucleus-url");
    }
    return check("store-url", "pass", "NUCLEUS_URL not set: local file store (shape only, nothing connected)");
  }
  let u: URL;
  try {
    u = new URL(raw as string);
  } catch {
    // The parse error can quote the input, and the input may carry a password.
    return check("store-url", "fail", "NUCLEUS_URL is not a parseable URL", "use postgres://host:port/db");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    return check("store-url", "fail", `NUCLEUS_URL scheme "${u.protocol}" is not postgres`, "use postgres://host:port/db");
  }
  if (u.hostname === "") return check("store-url", "fail", "NUCLEUS_URL has no host", "use postgres://host:port/db");
  const prefix = store.kind === undefined ? "" : `store ${store.kind}: `;
  return check("store-url", "pass", `${prefix}NUCLEUS_URL shape valid, host ${u.hostname}${u.port !== "" ? `:${u.port}` : ""} (shape only, nothing connected)`);
}

export async function checkStoreConnectivity(p: DoctorProbes): Promise<DoctorCheck> {
  if (p.storeKind === "file") return check("store-connectivity", "unknown", "store file: nothing to connect to", "not applicable to a local file store; verify with a real run");
  const url = storeUrlOf(p);
  if (!isSet(url)) return check("store-connectivity", "unknown", "no NUCLEUS_URL: nothing to connect to", "not applicable to a local file store; verify with a real run");
  let ok: boolean | undefined;
  try {
    ok = p.storeReachable === undefined ? undefined : await p.storeReachable(url as string);
  } catch {
    ok = false;
  }
  if (ok === undefined) return check("store-connectivity", "unknown", "no connect probe was run", "run `teploy-ship preflight` against the live store");
  const prefix = p.storeKind === undefined ? "" : `store ${p.storeKind}: `;
  return ok
    ? check("store-connectivity", "pass", `${prefix}store answered`)
    : check("store-connectivity", "fail", `${prefix}store did not answer`, "check NUCLEUS_URL, the network path and that the store is up");
}

/** Which engine a `version()` string names. Nucleus reports "PostgreSQL 16.0 (Nucleus …)". */
export function engineOf(version: string | undefined): "nucleus" | "postgres" | undefined {
  if (version === undefined) return undefined;
  if (/nucleus/i.test(version)) return "nucleus";
  if (/^\s*PostgreSQL\b/.test(version)) return "postgres";
  return undefined;
}

/**
 * Only for a stated shared-store kind with a URL: does the engine behind the
 * URL match the dialect the runtime will speak? The two KV/stream surfaces
 * are not interchangeable (engine built-ins vs plain tables), so a mismatch
 * is a fail. An engine that does not identify itself is unknown, never pass.
 */
export async function checkStoreEngine(p: DoctorProbes): Promise<DoctorCheck | undefined> {
  if (p.storeKind !== "nucleus" && p.storeKind !== "postgres") return undefined;
  if (!isSet(storeUrlOf(p))) return undefined;
  let version: string | undefined;
  try {
    version = p.storeEngine === undefined ? undefined : await p.storeEngine();
  } catch {
    version = undefined;
  }
  const engine = engineOf(version);
  if (engine === undefined) {
    return check("store-engine", "unknown", `store ${p.storeKind}: the engine did not identify itself`, "run `SELECT version()` against the store by hand");
  }
  return engine === p.storeKind
    ? check("store-engine", "pass", `store ${p.storeKind}: engine identifies as ${engine}`)
    : check(
        "store-engine",
        "fail",
        `store ${p.storeKind} selected but the engine identifies as ${engine}`,
        `run with --store ${engine}, or point NUCLEUS_URL at the ${p.storeKind} store`,
      );
}

export async function checkClock(p: DoctorProbes): Promise<DoctorCheck> {
  if (!Number.isFinite(p.nowMs) || p.nowMs < CLOCK_FLOOR_MS) {
    return check("clock", "fail", "the system clock is unset or implausibly early", "set the clock (NTP) before running Ship");
  }
  let ref: number | undefined;
  try {
    ref = p.referenceMs === undefined ? undefined : await p.referenceMs();
  } catch {
    ref = undefined;
  }
  if (ref === undefined || !Number.isFinite(ref)) {
    return check("clock", "unknown", "clock is plausible but no independent reference was available to measure skew", "compare against a trusted time source");
  }
  const skew = Math.abs(p.nowMs - ref);
  return skew <= MAX_CLOCK_SKEW_MS
    ? check("clock", "pass", `skew ${Math.round(skew / 1000)}s against the reference`)
    : check("clock", "fail", `skew ${Math.round(skew / 1000)}s exceeds ${MAX_CLOCK_SKEW_MS / 1000}s`, "enable NTP; leases, schedules and tokens depend on agreeing clocks");
}

/**
 * E7 EV3 — the built-in shadow's health check. A diff counts as a failure
 * (the design note's rule), so one recorded diff fails the check while the
 * built-in path keeps running exactly as before: the check is the alarm, not
 * the enforcement. Off with no history is a pass, not an unknown — the
 * shadow is a soak, not an install requirement.
 */
export function checkEventRulesShadow(env: DoctorProbes["env"], counters: BuiltinShadowCounters | null | undefined): DoctorCheck {
  const mode = eventRulesMode(env);
  const id = "event-rules-shadow";
  const summary =
    counters === null || counters === undefined
      ? undefined
      : `${counters.deliveries} built-in delivery(s) shadow-evaluated since ${counters.since}: ${counters.matched} matched, ${counters.diffed} diffed`;
  if (mode === "off") {
    return check(id, "pass", `SHIP_EVENT_RULES is off${summary === undefined ? " — the built-in shadow is not running" : `; ${summary} recorded from a previous soak`}`);
  }
  if (mode === "on") {
    return check(id, "pass", `SHIP_EVENT_RULES is on — the built-in flip slice owns this state${summary === undefined ? "" : `; ${summary}`}`);
  }
  if (summary === undefined) {
    return check(id, "pass", "shadow on; no built-in traffic evaluated yet (no counters recorded)");
  }
  if (counters!.diffed > 0) {
    return check(
      id,
      "fail",
      `${summary} — the built-in path stayed authoritative; inspect the [event-rules shadow] diff lines in the web and worker logs`,
      "resolve every diff (or acknowledge it) before flipping SHIP_EVENT_RULES=on for the built-ins",
    );
  }
  return check(id, "pass", summary);
}

export async function runDoctor(p: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNode(p.nodeVersion),
    await checkStateWritable(p),
    await checkRecordDirsWritable(p),
    await checkStateSpace(p),
    await checkPort(p),
    ...checkEnv(p.env),
    checkStoreShape(p.env, { ...(p.storeKind !== undefined ? { kind: p.storeKind } : {}), ...(p.storeUrl !== undefined ? { url: p.storeUrl } : {}) }),
    await checkStoreConnectivity(p),
  ];
  const engine = await checkStoreEngine(p);
  if (engine !== undefined) checks.push(engine);
  const harnessEgress = checkHarnessEgress(p.env);
  if (harnessEgress !== undefined) checks.push(harnessEgress);
  checks.push(await checkClock(p));
  let shadowCounters: BuiltinShadowCounters | null | undefined;
  if (p.shadowCounters !== undefined) {
    try {
      shadowCounters = await p.shadowCounters();
    } catch {
      shadowCounters = undefined;
    }
  }
  checks.push(checkEventRulesShadow(p.env, shadowCounters));
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, unknown: 0 };
  for (const c of checks) counts[c.status]++;
  const verdict: DoctorVerdict = counts.fail > 0 ? "not-ready" : counts.unknown > 0 ? "incomplete" : "ready";
  return { version: 1, verdict, counts, checks };
}

/** The redacted support-bundle section: parseable JSON, every string through the gate. */
export function renderDoctor(report: DoctorReport): { json: string; redactions: number } {
  const gate = new RedactionGate();
  const safe = gate.redactJson(report);
  return { json: JSON.stringify(safe, null, 2) + "\n", redactions: gate.total };
}

export function formatDoctor(report: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { pass: "PASS   ", fail: "FAIL   ", unknown: "UNKNOWN" };
  const gate = new RedactionGate();
  const lines = report.checks.map(
    (c) => `${mark[c.status]} ${c.id}: ${gate.redact(c.detail)}${c.remedy !== undefined ? `\n        -> ${gate.redact(c.remedy)}` : ""}`,
  );
  lines.push(`verdict: ${report.verdict} (${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.unknown} unknown)`);
  return lines.join("\n") + "\n";
}

/** Real probes. Local filesystem and loopback only; no outbound network. */
export function defaultProbes(base: Pick<DoctorProbes, "env" | "stateDir" | "webPort" | "nodeVersion" | "recordDirs">): DoctorProbes {
  return {
    ...base,
    nowMs: Date.now(),
    writeProbe: async (dir) => {
      await mkdir(dir, { recursive: true });
      const f = join(dir, `.doctor-${randomBytes(6).toString("hex")}`);
      await writeFile(f, "ok");
      await rm(f);
    },
    freeMb: async (dir) => {
      const s = await statfs(dir);
      return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024);
    },
    portState: (port) =>
      new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE" ? "in-use" : undefined));
        srv.listen(port, "127.0.0.1", () => srv.close(() => resolve("free")));
      }),
  };
}

// ---------------------------------------------------------------------------
// live store probes — read-only, or honestly unknown
// ---------------------------------------------------------------------------

/** The read-only query surface the live probes need. */
export interface StoreQueryClient {
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface LiveStoreProbes {
  storeReachable: NonNullable<DoctorProbes["storeReachable"]>;
  referenceMs: () => Promise<number | undefined>;
  storeEngine: () => Promise<string | undefined>;
}

/**
 * Real read-only probes against the store NUCLEUS_URL names — the one this
 * machine will actually run on, so asking it is not new network surface.
 *
 * `storeReachable` is liveness only (`SELECT 1`, the rehearse proof's own
 * question). `referenceMs` asks the store its clock (`SELECT now()`); the
 * store's clock is the independent reference the skew check needs, and when
 * the engine does not answer a time query the clock check stays UNKNOWN and
 * says why — never a guessed reference. `storeEngine` asks `SELECT version()`
 * so a stated store kind can be checked against the engine that answers.
 * `dialect` matters only for KV/stream surfaces, which no probe touches; it is
 * passed through so the probe client is the same shape the runtime opens.
 * What is deliberately NOT probed:
 * anything write-shaped, and store CONSISTENCY, which cannot be established
 * read-only while writers run (that proof is a snapshot rehearsal, not a
 * doctor check).
 */
export function nucleusProbes(url: string, deps: { connect?: () => StoreQueryClient; dialect?: PgwireDialect } = {}): LiveStoreProbes {
  const connect = deps.connect ?? (() => new NucleusPgwire(url, "doctor", { dialect: deps.dialect ?? "nucleus" }));
  return {
    storeReachable: async () => {
      const client = connect();
      try {
        await client.query("SELECT 1");
        return true;
      } catch {
        return false;
      } finally {
        await client.close().catch(() => {});
      }
    },
    referenceMs: async () => {
      const client = connect();
      try {
        const rows = await client.query("SELECT now() AS t");
        const value = Object.values(rows[0] ?? {})[0];
        if (value instanceof Date) return value.getTime();
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const t = Date.parse(value);
          if (Number.isFinite(t)) return t;
        }
        return undefined;
      } catch {
        return undefined;
      } finally {
        await client.close().catch(() => {});
      }
    },
    storeEngine: async () => {
      const client = connect();
      try {
        const rows = await client.query("SELECT version() AS v");
        const value = Object.values(rows[0] ?? {})[0];
        return typeof value === "string" && value.trim() !== "" ? value : undefined;
      } catch {
        return undefined;
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// E7 EV3 — reading the built-in shadow's counters, wherever this install
// keeps its runtime config KV
// ---------------------------------------------------------------------------

/**
 * The shadow counters as the doctor can read them: the file runtime config
 * when the store is file-backed (or unstated), otherwise a read-only SELECT
 * against the shared store's ship_runtime_config table. Read-only, and any
 * failure reads as "none recorded" rather than an error — the table is only
 * created by the first counter WRITE, so a fresh shared-store install without
 * shadow traffic legitimately has neither the table nor the row, and a store
 * that cannot be reached here is reported by the connectivity check, not
 * manufactured into a shadow verdict.
 */
export async function readShadowCountersForDoctor(
  kind: DoctorStoreKind | undefined,
  url: string | undefined,
  stateDirPath: string,
): Promise<BuiltinShadowCounters | null> {
  if (kind === undefined || kind === "file") {
    return readBuiltinShadowCounters(new FileRuntimeConfig(stateDirPath));
  }
  if (url === undefined) return null;
  const client = new NucleusPgwire(url, "doctor", { dialect: kind === "postgres" ? "postgres" : "nucleus" });
  try {
    const rows = await client.query(`SELECT config_value AS v FROM ship_runtime_config WHERE config_key = '${BUILTIN_SHADOW_COUNTER_KEY}'`);
    const value = Object.values(rows[0] ?? {})[0];
    return typeof value === "string" ? parseBuiltinShadowCounters(safeJsonParse(value)) : null;
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
