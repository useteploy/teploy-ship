import type { GenerateTextResult, ModelAdapter, Tool } from "@neutron-build/ai";
import { jsonSchema, tool } from "@neutron-build/ai";
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

/**
 * Appended when the reviewer has `read_file`. Kept separate from the base
 * instructions so a toolless critic is not told about a tool it does not have.
 */
const CRITIC_TOOL_INSTRUCTIONS =
  " You can call read_file to read any file in the workspace by repo-relative path. A diff shows changed " +
  "lines without their surroundings, so use it when the change's correctness depends on code the diff does " +
  "not show — the rest of the function it edits, the caller it must stay compatible with, the test that " +
  "covers it, or a file the diff omitted. Read before you object: an objection you could have checked and " +
  "did not is worse than no objection. Then give your verdict in the format above.";

/**
 * Appended when the run has a suite result. The suite is the single most
 * informative signal available about whether a change works, and it used to be
 * produced AFTER this review — so the reviewer's verdict was formed without
 * it, and a change that broke the build could be approved.
 */
const CRITIC_EVIDENCE_INSTRUCTIONS =
  " The project's own test suite was run over exactly this diff, by the harness rather than by the agent, " +
  "and its result is given below. Treat it as fact, not as a claim. A suite that FAILED is grounds to " +
  "reject unless you can show the failure is unrelated to this change; a suite that passed is evidence " +
  "but not proof, since the change may not be covered by any test.";

export interface ReviewInput {
  task: string;
  /** The agent's own finish message. */
  summary: string;
  /** Working-tree diff of the changes being reviewed (see git.ts's workingDiff). */
  diff: string;
  /**
   * The suite's verdict over this same diff, already rendered for a human
   * (tests.ts's testComment). Absent when the run has no suite configured, or
   * when the review is not a repo run.
   */
  evidence?: string;
}

/**
 * How many model turns the reviewer gets. One when it has no tools — there is
 * nothing to do with a second. A handful when it can read files, which is
 * enough to open the function under edit, its caller and its test without
 * turning the review into a second agent loop.
 */
export const CRITIC_MAX_STEPS_WITH_TOOLS = 6;

export interface ReviewOptions {
  /**
   * Read a workspace file by repo-relative path, for the reviewer's own
   * `read_file` tool. Omit and the reviewer judges on the diff alone, exactly
   * as before.
   */
  readFile?: (path: string) => Promise<string>;
  maxSteps?: number;
}

function reviewPrompt(input: ReviewInput): string {
  const evidence =
    input.evidence !== undefined && input.evidence.trim() !== ""
      ? `\n\nThe project's test suite, run by the harness over exactly this diff:\n${input.evidence}`
      : "";
  return `Task:\n${input.task}\n\nThe agent says it is done:\n${input.summary}\n\nDiff of the changes made:\n${input.diff}${evidence}`;
}

/**
 * The reviewer's one tool: read a file it is judging.
 *
 * Read-only on purpose. A reviewer that can run commands is a second agent,
 * with a second agent's blast radius and a second agent's ability to talk
 * itself into approving its own workaround. Reading is the whole gap between
 * "the diff looks wrong" and "the diff IS wrong", and it is the entire reason
 * a toolless critic had to guess.
 */
export function readFileTool(readFile: (path: string) => Promise<string>, maxChars = 20_000): Tool {
  return tool({
    name: "read_file",
    description:
      "Read a file from the workspace being reviewed. Path is relative to the repository root. " +
      "Use it to see code the diff does not show.",
    inputSchema: jsonSchema<{ path: string }>({
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path, e.g. src/agent.ts" } },
      required: ["path"],
      additionalProperties: false,
    }),
    async execute(input) {
      const path = String(input?.path ?? "").trim();
      if (path === "") return "read_file needs a path.";
      try {
        const text = await readFile(path);
        // A reviewer that reads a 500 KB generated file has spent its window
        // and learned nothing; say so rather than silently feeding a prefix.
        return text.length > maxChars
          ? `${text.slice(0, maxChars)}\n... [${text.length - maxChars} more chars; read a narrower path if you need them]`
          : text;
      } catch (error) {
        // A read failure is information for the reviewer, not an error for the
        // run: "that file does not exist" is often the finding itself.
        return `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

/** One independent review pass over a claimed-done diff. */
export function reviewWork(model: ModelAdapter, input: ReviewInput, options: ReviewOptions = {}): Promise<GenerateTextResult> {
  const tools = options.readFile !== undefined ? [readFileTool(options.readFile)] : [];
  const maxSteps = options.maxSteps ?? (tools.length > 0 ? CRITIC_MAX_STEPS_WITH_TOOLS : 1);
  const instructions =
    CRITIC_INSTRUCTIONS +
    (tools.length > 0 ? CRITIC_TOOL_INSTRUCTIONS : "") +
    (input.evidence !== undefined && input.evidence.trim() !== "" ? CRITIC_EVIDENCE_INSTRUCTIONS : "");
  const critic: LoadedAgent = {
    definition: { name: "critic", model, maxSteps },
    instructions,
    tools,
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

/**
 * Multi-harness attempts (P5-4): several harnesses tried the same task in
 * their own workspaces; the critic picks the diff to publish. Reply format is
 * one line, "ATTEMPT <n>", so the choice parses without ambiguity.
 */
export interface PickCandidate {
  /** 1-based label the model answers with. */
  attempt: number;
  harness: string;
  summary: string;
  diff: string;
}

export const PICK_INSTRUCTIONS =
  "You are a strict code reviewer choosing between several candidate changes for the same task, each made independently. " +
  "Judge correctness and completeness against the task first, then minimality and style. " +
  "Do not reward length. A candidate that changes nothing relevant loses. " +
  "Reply with exactly one line: ATTEMPT <n> — the number of the candidate to publish — and nothing else.";

export function pickPrompt(task: string, candidates: PickCandidate[], maxDiffChars = 12_000): string {
  const per = Math.max(1000, Math.floor(maxDiffChars / Math.max(1, candidates.length)));
  const blocks = candidates.map((c) => {
    const diff = c.diff.length > per ? `${c.diff.slice(0, per)}\n... [${c.diff.length - per} chars truncated]` : c.diff;
    return `## ATTEMPT ${c.attempt} (harness: ${c.harness})\n\nSummary: ${c.summary.slice(0, 600)}\n\n\`\`\`diff\n${diff}\n\`\`\``;
  });
  return `Task:\n${task}\n\n${blocks.join("\n\n")}\n\nWhich attempt should be published? Reply: ATTEMPT <n>`;
}

export function pickAttempt(model: ModelAdapter, input: { task: string; candidates: PickCandidate[] }): Promise<GenerateTextResult> {
  const picker: LoadedAgent = {
    definition: { name: "picker", model, maxSteps: 1 },
    instructions: PICK_INSTRUCTIONS,
    tools: [],
  };
  const team = defineTeam({ name: "ship-picker", members: { picker }, policy: pipeline(["picker"]) });
  return runTeamTurn(team, { input: pickPrompt(input.task, input.candidates) });
}

/** The chosen 1-based attempt from a verdict, or null when it does not name one of `valid`. */
export function parsePick(text: string, valid: number[]): number | null {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "");
  // Verdict on the last line, like the critic: reasoning-then-answer is how
  // models naturally reply, and only the last line is unambiguous.
  const last = lines[lines.length - 1] ?? "";
  const m = /^ATTEMPT\s+(\d+)\b/i.exec(last) ?? /^ATTEMPT\s+(\d+)\b/im.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  return valid.includes(n) ? n : null;
}
