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

/** MB as a number an operator reads at a glance: GB above a gigabyte, MB below. */
function size(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Why this worker has the ceiling it has. The whole point of B1 is that the
 * number is measured rather than configured, so the page has to say which
 * measurement produced it — otherwise a silently-derived ceiling is worse than
 * a configured one.
 */
function bindingNote(w: FleetWorker): string {
  const slots = `${w.maxConcurrent} slot${w.maxConcurrent === 1 ? "" : "s"}`;
  switch (w.capacityBinding) {
    case "override":
      return `${slots} — set by hand (SHIP_MAX_CONCURRENT_RUNS), not measured`;
    case "cpu":
      return `${slots} — cpu binding${w.cpus !== undefined ? ` (${w.cpus} cores)` : ""}`;
    case "memory":
      return `${slots} — memory binding${w.totalMemMB !== undefined ? ` (${size(w.totalMemMB)} on the box)` : ""}`;
    case "disk":
      return `${slots} — disk binding${w.diskFreeMB !== undefined ? ` (${size(w.diskFreeMB)} free on the docker root)` : ""}`;
    default:
      // A worker on an older build: it reports a ceiling but not what set it.
      return `${slots} — ceiling not reported`;
  }
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
  const held = online.filter((w) => w.held !== undefined);

  return (
    <>
      <h1 class="page">Fleet</h1>
      <SubNav items={FLEET_VIEWS} current="workers" />
      <p class="meta">
        Workers claim runs from one shared queue via leases, so many can run at once across servers. Each one <b>measures
        its own box</b> — cores, memory, and free space and inodes on the docker root — and derives its slot count from
        that every 15 seconds, so adding a VM raises the fleet's capacity and a squeeze lowers it with no knob touched.
        The binding constraint is named on each card. A worker marked <b>held</b> has slots but is refusing launches
        until its host has room again; its due runs wait in the queue and go the moment it clears — nothing is dropped.
        The env knobs (SHIP_MAX_CONCURRENT_RUNS, SHIP_MIN_FREE_MB, SHIP_MAX_LOAD_PER_CPU, SHIP_MIN_FREE_DISK_MB,
        SHIP_MAX_INODE_USED_PCT) are overrides on top, not the mechanism. · store: {data.store}
        {data.store === "file" && " · file store runs no worker daemon — nothing to show here"}
      </p>

      {online.length > 0 && (
        <div class="row-actions" style="gap:24px;flex-wrap:wrap;margin:6px 0 18px">
          <span><b>{online.length}</b> <span class="meta">worker{online.length === 1 ? "" : "s"} online</span></span>
          <span><b>{hosts}</b> <span class="meta">host{hosts === 1 ? "" : "s"}</span></span>
          <span><b>{activeRuns}</b> <span class="meta">runs active</span></span>
          <span><b>{activeRuns}/{capacity}</b> <span class="meta">capacity, measured from the boxes</span></span>
          {held.length > 0 && (
            <span>
              <b>{held.length}</b> <span class="meta">held ({[...new Set(held.map((w) => w.held))].join(", ")})</span>
            </span>
          )}
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
                {w.inodeUsedPct !== undefined && w.inodeUsedPct >= 90 && (
                  <span class="status waiting">inodes {w.inodeUsedPct}%</span>
                )}
                <span style="flex:1" />
                {w.diskFreeMB !== undefined && (
                  <span class="meta">
                    {size(w.diskFreeMB)} disk{w.diskUsedPct !== undefined ? ` (${w.diskUsedPct}% used)` : ""}
                  </span>
                )}
                {w.freeMemMB !== undefined && (
                  <span class="meta">
                    {size(w.freeMemMB)} free{w.totalMemMB !== undefined ? ` / ${size(w.totalMemMB)}` : ""}
                  </span>
                )}
                {w.load1 !== undefined && <span class="meta">load {w.load1}{w.cpus !== undefined ? ` / ${w.cpus} cpu` : ""}</span>}
                <span class="meta">{w.activeRuns}/{w.maxConcurrent} slots</span>
                <span class="meta">seen {ago(w.ageMs)}</span>
              </div>
              <div style="margin-top:8px;height:6px;background:var(--bg);border-radius:4px;overflow:hidden">
                <div style={`height:100%;width:${pct}%;background:${full ? "var(--yellow)" : "var(--green)"}`} />
              </div>
              <div class="meta" style="margin-top:8px;font-size:12px">
                {bindingNote(w)} · {w.owner}{w.sandbox !== "host" ? ` · ${w.sandbox}` : ""}
              </div>
            </div>
          );
        })
      )}
      <script dangerouslySetInnerHTML={{ __html: POLL }} />
    </>
  );
}
