import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

/**
 * Family-convention health endpoint: GET /health → {status, nucleus,
 * version}. Unauthenticated (exempted in _layout) — it is also the URL
 * teploy's deploy health gate polls before switching traffic, which runs
 * before any human could log in. Returns 503 when the nucleus store is
 * configured but unreachable: a dashboard that can't read its store is
 * down, not degraded.
 */
export async function loader(): Promise<Response> {
  let nucleus = "n/a";
  let worker = "n/a";
  if ((process.env.SHIP_STORE ?? "file") === "nucleus") {
    try {
      const runtime = await shipRuntime();
      // A constant-time probe, not a data read. This used to call listMeta(),
      // so the deploy gate's health check got steadily more expensive as run
      // history grew — the check most needs to be cheap exactly when the system
      // is under strain.
      await runtime.ping();
      nucleus = "ok";

      // Liveness of the web process says nothing about whether any worker is
      // alive to execute runs, which is the thing an operator actually cares
      // about. Reported, not fatal: a fleet can legitimately be scaled to zero.
      const fleet = await runtime.fleet.list().catch(() => []);
      const fresh = fleet.filter((w) => Date.now() - new Date(w.lastSeen).getTime() < 60_000);
      worker = fresh.length > 0 ? `ok (${fresh.length})` : "none";
    } catch {
      nucleus = "unreachable";
    }
  }
  const ok = nucleus !== "unreachable";
  return new Response(
    JSON.stringify({
      status: ok ? "ok" : "error",
      nucleus,
      worker,
      version: process.env.SHIP_VERSION ?? "dev",
    }),
    { status: ok ? 200 : 503, headers: { "content-type": "application/json" } },
  );
}
