import { hostname, userInfo } from "node:os";

/**
 * Who asked for this.
 *
 * Ship recorded no actor anywhere until this existed: a run did not record who
 * enqueued it and an approval did not record who granted it, so the audit
 * export could answer *what ran, when, at what cost* and never *who authorised
 * it*. That is the difference between an operator record and a compliance
 * artefact, and it blocked the same question in dash (`app exec`).
 *
 * ## Identity is the id, not the name
 *
 * `id` is the STABLE identity and `display` is cosmetic. This is the same rule
 * the web session layer already settled on for `Principal` (an SSO principal is
 * `issuer#sub`, never the username): usernames change, get reused, and collide
 * across providers, so anything keyed on one — an audit trail above all —
 * silently follows the *name* rather than the *person*. An audit row that
 * attributes a merge to whoever holds the handle today is worse than one that
 * attributes it to nobody.
 *
 * `Principal` itself lives in the web package and cannot be imported here (web
 * depends on this package, not the other way round). This is deliberately the
 * SAME SHAPE rather than a second identity model — `actorFromPrincipal` is the
 * one mapping, and there should never be a third.
 */
export interface Actor {
  /** Stable identity. `issuer#sub` for SSO, username for a local account, `user@host` for the CLI. */
  id: string;
  /** Friendly name for display. Falls back to `id`. */
  display?: string;
  kind: ActorKind;
}

/**
 * How the identity was established — which is what tells a reader how much to
 * trust it. An authenticated web session is a person; a CLI actor is whoever
 * held the shell (a real operator, but attested by the OS rather than by us);
 * an intake actor is a name a forge or chat platform asserted in a webhook
 * payload, which Ship did not verify and must not present as if it had.
 */
export type ActorKind = "user" | "cli" | "intake" | "unknown";

/**
 * A run whose actor is not known.
 *
 * Deliberately legal, and deliberately not an error. Refusing to enqueue
 * without an actor would break every in-flight run and every intake wiring that
 * predates this field, for no security gain — the surfaces that can be
 * authenticated already are. The distinction surfaces in the audit export as
 * `attributable: false` instead, where a reader can see it.
 */
export const UNKNOWN_ACTOR: Actor = { id: "unknown", kind: "unknown" };

/** Only "unknown" is unattributable; the other three name someone. */
export function isAttributable(actor: Actor | undefined): boolean {
  return actor !== undefined && actor.kind !== "unknown";
}

/**
 * The operator running a CLI command, attested by the OS rather than by Ship.
 *
 * `user@host` and not a bare username: two people called `deploy` on two boxes
 * are two actors, and the host is the only thing that separates them. Falls
 * back to the unknown actor rather than throwing — `userInfo()` raises on a
 * container with no passwd entry for the uid, which is an ordinary way to run
 * this and not a reason to refuse the command.
 */
export function cliActor(): Actor {
  try {
    const name = userInfo().username;
    const host = hostname();
    return { id: `${name}@${host}`, display: name, kind: "cli" };
  } catch {
    return UNKNOWN_ACTOR;
  }
}

/**
 * A name a webhook payload asserted. NOT verified by Ship — the delivery's
 * signature proves the payload came from the forge, not that the forge is
 * telling the truth about who wrote the issue. Recorded because it is the only
 * answer available and a wrong-looking name is more auditable than a blank.
 */
export function intakeActor(handle: string | undefined, source: string): Actor {
  const trimmed = (handle ?? "").trim();
  if (trimmed === "") return UNKNOWN_ACTOR;
  return { id: `${source}:${trimmed}`, display: trimmed, kind: "intake" };
}

/**
 * Map an authenticated web principal onto an actor. Structural on purpose so
 * the web package can pass its `Principal` without this package importing it.
 */
export function actorFromPrincipal(
  principal: { user: string; display?: string } | null | undefined,
): Actor {
  if (principal === undefined || principal === null || principal.user === "") return UNKNOWN_ACTOR;
  return {
    id: principal.user,
    ...(principal.display !== undefined ? { display: principal.display } : {}),
    kind: "user",
  };
}

/**
 * Rebuild an actor from the two flat columns a run carries.
 *
 * The store persists `actor` and `actorKind` FLAT rather than a nested object,
 * because the Nucleus doc store is a hand-written column map of scalars — a
 * nested value would be stringified into a column and read back as the literal
 * text `[object Object]`.
 */
export function actorFromMeta(meta: { actor?: string; actorKind?: string }): Actor {
  if (meta.actor === undefined || meta.actor === "") return UNKNOWN_ACTOR;
  const kind = meta.actorKind;
  const known: ActorKind[] = ["user", "cli", "intake", "unknown"];
  return {
    id: meta.actor,
    kind: known.includes(kind as ActorKind) ? (kind as ActorKind) : "unknown",
  };
}

/** `display (id)` when they differ, else the id. For CSV and operator output. */
export function formatActor(actor: Actor): string {
  if (actor.display === undefined || actor.display === actor.id) return actor.id;
  return `${actor.display} (${actor.id})`;
}
