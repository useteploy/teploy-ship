import type { GenerateTextResult, ModelAdapter } from "@neutron-build/ai";
import type { LoadedAgent } from "@neutron-build/agents";
import { defineTeam, pipeline, runTeamTurn } from "@neutron-build/agents";

/**
 * Post-finish critic pass: an independent reviewer checks the agent's
 * claimed-done work before it ships — the proposer/critic/verifier
 * pattern, built on Team/TeamPolicy (@neutron-build/agents), applied at
 * the one place Ship's CodeAct loop had no independent correctness check
 * beyond its own prompt-level "prove it" nudge (see FINISH_NUDGE_VERIFY
 * in actions.ts).
 *
 * This deliberately does NOT use roundtrip(): roundtrip()'s `from` member
 * is a single LoadedAgent turn, but Ship's real "proposer" is the whole
 * many-turn sandboxed CodeAct loop (bash/edit/create against a live
 * executor) — there's no single-call agent to plug in as the revising
 * party without reimplementing that loop as a member runner. Instead this
 * is a single-member team (pipeline() over one member — the primitive's
 * own degenerate case, see the "solo agent" test in
 * neutron-agents/src/m2plus.test.ts) that produces one verdict; the
 * caller's own loop already owns "send it back for one more attempt" via
 * the same nudge-and-continue mechanism it uses for FINISH_NUDGE_*.
 */

export const CRITIC_APPROVE_TOKEN = "APPROVE";

const CRITIC_INSTRUCTIONS =
  "You are an independent reviewer checking another agent's work before it ships. You did not write " +
  "this code and have no stake in it looking good — be skeptical. Verify the diff actually accomplishes " +
  "the stated task; do not assume claims in the summary are true just because they are stated confidently. " +
  `Reply with exactly "${CRITIC_APPROVE_TOKEN}" (and nothing else) if the change is correct and complete. ` +
  "Otherwise, reply with specific, actionable feedback describing exactly what is wrong or missing — no " +
  "code, just the assessment.";

export interface ReviewInput {
  task: string;
  /** The agent's own finish message. */
  summary: string;
  /** Working-tree diff of the changes being reviewed (see git.ts's workingDiff). */
  diff: string;
}

function reviewPrompt(input: ReviewInput): string {
  return `Task:\n${input.task}\n\nThe agent says it is done:\n${input.summary}\n\nDiff of the changes made:\n${input.diff}`;
}

/** One independent review pass over a claimed-done diff. */
export function reviewWork(model: ModelAdapter, input: ReviewInput): Promise<GenerateTextResult> {
  const critic: LoadedAgent = {
    definition: { name: "critic", model, maxSteps: 1 },
    instructions: CRITIC_INSTRUCTIONS,
    tools: [],
  };
  const team = defineTeam({ name: "ship-critic", members: { critic }, policy: pipeline(["critic"]) });
  return runTeamTurn(team, { input: reviewPrompt(input) });
}

/**
 * Whether a verdict approves the work.
 *
 * An exact match, deliberately not a substring test: the critic is told to
 * reply with exactly "APPROVE" and nothing else, so a verdict that merely
 * contains the word — "I cannot APPROVE this, the fix is wrong" — is a
 * rejection. Testing with includes() reads that as approval and ships the
 * broken change, which is the single failure this gate exists to prevent, so
 * anything that looks like prose means rework. Case and a trailing sentence
 * mark are tolerated; that costs nothing and spares a rework cycle when the
 * model answers "Approve." instead.
 */
export function isApproved(review: string): boolean {
  const normalize = (s: string): string => s.trim().replace(/[.!]+$/, "").trim().toUpperCase();
  if (normalize(review) === CRITIC_APPROVE_TOKEN) return true;
  // Also accept the token alone on the final line: reasoning-then-verdict is
  // how models naturally answer, and a verdict on its own line is still
  // unambiguous. Inline mentions ("Looks correct. APPROVE") are NOT accepted —
  // once the token can sit inside a sentence there is no way to tell it apart
  // from "I cannot APPROVE this", which is the case that must never pass.
  const lines = review.trim().split("\n").filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1];
  return last !== undefined && normalize(last) === CRITIC_APPROVE_TOKEN;
}

/**
 * The nudge pushed back into the loop when the critic does not approve.
 * Kept here (not actions.ts) because, unlike FINISH_NUDGE_*, its text
 * depends on the critic's own review.
 */
export function criticFeedback(review: string): string {
  return `An independent review of your changes found problems:\n\n${review.trim()}\n\nAddress this feedback — make the necessary changes and verify them — then finish again.`;
}
