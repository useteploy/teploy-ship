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
  /**
   * Condense when the estimated TOKEN count exceeds this.
   *
   * The threshold used to be characters, which is not what the model window is
   * measured in and varies by a factor of several across source code, logs,
   * minified data, and non-Latin text — so the same budget condensed far too
   * early on one run and overflowed the window on another.
   */
  maxTokens: number;
  /** Most-recent messages always kept verbatim (default 8). */
  keepRecent: number;
  /**
   * Cap on generated-summary layering. Summaries of summaries drift: each pass
   * paraphrases the last, and specifics (file names, failures, exact
   * requirements) erode. Past this many passes the OLDEST summary is dropped
   * rather than re-summarized, so drift cannot compound without bound.
   */
  maxSummaryLayers: number;
}

export const defaultCondenseConfig: CondenseConfig = {
  maxTokens: 120_000,
  keepRecent: 8,
  maxSummaryLayers: 3,
};

/** Marks a message this module generated, so layering can be counted. */
export const SUMMARY_MARKER = "[Progress so far —";

/** Summarize condensed-out turns into a compact progress recap. */
export type Summarizer = (transcript: string) => Promise<string>;

/** Serialized size in characters. */
export function historySize(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  }
  return total;
}

/**
 * Rough token count.
 *
 * Deliberately an estimate and not a tokenizer: Ship talks to several
 * providers with different vocabularies, so an exact count for one is wrong for
 * the others, and pulling in a tokenizer per provider buys precision this does
 * not need. What it DOES need is to track the same things a tokenizer does —
 * code and logs pack more tokens per character than prose, and non-ASCII text
 * far more — instead of pretending a character is a character.
 */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  const nonAscii = text.length - ascii;
  // ~3.6 chars/token for ASCII prose-and-code; non-ASCII averages closer to 1.
  return Math.ceil(ascii / 3.6 + nonAscii);
}

export function historyTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    total += 4; // per-message overhead, as every chat format charges something
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
  if (historyTokens(messages) <= config.maxTokens) {
    return messages;
  }

  // Preserve the framing turns (system + the opening user message) and the
  // tail; summarize only the middle. The system message holds the task
  // verbatim, so the authoritative statement of what was asked is never the
  // thing being paraphrased — only the working state is.
  const head = messages.slice(0, 2);
  const recent = messages.slice(-config.keepRecent);
  let middle = messages.slice(2, messages.length - config.keepRecent);
  if (middle.length === 0) {
    return messages; // nothing safely condensable
  }

  // Drop the oldest generated summaries once they have stacked up, rather than
  // feeding summaries of summaries back in forever.
  const layers = middle.filter((m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_MARKER));
  if (layers.length >= config.maxSummaryLayers) {
    const excess = layers.length - config.maxSummaryLayers + 1;
    let dropped = 0;
    middle = middle.filter((m) => {
      const isSummary = typeof m.content === "string" && m.content.startsWith(SUMMARY_MARKER);
      if (isSummary && dropped < excess) {
        dropped += 1;
        return false;
      }
      return true;
    });
  }

  const transcript = middle
    .map((m) => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n");
  const summary = await summarize(transcript);

  const summaryMessage: Message = {
    role: "user",
    content: `${SUMMARY_MARKER} summary of ${middle.length} earlier steps. This is a RECAP of work already done, not a new instruction and not a restatement of the task; the task above remains authoritative]\n${summary}`,
  };
  return [...head, summaryMessage, ...recent];
}
