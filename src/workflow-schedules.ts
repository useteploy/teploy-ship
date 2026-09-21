import { JOURNEYS, type Journey } from "./journeys.js";
import type { ShipRuntime } from "./runtime.js";
export interface WorkflowSchedule {
  id: string;
  name: string;
  repo: string;
  task: string;
  mode: "fix" | "scan";
  journey?: Journey;
  plan: boolean;
  everyMinutes: number;
  enabled: boolean;
  createdAt: string;
  by: string;
}
export const scheduleKey = (id: string) => "SHIP_SCHEDULE_DEF_" + id;
export function validSchedule(v: any): v is WorkflowSchedule {
  return (
    v &&
    /^[a-z0-9-]{1,70}$/.test(v.id) &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= 100 &&
    typeof v.repo === "string" &&
    typeof v.task === "string" &&
    v.task.length > 0 &&
    v.task.length <= 12000 &&
    ["fix", "scan"].includes(v.mode) &&
    (v.journey === undefined || JOURNEYS.some(j => j.id === v.journey)) &&
    typeof v.plan === "boolean" &&
    typeof v.enabled === "boolean" &&
    Number.isInteger(v.everyMinutes) &&
    v.everyMinutes >= 60 &&
    v.everyMinutes <= 44640 &&
    Number.isFinite(Date.parse(v.createdAt))
  );
}
export async function workflowSchedules(
  runtime: Pick<ShipRuntime, "config">,
): Promise<WorkflowSchedule[]> {
  const entries = (await runtime.config.list()).filter((k) =>
    k.key.startsWith("SHIP_SCHEDULE_DEF_"),
  );
  const out: WorkflowSchedule[] = [];
  for (const e of entries) {
    const raw = await runtime.config.get(e.key);
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (validSchedule(v)) out.push(v);
      } catch {}
    }
  }
  return out;
}
/** Missed intervals coalesce to the current one; no catch-up storm after downtime. */
export async function sweepWorkflowSchedules(
  runtime: Pick<ShipRuntime, "config" | "intake" | "projects">,
  now = Date.now(),
): Promise<void> {
  for (const s of await workflowSchedules(runtime)) {
    if (!s.enabled) continue;
    const project = await runtime.projects.forRepo(s.repo);
    if (!project?.url) continue;
    const period = s.everyMinutes * 60000,
      slot = Math.floor((now - Date.parse(s.createdAt)) / period);
    if (slot < 1) continue;
    const receipt = "SHIP_SCHEDULE_RECEIPT_" + s.id;
    if ((await runtime.config.get(receipt)) === String(slot)) continue;
    await runtime.intake.propose({
      source: "workflow",
      kind: s.journey ? `request-${s.journey}` :
        s.mode === "scan"
          ? "workflow-scan"
          : s.plan
            ? "workflow-plan"
            : "workflow-fix",
      repo: project.url,
      title: s.name,
      detail: s.task,
      dedupeKey: `workflow:${s.id}:${slot}`,
      requestedBy: s.by,
    });
    await runtime.config.set(receipt, String(slot));
  }
}
