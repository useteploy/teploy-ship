import { shipRuntime } from "./store.server.js";

/**
 * One change-detection loop per web process, shared by every open SSE
 * connection. Instead of each browser polling the store on its own timer, the
 * server polls once, computes a cheap version digest of the state the
 * dashboard cares about, and pushes a signal to all subscribers when it
 * changes. Clients then re-run their own loader (which diffs and reloads only
 * if their slice actually changed), so a global "something changed" ping stays
 * correct without over-reloading.
 *
 * This is the store-tail seam: today it polls Nucleus; it can later be swapped
 * for a real LISTEN/NOTIFY subscription without touching the SSE route or the
 * clients.
 */
type Subscriber = (version: string) => void;

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastVersion = "";

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function computeVersion(): Promise<string> {
  const runtime = await shipRuntime();
  const [runs, proposed, fleet] = await Promise.all([
    runtime.listMeta(),
    runtime.intake.list("proposed"),
    runtime.fleet.list(),
  ]);
  const r = runs.map((m) => `${m.runId}:${m.status}:${m.updatedAt}`).sort().join("|");
  const p = proposed.map((t) => t.taskId).sort().join(",");
  const f = fleet.map((w) => `${w.owner}:${w.activeRuns}:${w.lastSeen}`).sort().join("|");
  return hash(`${r}#${p}#${f}`);
}

function ensurePolling(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void computeVersion()
      .then((version) => {
        if (version === lastVersion) return;
        lastVersion = version;
        for (const fn of subscribers) fn(version);
      })
      .catch(() => {});
  }, 2000);
  timer.unref?.();
}

/** Subscribe to change signals. Returns an unsubscribe function. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  ensurePolling();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
