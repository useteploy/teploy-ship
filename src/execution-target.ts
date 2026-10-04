/**
 * Execution targets: what a place to run can actually do, and placement that
 * refuses rather than guesses.
 *
 * WHY THIS EXISTS. `sandbox-pool.ts` places on "least-loaded healthy host" and
 * that is correct only while every host is the same thing: a Linux container
 * on the daemon's own architecture. The moment a pool can hold an arm64 box, a
 * Windows or macOS VM, a headed-browser desktop, a GPU host or a customer's
 * private worker, "healthy and least loaded" will happily put an arm64 build
 * on amd64 or a browser run on a headless container, and the failure shows up
 * as a confusing in-run error (or worse, a green run that tested the wrong
 * thing). This module is the pure decision: given what a run NEEDS and what
 * each target DECLARES, pick one or say exactly why none will do.
 *
 * RULES, each with a negative control in the test file:
 *  - A target that does not declare a capability does not have it. There is no
 *    fallback to an unsuitable target; the answer is a refusal naming each
 *    target and why.
 *  - Unknown is not healthy: a target with no state entry is rejected.
 *  - Draining means no NEW work (as in sandbox-pool); it never moves a run.
 *  - Quotas are per target and per project.
 *  - A snapshot restores only onto a target that supports its format, matches
 *    its os/arch, and (for a host-local snapshot, like a pool `<index>@<id>`
 *    handle) is the host that holds it.
 *  - After host loss a run is recovered elsewhere only if that is true to what
 *    survived. Uncommitted work on the lost host is never reported preserved.
 *
 * REFUSAL KINDS separate "never" from "not now". `no-suitable-target` means
 * every target is permanently wrong for this requirement (fail the run now);
 * `retry-later` means at least one target would fit but is full, draining,
 * over quota or down (queue, do not fail).
 *
 * SCOPE. The control plane (web, queue, Nucleus) is not a target and is not
 * modelled here: self-hosting it is a separate deployment concern. A
 * customer-hosted worker is a target with `hosting: "customer"`, and a
 * requirement can demand or exclude it.
 *
 * Pure: no I/O, no clock. Not yet wired into sandbox-pool.ts or the scheduler.
 */

export type TargetOs = "linux" | "windows" | "macos";
export type TargetArch = "amd64" | "arm64";
export type BrowserSupport = "none" | "headless" | "headed";
export type CredentialMode = "disposable" | "static" | "none";
export type TargetKind = "local-container" | "remote-container" | "local-vm" | "remote-vm" | "customer-worker";
export type MobileSim = "android" | "ios";

export interface TargetCapabilities {
  kind: TargetKind;
  /** Who operates it. A customer-hosted worker is never a managed one. */
  hosting: "managed" | "customer";
  os: TargetOs;
  arch: TargetArch;
  cpu: number;
  memMB: number;
  diskMB: number;
  browser: BrowserSupport;
  /** A real desktop session (screen, window manager), not just a browser. */
  desktop: boolean;
  /** Services present on the target (postgres, redis, docker...). */
  services: string[];
  hardware: { gpu: number; mobileSim: MobileSim[] };
  /** Named private networks the target can reach (a customer LAN, a VPC). */
  network: string[];
  /** Snapshot formats it can write and restore ("oci-image", "vm-disk"...). */
  snapshotFormats: string[];
  /** Does it isolate the agent from the host? Same meaning as ExecutorProvider.isolated. */
  isolated: boolean;
  credentialMode: CredentialMode;
  /** Admission limits. `perProject` caps one project's concurrent runs here. */
  quota: { maxRuns: number; perProject?: number };
}

export interface Target {
  id: string;
  caps: TargetCapabilities;
}

/** Live state of one target, read by the caller at placement time. */
export interface TargetState {
  healthy: boolean;
  draining: boolean;
  live: number;
  usedCpu: number;
  usedMemMB: number;
  usedDiskMB: number;
  /** Live runs per project on this target. */
  projectRuns: Record<string, number>;
  /** Repos whose warm volume is on this target; breaks ties only. */
  warmRepos?: string[];
}

export type PlacementState = Record<string, TargetState>;

/** A snapshot a run wants to restore from. */
export interface SnapshotRef {
  format: string;
  os: TargetOs;
  arch: TargetArch;
  /** Set when the snapshot lives only on one target (a pool-local handle). Absent means portable (in a shared store). */
  host?: string;
}

export interface RunRequirement {
  project: string;
  /** Required, never defaulted: a run that does not say its OS does not get Linux by accident. */
  os: TargetOs;
  /** Absent means any architecture. Present means exactly that one. */
  arch?: TargetArch;
  cpu?: number;
  memMB?: number;
  diskMB?: number;
  /** "headless" is satisfied by a headed target; "headed" only by headed. */
  browser?: "headless" | "headed";
  desktop?: boolean;
  services?: string[];
  gpu?: number;
  mobileSim?: MobileSim;
  /** Private networks the run must reach. */
  network?: string[];
  hosting?: "managed" | "customer";
  /** The task came from outside: only an isolating target will do. */
  isolated?: boolean;
  credentials?: "disposable";
  restore?: SnapshotRef;
  /** For warm-volume tie-breaking. */
  warmRepo?: string;
}

export type RejectionCode =
  | "os"
  | "arch"
  | "hosting"
  | "capability"
  | "isolation"
  | "credentials"
  | "snapshot-incompatible"
  | "unhealthy"
  | "draining"
  | "capacity"
  | "quota";

/** Reasons that cannot change by waiting. */
const PERMANENT: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "os",
  "arch",
  "hosting",
  "capability",
  "isolation",
  "credentials",
  "snapshot-incompatible",
]);

export interface Rejection {
  code: RejectionCode;
  detail: string;
}

export interface TargetVerdict {
  targetId: string;
  /** Every reason, in check order. Empty means suitable. */
  rejections: Rejection[];
}

export type Placement =
  | { ok: true; target: Target; verdicts: TargetVerdict[]; suitable: string[] }
  | {
      ok: false;
      refusal: "no-suitable-target" | "retry-later";
      reason: string;
      verdicts: TargetVerdict[];
    };

function describe(v: TargetVerdict): string {
  return `${v.targetId}: ${v.rejections.map((r) => `${r.code} (${r.detail})`).join("; ")}`;
}

/** Judge one target against a requirement. Static fit first, then dynamic. */
export function judgeTarget(req: RunRequirement, target: Target, state: TargetState | undefined): TargetVerdict {
  const c = target.caps;
  const out: Rejection[] = [];
  const no = (code: RejectionCode, detail: string) => out.push({ code, detail });

  // Permanent: what the target is.
  if (c.os !== req.os) no("os", `needs ${req.os}, target is ${c.os}`);
  if (req.arch !== undefined && c.arch !== req.arch) no("arch", `needs ${req.arch}, target is ${c.arch}`);
  if (req.hosting !== undefined && c.hosting !== req.hosting) no("hosting", `needs ${req.hosting}-hosted, target is ${c.hosting}-hosted`);
  if (req.isolated === true && !c.isolated) no("isolation", "run needs an isolating target");
  if (req.credentials === "disposable" && c.credentialMode !== "disposable") {
    no("credentials", `needs disposable credentials, target uses ${c.credentialMode}`);
  }
  if (req.browser !== undefined) {
    const have = c.browser === "headed" ? 2 : c.browser === "headless" ? 1 : 0;
    if (have < (req.browser === "headed" ? 2 : 1)) no("capability", `needs ${req.browser} browser, target has ${c.browser}`);
  }
  if (req.desktop === true && !c.desktop) no("capability", "needs a desktop session");
  for (const s of req.services ?? []) if (!c.services.includes(s)) no("capability", `needs service ${s}`);
  if ((req.gpu ?? 0) > c.hardware.gpu) no("capability", `needs ${req.gpu} gpu, target has ${c.hardware.gpu}`);
  if (req.mobileSim !== undefined && !c.hardware.mobileSim.includes(req.mobileSim)) no("capability", `needs ${req.mobileSim} simulator`);
  for (const n of req.network ?? []) if (!c.network.includes(n)) no("capability", `cannot reach private network ${n}`);
  // A run bigger than the whole target can never fit, however idle it gets.
  if ((req.cpu ?? 0) > c.cpu) no("capability", `needs ${req.cpu} cpu, target has ${c.cpu}`);
  if ((req.memMB ?? 0) > c.memMB) no("capability", `needs ${req.memMB} MB memory, target has ${c.memMB}`);
  if ((req.diskMB ?? 0) > c.diskMB) no("capability", `needs ${req.diskMB} MB disk, target has ${c.diskMB}`);
  if (req.restore !== undefined) {
    const s = req.restore;
    if (!c.snapshotFormats.includes(s.format)) no("snapshot-incompatible", `snapshot is ${s.format}, target supports [${c.snapshotFormats.join(", ")}]`);
    else if (s.os !== c.os || s.arch !== c.arch) no("snapshot-incompatible", `snapshot is ${s.os}/${s.arch}, target is ${c.os}/${c.arch}`);
    else if (s.host !== undefined && s.host !== target.id) no("snapshot-incompatible", `snapshot is local to ${s.host}`);
  }

  // Transient: what the target is doing right now.
  if (state === undefined) {
    no("unhealthy", "no state reported");
  } else {
    if (!state.healthy) no("unhealthy", "marked unhealthy");
    if (state.draining) no("draining", "no new work");
    if (state.live >= c.quota.maxRuns) no("quota", `${state.live}/${c.quota.maxRuns} runs`);
    const pq = c.quota.perProject;
    const mine = state.projectRuns[req.project] ?? 0;
    if (pq !== undefined && mine >= pq) no("quota", `project ${req.project} has ${mine}/${pq} runs here`);
    // (an oversize request was already rejected above as a capability; do not double-report it as busy)
    if ((req.cpu ?? 0) <= c.cpu && (req.cpu ?? 0) > c.cpu - state.usedCpu) no("capacity", `${c.cpu - state.usedCpu} cpu free, needs ${req.cpu}`);
    if ((req.memMB ?? 0) <= c.memMB && (req.memMB ?? 0) > c.memMB - state.usedMemMB) no("capacity", `${c.memMB - state.usedMemMB} MB memory free, needs ${req.memMB}`);
    if ((req.diskMB ?? 0) <= c.diskMB && (req.diskMB ?? 0) > c.diskMB - state.usedDiskMB) no("capacity", `${c.diskMB - state.usedDiskMB} MB disk free, needs ${req.diskMB}`);
  }
  return { targetId: target.id, rejections: out };
}

/**
 * Choose a target, or refuse with the reason for every target.
 *
 * Among suitable targets: lowest utilisation (live / maxRuns, so a big box and
 * a small one are compared fairly), then a warm volume for the repo, then
 * declaration order (a one-target list behaves like the single provider).
 */
export function placeRun(req: RunRequirement, targets: Target[], state: PlacementState): Placement {
  const verdicts = targets.map((t) => judgeTarget(req, t, state[t.id]));
  const suitable = targets.filter((_, i) => verdicts[i]!.rejections.length === 0);
  if (suitable.length > 0) {
    let best = suitable[0]!;
    const rank = (t: Target): [number, number] => [
      state[t.id]!.live / t.caps.quota.maxRuns,
      req.warmRepo !== undefined && state[t.id]!.warmRepos?.includes(req.warmRepo) ? 0 : 1,
    ];
    for (const t of suitable.slice(1)) {
      const [a0, a1] = rank(t);
      const [b0, b1] = rank(best);
      if (a0 < b0 || (a0 === b0 && a1 < b1)) best = t;
    }
    return { ok: true, target: best, verdicts, suitable: suitable.map((t) => t.id) };
  }
  if (targets.length === 0) return { ok: false, refusal: "no-suitable-target", reason: "no targets configured", verdicts };
  // Would any target fit if only the transient problems cleared?
  const couldFit = verdicts.some((v) => v.rejections.every((r) => !PERMANENT.has(r.code)));
  const why = verdicts.map(describe).join(" | ");
  return couldFit
    ? { ok: false, refusal: "retry-later", reason: `suitable targets are unavailable: ${why}`, verdicts }
    : { ok: false, refusal: "no-suitable-target", reason: `no target fits this run: ${why}`, verdicts };
}

/** What the run had when its host went away. */
export interface RunOnHost {
  id: string;
  targetId: string;
  requirement: RunRequirement;
  /** The latest snapshot, if one was taken. */
  snapshot?: SnapshotRef;
  /** The working tree had changes that were not committed and pushed. */
  uncommittedWork: boolean;
  /** The run can be restarted from its pushed ref without harm (idempotent from there). */
  restartableFromCommitted: boolean;
}

export type HostLossDecision =
  | {
      action: "recover";
      target: Target;
      /** What the new workspace starts from. */
      from: "snapshot" | "committed";
      /** True only when nothing the run had was lost. */
      preserved: boolean;
      /** Stated losses, never empty when preserved is false. */
      lost: string[];
    }
  | { action: "fail"; reason: string; retryable: boolean };

/**
 * A host is gone. Recover on another suitable target, or fail honestly.
 *
 * `targets` and `state` are the fleet as the caller sees it now; the lost
 * target is excluded here regardless of what its state says.
 */
export function onHostLoss(run: RunOnHost, targets: Target[], state: PlacementState): HostLossDecision {
  const lostId = run.targetId;
  const survivors = targets.filter((t) => t.id !== lostId);
  const surviving: PlacementState = { ...state };
  delete surviving[lostId];

  // A snapshot held only by the lost host went down with it.
  const snap = run.snapshot !== undefined && run.snapshot.host !== lostId ? run.snapshot : undefined;
  const snapGone = run.snapshot !== undefined && snap === undefined;

  if (snap !== undefined) {
    const p = placeRun({ ...run.requirement, restore: snap }, survivors, surviving);
    if (p.ok) {
      return {
        action: "recover",
        target: p.target,
        from: "snapshot",
        // The snapshot is a point in time: preserved only if the tree was clean since.
        preserved: !run.uncommittedWork,
        lost: run.uncommittedWork ? ["working-tree changes made after the last snapshot"] : [],
      };
    }
    return { action: "fail", reason: `host ${lostId} was lost and the snapshot cannot be restored: ${p.reason}`, retryable: p.refusal === "retry-later" };
  }

  const base = `host ${lostId} was lost${snapGone ? " with its only snapshot" : " and the run has no snapshot"}`;
  if (run.uncommittedWork && !run.restartableFromCommitted) {
    return { action: "fail", reason: `${base}; the uncommitted working tree is gone and the run cannot restart from its committed state`, retryable: false };
  }
  const { restore: _dropped, ...fresh } = run.requirement;
  const p = placeRun(fresh, survivors, surviving);
  if (!p.ok) return { action: "fail", reason: `${base}; no other target can take it: ${p.reason}`, retryable: p.refusal === "retry-later" };
  return {
    action: "recover",
    target: p.target,
    from: "committed",
    preserved: !run.uncommittedWork,
    lost: run.uncommittedWork ? ["uncommitted working tree on the lost host"] : [],
  };
}

// ---- conformance -----------------------------------------------------------

/** What a backend measures about itself, as opposed to what it declares. A missing field means "not observable". */
export interface ObservedCapabilities {
  os?: TargetOs;
  arch?: TargetArch;
  cpu?: number;
  memMB?: number;
  diskMB?: number;
  browser?: BrowserSupport;
  desktop?: boolean;
  services?: string[];
  gpu?: number;
  mobileSim?: MobileSim[];
}

export interface TargetAdapter {
  declared: TargetCapabilities;
  observe(): Promise<ObservedCapabilities>;
  /** Can a probe from the target reach this private network? */
  reach?(network: string): Promise<boolean>;
  /** Snapshot then restore in `format`; true if the restored workspace matched. A refusal (false or throw) is the correct answer for a format it does not support. */
  snapshotRoundTrip?(format: string): Promise<boolean>;
  /** Put the target into draining; returns whether it still accepts new runs. */
  drain?(): Promise<{ acceptsNew: boolean }>;
  credential?: {
    mint(): Promise<{ id: string }>;
    valid(id: string): Promise<boolean>;
    revoke(id: string): Promise<void>;
  };
}

export type ConformanceStatus = "pass" | "fail" | "not-observable";

export interface ConformanceResult {
  check: string;
  status: ConformanceStatus;
  declared: string;
  observed: string;
}

/** Only an all-pass run is conformant. "Not observable" is not a pass: an unverified claim is not a claim. */
export function isConformant(results: ConformanceResult[]): boolean {
  return results.every((r) => r.status === "pass");
}

const show = (v: unknown): string => (v === undefined ? "unknown" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/**
 * Boundary checks a backend must pass before it is allowed into placement:
 * declared must not exceed observed. Declaring LESS than observed is
 * conservative and passes; declaring more is the lie placement cannot detect.
 */
export async function conformance(adapter: TargetAdapter): Promise<ConformanceResult[]> {
  const d = adapter.declared;
  const o = await adapter.observe();
  const out: ConformanceResult[] = [];
  const add = (check: string, status: ConformanceStatus, declared: unknown, observed: unknown) =>
    out.push({ check, status, declared: show(declared), observed: show(observed) });
  const exact = <T>(check: string, dv: T, ov: T | undefined) =>
    add(check, ov === undefined ? "not-observable" : ov === dv ? "pass" : "fail", dv, ov);
  const atLeast = (check: string, dv: number, ov: number | undefined) =>
    add(check, ov === undefined ? "not-observable" : ov >= dv ? "pass" : "fail", dv, ov);

  exact("os", d.os, o.os);
  exact("arch", d.arch, o.arch);
  atLeast("cpu", d.cpu, o.cpu);
  atLeast("memMB", d.memMB, o.memMB);
  atLeast("diskMB", d.diskMB, o.diskMB);
  exact("browser", d.browser, o.browser);
  exact("desktop", d.desktop, o.desktop);
  atLeast("gpu", d.hardware.gpu, o.gpu);
  for (const s of d.services) add(`service:${s}`, o.services === undefined ? "not-observable" : o.services.includes(s) ? "pass" : "fail", s, o.services);
  for (const m of d.hardware.mobileSim) add(`mobileSim:${m}`, o.mobileSim === undefined ? "not-observable" : o.mobileSim.includes(m) ? "pass" : "fail", m, o.mobileSim);

  for (const n of d.network) {
    if (adapter.reach === undefined) add(`network:${n}`, "not-observable", n, undefined);
    else add(`network:${n}`, (await adapter.reach(n)) ? "pass" : "fail", n, "probe");
  }
  for (const f of d.snapshotFormats) {
    if (adapter.snapshotRoundTrip === undefined) add(`snapshot:${f}`, "not-observable", f, undefined);
    else add(`snapshot:${f}`, (await adapter.snapshotRoundTrip(f).catch(() => false)) ? "pass" : "fail", f, "round trip");
  }
  // An undeclared format must be refused, or "snapshot-incompatible" means nothing.
  if (adapter.snapshotRoundTrip !== undefined) {
    const accepted = await adapter.snapshotRoundTrip("__undeclared-format__").catch(() => false);
    add("snapshot:undeclared-refused", accepted ? "fail" : "pass", "refuse", accepted ? "accepted" : "refused");
  }
  if (adapter.drain === undefined) add("draining", "not-observable", "no new work", undefined);
  else {
    const r = await adapter.drain();
    add("draining", r.acceptsNew ? "fail" : "pass", "no new work", r.acceptsNew ? "still accepting" : "refusing");
  }
  if (d.credentialMode === "disposable") {
    const cr = adapter.credential;
    if (cr === undefined) add("credentials:disposable", "not-observable", "disposable", undefined);
    else {
      const a = await cr.mint();
      const b = await cr.mint();
      await cr.revoke(a.id);
      const ok = a.id !== b.id && !(await cr.valid(a.id)) && (await cr.valid(b.id));
      await cr.revoke(b.id);
      add("credentials:disposable", ok ? "pass" : "fail", "distinct, revocable", ok ? "distinct, revocable" : "reused or not revoked");
    }
  }
  return out;
}
