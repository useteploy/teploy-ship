import { createHash } from "node:crypto";

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

/** How many recent runs the change signal watches. */
const CHANGE_WINDOW = 200;

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastVersion = "";

/**
 * State digest.
 *
 * This was a 32-bit DJB2, which collides readily on strings of this size —
 * and a collision here is not a cosmetic problem: it means a real state change
 * emits nothing, so the dashboard silently stops updating until something else
 * changes. A cryptographic digest costs microseconds on a string this size and
 * removes the failure mode rather than making it rarer.
 */
function hash(s: string): string {
  return createHash("sha256").update(s).digest("base64url").slice(0, 22);
}

async function computeVersion(): Promise<string> {
  const runtime = await shipRuntime();
  // Bounded: this runs every 2s per web process forever, and listMeta over the
  // full run history is exactly the read that gets slower the longer Ship has
  // been useful. The dashboard only ever shows recent runs, so the change
  // signal only has to cover them.
  const [runs, proposed, fleet] = await Promise.all([
    runtime.listMeta({ limit: CHANGE_WINDOW }),
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
