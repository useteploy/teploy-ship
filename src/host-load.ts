import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";

/**
 * What the host has left, for load-aware admission (C2) and for deriving the
 * concurrency ceiling from the box rather than from a constant (B1). Read at
 * every scheduler pass and every heartbeat; cheap (one small file, three
 * syscalls).
 *
 * Free memory is MemAvailable from /proc/meminfo where it exists, not
 * os.freemem(): on Linux the latter is MemFree, which excludes reclaimable
 * page cache and reads a few hundred MB on a box with gigabytes to spare
 * (deploy-test: MemFree 543 MB, MemAvailable 2535 MB). A worker inside a
 * container still sees the HOST's meminfo, which is the number that matters —
 * sandboxes are host containers, not children of the worker.
 */
export interface HostLoad {
  /** MemTotal. The stable term the ceiling is planned from (see capacityPlan). */
  totalMemMB: number;
  freeMemMB: number;
  load1: number;
  cpus: number;
  /** Docker-root filesystem, when it could be measured at all. Absent = no statfs (not Linux, or the path is gone). */
  disk?: HostDisk;
}

/**
 * The filesystem docker writes image layers, container upper dirs and volumes
 * into. A full disk is the failure mode that takes the WHOLE box down — the
 * daemon cannot write a layer, running containers cannot write, and the
 * recovery is manual — where memory pressure only delays. A sandbox image plus
 * a clone plus a Go module cache is not small.
 */
export interface HostDisk {
  /** Bytes available to an unprivileged writer (statfs bavail), in MB. Bytes, not percent, is the honest measure. */
  freeMB: number;
  /** Percent used as `df` reports it, so the number matches what an operator sees. */
  usedPct: number;
  /**
   * Percent of inodes used. Its own signal because it fails independently:
   * a module/build cache is millions of tiny files, so a box can exhaust
   * inodes with tens of GB of bytes still free and every write still fails.
   */
  inodeUsedPct: number;
}

/** Injection seams, so sensing is testable without a real procfs or filesystem. */
export interface HostProbes {
  readMeminfo?: () => string;
  /** Same shape as node:fs statfsSync's result; only these five fields are read. */
  statfs?: (path: string) => { bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number };
  /** Candidate mount points, tried in order; the first that answers wins. */
  diskPaths?: string[];
}

/**
 * Where to measure the docker root. `/var/lib/docker` is the real answer and is
 * tried first; `/` is the fallback because a worker running INSIDE a container
 * has no `/var/lib/docker`, and its own `/` is an overlayfs whose statfs
 * reports the underlying upper filesystem — i.e. the host's docker root anyway.
 */
export function diskPathCandidates(): string[] {
  const configured = process.env.SHIP_DISK_PATH;
  return [...(configured !== undefined && configured !== "" ? [configured] : []), "/var/lib/docker", "/"];
}

function senseDisk(probes: HostProbes): HostDisk | undefined {
  const statfs = probes.statfs ?? ((path: string) => statfsSync(path) as unknown as ReturnType<NonNullable<HostProbes["statfs"]>>);
  for (const path of probes.diskPaths ?? diskPathCandidates()) {
    try {
      const s = statfs(path);
      if (!Number.isFinite(s.bsize) || !Number.isFinite(s.blocks) || s.blocks <= 0) continue;
      // df's definition of "used %": blocks reserved for root are excluded from
      // the denominator, which is why df shows 97% where blocks-bfree/blocks
      // would show 91%. Matching df keeps the dashboard number checkable.
      const used = s.blocks - s.bfree;
      const denom = used + s.bavail;
      return {
        freeMB: Math.round((s.bavail * s.bsize) / (1024 * 1024)),
        usedPct: denom > 0 ? Math.round((used / denom) * 1000) / 10 : 0,
        // Not every filesystem accounts inodes (btrfs reports files = 0);
        // absent accounting reads as no pressure rather than as 100% used.
        inodeUsedPct: s.files > 0 ? Math.round(((s.files - s.ffree) / s.files) * 1000) / 10 : 0,
      };
    } catch {
      // This mount point is not there (a container has no /var/lib/docker): try the next.
    }
  }
  return undefined;
}

export function hostLoad(probes: HostProbes = {}): HostLoad {
  const readMeminfo = probes.readMeminfo ?? (() => readFileSync("/proc/meminfo", "utf8"));
  let freeMemMB = Math.round(freemem() / (1024 * 1024));
  let totalMemMB = Math.round(totalmem() / (1024 * 1024));
  try {
    const info = readMeminfo();
    const avail = /^MemAvailable:\s+(\d+)\s+kB/m.exec(info);
    if (avail !== null) freeMemMB = Math.round(Number(avail[1]) / 1024);
    const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(info);
    if (total !== null) totalMemMB = Math.round(Number(total[1]) / 1024);
  } catch {
    // Not Linux, or no procfs: os.freemem()/os.totalmem() are the best available answers.
  }
  const disk = senseDisk(probes);
  return {
    totalMemMB,
    freeMemMB,
    load1: loadavg()[0] ?? 0,
    cpus: Math.max(1, cpus().length),
    ...(disk !== undefined ? { disk } : {}),
  };
}

export interface HostLimits {
  /** Refuse to launch below this much available memory (SHIP_MIN_FREE_MB). */
  minFreeMB: number;
  /** Refuse to launch above this 1-minute load per CPU (SHIP_MAX_LOAD_PER_CPU). */
  maxLoadPerCpu: number;
  /** Refuse to launch below this much free disk on the docker root (SHIP_MIN_FREE_DISK_MB). */
  minFreeDiskMB: number;
  /** Refuse to launch above this percent of inodes used (SHIP_MAX_INODE_USED_PCT). */
  maxInodeUsedPct: number;
}

/** One run plus headroom, from the measured 350–400 MB per in-flight run (docs/capacity.md). */
export const DEFAULT_MIN_FREE_MB = 600;
export const DEFAULT_MAX_LOAD_PER_CPU = 1.5;
/**
 * Disk a run needs before it is safe to start one: a clone, a Go/Node module
 * cache and a build cache for one repo (docs/capacity.md's per-run sandbox),
 * plus the same again as headroom for the layers docker writes underneath it.
 * The sandbox IMAGE is not in this number — it is pulled once and already on
 * disk by the time a worker is admitting runs.
 */
export const DEFAULT_MIN_FREE_DISK_MB = 2048;
export const DEFAULT_MAX_INODE_USED_PCT = 95;

/** Why a launch is held right now, or null when the host has room. */
export type HostHold = "memory" | "load" | "disk";

/**
 * Disk is checked FIRST, ahead of memory, though memory is what binds first on
 * a small box. Being out of memory delays work and the kernel resolves it;
 * being out of disk breaks the docker daemon for every tenant on the box and
 * needs a human. The cheaper failure yields to the more expensive one.
 */
export function hostHold(load: HostLoad, limits: HostLimits): HostHold | null {
  if (load.disk !== undefined) {
    if (limits.minFreeDiskMB > 0 && load.disk.freeMB < limits.minFreeDiskMB) return "disk";
    if (limits.maxInodeUsedPct > 0 && load.disk.inodeUsedPct > limits.maxInodeUsedPct) return "disk";
  }
  if (limits.minFreeMB > 0 && load.freeMemMB < limits.minFreeMB) return "memory";
  if (limits.maxLoadPerCpu > 0 && load.load1 / load.cpus > limits.maxLoadPerCpu) return "load";
  return null;
}

/**
 * The stack's base footprint (web + worker + Nucleus + gateway + ollama),
 * measured idle at ~1.3 GB on deploy-test and rounded up (docs/capacity.md).
 * Nucleus grows with run history, so this is a floor, not a constant of nature.
 */
export const BASE_RESERVE_MB = 1536;
/** Host memory one in-flight run costs: measured 350–400 MB (docs/capacity.md). */
export const PER_RUN_MB = 400;
/** Disk one in-flight run costs beyond the reserve above: clone + caches for one more repo. */
export const PER_RUN_DISK_MB = 1024;
/**
 * Nothing above 4 was ever measured (docs/capacity.md, "Not measured, and
 * why"). A derived ceiling on a 64-core box is a projection, so it is bounded:
 * an operator who genuinely wants 32 sets SHIP_MAX_CONCURRENT_RUNS and owns
 * the result.
 */
export const DERIVED_CEILING_CAP = 16;

/** Which sensed term produced the ceiling — the thing the Fleet page reports as binding. */
export type CapacityBinding = "override" | "cpu" | "memory" | "disk";

export interface Capacity {
  /** Slots this worker will actually use. Never 0: see the floor note below. */
  maxConcurrent: number;
  binding: CapacityBinding;
  /** Each term's own answer, so the UI can show why the min is the min. `disk` is null when unsensed. */
  terms: { cpu: number; memory: number; disk: number | null };
}

export interface CapacityInput {
  limits: HostLimits;
  /** Runs already in flight here. Their memory and disk are ALREADY in the sensed numbers. */
  activeRuns: number;
  /** SHIP_MAX_CONCURRENT_RUNS / --max-concurrent. Wins outright when set. */
  override?: number;
}

/**
 * Derive the concurrency ceiling from what the box actually has.
 *
 * docs/capacity.md's rule of thumb is the starting point:
 *
 *     ceiling = min( vCPUs, floor((RAM_GB - 1.5) / 0.4) )
 *
 * with 1.5 GB the stack's base and 0.4 GB the measured cost of one in-flight
 * run. Two changes make it a runtime formula rather than an operator's sum:
 *
 *  1. The memory term is the MIN of two readings. From MemTotal it is the
 *     doc's formula unchanged — stable, so the ceiling does not oscillate as
 *     runs start and stop. From MemAvailable it is `activeRuns + how many more
 *     fit above the minFreeMB floor` — which is the same number while this
 *     worker is the only tenant, and DROPS when something else on the box eats
 *     the RAM. Taking the min means a co-tenant lowers the ceiling; this
 *     worker's own runs do not (they raise freeMemMB's shortfall and
 *     activeRuns together, which cancel).
 *  2. A disk term the doc has none of, on the same shape: how many more runs
 *     fit above the free-disk floor. docs/capacity.md measured a box with
 *     54 GB used of 75 and never looked at disk; that box is at 97% today.
 *
 * The result is floored at 1, never 0. A ceiling of 0 would wedge the worker
 * permanently — no launch, so no completion, so nothing to free the resource.
 * Refusing to launch is hostHold's job, and hostHold re-senses every pass, so a
 * squeezed box holds and then RECOVERS. The ceiling only ever says how many
 * runs to plan for.
 */
export function capacityPlan(load: HostLoad, input: CapacityInput): Capacity {
  const activeRuns = Math.max(0, input.activeRuns);
  const cpu = Math.max(1, load.cpus);
  const byTotalMem = Math.floor((load.totalMemMB - BASE_RESERVE_MB) / PER_RUN_MB);
  const byFreeMem = activeRuns + Math.floor((load.freeMemMB - Math.max(0, input.limits.minFreeMB)) / PER_RUN_MB);
  const memory = Math.min(byTotalMem, byFreeMem);
  const disk =
    load.disk === undefined
      ? null
      : activeRuns + Math.floor((load.disk.freeMB - Math.max(0, input.limits.minFreeDiskMB)) / PER_RUN_DISK_MB);
  const terms = { cpu, memory, disk };

  if (input.override !== undefined && input.override >= 1) {
    return { maxConcurrent: Math.floor(input.override), binding: "override", terms };
  }
  // Ordered scarcest-consequence first, so a tie names the resource that hurts
  // more and that the operator can actually do something about.
  const ranked: Array<[CapacityBinding, number]> = [
    ...(disk !== null ? ([["disk", disk]] as Array<[CapacityBinding, number]>) : []),
    ["memory", memory],
    ["cpu", cpu],
  ];
  let binding: CapacityBinding = ranked[0]![0];
  let value = ranked[0]![1];
  for (const [name, n] of ranked) {
    if (n < value) {
      binding = name;
      value = n;
    }
  }
  if (DERIVED_CEILING_CAP < value) return { maxConcurrent: DERIVED_CEILING_CAP, binding, terms };
  return { maxConcurrent: Math.max(1, value), binding, terms };
}

/** One line an operator can act on: the ceiling, what bound it, and the numbers behind it. */
export function describeCapacity(load: HostLoad, capacity: Capacity): string {
  const disk =
    load.disk === undefined
      ? "disk unsensed"
      : `disk ${load.disk.freeMB} MB free (${load.disk.usedPct}% used, ${load.disk.inodeUsedPct}% inodes)`;
  return (
    `${capacity.maxConcurrent} slot${capacity.maxConcurrent === 1 ? "" : "s"}, ${capacity.binding} binding ` +
    `(cpu ${capacity.terms.cpu}, memory ${capacity.terms.memory}, disk ${capacity.terms.disk ?? "n/a"}) — ` +
    `${load.cpus} cpu, ${load.freeMemMB}/${load.totalMemMB} MB free, ${disk}`
  );
}

/** Floor and cap on a derived sandbox memory limit. 512 MB will not build much; above 4 GB is not a "default". */
export const SANDBOX_MIN_MEMORY_MB = 512;
export const SANDBOX_MAX_MEMORY_MB = 4096;

/**
 * Per-sandbox limits sized from the host, for runs whose project record does
 * not specify its own. Without this the teploy-sandbox daemon's fixed default
 * applies (1 CPU / 1 GB) whatever the box is — which starves a 16 GB builder
 * and over-commits a 2 GB one.
 *
 * The box's usable memory is split evenly across the slots it planned for, so
 * the sum of the caps is what the host can actually back. It is a CAP, not a
 * reservation: a run that needs less takes less.
 */
export function sandboxLimitsFor(
  load: HostLoad,
  maxConcurrent: number,
  sandboxHost: SandboxHost = {},
): { memoryMb: number; cpus: number } {
  const slots = Math.max(1, Math.floor(maxConcurrent));
  const totalMemMB = sandboxHost.totalMemMB ?? load.totalMemMB;
  const hostCpus = sandboxHost.cpus ?? load.cpus;
  const usable = Math.max(0, totalMemMB - BASE_RESERVE_MB);
  // Rounded down to 64 MB so the number reads as a limit someone chose.
  const share = Math.floor(usable / slots / 64) * 64;
  return {
    memoryMb: Math.max(SANDBOX_MIN_MEMORY_MB, Math.min(SANDBOX_MAX_MEMORY_MB, share)),
    // Fractional shares are honest on a small box (2 cpu, 4 slots -> 0.5 each);
    // below half a core the container spends its life throttled, so that is the floor.
    cpus: Math.max(0.5, Math.round((hostCpus / slots) * 10) / 10),
  };
}

/**
 * The box the SANDBOXES run on, when it is not the box the worker runs on.
 *
 * `load` above is the worker host's /proc/meminfo. That is the right box for
 * admission (the worker's own footprint) and the wrong one for sizing a
 * container the teploy-sandbox daemon creates somewhere else: with the worker
 * on a 29 GB host and the daemon on a 7.8 GB one, four un-configured runs each
 * got the 4096 MB cap — 16 GB of caps on a box that backs about 6 GB
 * (docs/capacity.md, the 0.4 GB-per-run term with a Rust build in it). The
 * daemon's /health says only {status, version}, so there is nothing to read
 * remotely; the operator states it.
 */
export interface SandboxHost {
  totalMemMB?: number;
  cpus?: number;
}

/** SHIP_SANDBOX_HOST_MEMORY_MB / SHIP_SANDBOX_HOST_CPUS; absent or invalid = fall back to the worker host. */
export function sandboxHostFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxHost {
  const num = (name: string): number | undefined => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const totalMemMB = num("SHIP_SANDBOX_HOST_MEMORY_MB");
  const cpus = num("SHIP_SANDBOX_HOST_CPUS");
  return { ...(totalMemMB !== undefined ? { totalMemMB } : {}), ...(cpus !== undefined ? { cpus } : {}) };
}
