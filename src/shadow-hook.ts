import type { AuthorityAction, Governance } from "./governance.js";
import type { Authority, ProjectVerification } from "./ladder.js";
import type { NetworkTier } from "./egress.js";

/**
 * The seam between Ship's existing decision points and the S25 policy shadow.
 *
 * WHY a leaf module. The decision points (governance.ts, ladder.ts, egress.ts,
 * repo-policy.ts, runtime.ts) cannot import policy-inheritance.ts: that module
 * imports governance, ladder and egress at load time, so the reverse edge is a
 * cycle whose first victim is a top-level constant. This file imports only
 * TYPES (erased at compile), so every decision point can call it freely.
 *
 * WHY an observer and not a return value. Shadow mode never changes an
 * outcome. A decision point reports what it decided, AFTER deciding, to an
 * observer that is null unless `SHIP_POLICY_SHADOW=on` installed one
 * (policy-shadow.ts). Off, the cost is one null comparison and the decision is
 * exactly what it was. The observer is isolated: a throw, or a rejected
 * promise, is swallowed here so the shadow can never fail a request.
 */

export interface ShadowPrincipal {
  user: string;
  role: string;
  /** Set by callers that know the principal is an automation identity. Ship has none today. */
  serviceAccount?: boolean;
}

export interface ShadowProjectLike {
  repo?: string;
  authority?: Authority;
  neverAuto?: boolean;
  verification?: ProjectVerification;
  sandboxNetwork?: NetworkTier;
  sandboxEgressAllow?: string[];
  dailyBudgetUSD?: number;
  weeklyBudgetUSD?: number;
}

export type ShadowEvent =
  | { point: "mayDo"; governance: Pick<Governance, "authority">; action: AuthorityAction; principal: ShadowPrincipal | null | undefined; allowed: boolean }
  | { point: "authority"; project: ShadowProjectLike; result: Authority }
  | { point: "network"; result: NetworkTier | null }
  | { point: "egress"; result: string[] | undefined }
  | { point: "repo"; url: string; trust: string; host: string | null; allowed: boolean; reason?: string }
  | {
      point: "budget";
      source: string;
      repo?: string;
      /** The daily cap the existing code applied. <= 0 means it applied none. */
      budget: number;
      /** Spend committed today INCLUDING this run's own reservation. Null when no spend was read (cap disabled). */
      committed: number | null;
      estimate: number;
      existingAllowed: boolean;
      loadProject: () => Promise<ShadowProjectLike | null>;
    };

export type ShadowObserver = (event: ShadowEvent) => void | Promise<void>;

let observer: ShadowObserver | null = null;
let suppressed = 0;

export function setShadowObserver(next: ShadowObserver | null): void {
  observer = next;
}

export function shadowActive(): boolean {
  return observer !== null && suppressed === 0;
}

/** Run `fn` with the shadow muted: the observer itself calls decision points (resolvePolicy -> effectiveAuthority). */
export function suppressShadow<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

/** Report a decision that has ALREADY been made. Never throws, never returns anything, never delays the caller. */
export function shadowObserve(event: ShadowEvent): void {
  if (observer === null || suppressed > 0) return;
  try {
    const out = suppressShadow(() => observer!(event));
    if (out !== undefined && typeof (out as Promise<void>).catch === "function") (out as Promise<void>).catch(() => {});
  } catch {
    // The shadow must never fail the decision it is watching.
  }
}
