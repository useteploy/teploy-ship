import { transcriptTurn } from "../../../dist/actions.js";
/** Read-only projections of recorded work. Never infer a passing check from agent prose. */
export interface LogEvent {
  type: string;
  name?: string;
  at: string;
  data?: unknown;
}
export interface Message {
  role: "You" | "Agent" | "Decision";
  text: string;
  at: string;
  detail?: string;
}
export interface DiffSnapshot {
  name: string;
  at: string;
  diff: string;
  truncated: boolean;
}
export interface Check {
  name: string;
  state: string;
  detail: string;
  output?: string;
}
export interface Evidence {
  unattached: string[];
  videos: { name: string; href: string }[];
  checks: Check[];
  images: { name: string; href: string }[];
  preview?: string;
  pr?: string;
  sha?: string;
}
const record = (v: unknown): Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\/api\/artifacts\/[a-f0-9]{64}$/.test(value)) return value;
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function conversation(events: LogEvent[]): Message[] {
  const messages: Message[] = [];
  for (const e of events) {
    const d = record(e.data),
      r = d.result;
    if (e.type === "run-started" && typeof record(d.input).task === "string")
      messages.push({ role: "You", text: record(d.input).userMessage ?? record(d.input).task, at: e.at });
    if (
      e.type === "step-completed" &&
      /-steer$/.test(e.name ?? "") &&
      Array.isArray(r)
    )
      for (const text of r)
        if (typeof text === "string")
          messages.push({ role: "You", text, at: e.at });
    if (
      e.type === "step-completed" &&
      (/-think$/.test(e.name ?? "") || e.name === "plan-think")
    ) {
      const raw = typeof r === "string" ? r : record(r).text;
      if (typeof raw === "string") {
        // Commands stay in Activity; retain the human-readable progress and questions.
        const consumed = /(?:^|-)plan-think$/.test(e.name ?? "") ? raw : transcriptTurn(raw);
        const text = consumed
          .replace(/```(?:bash|python|sh|javascript|edit|create)[^\n]*\n[\s\S]*?```/g, "")
          .trim();
        if (text)
          messages.push({
            role: "Agent",
            text: text.slice(0, 12000),
            at: e.at,
          });
      }
    }
    if (e.type === "event-received") {
      const p = record(d.payload);
      messages.push({
        role: "Decision",
        text:
          typeof p.answer === "string"
            ? p.answer
            : `${p.approved === true ? "Approved" : "Declined"}${p.reason ? ": " + p.reason : ""}`,
        at: e.at,
      });
    }
    if (e.type === "run-completed") {
      const o = record(d.output);
      const text = o.agentSummary ?? o.summary;
      if (typeof text === "string")
        messages.push({ role: "Agent", text, at: e.at });
    }
  }
  return messages;
}
export function diffSnapshots(events: LogEvent[]): DiffSnapshot[] {
  const snapshots: DiffSnapshot[] = [];
  for (const e of events) {
    if (e.type !== "step-completed") continue;
    const r = record(e.data).result;
    const diff =
      typeof r === "string" && /diff/.test(e.name ?? "") ? r : record(r).diff;
    if (typeof diff !== "string" || !diff.includes("diff --git ")) continue;
    snapshots.push({
      name: e.name ?? "Recorded diff",
      at: e.at,
      diff: diff.slice(0, 200000),
      truncated:
        diff.length > 200000 || /truncated|omitted from the middle/i.test(diff),
    });
  }
  return snapshots.reverse();
}
export function splitDiff(diff: string): { file: string; lines: string[] }[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((s) => s.startsWith("diff --git "))
    .map((s) => ({
      file:
        s
          .split("\n")
          .find((l) => l.startsWith("+++ "))
          ?.replace(/^\+\+\+ (?:b\/)?/, "") ??
        s.split("\n")[0].replace("diff --git ", ""),
      lines: s.split("\n"),
    }));
}
export function evidence(facts: Record<string, any>, reviewedHead?: string): Evidence {
  const checks: Check[] = [];
  for (const [key, name] of [
    ["preparation", "Environment setup"],
    ["environmentCheck", "Environment tests"],
    ["baseline", "Baseline tests"],
    ["build", "Build"],
    ["tests", "Tests"],
    ["preview", "Preview"],
    ["smoke", "Smoke test"],
    ["visual", "Visual comparison"],
    ["flow", "Browser flow"],
    ["observeWindow", "Telemetry"],
    ["merge", "Merge"],
    ["rollback", "Recovery"],
  ]) {
    const v = record(facts[key]);
    checks.push({
      name,
      state: typeof v.kind === "string" ? v.kind : "not recorded",
      detail: [
        key === "preview" && typeof v.revision === "string" ? `Revision ${v.revision}` : undefined,
        key === "preview" && typeof v.image === "string" ? `Image ${v.image}` : undefined,
        v.command,
        v.script,
        v.reason,
        Array.isArray(v.reasons) ? v.reasons.join("; ") : undefined,
        v.kind === "captured"
          ? v.differs
            ? "Screenshots differ — review required"
            : "Screenshots match"
          : undefined,
      ]
        .filter((x) => typeof x === "string")
        .join(" · "),
      ...(typeof v.output === "string"
        ? { output: v.output.slice(0, 20000) }
        : {}),
    });
  }
  const images: Evidence["images"] = [];
  const visual = record(facts.visual),
    flow = record(facts.flow);
  for (const [name, v] of [
    ["Before", visual.main],
    ["After", visual.preview],
  ] as const) {
    const href = safeLink(record(v).asset);
    if (href) images.push({ name, href });
  }
  if (Array.isArray(flow.shots))
    for (const shot of flow.shots) {
      const s = record(shot),
        href = safeLink(s.asset);
      if (href)
        images.push({ name: String(s.name ?? "Browser screenshot"), href });
    }
  const videos: Evidence["videos"] = Array.isArray(flow.videos)
    ? flow.videos.flatMap((v: unknown) => {
        const s = record(v),
          href = safeLink(s.asset);
        return href
          ? [{ name: String(s.name ?? "Browser recording"), href }]
          : [];
      })
    : [];
  return {
    unattached: [
      ...(Array.isArray(flow.shots) ? flow.shots : []),
      ...(Array.isArray(flow.videos) ? flow.videos : []),
      ...(visual.kind === "captured" ? [visual.main, visual.preview] : []),
    ]
      .filter((v) => !safeLink(record(v).asset))
      .map((v) => String(record(v).name ?? "Visual capture")),
    checks,
    images,
    videos,
    preview: safeLink(record(facts.preview).url),
    pr: safeLink(record(facts.pr).url),
    sha:
      record(facts.push).kind === "pushed" ? record(facts.push).sha : typeof reviewedHead === "string" && /^[a-f0-9]{7,64}$/i.test(reviewedHead) ? reviewedHead : undefined,
  };
}


/** Recovery evidence is historical; a recorded snapshot is not a live TTL check. */
export function workspaceRecovery(events: LogEvent[]): { snapshotAt?: string; restoredAt?: string; checked: boolean; warm: boolean } {
  const input = record(record(events.find(e => e.type === "run-started")?.data).input);
  const snapshots = events.filter(e => e.type === "step-completed" && /-snapshot$/.test(e.name ?? ""));
  const restores = events.filter(e => e.type === "step-completed" && /-restore$/.test(e.name ?? ""));
  return { snapshotAt: snapshots.at(-1)?.at, restoredAt: restores.at(-1)?.at, checked: restores.length > 0 && input.restoreValidation === 1, warm: input.warm === true };
}
