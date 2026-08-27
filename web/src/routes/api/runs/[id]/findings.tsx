import type { LoaderArgs } from "@neutron-build/core";
import type { ScanFinding } from "teploy-ship/runtime";

import { currentUser } from "../../../../lib/session.server.js";
import { shipRuntime } from "../../../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * A scan run's findings, for a program (L2 / D3).
 *
 * A scan's whole deliverable is run data — it opens no pull request and writes
 * no file (see findings.ts for why a file was never possible) — so without a
 * machine-readable endpoint the only way to read one is to open the run page
 * and look. That is exactly the position the prompt-only MVP left us in: seven
 * completed scans whose signal was in free text nobody could aggregate.
 *
 * Read from the RECORDED STEP, not from the run's output, so a scan that is
 * still running or that failed after collecting is still readable.
 *
 * Auth is the existing bearer credential (`Authorization: Bearer
 * <SHIP_WEB_TOKEN>`), same as the sibling decide route. Reading findings needs
 * no authority grant beyond being signed in — they are a report, and every
 * authenticated role can already read the run page they appear on.
 */
export async function loader({ request, params }: LoaderArgs): Promise<Response> {
  const principal = await currentUser(request);
  if (principal === null) return json(401, { error: "unauthorized — send Authorization: Bearer <SHIP_WEB_TOKEN>" });
  const runId = (params as { id?: string }).id ?? "";
  if (runId === "") return json(400, { error: "run id is required" });

  const runtime = await shipRuntime();
  const [meta, events] = await Promise.all([runtime.loadMeta(runId), runtime.store.load(runId)]);
  if (meta === null && events.length === 0) return json(404, { error: `no such run: ${runId}` });

  const started = events.find((e) => e.type === "run-started");
  const mode = (started?.data as { input?: { mode?: string } } | undefined)?.input?.mode;
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const result = (step?.data as { result?: unknown } | undefined)?.result as
    | { findings?: unknown; errors?: unknown; found?: unknown }
    | undefined;

  if (mode !== "scan") {
    // A 200 with mode:"fix" rather than a 404: "this run is not a scan" is an
    // answer, and a caller sweeping a night's runs should not have to treat it
    // as an error.
    return json(200, { run: runId, mode: mode ?? "fix", scan: false, findings: [] as ScanFinding[] });
  }
  return json(200, {
    run: runId,
    mode: "scan",
    scan: true,
    status: meta?.status ?? "unknown",
    repo: (started?.data as { input?: { repo?: string } } | undefined)?.input?.repo ?? null,
    // `collected: false` means the run has not reached its findings step yet
    // (or never will) — distinct from a scan that collected an empty array.
    collected: result !== undefined,
    // Whether the agent emitted an array at ALL. `collected && !found` is the
    // MVP's exact failure mode, and a caller should be able to count it.
    found: result?.found === true,
    findings: Array.isArray(result?.findings) ? result.findings : [],
    notes: Array.isArray(result?.errors) ? result.errors : [],
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A route with only server handlers still needs a default export or the router
// does not register it (see api/runs/[id]/decide.tsx).
export default function Never() {
  return null;
}
