import type { StackProposal } from "../../../dist/stack-propose.js";

/**
 * View model for the setup page's "Suggested from the repository" panel
 * (SHIP_STACK_DETECT). Everything shown is a PROPOSAL with its citation; the
 * page never writes it anywhere. A person copies what they accept into the
 * form below, which is the only path to a saved project change.
 */
export interface SuggestedCommand {
  field: "preparation" | "test" | "start";
  /** undefined = nothing proposed; `why` says unknown or conflict. */
  command?: string;
  timeoutSeconds?: number;
  cite?: string;
  review?: string[];
  why?: string;
  options?: string[];
}
export interface SuggestionView {
  commands: SuggestedCommand[];
  services: { name: string; detail: string; cite: string }[];
  gaps: string[];
  notes: string[];
  digest: string;
}

const cite = (s: { file: string; line?: number; text: string }) => `${s.file}${s.line !== undefined ? `:${s.line}` : ""} ${s.text}`;

export function suggestionView(p: StackProposal): SuggestionView {
  const d = p.detection;
  const commands = (["preparation", "test", "start"] as const).map((field): SuggestedCommand => {
    const pr = d.proposals[field];
    if (pr) return { field, command: pr.command, timeoutSeconds: Math.round(pr.timeoutMs / 1000), cite: cite(pr.source), ...(pr.safety === "review" ? { review: pr.flags } : {}) };
    const conflict = d.conflicts.find((c) => c.field === field);
    if (conflict) return { field, why: `Conflicting signals, nothing chosen: ${conflict.reason}`, options: conflict.options.map((o) => `${o.command} (${o.source.file})`) };
    return { field, why: `Unknown: ${d.unknown.find((u) => u.field === field)?.reason ?? "no evidence in the repository"}` };
  });
  return {
    commands,
    services: d.services.map((s) => ({ name: s.name, detail: `${s.kind}${s.image ? ` · ${s.image}` : ""}${s.declared ? "" : " · hinted only, not declared"}`, cite: cite(s.source) })),
    gaps: p.recipe.gaps,
    notes: p.notes,
    digest: (p.recipeDigest ?? p.inputsDigest).digest,
  };
}
