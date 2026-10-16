import { dirname } from "node:path";

import { budgetReservationMode } from "./budget-gate.js";
import { placementMode, placementShadowFile } from "./placement-shadow.js";
import { shadowFile, shadowFlagOn } from "./policy-shadow.js";
import { chownHint, probeDirWritable, uidOf } from "./record-writes.js";
import type { DirProbe } from "./record-writes.js";
import { stateDir } from "./run-store.js";
import { toolManifestMode, toolManifestShadowFile } from "./tool-manifest-shadow.js";

/**
 * The directories file-backed shadows write into: the data (state) dir always,
 * plus the directory of each enabled shadow's record file (which an override
 * may point elsewhere). Deduplicated, in a stable order.
 */
export function recordDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [stateDir()];
  if (shadowFlagOn(env)) dirs.push(dirname(shadowFile(env)));
  if (placementMode(env) === "shadow") dirs.push(dirname(placementShadowFile(env)));
  if (toolManifestMode(env) !== "off") dirs.push(dirname(toolManifestShadowFile(env)));
  // The budget ledger and file-mode knowledge records live under the state dir itself.
  if (budgetReservationMode(env).mode !== "off") dirs.push(stateDir());
  return [...new Set(dirs)];
}

let checked: Promise<DirProbe[]> | undefined;

/**
 * Worker and web startup: probe each record dir for writability and say so
 * loudly when one is not. Never throws and never stops the process (existing
 * behaviour holds); it exists so a root-owned volume is visible on the first
 * log line instead of after twelve days of empty shadows. Once per process.
 */
export function checkRecordDirsAtStartup(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<DirProbe[]> {
  checked ??= (async (): Promise<DirProbe[]> => {
    // The WHOLE body is inside the try, recordDirs(env) included: the cli
    // awaits this (a throw would abort worker startup) and web only voids it
    // (a throw would surface as an unhandled rejection). An env that cannot
    // even be parsed into dirs probes nothing, says so once, and the process
    // keeps running.
    try {
      const out: DirProbe[] = [];
      for (const dir of recordDirs(env)) {
        try {
          const p = await probeDirWritable(dir);
          out.push(p);
          if (p.status === "not-writable") {
            log(
              `[ship] ERROR: data dir ${dir} is not writable by uid ${uidOf()} (${p.code ?? "EACCES"}); ` +
                `file-backed shadows and records written here (policy, placement, tool-manifest, budget ledger) will record NOTHING. ` +
                `Fix: ${chownHint(dir)}. Ship keeps running.`,
            );
          } else if (p.status === "unknown") {
            log(`[ship] warning: could not tell whether data dir ${dir} is writable (${p.code ?? "unknown"}); run \`teploy-ship doctor\`.`);
          }
        } catch {
          out.push({ dir, status: "unknown" });
        }
      }
      return out;
    } catch (error) {
      log(
        `[ship] warning: could not determine the record directories to probe (${error instanceof Error ? error.message : String(error)}); ` +
          `run \`teploy-ship doctor\`. Ship keeps running.`,
      );
      return [];
    }
  })();
  return checked;
}

/** Test seam: forget the once-per-process result. */
export function resetRecordDirCheck(): void {
  checked = undefined;
}
