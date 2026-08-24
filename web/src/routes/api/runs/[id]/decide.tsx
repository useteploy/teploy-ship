import type { ActionArgs } from "@neutron-build/core";

import { deliverEvent } from "../../../../lib/ship.server.js";

import { PLAN_EVENT } from "teploy-ship/plan";

import { currentUser, roleAllows } from "../../../../lib/session.server.js";
import { shipRuntime } from "../../../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * Machine-callable approve/deny for a parked run.
 *
 * The dashboard already has this as an HTML form on runs/[id].tsx. That is the
 * right surface for a person and the wrong one for a program: a caller would
 * have to post form-encoded fields and parse a 302. This route is the same
 * decision expressed for a program — JSON in, JSON out, and a real status code
 * when the decision cannot be applied.
 *
 * It deliberately reuses the identical primitive the form uses —
 * deliverEvent → markWake → saveMeta — rather than reimplementing the resume.
 * Two code paths that both resume a durable run would have to be kept in step
 * forever, and the one used less often would rot.
 *
 * Auth is the existing bearer credential (`Authorization: Bearer
 * <SHIP_WEB_TOKEN>`), already documented in session.server.ts as the API path.
 * Deciding is a write, so it needs the editor role.
 *
 * The race this route has to refuse: a consumer (an approvals queue in a
 * workspace, say) learned about a park from a webhook, the run then parked again
 * on a DIFFERENT action, and the stale approval arrives. Delivering it would
 * approve something nobody looked at. So a caller may pin `event_name`, and a
 * mismatch is a 409 rather than a silent misapplication.
 *
 * The run id is a path param. It briefly was not: Neutron only ran the LAST
 * segment of a route through its param rule, so a `[id]` DIRECTORY was emitted
 * as a literal and every real call 404'd with no build error. Fixed in
 * @neutron-build/core 0.1.8, which also made that class of broken route table a
 * build error rather than a 404 found in production. This route requires that
 * version — see the floor in web/package.json.
 */
interface DecideBody {
  approved?: boolean;
  reason?: string;
  /** Optional operator-edited plan, honoured only on a plan approval. */
  plan?: string;
  /**
   * The park this decision is for. REQUIRED: a decision that names no target
   * is a decision applied to whatever happens to be waiting, and this endpoint
   * approves remote code execution. A mismatch (or a run that has moved on) is
   * a 409 naming the current event, so a caller can re-review and retry.
   */
  event_name?: string;
}

export async function action({ request, params }: ActionArgs): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed — POST only" });
  }

  const principal = await currentUser(request);
  if (principal === null) {
    return json(401, { error: "unauthorized — send Authorization: Bearer <SHIP_WEB_TOKEN>" });
  }
  if (!roleAllows(principal.role, "editor")) {
    return json(403, { error: `role ${principal.role} may not decide runs` });
  }

  let body: DecideBody;
  try {
    body = (await request.json()) as DecideBody;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  if (typeof body.approved !== "boolean") {
    // Not defaulted: a missing field must never be read as "approved".
    return json(400, { error: '"approved" is required and must be a boolean' });
  }
  const runId = (params.id ?? "").trim();
  if (runId === "") {
    return json(400, { error: "missing run id in the path" });
  }

  const runtime = await shipRuntime();
  const meta = await runtime.loadMeta(runId);
  if (meta === null) {
    return json(404, { error: `unknown run: ${runId}` });
  }
  if (meta.eventName === undefined) {
    // Already decided, or never waiting. Distinguished from success because a
    // caller that treats this as "done" would show an approval as applied when
    // nothing happened.
    return json(409, { error: `run ${runId} is not waiting for a decision`, status: meta.status });
  }
  if (typeof body.event_name !== "string" || body.event_name.trim() === "") {
    return json(400, {
      error: '"event_name" is required — name the decision you reviewed',
      waiting_on: meta.eventName,
    });
  }
  if (body.event_name !== meta.eventName) {
    return json(409, {
      error: "this run has moved on to a different decision since you saw it",
      expected: body.event_name,
      waiting_on: meta.eventName,
    });
  }

  const reason = (body.reason ?? "").trim();
  // A plan may be redirected by editing it; honoured only on a plan approval,
  // matching the form's behaviour exactly.
  const plan = meta.eventName === PLAN_EVENT ? (body.plan ?? "").trim() : "";

  // Atomic claim before delivery: two callers deciding the same park must not
  // both deliver, and the loser must be told rather than shown a success it
  // did not cause.
  if (!(await runtime.claimDecision(runId, body.event_name))) {
    return json(409, { error: "another decision for this park was applied first", waiting_on: meta.eventName });
  }
  try {
    await deliverEvent(runtime.store, runId, body.event_name, {
      approved: body.approved,
      ...(reason !== "" ? { reason } : {}),
      ...(plan !== "" ? { plan } : {}),
    });
  } catch (error) {
    await runtime.releaseDecision(runId, body.event_name).catch(() => {});
    throw error;
  }
  // Make the run due; the resident worker carries it from here. This process
  // never executes the agent. (The claim already recorded the status change.)
  await runtime.markWake?.(runId);

  return json(200, {
    ok: true,
    run_id: runId,
    decision: body.approved ? "approved" : "denied",
    delivered_to: body.event_name,
    status: "wake",
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A route with only an action still needs a default export, or the router does
// not register it and every request 404s — no build error, no warning, just a
// missing route. Same stub the webhook receivers use (hooks/forgejo.tsx).
// Nothing ever renders it: this path is POST-only and returns JSON.
export default function Never() {
  return null;
}
