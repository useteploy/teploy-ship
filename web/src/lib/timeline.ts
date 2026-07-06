import type { WorkflowEvent } from "@neutron-build/workflow";

export interface TimelineItem {
  kind: "task" | "thought" | "action-result" | "approval" | "decision" | "done" | "error" | "note";
  title: string;
  body: string;
  at: string;
}

/**
 * Project the workflow event log into what an operator wants to read.
 * turn-N-think steps carry the model's full response (thought + the
 * fenced action); turn-N-exec steps carry the execution result; the
 * park/decision pair brackets approvals.
 */
export function toTimeline(events: WorkflowEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    const at = event.at;
    switch (event.type) {
      case "run-started": {
        const input = (event.data as { input?: { task?: string } } | undefined)?.input;
        items.push({ kind: "task", title: "task", body: input?.task ?? "", at });
        break;
      }
      case "step-completed": {
        const name = event.name ?? "";
        const result = (event.data as { result?: unknown } | undefined)?.result;
        if (/-think$/.test(name)) {
          items.push({ kind: "thought", title: name, body: String(result ?? ""), at });
        } else if (/-exec$/.test(name)) {
          const r = result as { exitCode?: number; stdout?: string; stderr?: string } | string | undefined;
          if (typeof r === "object" && r !== null && "exitCode" in r) {
            const parts = [`exit ${r.exitCode}`];
            if (r.stdout !== undefined && r.stdout !== "") parts.push(`stdout:\n${r.stdout}`);
            if (r.stderr !== undefined && r.stderr !== "") parts.push(`stderr:\n${r.stderr}`);
            items.push({ kind: "action-result", title: name, body: parts.join("\n"), at });
          } else {
            items.push({ kind: "action-result", title: name, body: String(r ?? ""), at });
          }
        } else if (name === "sandbox" || /-snapshot$/.test(name) || /-restore$/.test(name)) {
          items.push({ kind: "note", title: name, body: String(result ?? ""), at });
        } else {
          items.push({ kind: "note", title: name, body: JSON.stringify(result ?? null, null, 2), at });
        }
        break;
      }
      case "step-failed": {
        const data = event.data as { error?: { message?: string }; attempt?: number } | undefined;
        items.push({
          kind: "error",
          title: `${event.name ?? "step"} failed (attempt ${data?.attempt ?? "?"})`,
          body: data?.error?.message ?? "",
          at,
        });
        break;
      }
      case "event-waiting":
        items.push({ kind: "approval", title: "waiting for approval", body: event.name ?? "", at });
        break;
      case "event-received": {
        const payload = (event.data as { payload?: { approved?: boolean; reason?: string } } | undefined)?.payload;
        items.push({
          kind: "decision",
          title: payload?.approved === true ? "approved" : "denied",
          body: payload?.reason ?? "",
          at,
        });
        break;
      }
      case "run-completed": {
        const output = (event.data as { output?: { summary?: string } } | undefined)?.output;
        items.push({ kind: "done", title: "completed", body: output?.summary ?? "", at });
        break;
      }
      case "run-failed": {
        const error = (event.data as { error?: { detail?: string; title?: string } } | undefined)?.error;
        items.push({ kind: "error", title: "run failed", body: error?.detail ?? error?.title ?? "", at });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

export function itemClass(kind: TimelineItem["kind"]): string {
  switch (kind) {
    case "thought":
      return "thought";
    case "action-result":
      return "action";
    case "approval":
      return "approval";
    case "decision":
      return "approval";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "observation";
  }
}
