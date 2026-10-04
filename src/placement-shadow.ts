/**
 * S26 in SHADOW mode: run `placeRun` / `onHostLoss` (execution-target.ts) next
 * to the placement the pool actually made, record where they differ, change
 * nothing.
 *
 * Flag `SHIP_PLACEMENT=shadow` (default off; any other value is off). Off
 * constructs no shadow, so `SandboxPool` runs exactly the code it ran before.
 * On, every `create`, every `createFrom` and every failed C5 liveness probe
 * appends ONE JSON line to `placement-shadow.jsonl` in the state directory
 * (`SHIP_PLACEMENT_SHADOW_FILE` overrides). `teploy-ship placement
 * shadow-report` summarises it. Nothing here can change which host is used or
 * how a run fails: the comparison runs on a snapshot taken before the real
 * attempt, and a throw anywhere in it is swallowed and logged.
 *
 * WHAT THE TARGETS ARE. The pool knows a URL, a provider and (new, optional)
 * what the operator DECLARED about it in `SHIP_PLACEMENT_TARGETS` (a JSON
 * object keyed by host URL). Anything undeclared is the conservative answer:
 * os linux (a sandbox daemon runs Linux containers), arch UNKNOWN (a sentinel
 * that equals no real architecture, so a requirement naming an arch is never
 * met by it), no browser, no desktop, no services, no gpu, no private
 * networks, static credentials, no snapshot formats beyond oci-image. cpu,
 * memory, disk and the run cap default to "very large": the daemon enforces
 * the per-container limits itself at create, and an invented small number would
 * manufacture disagreements. They are finite so utilisation (live / maxRuns)
 * orders hosts exactly as the pool's own live count does.
 *
 * WHAT THE REQUIREMENT IS. Ship records no per-run arch/browser/etc today, so
 * the requirement is: `limits` and `warm.repo` from the run's SandboxOverrides
 * (cpu, memory, project/warm repo), merged over an operator-declared
 * deployment-wide `SHIP_PLACEMENT_REQUIRE` (JSON; e.g. every run here needs
 * arm64). `os` defaults to linux and every record says so.
 *
 * WHAT IS NOT KNOWN. Draining: the pool has no drain concept, so draining
 * comes only from `SHIP_PLACEMENT_TARGETS` (`"draining": true`) or the
 * `draining` option. Whether a failed liveness probe is host loss or just an
 * expired container TTL: the pool cannot tell, so a host-loss record states the
 * host's own health and the decision under both a clean and a dirty tree (a
 * replay cannot see the tree). Per-project live counts exist only for runs
 * this process placed. A create that fails on every host is not recorded.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SandboxOverrides } from "./durable.js";
import { onHostLoss, placeRun } from "./execution-target.js";
import type {
  HostLossDecision,
  Placement,
  PlacementState,
  Rejection,
  RunOnHost,
  RunRequirement,
  SnapshotRef,
  Target,
  TargetCapabilities,
  TargetState,
} from "./execution-target.js";
import { stateDir } from "./run-store.js";

export const PLACEMENT_FLAG = "SHIP_PLACEMENT";

export function placementMode(env: NodeJS.ProcessEnv = process.env): "off" | "shadow" {
  return env[PLACEMENT_FLAG]?.trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

export const placementShadowFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIP_PLACEMENT_SHADOW_FILE ?? join(stateDir(), "placement-shadow.jsonl");

/** Matches no real `TargetArch`: a host that never declared one fits no requirement that names one. */
export const UNKNOWN_ARCH = "unknown" as unknown as TargetCapabilities["arch"];

const BIG = 1_000_000;

// ---------------------------------------------------------------------------
// Declared capabilities
// ---------------------------------------------------------------------------

/** What an operator may declare per host. Unknown keys and wrongly typed values are ignored. */
export type DeclaredTarget = Partial<Omit<TargetCapabilities, "quota" | "hardware">> & {
  quota?: Partial<TargetCapabilities["quota"]>;
  hardware?: Partial<TargetCapabilities["hardware"]>;
  /** Operator-declared: no new work. The pool itself has no drain. */
  draining?: boolean;
};

export interface HostLike {
  url: string;
  isolated?: boolean;
}

/** Conservative capabilities for a host, overlaid with whatever was declared. */
export function declaredCaps(host: HostLike, declared: DeclaredTarget = {}): TargetCapabilities {
  const q = declared.quota ?? {};
  const h = declared.hardware ?? {};
  return {
    kind: declared.kind ?? "remote-container",
    hosting: declared.hosting ?? "managed",
    os: declared.os ?? "linux",
    arch: declared.arch ?? UNKNOWN_ARCH,
    cpu: declared.cpu ?? BIG,
    memMB: declared.memMB ?? BIG,
    diskMB: declared.diskMB ?? BIG,
    browser: declared.browser ?? "none",
    desktop: declared.desktop ?? false,
    services: declared.services ?? [],
    hardware: { gpu: h.gpu ?? 0, mobileSim: h.mobileSim ?? [] },
    network: declared.network ?? [],
    snapshotFormats: declared.snapshotFormats ?? ["oci-image"],
    isolated: declared.isolated ?? host.isolated === true,
    credentialMode: declared.credentialMode ?? "static",
    quota: { maxRuns: q.maxRuns ?? BIG, ...(q.perProject !== undefined ? { perProject: q.perProject } : {}) },
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(isStr) ? (v as string[]) : undefined);
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T | undefined => (isStr(v) && (options as readonly string[]).includes(v) ? (v as T) : undefined);

function sanitizeDeclared(raw: unknown): DeclaredTarget {
  if (raw === null || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  put("kind", oneOf(r.kind, ["local-container", "remote-container", "local-vm", "remote-vm", "customer-worker"] as const));
  put("hosting", oneOf(r.hosting, ["managed", "customer"] as const));
  put("os", oneOf(r.os, ["linux", "windows", "macos"] as const));
  put("arch", oneOf(r.arch, ["amd64", "arm64"] as const));
  for (const k of ["cpu", "memMB", "diskMB"]) put(k, isNum(r[k]) ? r[k] : undefined);
  put("browser", oneOf(r.browser, ["none", "headless", "headed"] as const));
  put("desktop", isBool(r.desktop) ? r.desktop : undefined);
  put("services", strList(r.services));
  put("network", strList(r.network));
  put("snapshotFormats", strList(r.snapshotFormats));
  put("isolated", isBool(r.isolated) ? r.isolated : undefined);
  put("credentialMode", oneOf(r.credentialMode, ["disposable", "static", "none"] as const));
  put("draining", isBool(r.draining) ? r.draining : undefined);
  if (r.quota !== null && typeof r.quota === "object") {
    const q = r.quota as Record<string, unknown>;
    put("quota", { ...(isNum(q.maxRuns) ? { maxRuns: q.maxRuns } : {}), ...(isNum(q.perProject) ? { perProject: q.perProject } : {}) });
  }
  if (r.hardware !== null && typeof r.hardware === "object") {
    const hw = r.hardware as Record<string, unknown>;
    const sims = Array.isArray(hw.mobileSim) ? hw.mobileSim.filter((s): s is "android" | "ios" => s === "android" || s === "ios") : undefined;
    put("hardware", { ...(isNum(hw.gpu) ? { gpu: hw.gpu } : {}), ...(sims !== undefined ? { mobileSim: sims } : {}) });
  }
  return out as DeclaredTarget;
}

function parseJson(raw: string | undefined, name: string, log: (line: string) => void): unknown {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    log(`[placement] ${name} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using conservative defaults`);
    return undefined;
  }
}

/** `SHIP_PLACEMENT_TARGETS`: `{ "<host url>": { ...declared } }`. URLs are matched without a trailing slash. */
export function declaredTargetsFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void = () => {}): Record<string, DeclaredTarget> {
  const raw = parseJson(env.SHIP_PLACEMENT_TARGETS, "SHIP_PLACEMENT_TARGETS", log);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DeclaredTarget> = {};
  for (const [url, v] of Object.entries(raw as Record<string, unknown>)) out[url.replace(/\/+$/, "")] = sanitizeDeclared(v);
  return out;
}

/** `SHIP_PLACEMENT_REQUIRE`: a deployment-wide requirement merged under each run's own. */
export function declaredRequirementFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void = () => {}): Partial<RunRequirement> {
  const raw = parseJson(env.SHIP_PLACEMENT_REQUIRE, "SHIP_PLACEMENT_REQUIRE", log);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RunRequirement> = {};
  const os = oneOf(r.os, ["linux", "windows", "macos"] as const);
  if (os !== undefined) out.os = os;
  const arch = oneOf(r.arch, ["amd64", "arm64"] as const);
  if (arch !== undefined) out.arch = arch;
  for (const k of ["cpu", "memMB", "diskMB", "gpu"] as const) if (isNum(r[k])) out[k] = r[k] as number;
  const browser = oneOf(r.browser, ["headless", "headed"] as const);
  if (browser !== undefined) out.browser = browser;
  if (r.desktop === true) out.desktop = true;
  const services = strList(r.services);
  if (services !== undefined) out.services = services;
  const network = strList(r.network);
  if (network !== undefined) out.network = network;
  const sim = oneOf(r.mobileSim, ["android", "ios"] as const);
  if (sim !== undefined) out.mobileSim = sim;
  const hosting = oneOf(r.hosting, ["managed", "customer"] as const);
  if (hosting !== undefined) out.hosting = hosting;
  if (r.isolated === true) out.isolated = true;
  if (r.credentials === "disposable") out.credentials = "disposable";
  return out;
}

/** The requirement for a create: deployment-wide declaration under the run's own overrides. */
export function requirementOf(overrides: SandboxOverrides | undefined, base: Partial<RunRequirement> = {}): { req: RunRequirement; defaults: string[] } {
  const defaults: string[] = [];
  if (base.os === undefined) defaults.push("os=linux");
  const repo = overrides?.warm?.repo;
  const cpu = overrides?.limits?.cpus;
  const memMB = overrides?.limits?.memoryMb;
  const req: RunRequirement = {
    ...base,
    project: repo ?? "(unknown)",
    os: base.os ?? "linux",
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memMB !== undefined ? { memMB } : {}),
    ...(repo !== undefined ? { warmRepo: repo } : {}),
  };
  if (repo === undefined) defaults.push("project=(unknown)");
  return { req, defaults };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type PlacementPoint = "create" | "createFrom" | "host-loss";

/**
 * - `chosen-unsuitable`: the host the pool used would have been rejected.
 * - `different-choice`: the pool's host was suitable but placeRun ranks another first.
 * - `would-recover`: host loss, where the existing path fails and onHostLoss would recover.
 */
export type PlacementDisagreement = "chosen-unsuitable" | "different-choice" | "would-recover";

export interface PlacementRecord {
  v: 1;
  at: string;
  point: PlacementPoint;
  disagreement: PlacementDisagreement | null;
  requirement: RunRequirement;
  /** What the requirement filled in because nothing declared it. */
  defaulted: string[];
  /** The host the pool used (create/createFrom) or lost (host-loss). */
  host: string;
  /** What the pool's own order made of it. */
  state: Record<string, { live: number; healthy: boolean; draining: boolean }>;
  /** create / createFrom */
  would?: { ok: true; target: string; suitable: string[] } | { ok: false; refusal: "no-suitable-target" | "retry-later"; reason: string };
  chosenRejections?: Rejection[];
  /** host-loss */
  hostLoss?: {
    cause: string;
    existing: string;
    hostHealthyPerPool: boolean;
    ifClean: HostLossDecision;
    ifDirty: HostLossDecision;
    snapshot?: SnapshotRef;
  };
}

export interface PlacementSink {
  append(record: PlacementRecord): Promise<void>;
}

export function fileSink(path: string): PlacementSink {
  return {
    async append(record) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`);
    },
  };
}

export class MemoryPlacementSink implements PlacementSink {
  readonly records: PlacementRecord[] = [];
  async append(record: PlacementRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

// ---------------------------------------------------------------------------
// The shadow
// ---------------------------------------------------------------------------

/** What the pool hands over: its own view of each host at one instant. */
export interface PoolView {
  hosts: Array<{ url: string; isolated?: boolean; live: number; healthy: boolean }>;
  /** Per host index: live runs per project that THIS pool placed. */
  projectRuns: Array<Record<string, number>>;
}

export interface PlacementShadowOptions {
  sink: PlacementSink;
  declared?: Record<string, DeclaredTarget>;
  /** Deployment-wide requirement (SHIP_PLACEMENT_REQUIRE). */
  require?: Partial<RunRequirement>;
  /** Hosts (by URL) treated as draining in addition to the declared ones. */
  draining?: string[];
  log?: (line: string) => void;
  now?: () => Date;
}

const pending = new Set<Promise<void>>();

/** Wait for in-flight shadow writes (tests, and a clean worker shutdown). */
export async function flushPlacementShadow(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export class PlacementShadow {
  readonly #sink: PlacementSink;
  readonly #declared: Record<string, DeclaredTarget>;
  readonly #require: Partial<RunRequirement>;
  readonly #draining: Set<string>;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: PlacementShadowOptions) {
    this.#sink = options.sink;
    this.#declared = options.declared ?? {};
    this.#require = options.require ?? {};
    this.#draining = new Set((options.draining ?? []).map((u) => u.replace(/\/+$/, "")));
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date());
  }

  #targets(view: PoolView): { targets: Target[]; state: PlacementState; ids: string[] } {
    const targets: Target[] = [];
    const state: PlacementState = {};
    view.hosts.forEach((h, i) => {
      const url = h.url.replace(/\/+$/, "");
      const d = this.#declared[url] ?? {};
      targets.push({ id: h.url, caps: declaredCaps(h, d) });
      const s: TargetState = {
        healthy: h.healthy,
        draining: d.draining === true || this.#draining.has(url),
        live: h.live,
        usedCpu: 0,
        usedMemMB: 0,
        usedDiskMB: 0,
        projectRuns: view.projectRuns[i] ?? {},
      };
      state[h.url] = s;
    });
    return { targets, state, ids: view.hosts.map((h) => h.url) };
  }

  #summary(state: PlacementState): PlacementRecord["state"] {
    return Object.fromEntries(Object.entries(state).map(([id, s]) => [id, { live: s.live, healthy: s.healthy, draining: s.draining }]));
  }

  #emit(record: PlacementRecord): void {
    this.#log(`[placement] shadow ${record.point} host=${record.host} disagreement=${record.disagreement ?? "none"}`);
    const p = this.#sink
      .append(record)
      .catch((error: unknown) => this.#log(`[placement] could not record: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  /**
   * Decide a create the way placeRun would, from the view taken BEFORE the real
   * attempt, and return a function that records the comparison once the pool
   * knows which host it used. Never throws.
   */
  begin(point: "create" | "createFrom", view: PoolView, overrides: SandboxOverrides | undefined, restoreIndex?: number): (chosenIndex: number) => void {
    let decided: { placement: Placement; targets: Target[]; state: PlacementState; req: RunRequirement; defaulted: string[] } | undefined;
    try {
      const { targets, state } = this.#targets(view);
      const { req: base, defaults } = requirementOf(overrides, this.#require);
      let req = base;
      if (restoreIndex !== undefined) {
        const t = targets[restoreIndex];
        if (t !== undefined) req = { ...base, restore: { format: "oci-image", os: t.caps.os, arch: t.caps.arch, host: t.id } };
      }
      decided = { placement: placeRun(req, targets, state), targets, state, req, defaulted: defaults };
    } catch (error) {
      this.#log(`[placement] shadow could not decide: ${error instanceof Error ? error.message : String(error)}`);
    }
    return (chosenIndex) => {
      try {
        if (decided === undefined) return;
        const chosen = decided.targets[chosenIndex];
        if (chosen === undefined) return;
        const p = decided.placement;
        const verdict = p.verdicts.find((v) => v.targetId === chosen.id);
        const rejections = verdict?.rejections ?? [];
        const disagreement: PlacementDisagreement | null =
          rejections.length > 0 ? "chosen-unsuitable" : p.ok && p.target.id !== chosen.id ? "different-choice" : null;
        this.#emit({
          v: 1,
          at: this.#now().toISOString(),
          point,
          disagreement,
          requirement: decided.req,
          defaulted: decided.defaulted,
          host: chosen.id,
          state: this.#summary(decided.state),
          would: p.ok
            ? { ok: true, target: p.target.id, suitable: p.suitable }
            : { ok: false, refusal: p.refusal, reason: p.reason },
          ...(rejections.length > 0 ? { chosenRejections: rejections } : {}),
        });
      } catch (error) {
        this.#log(`[placement] shadow could not record: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  /**
   * A run's container failed its liveness probe on `lostIndex`. Record what
   * onHostLoss would have done. The existing path always fails the run (the
   * C5 error); the tree's state is unknown to a replay, so both bounds are
   * recorded. Never throws.
   */
  hostLoss(view: PoolView, lostIndex: number, requirement: { req: RunRequirement; defaults: string[] }, snapshotIndex?: number): void {
    try {
      const { targets, state } = this.#targets(view);
      const lost = targets[lostIndex];
      if (lost === undefined) return;
      const snapshot: SnapshotRef | undefined =
        snapshotIndex !== undefined && targets[snapshotIndex] !== undefined
          ? { format: "oci-image", os: targets[snapshotIndex]!.caps.os, arch: targets[snapshotIndex]!.caps.arch, host: targets[snapshotIndex]!.id }
          : undefined;
      const req = requirement.req;
      const run = (uncommittedWork: boolean, restartableFromCommitted: boolean): RunOnHost => ({
        id: "run",
        targetId: lost.id,
        requirement: req,
        ...(snapshot !== undefined ? { snapshot } : {}),
        uncommittedWork,
        restartableFromCommitted,
      });
      const ifClean = onHostLoss(run(false, true), targets, state);
      const ifDirty = onHostLoss(run(true, false), targets, state);
      this.#emit({
        v: 1,
        at: this.#now().toISOString(),
        point: "host-loss",
        disagreement: ifClean.action === "recover" || ifDirty.action === "recover" ? "would-recover" : null,
        requirement: req,
        defaulted: requirement.defaults,
        host: lost.id,
        state: this.#summary(state),
        hostLoss: {
          cause: "c5 liveness probe failed: host loss and container TTL expiry are indistinguishable here",
          existing: "fail: re-enqueue (sandbox no longer available)",
          hostHealthyPerPool: state[lost.id]?.healthy === true,
          ifClean,
          ifDirty,
          ...(snapshot !== undefined ? { snapshot } : {}),
        },
      });
    } catch (error) {
      this.#log(`[placement] shadow could not record host loss: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The shadow for this process, or undefined when `SHIP_PLACEMENT` is not `shadow`. */
export function placementShadowFromEnv(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = () => {}): PlacementShadow | undefined {
  const raw = env[PLACEMENT_FLAG]?.trim();
  if (raw !== undefined && raw !== "" && placementMode(env) === "off" && raw.toLowerCase() !== "off") {
    log(`[placement] ${PLACEMENT_FLAG}=${raw} is not a mode (only "shadow" exists); placement shadow is off`);
  }
  if (placementMode(env) !== "shadow") return undefined;
  const draining = env.SHIP_PLACEMENT_DRAINING?.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return new PlacementShadow({
    sink: fileSink(placementShadowFile(env)),
    declared: declaredTargetsFromEnv(env, log),
    require: declaredRequirementFromEnv(env, log),
    ...(draining !== undefined ? { draining } : {}),
    log,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface PlacementSummary {
  fileFound: boolean;
  records: number;
  malformedLines: number;
  byPoint: Record<PlacementPoint, number>;
  disagreements: number;
  byKind: Record<PlacementDisagreement, number>;
  /** Rejection code -> count, across chosen-unsuitable records. */
  byRejection: Record<string, number>;
  groups: Array<{ kind: PlacementDisagreement; point: PlacementPoint; host: string; detail: string; count: number; first: string; last: string }>;
  notes: string[];
}

export const PLACEMENT_REPORT_NOTES: readonly string[] = [
  "shadow only: no placement or failure was changed by this module",
  "undeclared hosts have unknown architecture: a requirement naming an arch disagrees with them by design",
  "host-loss records cannot tell host loss from container TTL expiry, and assume nothing about the working tree (both bounds are recorded)",
];

export function parsePlacementRecords(text: string): { records: PlacementRecord[]; malformed: number } {
  const records: PlacementRecord[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as PlacementRecord;
      if (r === null || typeof r !== "object" || r.v !== 1 || typeof r.point !== "string") malformed += 1;
      else records.push(r);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function detailOf(r: PlacementRecord): string {
  if (r.point === "host-loss") {
    const h = r.hostLoss!;
    const d = (x: HostLossDecision) => (x.action === "recover" ? `recover on ${x.target.id} from ${x.from}` : `fail (${x.retryable ? "retryable" : "not retryable"})`);
    return `clean tree: ${d(h.ifClean)}; dirty tree: ${d(h.ifDirty)}`;
  }
  const why = (r.chosenRejections ?? []).map((x) => `${x.code} (${x.detail})`).join("; ");
  const would = r.would === undefined ? "" : r.would.ok ? `placeRun would use ${r.would.target}` : `placeRun would refuse (${r.would.refusal})`;
  return [why, would].filter((s) => s !== "").join(" -> ");
}

export function summarisePlacement(records: readonly PlacementRecord[], malformed = 0): PlacementSummary {
  const s: PlacementSummary = {
    fileFound: true,
    records: records.length,
    malformedLines: malformed,
    byPoint: { create: 0, createFrom: 0, "host-loss": 0 },
    disagreements: 0,
    byKind: { "chosen-unsuitable": 0, "different-choice": 0, "would-recover": 0 },
    byRejection: {},
    groups: [],
    notes: [...PLACEMENT_REPORT_NOTES],
  };
  const groups = new Map<string, PlacementSummary["groups"][number]>();
  for (const r of records) {
    if (r.point in s.byPoint) s.byPoint[r.point] += 1;
    if (r.disagreement === null || r.disagreement === undefined) continue;
    s.disagreements += 1;
    s.byKind[r.disagreement] = (s.byKind[r.disagreement] ?? 0) + 1;
    for (const x of r.chosenRejections ?? []) s.byRejection[x.code] = (s.byRejection[x.code] ?? 0) + 1;
    const detail = detailOf(r);
    const key = [r.disagreement, r.point, r.host, detail].join("\u0000");
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { kind: r.disagreement, point: r.point, host: r.host, detail, count: 1, first: r.at, last: r.at });
    else {
      g.count += 1;
      if (r.at < g.first) g.first = r.at;
      if (r.at > g.last) g.last = r.at;
    }
  }
  s.groups = [...groups.values()].sort((a, b) => b.count - a.count);
  return s;
}

export function renderPlacementReport(s: PlacementSummary, file: string): string {
  const out: string[] = [];
  out.push(`placement shadow report (${file})`);
  if (!s.fileFound) out.push(`no record file: the shadow has not recorded anything here (${PLACEMENT_FLAG} is not "shadow", or never ran). This is unknown, not zero disagreements.`);
  out.push(`${s.records} decision(s): ${s.byPoint.create} create, ${s.byPoint.createFrom} createFrom, ${s.byPoint["host-loss"]} host-loss`);
  out.push(
    `${s.disagreements} disagreement(s): ${s.byKind["chosen-unsuitable"]} chosen host unsuitable, ` +
      `${s.byKind["different-choice"]} different choice, ${s.byKind["would-recover"]} would recover where the run fails today`,
  );
  if (s.malformedLines > 0) out.push(`${s.malformedLines} unreadable line(s) skipped`);
  const codes = Object.entries(s.byRejection).sort((a, b) => b[1] - a[1]);
  if (codes.length > 0) out.push(`rejections of the chosen host: ${codes.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  for (const g of s.groups) {
    out.push("");
    out.push(`${g.count}x ${g.kind} (${g.point}) on ${g.host}`);
    out.push(`  ${g.detail}`);
    out.push(`  seen ${g.first} .. ${g.last}`);
  }
  out.push("");
  for (const n of s.notes) out.push(`note: ${n}`);
  return out.join("\n");
}

export async function readPlacementSummary(path: string): Promise<PlacementSummary> {
  let text = "";
  let fileFound = true;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fileFound = false;
  }
  const { records, malformed } = parsePlacementRecords(text);
  return { ...summarisePlacement(records, malformed), fileFound };
}
