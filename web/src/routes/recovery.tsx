import { abandonAcceptedLaunch, launchDispositions, pendingLaunches, retryAcceptedLaunch, safeForDisplay } from "../lib/launch-recovery.server.js";
import { shipRuntime } from "../lib/store.server.js";
import { actorFromPrincipal } from "../lib/ship.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { redirect } from "../lib/http.server.js";
export const config = { mode: "app" };
export async function loader({ request }: { request: Request }) {
  if (!(await may("approve", await currentUser(request)))) throw new Response("Not permitted", { status: 403 });
  const runtime = await shipRuntime();
  const query = new URL(request.url).searchParams;
  const page = runtime.launches ? await pendingLaunches(runtime.launches, query.get("after") ?? undefined) : { rows: [] };
  // Disposition-load errors SURFACE (audit finding 2026-09-22): an audit
  // table that silently disappears is indistinguishable from "nothing was
  // ever abandoned" — the one thing this page must never imply.
  let abandoned: Awaited<ReturnType<typeof launchDispositions>> = [];
  let dispositionsError: string | undefined;
  if (runtime.launches) {
    try {
      abandoned = await launchDispositions(runtime.launches);
    } catch (error) {
      dispositionsError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ...page, abandoned, ...(dispositionsError !== undefined ? { dispositionsError } : {}), error: query.get("error"), enabled: !!runtime.launches };
}
export async function action({ request }: { request: Request }): Promise<Response> {
  if (!(await may("approve", await currentUser(request)))) return new Response("Not permitted", { status: 403 });
  const runtime = await shipRuntime();
  const form = await request.formData();
  const runId = String(form.get("runId") ?? "");
  try {
    if (!runtime.launches) throw new Error("Launch journal is unavailable");
    if (form.get("intent") === "abandon") {
      const principal = await currentUser(request);
      if (principal === null) return new Response("Not permitted", { status: 403 });
      await abandonAcceptedLaunch(runtime.launches, runId, {
        actor: actorFromPrincipal(principal).id,
        reason: String(form.get("reason") ?? ""),
      });
      return redirect(`/recovery`);
    }
    await retryAcceptedLaunch(runtime.launches, runId);
    return redirect(`/runs/${encodeURIComponent(runId)}`);
  } catch (error) {
    const detail = safeForDisplay(error instanceof Error ? error.message : String(error), 600);
    return redirect(`/recovery?error=${encodeURIComponent(detail)}`);
  }
}
export default function Recovery({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return <>
    <header class="page-head"><h1>Launch recovery</h1><a href="/">Back to Inbox</a></header>
    <p class="meta">Accepted tasks waiting to become visible runs. The worker retries these automatically. Retrying here keeps the original task and approvals; it cannot override a competing review decision.</p>
    {data.error && <p class="notice bad" role="alert">{data.error}</p>}
    {!data.enabled && <p class="notice">This deployment has no launch journal.</p>}
    {data.enabled && data.rows.length === 0 && <p class="empty">No pending accepted launches on this page.</p>}
    {data.rows.map(row => <article class="card" key={row.runId}>
      <h2>{row.summary ?? "Launch needs inspection"}</h2><p class="meta"><code>{row.runId}</code></p>
      {row.reviewParent && <p><a href={`/runs/${encodeURIComponent(row.reviewParent)}`}>Inspect the original review decision →</a></p>}
      {row.error && <p class="notice bad">{row.error}</p>}
      <form method="post"><input type="hidden" name="runId" value={row.runId}/><button type="submit">Retry accepted launch</button></form>
      <details class="disclosure" style="margin-top:10px">
        <summary>Abandon this accepted launch</summary>
        <p class="meta">For intents that can never publish (a conflicting history or a competing review claim). The record and reason are kept, nothing is resubmitted automatically, and no review claim is reopened. If the work is still wanted, submit it as a new request.</p>
        <form method="post" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
          <input type="hidden" name="runId" value={row.runId}/>
          <input type="hidden" name="intent" value="abandon"/>
          <label class="meta" for={`reason-${row.runId}`}>Reason (audited)</label>
          <textarea id={`reason-${row.runId}`} name="reason" rows={2} style="flex:1;min-width:240px" placeholder="Why this accepted launch can never publish" required minLength={8}></textarea>
          <button type="submit" class="sm">Abandon</button>
        </form>
      </details>
    </article>)}
    {data.next && <a href={`/recovery?after=${encodeURIComponent(data.next)}`}>Next pending launches →</a>}
    {data.dispositionsError !== undefined && (
      <p class="notice bad" role="alert">Abandoned-launch audit is unreadable right now: {data.dispositionsError}</p>
    )}
    {data.abandoned.length > 0 && (
      <section style="margin-top:24px">
        <h2>Abandoned launches (audit)</h2>
        <table>
          <tbody>
            {data.abandoned.map(d => <tr key={d.runId}>
              <td><code>{d.runId}</code></td>
              <td class="meta">{new Date(d.at).toISOString().slice(0, 19).replace("T", " ")}</td>
              <td class="meta">{d.actor}</td>
              <td>{d.reason}</td>
            </tr>)}
          </tbody>
        </table>
        <p class="meta">Abandoned records are retained, never deleted. Re-doing the work means a new request through normal intake.</p>
      </section>
    )}
    <p class="meta">A persistent conflict needs investigation of the original decision. Recovery does not delete accepted tasks, restart completed runs, or resolve unknown forge and deployment outcomes.</p>
  </>;
}
