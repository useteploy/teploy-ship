import { liveViewEnabled, readLiveView } from "../../../dist/live-view.js";
import type { LiveViewState } from "../../../dist/live-view.js";
import type { ShipRuntime } from "teploy-ship/runtime";

import { currentUser, requiredRole, roleAllows, type Principal } from "./session.server.js";
import { shipRuntime } from "./store.server.js";

export { liveViewEnabled };

type Deps = {
  principal: (request: Request) => Promise<Principal | null>;
  runtime: () => Promise<Pick<ShipRuntime, "config" | "loadMeta">>;
  enabled: () => boolean;
};

const DEFAULT_DEPS: Deps = {
  principal: currentUser,
  runtime: shipRuntime,
  enabled: () => liveViewEnabled(),
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "cancelling"]);

export type LiveViewBody = LiveViewState & { active: boolean; servedAt: string };

/**
 * GET /api/runs/<id>/live — the live view's read (D5). Access is the run
 * page's, exactly: a signed-in principal whose role clears the same
 * `requiredRole` gate the layout applies to /runs/<id> (viewer). There is no
 * write surface here; the module exports a loader only.
 */
export async function liveViewResponse(request: Request, runId: string, deps: Deps = DEFAULT_DEPS): Promise<Response> {
  const principal = await deps.principal(request);
  if (principal === null) return json(401, { error: "unauthorized" });
  if (!roleAllows(principal.role, requiredRole("GET", `/runs/${runId}`))) return json(403, { error: "forbidden" });
  if (!deps.enabled()) return json(503, { error: "live view is not enabled — set SHIP_LIVE_VIEW=on" });
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) return json(404, { error: "run not found" });
  const runtime = await deps.runtime();
  const meta = await runtime.loadMeta(runId);
  if (meta === null) return json(404, { error: "run not found" });
  const active = !TERMINAL.has(meta.status);
  const state = await readLiveView(runtime.config, runId, { active, by: principal.user });
  const body: LiveViewBody = { ...state, active, servedAt: new Date().toISOString() };
  return json(200, body);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
