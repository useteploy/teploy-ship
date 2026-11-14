import { handleHealth } from "../lib/health.server.js";

export const config = { mode: "app" };

/**
 * Family-convention health endpoint: GET /health → {status, store, nucleus,
 * worker, version}. Unauthenticated (exempted in _layout) — it is also the URL
 * teploy's deploy health gate polls before switching traffic, which runs
 * before any human could log in. Returns 503 when the configured store —
 * PostgreSQL, Nucleus or the file store — is unreachable: a dashboard that
 * can't read its store is down, not degraded. See lib/health.server.ts.
 */
export async function loader(): Promise<Response> {
  return handleHealth();
}
