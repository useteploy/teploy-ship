import type { ActionArgs, LoaderArgs } from "@neutron-build/core";
import type { AuthorityAction, Role } from "teploy-ship/runtime";

import { currentUser } from "../../lib/session.server.js";
import { may } from "../../lib/authority.server.js";
import { AUTHORITY_ACTIONS, GLOBAL_WINDOW, autoAllowedNow } from "../../lib/ship.server.js";
import { shipRuntime } from "../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * The Policies page for a program: GET reads governance (plus whether each
 * window is open right now), POST edits one rule. Same authority gate as the
 * page — `policies` — answered as a 403 with a reason, never a redirect.
 *
 * Body shapes for POST (exactly one):
 *   { "authority": { "action": "approve", "roles": ["admin"], "users": ["bot"] } }
 *   { "window": { "source": "forgejo", "days": [1,2,3,4,5], "start": "09:00", "end": "18:00", "tz": "Europe/Berlin" } }
 *   { "window": { "source": "forgejo", "remove": true } }         (source "" or "*" = all sources)
 *   { "reviewers": { "repo": "owner/name", "users": ["alice"], "teams": ["core"] } }   (both empty = remove)
 */
export async function loader({ request }: LoaderArgs): Promise<Response> {
  const principal = await currentUser(request);
  if (principal === null) return json(401, { error: "unauthorized" });
  const runtime = await shipRuntime();
  const governance = await runtime.governance.get();
  const now = new Date();
  const windows = Object.fromEntries(
    Object.entries(governance.windows).map(([source, w]) => [source, { ...w, autoAllowedNow: autoAllowedNow(governance.windows, source, now) }]),
  );
  return json(200, {
    authority: governance.authority,
    windows,
    reviewers: governance.reviewers,
    you: { user: principal.user, role: principal.role, may_change_policies: await may("policies", principal) },
  });
}

interface Body {
  authority?: { action?: string; roles?: unknown; users?: unknown };
  window?: { source?: string; days?: unknown; start?: unknown; end?: unknown; tz?: unknown; remove?: boolean };
  reviewers?: { repo?: string; users?: unknown; teams?: unknown };
}

export async function action({ request }: ActionArgs): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed — POST only" });
  const principal = await currentUser(request);
  if (principal === null) return json(401, { error: "unauthorized — send Authorization: Bearer <SHIP_WEB_TOKEN>" });
  if (!(await may("policies", principal))) {
    return json(403, { error: `${principal.user} (${principal.role}) may not change policies — the policies authority is not granted` });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const runtime = await shipRuntime();
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  try {
    if (body.authority !== undefined) {
      const name = body.authority.action ?? "";
      if (!(AUTHORITY_ACTIONS as readonly string[]).includes(name)) return json(400, { error: `authority.action must be one of ${AUTHORITY_ACTIONS.join(", ")}` });
      const roles = strings(body.authority.roles).filter((r): r is Role => ["admin", "editor", "viewer"].includes(r));
      const users = strings(body.authority.users);
      if (name === "policies" && roles.length === 0 && users.length === 0) {
        return json(400, { error: "the policies grant needs at least one role or user" });
      }
      await runtime.governance.setAuthority(name as AuthorityAction, { roles, users });
    } else if (body.window !== undefined) {
      const source = (body.window.source ?? "").trim();
      const key = source === "" || source === GLOBAL_WINDOW ? "" : source;
      if (body.window.remove === true) {
        await runtime.governance.setWindow(key, null);
      } else {
        await runtime.governance.setWindow(key, {
          days: Array.isArray(body.window.days) ? body.window.days.map(Number) : [],
          start: String(body.window.start ?? ""),
          end: String(body.window.end ?? ""),
          tz: String(body.window.tz ?? ""),
        });
      }
    } else if (body.reviewers !== undefined) {
      const repo = (body.reviewers.repo ?? "").trim();
      if (repo === "") return json(400, { error: "reviewers.repo is required" });
      await runtime.governance.setReviewers({ repo, users: strings(body.reviewers.users), teams: strings(body.reviewers.teams) });
    } else {
      return json(400, { error: "body must carry one of: authority, window, reviewers" });
    }
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : String(error) });
  }
  return json(200, { ok: true, governance: await runtime.governance.get() });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A route with only server handlers still needs a default export or the
// router does not register it (see api/runs/[id]/decide.tsx).
export default function Never() {
  return null;
}
