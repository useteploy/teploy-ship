/** User intent, independent of executor choice. Safe to import in the browser. */
export const JOURNEYS = [
  { id: "change", label: "Make a change", description: "Update wording, fix a problem, or add something to your project.", outcome: "A proposed change for review" },
  { id: "investigate", label: "Ask a question", description: "Understand how something works or investigate a problem.", outcome: "An answer with supporting evidence" },
  { id: "plan", label: "Make a plan", description: "Explore an idea and work out what it would take before changing anything.", outcome: "A plan you can discuss and turn into work" },
  { id: "review", label: "Review work", description: "Check an existing project or pull request for concrete problems.", outcome: "Findings and suggested next steps" },
] as const;
export type Journey = typeof JOURNEYS[number]["id"];
export function parseJourney(value: unknown): Journey {
  if (!JOURNEYS.some(j => j.id === value)) throw new Error("Choose a supported task type");
  return value as Journey;
}
export function journeyOptions(journey: Journey) {
  return { journey, mode: journey === "change" ? "fix" as const : "scan" as const };
}
/** Preserve intent through manual approval AND automatic intake. */
export function intakeJourney(kind: string) {
  if (kind.startsWith("request-")) return journeyOptions(parseJourney(kind.slice(8)));
  return kind === "workflow-scan" ? { mode: "scan" as const } : kind === "workflow-plan" ? { plan: true } : {};
}
export function journeyInstruction(journey: Journey): string {
  switch (journey) {
    case "investigate": return "Answer the user's question in plain language, starting with a short direct answer. Put file references and technical details in a supporting section. Distinguish behavior actually tested from conclusions based on reading code; do not claim a test proved something it did not exercise. Stay within the question, and do not add an unsolicited defect audit or speculative findings. Do not publish changes.";
    case "plan": return "Produce a plan, not an implementation. Investigate the current project, state assumptions and open questions, propose scoped steps and acceptance checks, and explain tradeoffs in plain language. Do not modify tracked files or publish changes. The user will decide whether to implement through an explicitly authorized follow-up. Planning alone grants no implementation, merge or deployment permission.";
    case "review": return "Review the requested scope for concrete defects. For a pull request, compare its head with the base and prioritize regressions introduced by that diff; clearly separate any relevant pre-existing issues instead of attributing them to this change. Give file locations, impact, evidence and suggested fixes. Distinguish behavior reproduced in tests from code-reading conclusions and open questions. Do not implement or publish changes.";
    case "change": return "Make the requested focused change using the project's existing conventions. Before editing, inspect the relevant code and state a concise approach: the requested outcome, intended scope, and how you will verify it. A small request still needs this planning; one or two sentences can be enough. Do not infer low risk from short wording, few changed lines or a cosmetic label: pricing, permissions, shared styles, accessibility and data behavior may have wider effects. Resolve questions from the code where possible; ask when a material requirement or authority is unclear, and stop with an explanation if clarification is unavailable. If the necessary work exceeds the authorized scope, explain the new scope before proceeding. Honor any required plan checkpoint; do not treat planning, verification, publication, merge and deployment as interchangeable approvals. Verify the relevant behavior and explain the result in plain language, including what could not be verified.";
  }
}
