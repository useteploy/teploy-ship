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
    case "investigate": return "Answer the user's question directly using the repository and observed evidence. Cite relevant file paths and lines, explain uncertainty, and suggest next steps. Do not broaden this into an unrelated repository audit. Do not publish changes.";
    case "plan": return "Produce a plan, not an implementation. Investigate the current project, state assumptions and open questions, propose scoped steps and acceptance checks, and explain tradeoffs in plain language. Do not modify tracked files or publish changes. The user will decide whether to implement in a separate task.";
    case "review": return "Review the requested scope for concrete defects. Give file locations, impact, evidence and suggested fixes. Distinguish verified defects from questions. Do not implement or publish changes.";
    case "change": return "Make the requested focused change using the project's existing conventions. Ask when a material requirement is unclear. Verify the relevant behavior and explain the result in plain language, including what could not be verified.";
  }
}
