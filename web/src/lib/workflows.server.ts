import type { Journey } from "teploy-ship/journeys";
import type { ShipRuntime } from "teploy-ship/runtime";
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  task: string;
  plan: boolean;
  mode: "fix" | "scan";
  custom?: boolean;
  journey?: Journey;
}
export const BUILTIN_WORKFLOWS: WorkflowTemplate[] = [
  { id: "wording", name: "Update wording", description: "Change text on a page while keeping the existing design.", task: "On [page], change [current wording] to [new wording]. Keep the existing style and check the result.", plan: false, mode: "fix", journey: "change" },
  { id: "explain", name: "Understand a feature", description: "Get a plain-language explanation of how your project works.", task: "Explain how [feature] works for a customer. Point to the relevant implementation and call out anything you could not verify.", plan: false, mode: "scan", journey: "investigate" },
  { id: "idea", name: "Explore an idea", description: "Work out the approach and open questions before making changes.", task: "We would like [outcome]. Explore what the project already supports, suggest an approach and explain what decisions we need to make. Stop after the plan.", plan: false, mode: "scan", journey: "plan" },
  {
    id: "fix",
    name: "Fix a bug",
    description: "Reproduce, fix, and verify a reported problem.",
    task: "Problem:\n\nExpected behavior:\n\nSteps to reproduce:\n\nReproduce the issue, make a focused fix, and add or run a regression test. Report what you verified and any remaining uncertainty.",
    plan: true,
    mode: "fix",
  },
  {
    id: "feature",
    name: "Implement a feature",
    description: "Agree on a plan and build against acceptance criteria.",
    task: "Feature:\n\nAcceptance criteria:\n\nConstraints:\n\nInspect the existing implementation and follow its conventions. Implement the feature, test the acceptance criteria, and report the changes and evidence.",
    plan: true,
    mode: "fix",
  },
  {
    id: "review",
    name: "Review a repository",
    description: "Read-only findings with locations and suggested fixes.",
    task: "Review this repository for concrete correctness and reliability bugs. Read the surrounding code to validate each finding. Report severity, file and line, impact, and a suggested fix. Do not change files.",
    plan: false,
    mode: "scan",
  },
  {
    id: "tests",
    name: "Add test coverage",
    description: "Cover important behavior and failure cases.",
    task: "Area to cover:\n\nIdentify meaningful untested behavior, add focused tests, and run the relevant suite. Avoid tests that merely mirror the implementation. Report which behavior is now covered.",
    plan: true,
    mode: "fix",
  },
  {
    id: "dependency",
    name: "Update a dependency",
    description: "Make a scoped upgrade and verify compatibility.",
    task: "Dependency and target version:\n\nUpdate the requested dependency, inspect its migration guidance, adapt affected code, and run the relevant checks. Keep unrelated dependencies unchanged.",
    plan: true,
    mode: "fix",
  },
];
const PREFIX = "SHIP_WORKFLOW_";
export async function workflows(
  runtime: ShipRuntime,
): Promise<WorkflowTemplate[]> {
  const entries = (await runtime.config.list()).filter((e) =>
    e.key.startsWith(PREFIX),
  );
  const custom: WorkflowTemplate[] = [];
  for (const entry of entries) {
    const raw = await runtime.config.get(entry.key);
    if (!raw) continue;
    try {
      const t = JSON.parse(raw);
      if (validTemplate(t)) custom.push({ ...t, custom: true });
    } catch {}
  }
  return [
    ...BUILTIN_WORKFLOWS,
    ...custom.sort((a, b) => a.name.localeCompare(b.name)),
  ];
}
export function validTemplate(t: unknown): t is WorkflowTemplate {
  const v = t as WorkflowTemplate;
  return (
    !!v &&
    typeof v.id === "string" &&
    /^custom-[a-z0-9-]{1,60}$/.test(v.id) &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 100 &&
    typeof v.description === "string" &&
    v.description.length <= 300 &&
    typeof v.task === "string" &&
    v.task.trim().length > 0 &&
    v.task.length <= 12000 &&
    typeof v.plan === "boolean" &&
    ["fix", "scan"].includes(v.mode)
  );
}
export const workflowKey = (id: string) => PREFIX + id;
