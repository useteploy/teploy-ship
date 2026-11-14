import { redirect } from "../lib/http.server.js";
import { requireRouteRole } from "../lib/route-access.server.js";

export const config = { mode: "app" };

/** Old path: the attention queue is the Inbox's "Needs you" section. */
export async function loader({ request }: { request: Request }): Promise<Response> {
  await requireRouteRole(request, "/attention", "loader");
  return redirect("/#needs-you");
}

export default function Moved() {
  return <p class="meta">Moved to the <a href="/#needs-you">Inbox</a>.</p>;
}
