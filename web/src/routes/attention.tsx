import { attentionRows } from "../lib/attention.server.js";
import type { AttentionRow } from "../lib/attention.server.js";
import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface Data {
  rows: AttentionRow[];
  truncated: boolean;
}

export async function loader(): Promise<Data> {
  const runtime = await shipRuntime();
  return attentionRows(runtime);
}

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

export default function Attention({ data }: { data: Data }) {
  return (
    <>
      <div class="page-heading">
        <div>
          <h1 class="page">
            Attention{" "}
            {data.rows.length > 0 && (
              <span class="count">({data.rows.length})</span>
            )}
          </h1>
          <p class="meta">
            Only what needs a human: decisions, fresh failures, held
            promotions, stopped or failing schedules, lapsed takeovers, work
            going stale. Everything else lives on the page that owns it.
          </p>
        </div>
      </div>
      {data.rows.length === 0 ? (
        <p class="empty">Nothing needs a human right now.</p>
      ) : (
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
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={r.href}>{r.title}</a>
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
      )}
      {data.truncated && (
        <p class="meta">
          Showing the first {data.rows.length} items — older or lower-priority
          rows exist on the pages they link to.
        </p>
      )}
    </>
  );
}
