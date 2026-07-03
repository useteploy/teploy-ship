import type { Message } from "@neutron-build/ai";

/**
 * Context condensation — keeping long runs inside the model's window
 * without losing the thread. When the conversation grows past a budget,
 * the oldest middle turns are replaced by one summary message, while the
 * system prompt, the original task, and the most recent turns are kept
 * verbatim. (The "condenser" pattern from OpenHands; the summarizer is
 * injected so it's an LLM call in production and trivially faked in
 * tests — and, crucially, so a durable workflow can wrap it in a step.)
 */
export interface CondenseConfig {
  /** Condense when the serialized history exceeds this many chars. */
  maxChars: number;
  /** Most-recent messages always kept verbatim (default 8). */
  keepRecent: number;
}

export const defaultCondenseConfig: CondenseConfig = {
  maxChars: 60_000,
  keepRecent: 8,
};

/** Summarize condensed-out turns into a compact progress recap. */
export type Summarizer = (transcript: string) => Promise<string>;

export function historySize(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  }
  return total;
}

/**
 * Return a condensed copy when over budget, else the original array.
 * Layout preserved: [system, first-user (task/begin), <summary>, ...recent].
 * The summary is itself a user message tagged so the model treats it as
 * recap, not instruction.
 */
export async function condenseIfNeeded(
  messages: Message[],
  summarize: Summarizer,
  config: CondenseConfig = defaultCondenseConfig,
): Promise<Message[]> {
  if (historySize(messages) <= config.maxChars) {
    return messages;
  }

  // Preserve the framing turns (system + the opening user message) and
  // the tail; summarize only the middle.
  const head = messages.slice(0, 2);
  const recent = messages.slice(-config.keepRecent);
  const middle = messages.slice(2, messages.length - config.keepRecent);
  if (middle.length === 0) {
    return messages; // nothing safely condensable
  }

  const transcript = middle
    .map((m) => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n");
  const summary = await summarize(transcript);

  const summaryMessage: Message = {
    role: "user",
    content: `[Progress so far — summary of ${middle.length} earlier steps]\n${summary}`,
  };
  return [...head, summaryMessage, ...recent];
}
