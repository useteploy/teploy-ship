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
  if ((process.env.SHIP_STORE ?? "file") === "nucleus") {
    try {
      const runtime = await shipRuntime();
      await runtime.listMeta();
      nucleus = "ok";
    } catch {
      nucleus = "unreachable";
    }
  }
  const ok = nucleus !== "unreachable";
  return new Response(
    JSON.stringify({ status: ok ? "ok" : "error", nucleus, version: process.env.SHIP_VERSION ?? "dev" }),
    { status: ok ? 200 : 503, headers: { "content-type": "application/json" } },
  );
}
