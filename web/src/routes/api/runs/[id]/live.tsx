import type { LoaderArgs } from "@neutron-build/core";

import { liveViewResponse } from "../../../../lib/live-view.server.js";

export const config = { mode: "app" };

/**
 * The live view (D5, SHIP_LIVE_VIEW): the run's terminal tail and its
 * running diff, read-only. The run page polls this while the run is active.
 *
 *   curl -sS "$SHIP_URL/api/runs/<run-id>/live" \
 *     -H "authorization: Bearer $SHIP_WEB_TOKEN"
 *
 * Loader only, on purpose: an observer has nothing to submit here.
 */
export async function loader({ request, params }: LoaderArgs): Promise<Response> {
  return liveViewResponse(request, (params as { id?: string }).id ?? "");
}

// A route with only server handlers still needs a default export or the router
// does not register it (see api/runs/[id]/decide.tsx).
export default function Never() {
  return null;
}
