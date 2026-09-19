export const RUN_FILTERS = ["all", "active", "waiting", "completed", "failed", "cancelled"] as const;
export type RunFilter = typeof RUN_FILTERS[number];
export function runCategory(status: string): RunFilter {
  return ["waiting", "completed", "failed", "cancelled"].includes(status) ? status as RunFilter : "active";
}
export function filterRuns<T extends { runId: string; task: string; model: string; status: string }>(runs: T[], status: string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return runs.filter(run => (status === "all" || runCategory(run.status) === status) && (!q || `${run.runId} ${run.task} ${run.model}`.toLowerCase().includes(q)));
}
