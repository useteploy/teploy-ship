import { randomUUID } from "node:crypto";

import { actorFromPrincipal } from "../lib/ship.server.js";
import { defaultModel, shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { redirect } from "../lib/http.server.js";
import {
  acceptCheckRisk,
  coordinationComplete,
  createCoordination,
  launchNext,
  listCoordinations,
  observeCoordination,
  proposeCheckFixTask,
  retryCoordinationCheck,
  retryCoordinationChild,
  rollupCoordinationCost,
} from "../../../dist/coordination.js";
import type { CoordinationChild, CoordinationCheckState, CoordinationCost, CoordinationRecord } from "../../../dist/coordination.js";

export const config = { mode: "app" };

// Server-only values reach this module through the dist import the way
// ship.server.ts re-exports the others; the types are erased at compile time.

interface ChildView {
  label: "API" | "Client";
  child: CoordinationChild;
  /** What this state MEANS for the pair, in outcome/next-action phrasing. */
  line: string;
  /** Retry is offered to an approver for exactly the states a human owns. */
  retryable: boolean;
}

interface CoordinationData {
  coordinations: Array<{ record: CoordinationRecord; api: ChildView; client: ChildView; cost: CoordinationCost; complete: boolean }>;
  canApprove: boolean;
  created: string | null;
  error: string | null;
  fixProposed: string | null;
  denied: boolean;
  model: string;
}

export async function loader({ request }: { request: Request }): Promise<CoordinationData> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const canApprove = await may("approve", me);
  const query = new URL(request.url).searchParams;
  const records = await listCoordinations(runtime);
  // Observe (never launch) so the page shows what actually happened; the
  // sweep and the retry action are the only things that enqueue. Cost is
  // derived on read from the runs' recorded steps — never stored, so it
  // cannot go stale between a launch and this render.
  const coordinations = [] as CoordinationData["coordinations"];
  for (const record of records) {
    const fresh = await observeCoordination(runtime, record);
    const cost = await rollupCoordinationCost(runtime, fresh);
    coordinations.push({
      record: fresh,
      api: childView(fresh, "api"),
      client: childView(fresh, "client"),
      cost,
      complete: coordinationComplete(fresh),
    });
  }
  return {
    coordinations,
    canApprove,
    created: query.get("created"),
    error: query.get("error"),
    fixProposed: query.get("fix-proposed"),
    denied: query.get("denied") === "1",
    model: defaultModel(),
  };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const runtime = await shipRuntime();
  const me = await currentUser(request);

  // Creating a coordination launches the API child, and a retry launches
  // either child: both authorise code execution and spend, so the `approve`
  // grant decides — the same boundary as launching a proposed task.
  if (!(await may("approve", me))) return redirect("/coordination?denied=1");

  try {
    if (intent === "create") {
      const record = await createCoordination(runtime, {
        parentIntent: String(form.get("parentIntent") ?? ""),
        apiRepo: String(form.get("apiRepo") ?? ""),
        clientRepo: String(form.get("clientRepo") ?? ""),
        model: defaultModel(),
        ...(me !== null ? { actor: actorFromPrincipal(me) } : {}),
      });
      // Start the API child immediately: the submit that created the pair is
      // the approval its first launch runs under.
      await launchNext(runtime, record.id);
      return redirect(`/coordination?created=${encodeURIComponent(record.id)}`);
    }
    if (intent === "retry") {
      const id = String(form.get("coordinationId") ?? "");
      const which = String(form.get("child") ?? "");
      if (which !== "api" && which !== "client") throw new Error("Retry needs the side to retry.");
      await retryCoordinationChild(runtime, id, which);
      return redirect("/coordination");
    }
    // The check's human actions. All three decide or commission work over a
    // verdict the pair is parked on, so they sit under the same approve grant
    // as create/retry: accept-risk waves drift through, re-run spends a new
    // check attempt, and the fix task proposes intake work.
    if (intent === "accept-check") {
      const id = String(form.get("coordinationId") ?? "");
      if (me === null) throw new Error("Accepting check risk needs a signed-in account.");
      await acceptCheckRisk(runtime, id, actorFromPrincipal(me));
      return redirect("/coordination");
    }
    if (intent === "retry-check") {
      const id = String(form.get("coordinationId") ?? "");
      await retryCoordinationCheck(runtime, id);
      return redirect("/coordination");
    }
    if (intent === "fix-task") {
      const id = String(form.get("coordinationId") ?? "");
      const proposed = await proposeCheckFixTask(runtime, id, me !== null ? actorFromPrincipal(me) : undefined);
      return redirect(`/coordination?fix-proposed=${encodeURIComponent(proposed.taskId)}`);
    }
    return new Response("Unknown action", { status: 400 });
  } catch (error) {
    return redirect("/coordination?error=" + encodeURIComponent(error instanceof Error ? error.message : "The coordination action failed"));
  }
}

/** The one-line outcome/next-action text each child state owes the operator. */
function childView(record: CoordinationRecord, which: "api" | "client"): ChildView {
  const child = record[which];
  const label = which === "api" ? "API" : "Client";
  const run = child.runId !== undefined ? ` Run: /runs/${child.runId}.` : "";
  switch (child.state) {
    case "pending":
      return {
        label,
        child,
        retryable: false,
        line:
          which === "api"
            ? `Queued to start — the API change launches on the next sweep.${run}`
            : record.api.state === "merged" || record.api.state === "delivered"
              ? `Ready to start against the merged API commit ${record.api.anchorSha ?? "(unproven)"}.${run}`
              : `Not started — the client task waits until the API change merges, so it never builds against an API that is not there yet.${run}`,
      };
    case "running":
      return {
        label,
        child,
        retryable: false,
        line:
          which === "api"
            ? `In flight — executing or awaiting review. The client task will not start until this change merges.${run}`
            : `In flight, building against merged API commit ${child.anchorSha ?? "(unproven)"}.${run}`,
      };
    case "merged":
      return {
        label,
        child,
        retryable: false,
        line:
          which === "api"
            ? `Merged as ${child.anchorSha ?? "an unproven commit"} — that commit is the compatibility anchor for the client change. Delivery approval happens on the Deliveries surface.${run}`
            : `Merged as ${child.mergedSha ?? "an unproven commit"} — the pair now owes its compatibility check before it can be called done. Delivery approval happens on the Deliveries surface.${run}`,
      };
    case "delivered":
      return {
        label,
        child,
        retryable: false,
        line: `Merged and confirmed delivered — this side is done.${run}`,
      };
    case "failed":
      return {
        label,
        child,
        retryable: true,
        line:
          which === "api"
            ? `Failed before merging (${child.failReason ?? "run failed"}). The client task is held — nothing dependent will start until you retry this side or abandon the coordination.${run}${child.lastError !== undefined ? ` Last launch error: ${child.lastError}` : ""}`
            : `Failed (${child.failReason ?? "run failed"}). The API side's merged work is preserved — nothing rolled back. Retry this side against the same anchor, or leave it.${run}${child.lastError !== undefined ? ` Last launch error: ${child.lastError}` : ""}`,
      };
    case "held":
      return {
        label,
        child,
        retryable: true,
        line: `Held — ${child.holdReason ?? "waiting for a human decision."}${run}`,
      };
  }
}

function statusClass(state: CoordinationChild["state"]): string {
  if (state === "failed") return "failed";
  if (state === "held") return "waiting";
  if (state === "pending") return "queued";
  if (state === "running") return "running";
  return "completed";
}

function checkStatusClass(state: CoordinationCheckState): string {
  if (state === "incompatible") return "failed";
  if (state === "uncertain") return "waiting";
  if (state === "pending") return "queued";
  if (state === "running") return "running";
  return "completed";
}

/**
 * Spend, per the honesty rule: an unpriced run makes the figure UNKNOWN —
 * never $0 (spend.ts P5-3). The known dollars still show beside the flag so
 * a partially-priced pair is not read as either free or fully counted.
 */
function costLine(roll: { costUsd: number; unknown: boolean }): string {
  const known = `$${roll.costUsd.toFixed(4)}`;
  return roll.unknown ? `${known} known · total unknown (unpriced work included)` : known;
}

export default function Coordination({ data }: { data: CoordinationData }) {
  return (
    <>
      <div class="page-heading">
        <div>
          <h1 class="page">Coordination</h1>
          <p class="meta">One parent intent across two repositories: the API change first, the client change against its merged commit.</p>
        </div>
        <a class="button" href="/runs">View all runs →</a>
      </div>
      {data.created && (
        <p class="notice good" role="status">
          Coordination started — the API-side run is queued. The client side will start only after it merges.
        </p>
      )}
      {data.fixProposed && (
        <p class="notice good" role="status">
          Fix task proposed ({data.fixProposed}) — it waits in the intake queue like any other proposed task.
        </p>
      )}
      {data.error && <p class="notice bad" role="alert">{data.error}</p>}
      {data.denied && (
        <p class="notice bad" role="alert">
          Not applied — creating or retrying a coordination launches work and spends budget, and your account may not approve runs. An admin can grant it on <a href="/policies">Policies</a>.
        </p>
      )}
      {data.coordinations.length === 0 && (
        <p class="empty">No coordinated changes yet. Describe one parent intent and the two repositories it spans.</p>
      )}

      {data.canApprove && (
        <section>
          <h2 class="section">New coordinated change</h2>
          <form method="post" class="card" style="display:grid;gap:10px">
            <input type="hidden" name="intent" value="create" />
            <label class="meta" for="parentIntent">Parent intent — what the pair is for</label>
            <textarea id="parentIntent" name="parentIntent" rows={3} required maxLength={20000} placeholder="For example: add the /v2/quotes endpoint and surface it in the app" />
            <label class="meta" for="apiRepo">API repository (merges first)</label>
            <input id="apiRepo" name="apiRepo" type="text" required placeholder="https://forge.example/team/api.git" />
            <label class="meta" for="clientRepo">Client repository (starts after the API change merges)</label>
            <input id="clientRepo" name="clientRepo" type="text" required placeholder="https://forge.example/team/client.git" />
            <p class="meta">Starting this launches the API-side run now ({data.model}) and authorises its spend. The client side is not launched until the API change merges.</p>
            <button type="submit" class="approve">Start coordinated change</button>
          </form>
        </section>
      )}

      {data.coordinations.length > 0 && (
        <section>
          <h2 class="section">
            Coordinated changes <span class="count">({data.coordinations.length})</span>
          </h2>
          {data.coordinations.map(({ record, api, client, cost, complete }) => (
            <article class="card" key={record.id}>
              <div class="row-actions">
                <strong>{record.parentIntent.length > 120 ? `${record.parentIntent.slice(0, 120)}…` : record.parentIntent}</strong>
                <span class="spacer" style="flex:1" />
                {complete && <span class="status completed">complete</span>}
                <span class="chip">{new Date(record.createdAt).toISOString().slice(0, 16).replace("T", " ")}</span>
              </div>
              <div class="summary-grid" style="margin-top:10px">
                {[api, client].map((view) => (
                  <div class="summary-card" key={view.label} style="cursor:default">
                    <div class="row-actions">
                      <strong>{view.label}</strong>
                      <span class={`status ${statusClass(view.child.state)}`}>{view.child.state}</span>
                      {view.child.attempts > 1 && <span class="meta">attempt {view.child.attempts}</span>}
                    </div>
                    <p class="meta" style="margin:6px 0 0;word-break:break-all">{view.child.repo}</p>
                    <p class="meta" style="margin:6px 0 0">{view.line}</p>
                    <p class="meta" style="margin:6px 0 0">
                      Spend: {costLine(view.label === "API" ? cost.api : cost.client)}
                    </p>
                    {view.retryable && data.canApprove && (
                      <form method="post" class="row-actions" style="margin-top:8px">
                        <input type="hidden" name="intent" value="retry" />
                        <input type="hidden" name="coordinationId" value={record.id} />
                        <input type="hidden" name="child" value={view.label === "API" ? "api" : "client"} />
                        <button type="submit" class="approve sm">{view.label === "API" ? "Retry API child" : "Retry client child"}</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
              {record.client.clientCheck !== undefined && (
                <div class="summary-card" style="margin-top:10px;cursor:default">
                  <div class="row-actions">
                    <strong>Compatibility check</strong>
                    <span class={`status ${checkStatusClass(record.client.clientCheck)}`}>{record.client.clientCheck}</span>
                    {(record.client.checkAttempts ?? 0) > 1 && <span class="meta">attempt {record.client.checkAttempts}</span>}
                    <span class="spacer" style="flex:1" />
                    <span class="meta">Spend: {costLine(cost.check)}</span>
                  </div>
                  {record.client.checkRunId !== undefined && (
                    <p class="meta" style="margin:6px 0 0">Run: /runs/{record.client.checkRunId} — read-only scan on the client repo against the API at {record.api.anchorSha ?? "(unproven)"}.</p>
                  )}
                  {record.client.integrationTest !== undefined && (
                    <p class="meta" style="margin:6px 0 0">Integration test: {record.client.integrationTest}</p>
                  )}
                  {record.client.clientCheck === "compatible" && record.client.checkVerdict !== undefined && (
                    <p class="meta" style="margin:6px 0 0">{record.client.checkVerdict.rationale} — the pair's complete shape is reached.</p>
                  )}
                  {(record.client.clientCheck === "incompatible" || record.client.clientCheck === "uncertain") && (
                    <>
                      <p class="meta" style="margin:6px 0 0">
                        {record.client.checkVerdict?.rationale ?? "The check reported a verdict a human must decide on."} The pair is held here — nothing else runs until you accept the risk, re-run the check, or open a fix task.
                      </p>
                      {record.client.checkVerdict?.findings.map((f) => (
                        <p class="meta" style="margin:4px 0 0" key={`${f.file}:${f.line ?? ""}:${f.title}`}>
                          {f.severity} — {f.title} ({f.file}{f.line !== undefined ? `:${f.line}` : ""})
                        </p>
                      ))}
                      {record.client.checkAccepted !== undefined ? (
                        <p class="meta" style="margin:6px 0 0">Risk accepted by {record.client.checkAccepted.by} at {record.client.checkAccepted.at} — the pair is complete on that decision.</p>
                      ) : (
                        data.canApprove && (
                          <div class="row-actions" style="margin-top:8px;gap:8px">
                            <form method="post">
                              <input type="hidden" name="intent" value="accept-check" />
                              <input type="hidden" name="coordinationId" value={record.id} />
                              <button type="submit" class="approve sm">Accept risk</button>
                            </form>
                            <form method="post">
                              <input type="hidden" name="intent" value="retry-check" />
                              <input type="hidden" name="coordinationId" value={record.id} />
                              <button type="submit" class="approve sm">Re-run check</button>
                            </form>
                            <form method="post">
                              <input type="hidden" name="intent" value="fix-task" />
                              <input type="hidden" name="coordinationId" value={record.id} />
                              <button type="submit" class="approve sm">Open a fix task</button>
                            </form>
                          </div>
                        )
                      )}
                    </>
                  )}
                  {record.client.clientCheck === "running" && (
                    <p class="meta" style="margin:6px 0 0">In flight — the verdict lands when the scan settles.</p>
                  )}
                </div>
              )}
              <p class="meta" style="margin:10px 0 0">Total spend: {costLine(cost.total)}</p>
            </article>
          ))}
        </section>
      )}
      <p class="meta">Ordering is fixed: API first, client second, gated on the API change's merge, then a read-only compatibility check gates the pair's completion. A failed API side holds the client; a failed client never rolls back merged API work; an incompatible or uncertain check holds the pair on a human.</p>
    </>
  );
}
