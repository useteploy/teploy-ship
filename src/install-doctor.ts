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
 *    unless a connect probe was injected and answered. Passing the first must
 *    not read as passing the second.
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

import { RedactionGate } from "./support.js";

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

export interface DoctorProbes {
  nodeVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  stateDir: string;
  webPort: number;
  /** Real write+remove of a scratch file in the state dir. Throws on failure. */
  writeProbe?: (dir: string) => Promise<void>;
  /** Free megabytes on the state dir's filesystem. */
  freeMb?: (dir: string) => Promise<number | undefined>;
  /** Whether something is already bound on the port. */
  portState?: (port: number) => Promise<"free" | "in-use" | undefined>;
  /** Try to reach the store. Resolves true only when it answered. */
  storeReachable?: (url: string) => Promise<boolean | undefined>;
  /** This host's clock, ms since epoch. */
  nowMs: number;
  /** An independent clock reading (e.g. the store's), ms since epoch. */
  referenceMs?: () => Promise<number | undefined>;
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
    return check("state-dir-writable", "fail", `cannot write to ${p.stateDir}: ${errMessage(e)}`, "create the directory and give the service user write access (TEPLOY_SHIP_STATE)");
  }
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

/** Parse only. Absent NUCLEUS_URL is a legitimate local-file install. */
export function checkStoreShape(env: DoctorProbes["env"]): DoctorCheck {
  const raw = env.NUCLEUS_URL;
  if (!isSet(raw)) return check("store-url", "pass", "NUCLEUS_URL not set: local file store (shape only, nothing connected)");
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
  return check("store-url", "pass", `NUCLEUS_URL shape valid, host ${u.hostname}${u.port !== "" ? `:${u.port}` : ""} (shape only, nothing connected)`);
}

export async function checkStoreConnectivity(p: DoctorProbes): Promise<DoctorCheck> {
  const url = p.env.NUCLEUS_URL;
  if (!isSet(url)) return check("store-connectivity", "unknown", "no NUCLEUS_URL: nothing to connect to", "not applicable to a local file store; verify with a real run");
  let ok: boolean | undefined;
  try {
    ok = p.storeReachable === undefined ? undefined : await p.storeReachable(url as string);
  } catch {
    ok = false;
  }
  if (ok === undefined) return check("store-connectivity", "unknown", "no connect probe was run", "run `teploy-ship preflight` against the live store");
  return ok
    ? check("store-connectivity", "pass", "store answered")
    : check("store-connectivity", "fail", "store did not answer", "check NUCLEUS_URL, the network path and that the store is up");
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

export async function runDoctor(p: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNode(p.nodeVersion),
    await checkStateWritable(p),
    await checkStateSpace(p),
    await checkPort(p),
    ...checkEnv(p.env),
    checkStoreShape(p.env),
    await checkStoreConnectivity(p),
    await checkClock(p),
  ];
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
export function defaultProbes(base: Pick<DoctorProbes, "env" | "stateDir" | "webPort" | "nodeVersion">): DoctorProbes {
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
