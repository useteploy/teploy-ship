/**
 * Per-run resource classes: a run admits its real footprint at placement.
 *
 * WHY THIS EXISTS. Admission plans every run as the same thing: one slot,
 * PER_RUN_MB of host memory (docs/capacity.md's measured 350-400 MB per
 * in-flight run). A browser run — a run whose input admits the ```look action
 * (`input.look`, SHIP_LOOK) — is not that thing: it also carries a Chromium,
 * which costs roughly 300-500 MB more than a plain run before the task's own
 * work starts. A box that admits N plain runs will over-admit when some of
 * the N are browser runs, and the failure is the OOM killer choosing between
 * a sandbox, Nucleus and the gateway — the exact failure mode capacity.md's
 * "do not go to 8" paragraph describes.
 *
 * The class is a FACT OF THE RECORDED INPUT, never a live read: it is derived
 * where the overrides are derived (`sandboxOverridesOf`, the single funnel
 * every workspace creation goes through), so a replay asks for exactly the
 * class the original run asked for and no step or byte of the log changes.
 *
 * Pure: no I/O, no clock, no config. The conservative direction everywhere is
 * OVER-reserve: a browser run held briefly by a cautious ceiling queues; a
 * browser run admitted onto memory the floor never counted kills a box.
 */
import { PER_RUN_MB } from "./host-load.js";

/** What a run is, resource-wise. Everything that is not "browser" is "plain". */
export type ResourceClass = "plain" | "browser";

/**
 * Extra memory a browser run costs over a plain one, in MB.
 *
 * 512 is the top of the measured ~300-500 MB browser overhead, rounded up to
 * the quantum teploy-sandbox itself uses for the browser's shared memory
 * (SBX_SHM_MB defaults to 512 because "Chromium needs 512 MB or more" —
 * evals/receipts/2026-10-14-egress-proxy-browser-proof.txt, which ran a real
 * Chromium through the run container's limits). The PLAIN run underneath is
 * PER_RUN_MB from docs/capacity.md (measured 350-400 MB, taken as 400).
 * Rounding up rather than to the middle is the conservative direction: the
 * delta is a reservation, and under-reserving is the bug this module exists
 * to fix.
 */
export const BROWSER_MEMORY_DELTA_MB = 512;

/** The class of a run, from the facts its recorded input carries. */
export function resourceClassOf(input: { look?: boolean } | undefined): ResourceClass {
  return input?.look === true ? "browser" : "plain";
}

/** Memory to hold for a run of this class BEYOND what a plain run already costs. */
export function classMemoryDeltaMB(cls: ResourceClass): number {
  return cls === "browser" ? BROWSER_MEMORY_DELTA_MB : 0;
}

/**
 * Host memory one in-flight run of this class commits: the plain per-run cost
 * plus the class delta. This is the number free-memory accounting must
 * subtract per active run, not PER_RUN_MB alone.
 */
export function runHostMemoryMB(cls: ResourceClass): number {
  return PER_RUN_MB + classMemoryDeltaMB(cls);
}

/**
 * The memory LIMIT a create carries for a run of this class: the resolved
 * base (project-pinned or host-derived — identical here) plus the class
 * delta. The delta rides on top of a pinned base too: the browser's footprint
 * does not care who chose the base, and Limits.MemoryMB is a hard container
 * cap on the daemon, so an unraised limit is an OOM mid-```look, not a slower
 * run. Deliberately NOT clamped to SANDBOX_MAX_MEMORY_MB: that cap is for
 * derived defaults, and clamping the class raise would under-reserve the
 * exact runs the class exists for.
 */
export function classAwareMemoryMB(baseMemoryMb: number, cls: ResourceClass): number {
  return baseMemoryMb + classMemoryDeltaMB(cls);
}
