import { runBulletinSweep } from "../../../views/bulletin.server.js";

export const config = { mode: "app" };

/**
 * `POST /api/bulletin/sweep` — promote every eligible note on every auto board.
 *
 * This is the tick L6 describes, exposed as an API route rather than wired into
 * the worker's sweep loop, because `src/worker.ts` belongs to another lane. Run
 * it from cron or a timer against the dashboard with the bearer token:
 *
 *   curl -fsS -XPOST -H "authorization: Bearer $SHIP_WEB_TOKEN" \
 *        https://ship.example/api/bulletin/sweep
 *
 * `docs/bulletin.md` carries the four-line patch that makes it resident in the
 * worker instead, which is where it belongs once that file is free.
 *
 * The route is a machine surface, so it is authenticated by the same middleware
 * as every other `/api/*` path (401 as JSON, never a redirect) and requires the
 * editor role for a POST. It is idempotent: a note already promoted is refused
 * by `autoEligible` with `already-sent`, so a doubled cron does not double-send.
 */
export async function action(): Promise<Response> {
  const lines: string[] = [];
  const result = await runBulletinSweep((line) => {
    lines.push(line);
    console.log(line);
  });
  return new Response(JSON.stringify({ ok: true, ...result, log: lines }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default function Never() {
  return null;
}
