// Throw resource responses for compatibility with Neutron dev, which otherwise tries to render them.
import { runData } from "../../../../lib/run-data.server.js";
import { currentUser } from "../../../../lib/session.server.js";
export const config = { mode: "app" };
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}): Promise<Response> {
  if (!(await currentUser(request)))
    throw new Response("Unauthorized", { status: 401 });
  // Hono replaces global Response; inherited Response.json returns the native
  // class and fails Neutron’s instanceof check in production.
  throw new Response(JSON.stringify(await runData({ request, params })), {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}
