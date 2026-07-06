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
          const text =
            typeof result === "object" && result !== null && "text" in result
              ? String((result as { text: unknown }).text)
              : String(result ?? "");
          items.push({ kind: "thought", title: name, body: text, at });
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
        const output = (event.data as
          | { output?: { summary?: string; pr?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } } }
          | undefined)?.output;
        const extras: string[] = [];
        if (output?.pr !== undefined && output.pr !== null) extras.push(`PR: ${output.pr}`);
        const usage = output?.usage;
        if (usage !== undefined) {
          const cache = usage.cacheReadTokens !== undefined ? `, cache-read ${usage.cacheReadTokens}` : "";
          extras.push(`tokens: ${usage.inputTokens} in / ${usage.outputTokens} out${cache}`);
        }
        const body = [output?.summary ?? "", extras.join(" · ")].filter((s) => s !== "").join("\n\n");
        items.push({ kind: "done", title: "completed", body, at });
        break;
      }
      case "run-cancelled": {
        const reason = (event.data as { reason?: string | null } | undefined)?.reason;
        items.push({ kind: "error", title: "cancelled", body: reason ?? "", at });
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
