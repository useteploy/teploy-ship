import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";

/**
 * What the host has left, for load-aware admission (C2). Read at every
 * scheduler pass; cheap (one small file, two syscalls).
 *
 * Free memory is MemAvailable from /proc/meminfo where it exists, not
 * os.freemem(): on Linux the latter is MemFree, which excludes reclaimable
 * page cache and reads a few hundred MB on a box with gigabytes to spare
 * (deploy-test: MemFree 543 MB, MemAvailable 2535 MB). A worker inside a
 * container still sees the HOST's meminfo, which is the number that matters —
 * sandboxes are host containers, not children of the worker.
 */
export interface HostLoad {
  freeMemMB: number;
  load1: number;
  cpus: number;
}

export function hostLoad(readMeminfo: () => string = () => readFileSync("/proc/meminfo", "utf8")): HostLoad {
  let freeMemMB = Math.round(freemem() / (1024 * 1024));
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readMeminfo());
    if (m !== null) freeMemMB = Math.round(Number(m[1]) / 1024);
  } catch {
    // Not Linux, or no procfs: os.freemem() is the best available answer.
  }
  return { freeMemMB, load1: loadavg()[0] ?? 0, cpus: Math.max(1, cpus().length) };
}

export interface HostLimits {
  /** Refuse to launch below this much available memory (SHIP_MIN_FREE_MB). */
  minFreeMB: number;
  /** Refuse to launch above this 1-minute load per CPU (SHIP_MAX_LOAD_PER_CPU). */
  maxLoadPerCpu: number;
}

/** One run plus headroom, from the measured 350–400 MB per in-flight run (docs/capacity.md). */
export const DEFAULT_MIN_FREE_MB = 600;
export const DEFAULT_MAX_LOAD_PER_CPU = 1.5;

/** Why a launch is held right now, or null when the host has room. Memory first: it is what binds first on a small box. */
export function hostHold(load: HostLoad, limits: HostLimits): "memory" | "load" | null {
  if (limits.minFreeMB > 0 && load.freeMemMB < limits.minFreeMB) return "memory";
  if (limits.maxLoadPerCpu > 0 && load.load1 / load.cpus > limits.maxLoadPerCpu) return "load";
  return null;
}
