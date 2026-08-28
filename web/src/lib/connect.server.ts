import type { RateLimitConfig } from "./ratelimit.server.js";
import { roleAllows } from "./session.server.js";
import type { Principal } from "./session.server.js";

/**
 * The guards around the Akiroo connect, which SHIP starts.
 *
 * The first version of this flow had Akiroo start the handshake and Ship
 * approve it, and every piece of state lived in a signed cookie because the
 * code arrived in a URL from another site. That is gone, and so is the cookie:
 * a handshake now begins with an admin typing a workspace address into Ship's
 * own form, so the state is a row in Ship's own store from the first moment and
 * never has to survive a hop through somebody else's page.
 *
 * The reason for the reversal, since it is not obvious from the code that
 * remains: Akiroo-initiates cannot be made safe. Whoever starts the flow holds
 * the code, so whoever starts the flow can satisfy any check derived from it —
 * including the pairing phrase that used to be here, which was sha256 of the
 * code and therefore known to exactly the party it was supposed to exclude. An
 * attacker with any workspace could mail a Ship admin a link plus the phrase
 * and end up feeding work to someone else's fleet. The fix is structural: the
 * side that receives the credential is the side that starts the flow, so an
 * unsolicited link now lands on a Ship that has no local row for it and
 * refuses.
 */

/**
 * What a caller may do with the connect pages.
 *
 * Admin is the bar: completing this hands this Ship a credential that pulls
 * work someone else queued, which is the same authority as setting a secret.
 * Unlike the first version these routes are NOT exempt from the layout's role
 * gate — the operator is already signed in on Ship when they start — so this is
 * the second of two checks rather than the only one.
 */
export type ConnectAccess = "sign-in" | "forbidden" | "allowed";

export function connectAccess(principal: Principal | null): ConnectAccess {
  if (principal === null) return "sign-in";
  return roleAllows(principal.role, "admin") ? "allowed" : "forbidden";
}

/**
 * Handshakes started, per client.
 *
 * Each one makes this server hold a verifier for ten minutes and, on return,
 * make an outbound request to an address the caller typed. Neither is
 * expensive, but neither should be unbounded either: a script driving the form
 * would otherwise be a way to make Ship connect out to arbitrary hosts on
 * demand. Lockable follows the same rule as login — only when a declared proxy
 * makes the client address trustworthy, otherwise it slows down instead of
 * handing out an outage button.
 */
export const connectLimits: RateLimitConfig = {
  limit: 5,
  windowMs: 5 * 60_000,
  lockoutMs: 5 * 60_000,
  maxConcurrent: 2,
};

/**
 * A `?next=` value reduced to something safe to redirect to.
 *
 * Ship had no return-to parameter at all before this, and adding one is adding
 * an open-redirect surface unless it is bounded to a same-site PATH. The forms
 * that matter are `//evil.example` and `/\evil.example`, both of which a
 * browser resolves as another host despite starting with a slash. Anything that
 * is not a plain rooted path falls back to the dashboard root rather than
 * failing the sign-in.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // Control characters, CR and LF above all: a value that can split a header
  // has no business in a Location.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  // A rooted path cannot legally contain a scheme; a value that does is trying
  // to be parsed as an absolute URL by something downstream.
  if (/^\/[^/]*:/.test(raw)) return fallback;
  return raw;
}

/**
 * Is this request a top-level browser navigation?
 *
 * `/connect/return` completes a handshake, which spends a single-use row and
 * makes an outbound request — real work, on a GET, because that is the shape a
 * redirect back from another site has to take. `Sec-Fetch-Dest` is how a modern
 * browser distinguishes "the operator navigated here" from "something on a page
 * fetched this": a prefetch, an `<img>`, or a link scanner in a mail client
 * would otherwise burn the handshake before the operator arrived.
 *
 * ABSENT is allowed. Old browsers and curl send nothing, and refusing them
 * would break the flow for the sake of a header the attacker in this model does
 * not control anyway (a browser sets it; a script that omits it still cannot
 * make the operator's browser carry their session).
 */
export function isTopLevelNavigation(request: Request): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  return dest === null || dest === "" || dest === "document";
}
