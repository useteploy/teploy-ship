import { RUN_FILTERS, runCategory, filterRuns } from "../../lib/run-filter.js";
import type { RunMeta } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";
import { SubNav } from "../../lib/subnav.js";
import { RUN_VIEWS } from "../../views/run-views.js";
import Reviews from "../../views/reviews.js";
import { loader as reviewsLoader } from "../../views/reviews.server.js";
import type { ReviewsData } from "../../views/reviews.js";

export const config = { mode: "app" };

interface RunsData {
  view: "runs";
  query: string;
  status: string;
  total: number;
  counts: Record<string, number>;
  runs: RunMeta[];
}

export async function loader({ request }: { request: Request }): Promise<RunsData | ReviewsData> {
  if (new URL(request.url).searchParams.get("view") === "reviews") return reviewsLoader();
  const runtime = await shipRuntime();
  const [runs, places] = await Promise.all([runtime.listMeta(), runtime.placement.all()]);
  for (const r of runs) {
    const host = places[r.runId];
    if (host !== undefined) r.ranOn = host;
  }
  // Most-recent first.
  runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  const requested = params.get("status") ?? "all";
  const status = RUN_FILTERS.find(value => value === requested) ?? "all";
  const counts: Record<string, number> = { all: runs.length };
  for (const run of runs) { const key = runCategory(run.status); counts[key] = (counts[key] ?? 0) + 1; }
  return { view: "runs", runs: filterRuns(runs, status, query), total: runs.length, counts, query, status };
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const CHIPS: Array<{ f: string; label: string }> = [
  { f: "all", label: "All" },
  { f: "active", label: "Active" },
  { f: "waiting", label: "Waiting" },
  { f: "completed", label: "Completed" },
  { f: "failed", label: "Failed" },
  { f: "cancelled", label: "Cancelled" },
];

export default function RunsList({ data }: { data: RunsData | ReviewsData }) {
  if (data.view === "reviews") return <Reviews data={data} />;
  return (
    <>
      <div class="page-heading"><div><h1 class="page">Runs</h1><p class="meta">Follow work from the first step to the pull request.</p></div><a class="button primary" href="/#new-task">New task +</a></div>
      <SubNav items={RUN_VIEWS} current="runs" />
      <div class="run-toolbar">
        <div class="chips" role="group" aria-label="Filter runs by status">{CHIPS.map(c => <a key={c.f} class={c.f === data.status ? "on" : undefined} aria-current={c.f === data.status ? "page" : undefined} href={`/runs?status=${c.f}${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`}>{c.label} <span class="count">{data.counts[c.f] ?? 0}</span></a>)}</div>
        <form method="get" class="row-actions" role="search"><input type="hidden" name="status" value={data.status} /><input type="search" name="q" aria-label="Search runs" placeholder="Search tasks, run IDs, or models" value={data.query} /><button type="submit">Search</button></form>
      </div>
      <p class="meta">Showing {data.runs.length} of {data.total} runs{data.query ? ` matching “${data.query}”` : ""}. {(data.query || data.status !== "all") && <a href="/runs">Clear filters</a>}</p>
      {data.runs.length === 0 ? (
        <div class="empty"><h3>{data.total ? "No matching runs" : "Your first task starts here"}</h3><p>{data.total ? <a href="/runs">Clear filters to see all runs</a> : <a href="/#new-task">Describe a task in your inbox →</a>}</p></div>
      ) : (
        <div class="table-wrap">
        <table class="runs">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>model</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.runId}>
                <td class="run-task"><a class="run-title" href={`/runs/${run.runId}`}>{short(run.task, 140)}</a><span class="run-id">{run.runId}</span></td>
                <td><span class={`status ${run.status}`}>{run.status}</span></td>
                <td class="meta">{run.model}{run.ranOn !== undefined ? ` · ${run.ranOn}` : ""}</td>
                <td class="meta run-updated"><time dateTime={run.updatedAt} title={run.updatedAt}>{run.updatedAt.slice(0, 16).replace("T", " ")} UTC</time></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <script dangerouslySetInnerHTML={{ __html: `__shipLive("route:runs/index.tsx");` }} />
    </>
  );
}
