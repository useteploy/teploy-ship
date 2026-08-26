import { redirect } from "../lib/http.server.js";

export const config = { mode: "app" };

/** Old path: the content moved to /projects (C4 nav compression). */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const to = new URL("/projects?view=knowledge", "http://x");
  for (const [k, v] of q) if (!to.searchParams.has(k)) to.searchParams.set(k, v);
  return redirect(to.pathname + to.search);
}

export default function Moved() {
  return <p class="meta">Moved to <a href="/projects?view=knowledge">/projects?view=knowledge</a>.</p>;
}
