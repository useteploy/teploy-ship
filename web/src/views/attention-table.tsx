import type { AttentionRow } from "../lib/attention-row.js";

/** Kind to the shared status-chip styling: each kind reads at a glance. */
function kindClass(kind: AttentionRow["kind"]): string {
  switch (kind) {
    case "decision":
      return "waiting";
    case "failure":
      return "failed";
    case "delivery":
      return "waiting";
    case "schedule":
      return "cancelled";
    case "takeover":
      return "waiting";
    case "aging":
      return "cancelled";
  }
}

export function AttentionTable({ rows, truncated }: { rows: AttentionRow[]; truncated: boolean }) {
  return (
    <>
      <div class="table-wrap">
          <table class="runs">
            <thead>
              <tr>
                <th>What</th>
                <th>Kind</th>
                <th>Why it needs you</th>
                <th>Next</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={r.href}>{r.title}</a>
                    {r.repo !== undefined && <span class="run-repo" title={r.repo}>{r.repo}</span>}
                  </td>
                  <td>
                    <span class={`status ${kindClass(r.kind)}`}>{r.kind}</span>
                    {r.aging && (
                      <>
                        {" "}
                        <span class="status waiting">aging</span>
                      </>
                    )}
                  </td>
                  <td>{r.detail}</td>
                  <td>{r.nextAction}</td>
                  <td>{r.at !== undefined ? new Date(r.at).toISOString().slice(0, 16).replace("T", " ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </div>
      {truncated && (
        <p class="meta">
          Showing the first {rows.length} items. Older or lower-priority rows are on the pages they link to.
        </p>
      )}
    </>
  );
}
