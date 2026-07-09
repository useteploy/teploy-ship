import type { RunMeta } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";

export const config = { mode: "app" };

interface RunsData {
  runs: RunMeta[];
}

export async function loader(): Promise<RunsData> {
  const runtime = await shipRuntime();
  const [runs, places] = await Promise.all([runtime.listMeta(), runtime.placement.all()]);
  for (const r of runs) {
    const host = places[r.runId];
    if (host !== undefined) r.ranOn = host;
  }
  // Most-recent first.
  runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { runs };
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Which filter category a status belongs to (chips filter by category, so
// "active" covers every non-terminal, non-parked state).
function category(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "waiting") return "waiting";
  return "active";
}

// Client-side filter driven by ?status=<category>: hide non-matching rows,
// mark the active chip. Keeps URLs shareable without a loader round-trip.
const FILTER = `
(function(){
  var q=new URLSearchParams(location.search).get("status")||"all";
  document.querySelectorAll("tr[data-cat]").forEach(function(tr){
    tr.style.display=(q==="all"||tr.getAttribute("data-cat")===q)?"":"none";
  });
  document.querySelectorAll(".chips a").forEach(function(a){
    if((a.getAttribute("data-f")||"all")===q)a.classList.add("on");
  });
})();
`;

const CHIPS: Array<{ f: string; label: string }> = [
  { f: "all", label: "All" },
  { f: "active", label: "Active" },
  { f: "waiting", label: "Waiting" },
  { f: "completed", label: "Completed" },
  { f: "failed", label: "Failed" },
  { f: "cancelled", label: "Cancelled" },
];

export default function RunsList({ data }: { data: RunsData }) {
  return (
    <>
      <h1 class="page">Runs</h1>
      <p class="meta">{data.runs.length} run{data.runs.length === 1 ? "" : "s"} total.</p>

      <div class="chips">
        {CHIPS.map((c) => (
          <a key={c.f} href={c.f === "all" ? "/runs" : `/runs?status=${c.f}`} data-f={c.f}>
            {c.label}
          </a>
        ))}
      </div>

      {data.runs.length === 0 ? (
        <p class="empty">No runs yet. Queue one from the <a href="/">Inbox</a>.</p>
      ) : (
        <table class="runs">
          <thead>
            <tr>
              <th>run</th>
              <th>status</th>
              <th>task</th>
              <th>model</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.runId} data-cat={category(run.status)}>
                <td><a href={`/runs/${run.runId}`}>{run.runId}</a></td>
                <td><span class={`status ${run.status}`}>{run.status}</span></td>
                <td>{short(run.task, 80)}</td>
                <td class="meta">{run.model}{run.ranOn !== undefined ? ` · ${run.ranOn}` : ""}</td>
                <td class="meta">{run.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <script dangerouslySetInnerHTML={{ __html: FILTER }} />
      <script dangerouslySetInnerHTML={{ __html: `__shipLive("route:runs/index.tsx");` }} />
    </>
  );
}
