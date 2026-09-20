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
  throw Response.json(await runData({ request, params }), {
    headers: { "cache-control": "no-store" },
  });
}
