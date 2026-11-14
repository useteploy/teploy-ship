import { shipRuntime } from "./store.server.js";
// dist/version.js is the one place the running version is resolved
// (SHIP_VERSION override, else the image's baked dist/VERSION). Same
// direct-from-dist import as discovery.server.ts; this file is .server-only.
import { shipVersion } from "../../../dist/version.js";

/** The slice of the runtime /health touches. */
export interface HealthRuntime {
  ping(): Promise<void>;
  fleet: { list(): Promise<Array<{ lastSeen: string }>> };
}

export interface HealthDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the process's store-backed runtime. */
  runtime?: () => Promise<HealthRuntime>;
  now?: () => number;
}

/**
 * GET /health → {status, store, store_kind, nucleus, worker, version}.
 *
 * The store is checked WHATEVER it is. Until 0.5.1 the probe ran only when
 * SHIP_STORE was "nucleus", so on PostgreSQL — production's store since
 * 2026-10-14 and the install default — the endpoint answered 200 with
 * `"nucleus":"n/a"` while the database was down, and the deploy gate and every
 * uptime probe believed it (SHIP-04).
 *
 * Fields:
 *   store       ok | unreachable — the configured store answered a constant-
 *               time probe (or did not; then the status is 503).
 *   store_kind  file | postgres | nucleus — what SHIP_STORE selected.
 *   nucleus     the LEGACY name of `store`, same value on a shared store
 *               (postgres or nucleus), "n/a" on a file store as before. Kept
 *               because existing probes and `teploy-ship join` read it (the
 *               family's /health convention calls its database check
 *               "nucleus" whatever the engine is). New readers use `store`.
 *   worker      shared stores only: "ok (N)" workers heart-beating in the last
 *               minute, or "none". Reported, never fatal — a fleet can be
 *               scaled to zero. "n/a" on a file store, which has no fleet.
 */
export async function handleHealth(deps: HealthDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const kind = (env.SHIP_STORE ?? "").trim() === "" ? "file" : env.SHIP_STORE!.trim();
  let store = "unreachable";
  let worker = "n/a";
  try {
    const runtime = await (deps.runtime ?? (shipRuntime as () => Promise<HealthRuntime>))();
    // A constant-time probe, not a data read. This used to call listMeta(),
    // so the deploy gate's health check got steadily more expensive as run
    // history grew — the check most needs to be cheap exactly when the system
    // is under strain.
    await runtime.ping();
    store = "ok";
    if (kind !== "file") {
      // Liveness of the web process says nothing about whether any worker is
      // alive to execute runs, which is the thing an operator actually cares
      // about.
      const fleet = await runtime.fleet.list().catch(() => []);
      const fresh = fleet.filter((w) => now() - new Date(w.lastSeen).getTime() < 60_000);
      worker = fresh.length > 0 ? `ok (${fresh.length})` : "none";
    }
  } catch {
    // An unknown SHIP_STORE, a missing NUCLEUS_URL, a refused connection or a
    // failed migration all land here: a dashboard that cannot read its store
    // is down, not degraded.
    store = "unreachable";
  }
  const ok = store === "ok";
  return new Response(
    JSON.stringify({
      status: ok ? "ok" : "error",
      store,
      store_kind: kind,
      nucleus: kind === "file" ? "n/a" : store,
      worker,
      version: shipVersion(env),
    }),
    { status: ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
