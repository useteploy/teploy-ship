import { shipRuntime } from "../lib/store.server.js";
import { currentUser, roleAllows } from "../lib/session.server.js";
import { redirect } from "../lib/http.server.js";
import type { KnowledgeData } from "./knowledge.js";
import { knowledgeHref } from "./knowledge.js";

export async function loader({ request }: { request: Request }): Promise<KnowledgeData> {
  const runtime = await shipRuntime();
  const repo = new URL(request.url).searchParams.get("repo") ?? "";
  const [repos, notes] = await Promise.all([
    runtime.memory.repos(),
    repo !== "" ? runtime.memory.recent(repo, 200) : Promise.resolve([]),
  ]);
  repos.sort((a, b) => b.count - a.count);
  return { view: "knowledge", repos, repo, notes, store: runtime.kind };
}


export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const repo = String(form.get("repo") ?? "").trim();
  // Served under /projects, whose role gate is open so the governance grants
  // can decide. Notes are not governed, so keep the rule this page always had:
  // a mutation needs editor.
  const me = await currentUser(request);
  if (me === null || !roleAllows(me.role, "editor")) return redirect(knowledgeHref(repo));
  const runtime = await shipRuntime();
  if (repo !== "" && intent === "add") {
    const note = String(form.get("note") ?? "").trim();
    if (note !== "") await runtime.memory.record({ repo, note });
  } else if (repo !== "" && intent === "delete") {
    // Keyed on the note's own id. It used to be (repo, createdAt), and two
    // notes written in the same millisecond — which happens when runs finish
    // together — were both deleted by one click.
    const noteId = String(form.get("noteId") ?? "");
    if (noteId !== "") await runtime.memory.remove(noteId);
  }
  return redirect(knowledgeHref(repo));
}

