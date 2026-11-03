import { redirect } from "../lib/http.server.js";

export const config = { mode: "app" };

/** Old path: the attention queue is the Inbox's "Needs you" section. */
export async function loader(): Promise<Response> {
  return redirect("/#needs-you");
}

export default function Moved() {
  return <p class="meta">Moved to the <a href="/#needs-you">Inbox</a>.</p>;
}
