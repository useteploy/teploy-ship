import { deployPreview, previewTargetFromEnv } from "./deploy.js";
import { commentOnPr, readPullRequestBody, updatePullRequestBody } from "./git.js";
import type { RepoRef } from "./git.js";
import { compareAroundNow, telemetryTargetFromEnv } from "./observe.js";
import { spliceVerification, verificationSection } from "./verification.js";
import type { Evidence } from "./verification.js";
import type { parseArgs } from "./args.js";

/** An operator env flag, same words envFlag accepts in runtime.ts. */
export function envAsked(name: string): boolean {
  const raw = (process.env[name] ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Put the run's evidence in the pull request body, the way the worker does.
 *
 * Every piece of this is the durable path's own code — testTargetFromEnv,
 * deployPreview, compareAroundNow, verificationSection — called directly rather
 * than reimplemented. `fix` had none of it, so its pull request body was
 * `result.summary` and nothing else: the agent's own account of its own work,
 * which is exactly the claim FINISH_NUDGE_VERIFY exists because models get
 * wrong. The durable path stopped trusting it; this one still did.
 *
 * Two rules carried over deliberately. Nothing here can fail the run — the work
 * is already pushed and the PR is already open, so a failed preview or an
 * unreachable Observe must not turn a delivered fix into a non-zero exit. And a
 * surface wired for none of it adds NOTHING to the body, because printing "not
 * deployed, not measured, not tested" on every pull request trains a reviewer
 * to skip the section that sometimes carries the real thing.
 *
 * The preview is the one that needs an explicit ask on top of its config, and
 * it is the only one that changes the world: it shells the teploy CLI with
 * credentials that reach real servers. Reading telemetry and running a suite
 * are safe to infer from configuration; deploying is not.
 */
export async function attachEvidence(opts: {
  ref: RepoRef;
  token: string;
  pr: number;
  branch: string;
  runId: string;
  evidence: Evidence;
  args: ReturnType<typeof parseArgs>;
  /** Injected in tests; the real calls go through git.ts's default fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests, so a unit test never shells out to the deploy CLI. */
  deploy?: typeof deployPreview;
}): Promise<void> {
  const { ref, token, pr, branch, runId, evidence, args, fetchImpl } = opts;
  const doDeploy = opts.deploy ?? deployPreview;
  try {
    if (args.flags.preview === true || envAsked("SHIP_PREVIEW")) {
      const target = previewTargetFromEnv();
      if (target !== undefined) {
        evidence.preview = await doDeploy(target, branch).catch((error) => ({
          kind: "failed" as const,
          reason: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    // Configuration is consent here: a read is safe, so OBSERVE_* being set is
    // the ask. `--telemetry` and SHIP_TELEMETRY remain accepted so the same
    // invocation works against a worker, but neither is required.
    const telemetry = telemetryTargetFromEnv();
    if (telemetry !== undefined) {
      evidence.telemetry = await compareAroundNow(telemetry, new Date()).catch((error) => ({
        kind: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
    }

    const section = verificationSection(evidence, runId);
    if (section === null) return;
    const current = await readPullRequestBody({ ref, token, pr, ...(fetchImpl !== undefined ? { fetchImpl } : {}) });
    if (current !== null) {
      const updated = await updatePullRequestBody({
        ref,
        token,
        pr,
        body: spliceVerification(current, section),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      if (updated) return;
    }
    await commentOnPr(ref, token, pr, section, fetchImpl).catch(() => {});
  } catch {
    // The fix is pushed and the PR is open. Evidence is an improvement on that,
    // never a precondition for it.
  }
}
