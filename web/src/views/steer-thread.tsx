/**
 * The slice of thread-chain.server.ts's ThreadRunView these pieces read.
 * Restated structurally because a client module may not import a .server
 * module, not even for types (the Neutron build refuses it); the route
 * passes the real view, which satisfies this shape.
 */
export interface SteerNoteLike {
  text: string;
  at: string;
  state: "delivered" | "pending";
  turn?: number;
  mode?: "queue" | "interrupt";
  effect?: "not-done" | "done" | "unknown" | "none";
}
export interface ThreadRunLike {
  steers: SteerNoteLike[];
  asks: Array<{ event: string; question: string | null; at: string; answer: { text: string | null; at: string; by?: string } | null }>;
  replies?: Array<{ text: string; at: string; turn: number }>;
}

/**
 * The steering thread's run-page pieces (steering slice B, plus D2 two-way
 * steering): the per-run history card and the two-way steer composer. Kept
 * out of the route module so the web tests can render them directly.
 */

/** "2026-10-15 09:41 UTC" — the dashboard's established timestamp rendering. */
export function utcStamp(at: string): string {
  return `${at.replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * The current run's steer/ask history (steering slice B), folded like the
 * ancestors above it. The conversation interleaves these as messages; this
 * card is the operator-shaped cut — every note with its state (queued for
 * the next turn vs delivered to one), every question the agent parked on
 * with the answer that resumed it, timestamps on all of it. Rendered only
 * when there is something to show.
 */
export function ThreadHistory({ run }: { run: ThreadRunLike }) {
  const replies = run.replies ?? [];
  if (run.steers.length === 0 && run.asks.length === 0 && replies.length === 0) return null;
  // Operator notes and agent replies in one time-ordered list (D2): the
  // thread reads as a conversation. Without replies the order is exactly
  // the steer list's own, so a pre-D2 run renders as it did.
  const entries: Array<{ kind: "steer"; note: SteerNoteLike } | { kind: "reply"; reply: NonNullable<ThreadRunLike["replies"]>[number] }> = [
    ...run.steers.map((note) => ({ kind: "steer" as const, note })),
    ...replies.map((reply) => ({ kind: "reply" as const, reply })),
  ];
  if (replies.length > 0) {
    const at = (e: (typeof entries)[number]) => (e.kind === "steer" ? e.note.at : e.reply.at);
    entries.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  }
  return (
    <details class="disclosure">
      <summary>
        {replies.length > 0 ? "Steering, replies and questions" : "Steering and questions"} on this run ({run.steers.length + run.asks.length + replies.length})
      </summary>
      <ul style="margin:0;padding-left:0;list-style:none">
        {entries.map((e, i) => (
          <li key={`${e.kind}-${i}`} style={i === 0 ? "padding:8px 0" : "padding:8px 0;border-top:1px solid var(--line)"}>
            <div class="row-actions" style="gap:8px;align-items:baseline;flex-wrap:wrap">
              {e.kind === "reply" ? (
                <span class="chip">agent reply · turn {e.reply.turn}</span>
              ) : (
                <span class="chip">{steerChip(e.note)}</span>
              )}
              <span class="meta">{utcStamp(e.kind === "steer" ? e.note.at : e.reply.at)}</span>
            </div>
            <pre style="white-space:pre-wrap;margin:4px 0 0">{e.kind === "steer" ? e.note.text || (e.note.mode === "interrupt" ? "(interrupt, no message)" : "") : e.reply.text}</pre>
          </li>
        ))}
        {run.asks.map((a, i) => (
          <li key={`ask-${i}`} style="padding:8px 0;border-top:1px solid var(--line)">
            <div class="row-actions" style="gap:8px;align-items:baseline;flex-wrap:wrap">
              <span class="chip">{a.answer === null ? "waiting for an answer" : "answered"}</span>
              <span class="meta">{utcStamp(a.at)}</span>
            </div>
            <pre style="white-space:pre-wrap;margin:4px 0 0">{a.question ?? "(the question could not be read from the run's log)"}</pre>
            {a.answer !== null && (
              <div style="margin-top:4px">
                <span class="meta">
                  {utcStamp(a.answer.at)}
                  {a.answer.by !== undefined ? ` · ${a.answer.by}` : ""} —{" "}
                </span>
                {a.answer.text !== null
                  ? a.answer.text
                  : "no answer recorded — the agent was told to decide for itself"}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The chip for one operator note. A pre-D2 note (mode absent or `steer`)
 * reads exactly as before; queued notes and interrupts name their mode, and
 * a delivered interrupt names its effect on the action it landed on.
 */
export function steerChip(note: SteerNoteLike): string {
  const mode = note.mode ?? "steer";
  if (mode === "steer") return note.state === "pending" ? "queued" : `delivered turn ${note.turn}`;
  const label = mode === "queue" ? "queued for checkpoint" : "interrupt";
  if (note.state === "pending") return `${label} · waiting`;
  const effect = note.effect === "not-done" ? " · not done" : note.effect === "done" ? " · ran to completion" : note.effect === "unknown" ? " · effect unknown" : note.effect === "none" ? " · nothing running" : "";
  return `${label} · turn ${note.turn}${effect}`;
}

/**
 * The steer composer on a two-way-steering run (D2, input.steerReply). Same
 * form, same field, same intent as the plain composer above — plus the mode
 * toggle (steer now / queue for the agent's next checkpoint) and an
 * interrupt for the action in flight. The interrupt skips the required
 * check: an empty interrupt is a valid "stop".
 */
export function SteerComposer() {
  return (
    <form class="message-composer" method="post" style="margin:12px 0">
      <label class="field">Message the agent<textarea name="steer" rows={3} maxLength={12000} required placeholder="Add context, ask a question, or redirect the work." /></label>
      <div class="row-actions" role="radiogroup" aria-label="When to apply" style="gap:12px;align-items:center;flex-wrap:wrap">
        <span class="meta">Apply</span>
        <label class="check-field"><input type="radio" name="mode" value="steer" checked />now (next turn)</label>
        <label class="check-field"><input type="radio" name="mode" value="queue" />at the agent's next checkpoint</label>
      </div>
      <div class="row-actions" style="gap:8px;flex-wrap:wrap">
        <button type="submit" name="intent" value="steer">
          Send message
        </button>
        <button type="submit" name="intent" value="interrupt" class="deny" formNoValidate title="Stops the current action at its next safe point; the message, if any, goes with it">
          Interrupt current action
        </button>
      </div>
    </form>
  );
}
