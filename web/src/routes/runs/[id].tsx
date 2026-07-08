import { cancelRun, deliverEvent } from "@neutron-build/workflow";

import type { RunMeta } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";
import { itemClass, toTimeline } from "../../lib/timeline.js";
import type { TimelineItem } from "../../lib/timeline.js";

export const config = { mode: "app" };

interface RunData {
  meta: RunMeta | null;
  items: TimelineItem[];
  runId: string;
  eventCount: number;
}

export async function loader({ params }: { params: { id: string } }): Promise<RunData> {
  const runtime = await shipRuntime();
  const runId = params.id;
  const [meta, events] = await Promise.all([runtime.loadMeta(runId), runtime.store.load(runId)]);
  return { meta, items: toTimeline(events), runId, eventCount: events.length };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const runtime = await shipRuntime();
  const runId = params.id;
  const meta = await runtime.loadMeta(runId);
  const active = meta !== null && !["completed", "failed", "cancelled"].includes(meta.status);
  if (active && intent === "cancel") {
    await cancelRun(runtime.store, runId, "cancelled from the dashboard").catch(() => {});
    await runtime.markWake?.(runId);
    await runtime.saveMeta({ ...meta, status: "cancelled", updatedAt: new Date().toISOString() });
    return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
  }
  if (meta?.eventName !== undefined && (intent === "approve" || intent === "deny")) {
    const reason = String(form.get("reason") ?? "").trim();
    await deliverEvent(runtime.store, runId, meta.eventName, {
      approved: intent === "approve",
      ...(reason !== "" ? { reason } : {}),
    });
    // Make the run due; the resident worker carries it from here. The web
    // process never executes the agent.
    await runtime.markWake?.(runId);
    await runtime.saveMeta({ ...meta, status: "wake", updatedAt: new Date().toISOString() });
  }
  return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
}

// Poll via the framework's loader-data protocol (X-Neutron-Data): re-runs
// this route's loader and returns its data as JSON. Any change in the
// serialized data (new events, status flip) reloads the page.
const POLL = `
(function () {
  var root = document.getElementById("run-root");
  if (!root) return;
  var status = root.getAttribute("data-run-status");
  if (status === "completed" || status === "failed" || status === "cancelled") return;
  var last = null;
  setInterval(function () {
    fetch(location.pathname, {
      headers: { "X-Neutron-Data": "true", "X-Neutron-Routes": "route:runs/[id].tsx" },
    })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (text === null) return;
        if (last === null) { last = text; return; }
        if (text !== last) location.reload();
      })
      .catch(function () {});
  }, 3000);
})();
`;

export default function RunDetail({ data }: { data: RunData }) {
  const active = data.meta !== null && !["completed", "failed", "cancelled"].includes(data.meta.status);
  return (
    <div id="run-root" data-event-count={String(data.eventCount)} data-run-status={data.meta?.status ?? "unknown"}>
      <h1 class="page">
        <a href="/runs">runs</a> / {data.runId}
      </h1>
      {data.meta === null ? (
        <p class="empty">Unknown run.</p>
      ) : (
        <>
          <p class="meta">
            <span class={`status ${data.meta.status}`}>{data.meta.status}</span> · {data.meta.model} · updated{" "}
            {data.meta.updatedAt}
          </p>
          {(data.meta.eventName !== undefined || active) && (
            <form class="decide" method="post">
              <input type="hidden" name="reason" value="" />
              {data.meta.eventName !== undefined && (
                <>
                  <button class="approve" type="submit" name="intent" value="approve">
                    Approve
                  </button>
                  <button class="deny" type="submit" name="intent" value="deny">
                    Deny
                  </button>
                </>
              )}
              {active && (
                <button class="deny" type="submit" name="intent" value="cancel">
                  Cancel run
                </button>
              )}
            </form>
          )}
          <ul class="timeline">
            {data.items.map((item, i) => (
              <li key={i} class={itemClass(item.kind)}>
                <div class="kind">
                  {item.title} <span style="float: right">{item.at}</span>
                </div>
                {item.body !== "" && <pre>{item.body}</pre>}
              </li>
            ))}
          </ul>
          {active && <script dangerouslySetInnerHTML={{ __html: POLL }} />}
        </>
      )}
    </div>
  );
}
