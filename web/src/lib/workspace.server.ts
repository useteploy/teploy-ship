import {
  requestWorkspace,
  workspaceReply,
  replyKey,
  refreshForgeIfStale,
} from "../../../dist/workspace-requests.js";
import type { ShipRuntime } from "teploy-ship/runtime";
export { requestWorkspace, workspaceReply, refreshForgeIfStale };
export async function freshForge(
  runtime: ShipRuntime,
  runId: string,
  by: string,
) {
  const request = await requestWorkspace(runtime, runId, "forge", by);
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const reply = await workspaceReply(runtime, runId);
    if (reply?.id === request.id) {
      if (reply.error || !reply.forge)
        throw new Error(reply.error ?? "No forge result");
      return reply.forge;
    }
  }
  throw new Error(
    "Waiting for the worker to check this pull request. Refresh and retry, or choose the default branch.",
  );
}
export async function threadHistory(runtime: ShipRuntime, runId: string) {
  const seen = new Set<string>();
  const history: {
    runId: string;
    task: string;
    result: string;
    events: any[];
  }[] = [];
  let next: string | undefined = runId;
  for (let i = 0; next && i < 20 && !seen.has(next); i++) {
    seen.add(next);
    const events = await runtime.store.load(next);
    const input = (events.find((e) => e.type === "run-started")?.data as any)
      ?.input;
    const output = (events.find((e) => e.type === "run-completed")?.data as any)
      ?.output;
    history.unshift({
      runId: next,
      task: String(input?.userMessage ?? input?.task ?? "").slice(0, 12000),
      result: String(
        output?.agentSummary ?? output?.summary ?? "No final result recorded",
      ).slice(0, 6000),
      events,
    });
    next =
      typeof input?.parentRunId === "string" ? input.parentRunId : undefined;
  }
  return history;
}
