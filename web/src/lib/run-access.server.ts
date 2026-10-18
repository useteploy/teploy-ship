import { roleAllows } from "teploy-ship/runtime";
import type { Principal } from "./session.server.js";

/**
 * May this principal view this run and everything bound to it (its
 * recordings and screenshots on the artifact route)? THE one place that
 * answers it. Roles are deployment-wide today, so every signed-in viewer may
 * view every run; when per-project membership exists, it changes here and
 * nowhere else.
 */
export async function mayViewRun(user: Principal, _runId: string): Promise<boolean> {
  return roleAllows(user.role, "viewer");
}

/**
 * May this principal download this artifact? A bound artifact follows its
 * run; one without a run binding predates it and is admin-only, fail-closed.
 * The route answers 404 either way, so a refusal does not confirm the id.
 */
export async function mayViewArtifact(
  user: Principal,
  artifact: { runId?: string },
  mayView: (user: Principal, runId: string) => Promise<boolean> = mayViewRun,
): Promise<boolean> {
  if (artifact.runId === undefined) return user.role === "admin";
  return mayView(user, artifact.runId);
}
