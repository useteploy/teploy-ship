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
