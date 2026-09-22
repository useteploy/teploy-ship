import { pendingLaunches, retryAcceptedLaunch, safeForDisplay } from "../lib/launch-recovery.server.js";
import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { redirect } from "../lib/http.server.js";
export const config = { mode: "app" };
export async function loader({ request }: { request: Request }) {
  if (!(await may("approve", await currentUser(request)))) throw new Response("Not permitted", { status: 403 });
  const runtime = await shipRuntime();
  const query = new URL(request.url).searchParams;
  const page = runtime.launches ? await pendingLaunches(runtime.launches, query.get("after") ?? undefined) : { rows: [] };
  return { ...page, error: query.get("error"), enabled: !!runtime.launches };
}
export async function action({ request }: { request: Request }): Promise<Response> {
  if (!(await may("approve", await currentUser(request)))) return new Response("Not permitted", { status: 403 });
  const runtime = await shipRuntime();
  const form = await request.formData();
  const runId = String(form.get("runId") ?? "");
  try {
    if (!runtime.launches) throw new Error("Launch journal is unavailable");
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
    </article>)}
    {data.next && <a href={`/recovery?after=${encodeURIComponent(data.next)}`}>Next pending launches →</a>}
    <p class="meta">A persistent conflict needs investigation of the original decision. Recovery does not abandon accepted tasks, restart completed runs, or resolve unknown forge and deployment outcomes.</p>
  </>;
}
