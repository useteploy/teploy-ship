import type { ActionArgs } from "@neutron-build/core";

import { actorFromPrincipal } from "../../../../lib/ship.server.js";
import { currentUser } from "../../../../lib/session.server.js";
import { may } from "../../../../lib/authority.server.js";
import { shipRuntime } from "../../../../lib/store.server.js";
import { redirect } from "../../../../lib/http.server.js";

export const config = { mode: "app" };

/**
 * Approve a merged change's delivery (Package B, S14): move its delivery
 * record proposed → approved. This is an authority boundary, not a UI
 * affordance — same shape as the decide route: the `approve` authority
 * grant, a logged-in principal whose actor id is recorded, and the STORE's
 * conditional transition as the concurrency fence (two approvers race; the
 * record tells the loser what won).
 *
 * Approving records an intent with an explicit destination and retained
 * recovery version; it deploys NOTHING by itself. The worker's delivery
 * sweep executes approved records against the trusted working copy, and
 * only when one is configured — otherwise the approval is held with the
 * reason, visibly, until it is.
 */
export async function action({ request, params }: ActionArgs): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed — POST only" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const principal = await currentUser(request);
  if (principal === null) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (!(await may("approve", principal))) {
    return new Response(
      JSON.stringify({ error: `${principal.user} (${principal.role}) may not approve deliveries — the approve authority is not granted` }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  const runId = (params.id ?? "").trim();
  if (runId === "") {
    return new Response(JSON.stringify({ error: "missing run id in the path" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const form = await request.formData();
  const destination = String(form.get("destination") ?? "").trim();
  const recoveryVersion = String(form.get("recoveryVersion") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();

  const runtime = await shipRuntime();
  if (runtime.deliveryRecords === undefined) {
    return redirect(`/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent("this deployment keeps no delivery records")}`);
  }
  if (destination === "" || recoveryVersion === "") {
    return redirect(
      `/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent(
        "a delivery approval names its destination AND the retained recovery version — both are required",
      )}`,
    );
  }
  try {
    const record = await runtime.deliveryRecords.transition(runId, "proposed", "approved", {
      destination,
      recoveryVersion,
      actor: actorFromPrincipal(principal).id,
      policy: "operator-approval",
      ...(reason !== "" ? { reason } : {}),
    });
    if (record.state !== "approved") {
      return redirect(
        `/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent(`this delivery already moved on (state: ${record.state})`)}`,
      );
    }
    return redirect(`/runs/${encodeURIComponent(runId)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return redirect(`/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent(detail.slice(0, 400))}`);
  }
}

// POST-only route: the default export exists so the router registers the
// path (the decide route's lesson — a missing default 404s silently).
export default function Never() {
  return null;
}
