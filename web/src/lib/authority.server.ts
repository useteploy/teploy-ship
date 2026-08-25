import { mayDo } from "teploy-ship/runtime";
import type { AuthorityAction } from "teploy-ship/runtime";

import type { Principal } from "./session.server.js";
import { shipRuntime } from "./store.server.js";

/**
 * May this principal perform a governed action (governance.ts)? Reads the
 * live store on every call so an edit on the Policies page takes effect on
 * the next request. FAILS CLOSED: an unreadable store denies — approving is
 * remote code execution plus spend, and "the database was slow" must never
 * widen who may do that.
 */
export async function may(action: AuthorityAction, principal: Principal | null): Promise<boolean> {
  if (principal === null) return false;
  try {
    const governance = await (await shipRuntime()).governance.get();
    return mayDo(governance, action, principal);
  } catch {
    return false;
  }
}

/** The sentence a refused person reads. */
export function deniedMessage(action: AuthorityAction): string {
  const what: Record<AuthorityAction, string> = {
    approve: "approve, deny or launch runs",
    auto: "set a source to auto",
    steer: "steer or cancel runs",
    policies: "change policies",
  };
  return `Your account may not ${what[action]}. An admin can grant it on the Policies page.`;
}
