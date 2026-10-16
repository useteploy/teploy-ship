import type { LoaderArgs } from "@neutron-build/core";

import { runThread, threadViewEnabled } from "../../../../lib/thread-chain.server.js";
import { currentUser } from "../../../../lib/session.server.js";
import { shipRuntime } from "../../../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * The steering thread, read-only (steering slice B): for a run id — the
 * root, or any member of its chain — the whole follow-up chain with each
 * run's steer notes and ask parks, ordered root first.
 *
 *   curl -sS "$SHIP_URL/api/runs/<run-id>/thread" \
 *     -H "authorization: Bearer $SHIP_WEB_TOKEN"
 *
 * This is the surface pass-through clients (a future MCP, akiroo) read
 * rather than re-deriving the chain from run logs themselves — one
 * projection, one place to keep honest. Auth is the existing bearer
 * credential, same as the sibling findings route: reading a thread needs no
 * authority grant beyond being signed in, because every authenticated role
 * can already read each run page the chain links to.
 *
 * Flag: SHIP_THREAD_VIEW=on (default off — 503 with the reason, the
 * incident-intake pattern, rather than a 404 that says nothing about why).
 */
export async function loader({ request, params }: LoaderArgs): Promise<Response> {
  const principal = await currentUser(request);
  if (principal === null) return json(401, { error: "unauthorized — send Authorization: Bearer <SHIP_WEB_TOKEN>" });
  if (!threadViewEnabled()) {
    return json(503, { error: "thread view is not enabled — set SHIP_THREAD_VIEW=on" });
  }
  const runId = (params as { id?: string }).id ?? "";
  if (runId === "") return json(400, { error: "run id is required" });

  const runtime = await shipRuntime();
  let thread;
  try {
    thread = await runThread(runtime, runId);
  } catch (error) {
    // A chain that cannot be read (a missing run-started in an ancestor,
    // say) is an honest 500-shaped answer, not a wrong chain.
    return json(500, { error: `thread could not be read: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (thread === null) return json(404, { error: `no such run: ${runId}` });
  return json(200, thread);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// A route with only server handlers still needs a default export or the router
// does not register it (see api/runs/[id]/decide.tsx).
export default function Never() {
  return null;
}
