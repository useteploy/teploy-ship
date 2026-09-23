import type { ActionArgs } from "@neutron-build/core";

import { actorFromPrincipal } from "../../../../lib/ship.server.js";
import { currentUser } from "../../../../lib/session.server.js";
import { may } from "../../../../lib/authority.server.js";
import { shipRuntime } from "../../../../lib/store.server.js";
import { redirect } from "../../../../lib/http.server.js";

export const config = { mode: "app" };

/**
 * Request a rollback of a CONFIRMED delivery to its retained recovery
 * version (Package B slice 3): the same authority boundary as the promote
 * route — the `approve` grant, a logged-in principal whose actor id is
 * recorded, a REQUIRED reason. The route records intent only; the worker
 * sweep executes `teploy rollback --to <recoveryVersion>` from the trusted
 * copy and verifies the target by reading it back. Rollback never changes
 * the delivery state — confirmed stays confirmed; the record carries the
 * rollback as separate evidence. Data migrations make any rollback a
 * recovery plan, not a command; the reason field is where the operator
 * says which plan they are following.
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
      JSON.stringify({ error: `${principal.user} (${principal.role}) may not request rollbacks — the approve authority is not granted` }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  const runId = (params.id ?? "").trim();
  if (runId === "") {
    return new Response(JSON.stringify({ error: "missing run id in the path" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const form = await request.formData();
  const reason = String(form.get("rollbackReason") ?? "").trim();

  const runtime = await shipRuntime();
  if (runtime.deliveryRecords === undefined) {
    return redirect(`/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent("this deployment keeps no delivery records")}`);
  }
  if (reason === "") {
    return redirect(
      `/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent("a rollback names its reason — the recovery plan being followed")}`,
    );
  }
  try {
    const record = await runtime.deliveryRecords.requestRollback(runId, actorFromPrincipal(principal).id, reason);
    if (record.rollback?.state !== "requested") {
      return redirect(
        `/runs/${encodeURIComponent(runId)}?deliveryError=${encodeURIComponent(`this rollback could not be requested (state: ${record.rollback?.state ?? "none"})`)}`,
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
