// Client-safe: the attention row shape, shared by the loader and the Inbox view.

/** The kinds of attention, in the order the page shows them. */
export type AttentionKind = "decision" | "failure" | "delivery" | "schedule" | "takeover" | "aging";

export interface AttentionRow {
  id: string;
  kind: AttentionKind;
  /** What the thing is, in the operator's terms (task, schedule, repo). */
  title: string;
  /** The outcome or blocker, one line. */
  detail: string;
  /** The human's move. */
  nextAction: string;
  /** Where to make it. */
  href: string;
  /** Repository the row's run works on (owner/name slug), when meta has one. */
  repo?: string;
  /** When the blocking state landed / began, for the age column. */
  at?: string;
  /** Waiting longer than 72h — age is now itself the blocker. */
  aging?: boolean;
}
