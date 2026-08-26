import type { WorkerInfo } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";
import { SubNav } from "../lib/subnav.js";
import { FLEET_VIEWS } from "../views/fleet-views.js";
import Spend from "../views/spend.js";
import { loader as spendLoader } from "../views/spend.server.js";
import type { SpendData } from "../views/spend.js";

export const config = { mode: "app" };

// A worker with no heartbeat for this long is treated as gone (3 missed beats).
const STALE_MS = 45_000;

interface FleetWorker extends WorkerInfo {
  online: boolean;
  ageMs: number;
}

interface FleetData {
  view: "workers";
  workers: FleetWorker[];
  store: string;
}

export async function loader({ request }: { request: Request }): Promise<FleetData | SpendData> {
  if (new URL(request.url).searchParams.get("view") === "spend") return spendLoader();
  const runtime = await shipRuntime();
  const now = Date.now();
  const list = await runtime.fleet.list();
  const workers: FleetWorker[] = list
    .map((w) => {
      const seen = new Date(w.lastSeen).getTime();
      const ageMs = Number.isFinite(seen) ? now - seen : Infinity;
      return { ...w, online: ageMs < STALE_MS, ageMs };
    })
    .sort((a, b) => (a.online !== b.online ? (a.online ? -1 : 1) : a.host.localeCompare(b.host)));
  return { view: "workers", workers, store: runtime.kind };
}

function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "never";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const POLL = `__shipLive("route:fleet.tsx");`;

export default function Fleet({ data }: { data: FleetData | SpendData }) {
  if (data.view === "spend") return <Spend data={data} />;
  const online = data.workers.filter((w) => w.online);
  const activeRuns = online.reduce((n, w) => n + w.activeRuns, 0);
  const capacity = online.reduce((n, w) => n + w.maxConcurrent, 0);
  const hosts = new Set(online.map((w) => w.host)).size;

  return (
    <>
      <h1 class="page">Fleet</h1>
      <SubNav items={FLEET_VIEWS} current="workers" />
      <p class="meta">
        Workers claim runs from one shared queue via leases, so many can run at once across servers. A worker marked
        <b> held</b> has slots but is refusing launches until its host has room again (SHIP_MIN_FREE_MB / SHIP_MAX_LOAD_PER_CPU). · store: {data.store}
        {data.store === "file" && " · file store runs no worker daemon — nothing to show here"}
      </p>

      {online.length > 0 && (
        <div class="row-actions" style="gap:24px;flex-wrap:wrap;margin:6px 0 18px">
          <span><b>{online.length}</b> <span class="meta">worker{online.length === 1 ? "" : "s"} online</span></span>
          <span><b>{hosts}</b> <span class="meta">host{hosts === 1 ? "" : "s"}</span></span>
          <span><b>{activeRuns}</b> <span class="meta">runs active</span></span>
          <span><b>{activeRuns}/{capacity}</b> <span class="meta">capacity</span></span>
        </div>
      )}

      {data.workers.length === 0 ? (
        <p class="empty">No workers reporting.{data.store === "nucleus" ? " Start one with: teploy-ship worker" : ""}</p>
      ) : (
        data.workers.map((w) => {
          const pct = w.maxConcurrent > 0 ? Math.min(100, (w.activeRuns / w.maxConcurrent) * 100) : 0;
          const full = w.activeRuns >= w.maxConcurrent;
          return (
            <div key={w.owner} class="card" style={w.online ? "" : "opacity:.55"}>
              <div class="row-actions" style="flex-wrap:wrap;gap:12px;align-items:center">
                <span class={`status ${w.online ? "completed" : "failed"}`}>{w.online ? "online" : "stale"}</span>
                <span style="font-weight:600">{w.host}</span>
                <span class="chip">{w.sandbox === "host" ? "runs on host" : "sandbox"}</span>
                {w.held !== undefined && <span class="status waiting">held: {w.held}</span>}
                <span style="flex:1" />
                {w.freeMemMB !== undefined && <span class="meta">{w.freeMemMB} MB free</span>}
                {w.load1 !== undefined && <span class="meta">load {w.load1}{w.cpus !== undefined ? ` / ${w.cpus} cpu` : ""}</span>}
                <span class="meta">{w.activeRuns}/{w.maxConcurrent} slots</span>
                <span class="meta">seen {ago(w.ageMs)}</span>
              </div>
              <div style="margin-top:8px;height:6px;background:var(--bg);border-radius:4px;overflow:hidden">
                <div style={`height:100%;width:${pct}%;background:${full ? "var(--yellow)" : "var(--green)"}`} />
              </div>
              <div class="meta" style="margin-top:8px;font-size:12px">
                {w.owner}{w.sandbox !== "host" ? ` · ${w.sandbox}` : ""}
              </div>
            </div>
          );
        })
      )}
      <script dangerouslySetInnerHTML={{ __html: POLL }} />
    </>
  );
}
