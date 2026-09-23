import { randomUUID } from "node:crypto";

import { actorFromPrincipal } from "../lib/ship.server.js";
import { defaultModel, shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { redirect } from "../lib/http.server.js";
import {
  createCoordination,
  launchNext,
  listCoordinations,
  observeCoordination,
  retryCoordinationChild,
} from "../../../dist/coordination.js";
import type { CoordinationChild, CoordinationRecord } from "../../../dist/coordination.js";

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
  coordinations: Array<{ record: CoordinationRecord; api: ChildView; client: ChildView }>;
  canApprove: boolean;
  created: string | null;
  error: string | null;
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
  // sweep and the retry action are the only things that enqueue.
  const coordinations = [] as CoordinationData["coordinations"];
  for (const record of records) {
    const fresh = await observeCoordination(runtime, record);
    coordinations.push({
      record: fresh,
      api: childView(fresh, "api"),
      client: childView(fresh, "client"),
    });
  }
  return { coordinations, canApprove, created: query.get("created"), error: query.get("error"), denied: query.get("denied") === "1", model: defaultModel() };
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
            : `Merged — the pair landed. Delivery approval happens on the Deliveries surface.${run}`,
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
            <textarea id="parentIntent" name="parentIntent" rows="3" required maxLength={20000} placeholder="For example: add the /v2/quotes endpoint and surface it in the app" />
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
          {data.coordinations.map(({ record, api, client }) => (
            <article class="card" key={record.id}>
              <div class="row-actions">
                <strong>{record.parentIntent.length > 120 ? `${record.parentIntent.slice(0, 120)}…` : record.parentIntent}</strong>
                <span class="spacer" style="flex:1" />
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
            </article>
          ))}
        </section>
      )}
      <p class="meta">Ordering is fixed: API first, client second, gated on the API change's merge. A failed API side holds the client; a failed client never rolls back merged API work.</p>
    </>
  );
}
