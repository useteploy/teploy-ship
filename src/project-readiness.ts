import { createHash } from "node:crypto";
import type { Project } from "./projects.js";
/** Only project configuration is attested; worker credential/runtime changes require a new verification. */
export function projectReadinessKey(project: Project): string {
  const fields = {
    repo: project.url ?? project.repo,
    image: project.sandboxImage ?? null,
    network: project.sandboxNetwork ?? null,
    egress: [...(project.sandboxEgressAllow ?? [])].sort(),
    limits: project.sandboxLimits ?? null,
    harness: project.harness ?? null,
    preparation: project.preparation ?? null,
    tests: project.verification?.tests ?? project.testCommand ?? null,
    verification: project.verification ?? null,
  };
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(fields))).digest("hex");
}
/**
 * What an environment-check run records about its readiness basis: the config
 * key above, always, and (S05/S06, SHIP_STACK_DETECT on) the digest of the
 * manifests, lockfiles and proposed recipe a person looked at, ADDITIVELY. The
 * key itself is untouched, so existing runs and the stale check keep their
 * meaning; the digest is recorded, not yet compared (see AUDIT_OPEN S05).
 */
export function projectReadinessRecord(
  project: Project | null | undefined,
  inputsDigest: string | undefined,
  enabled: boolean,
): { environmentConfigId?: string; environmentInputsDigest?: string } {
  return {
    ...(project ? { environmentConfigId: projectReadinessKey(project) } : {}),
    ...(enabled && inputsDigest !== undefined && /^[0-9a-f]{64}$/.test(inputsDigest) ? { environmentInputsDigest: inputsDigest } : {}),
  };
}
