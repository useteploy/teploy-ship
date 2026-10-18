import { parseReply, transcriptTurn } from "../../../dist/actions.js";
import { frameAllowed } from "./csp.js";
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
/**
 * The reply dialect a run's recorded input admits — the loop's own parse
 * settings (actions.ts parseReply), read the same way here and in the thread
 * view so both render exactly what the loop delivered.
 */
export function replyDialectOf(input: Record<string, unknown>): { look: boolean; delegate: boolean; reply: true } {
  return { look: input.look === true, delegate: input.delegate === true || input.delegateChild === true, reply: true };
}

/** One ```reply fence, body captured. */
const REPLY_FENCE = /```reply[^\n]*\n([\s\S]*?)```/g;

/**
 * Inline the ONE reply the loop accepted. parseReply (the loop's own parse,
 * shared with replyHistory) already decided what that reply is; a second
 * fence in the same turn was never delivered, so it is dropped rather than
 * shown as a second message to the operator.
 */
function renderReply(stripped: string, reply: string): string {
  let first = true;
  return stripped.replace(REPLY_FENCE, (fence) => {
    if (first) {
      first = false;
      return reply;
    }
    return "";
  });
}

export function conversation(events: LogEvent[]): Message[] {
  const messages: Message[] = [];
  // D2: on a two-way-steering run (input.steerReply) a ```reply is the
  // agent talking to the operator, so it is shown as prose, and the held
  // steps' queued messages / interrupts are the operator's. Absent the
  // field nothing below changes what a run renders.
  let steerReply = false;
  let replyDialect: { look: boolean; delegate: boolean; reply: true } | null = null;
  for (const e of events) {
    const d = record(e.data),
      r = d.result;
    if (e.type === "run-started") {
      steerReply = record(d.input).steerReply === true;
      if (steerReply) replyDialect = replyDialectOf(record(d.input));
    }
    if (e.type === "run-started" && typeof record(d.input).task === "string")
      messages.push({ role: "You", text: record(d.input).userMessage ?? record(d.input).task, at: e.at });
    if (
      steerReply &&
      e.type === "step-completed" &&
      /-held$/.test(e.name ?? "") &&
      Array.isArray(r)
    )
      for (const item of r) {
        const h = record(item);
        if (typeof h.text !== "string") continue;
        if (h.mode === "queue") messages.push({ role: "You", text: h.text, at: e.at });
        else if (h.mode === "interrupt") messages.push({ role: "You", text: h.text === "" ? "(interrupt)" : `(interrupt) ${h.text}`, at: e.at });
      }
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
        const stripped = consumed
          .replace(/```(?:bash|python|sh|javascript|edit|create)[^\n]*\n[\s\S]*?```/g, "");
        // The reply shown is exactly what the loop delivered: parseReply
        // reads the FIRST reply fence before the action, so a second fence
        // (never delivered) is dropped rather than rendered as one more
        // message. A flag-on turn the loop read as having no reply keeps
        // the old inline shape; a flag-off run keeps the fence as literal
        // text, exactly as before the feature.
        const reply = replyDialect !== null ? parseReply(raw, replyDialect) : null;
        const text = (replyDialect === null
          ? stripped
          : reply !== null
            ? renderReply(stripped, reply)
            : stripped.replace(REPLY_FENCE, "$1")
        ).trim();
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
  // A recording stored without a public link is still on the run page, by
  // its artifact id on the same access-checked route.
  const recordingHref = (s: Record<string, any>) =>
    safeLink(s.asset) ??
    (typeof s.artifact === "string" ? safeLink(`/api/artifacts/${s.artifact}`) : undefined);
  const videos: Evidence["videos"] = Array.isArray(flow.videos)
    ? flow.videos.flatMap((v: unknown) => {
        const s = record(v),
          href = recordingHref(s);
        return href
          ? [{ name: String(s.name ?? "Browser recording"), href }]
          : [];
      })
    : [];
  return {
    unattached: [
      ...(Array.isArray(flow.shots) ? flow.shots : []).filter((v: unknown) => !safeLink(record(v).asset)),
      ...(Array.isArray(flow.videos) ? flow.videos : []).filter((v: unknown) => !recordingHref(record(v))),
      ...(visual.kind === "captured" ? [visual.main, visual.preview] : []).filter((v: unknown) => !safeLink(record(v).asset)),
    ]
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

/**
 * What the run page's preview panel shows (DELEGATED_DECISIONS_2026-09-23
 * §10). Read from recorded steps only; `now` decides expiry against the TTL
 * the CLI reported. The panel frames the preview's OWN hostname — never a
 * dashboard path — so agent-written code never runs on the dashboard origin.
 */
export type PreviewPanel =
  | { state: "none" }
  | { state: "deploying" }
  | { state: "not-deployed"; reason: string }
  | { state: "failed"; reason: string }
  | { state: "deployed"; url: string; expiresAt?: string; blocked?: string }
  | { state: "expired"; url: string; expiresAt: string }
  | { state: "removed"; url: string; reason: string }
  /** A newer revision of the same pull request deployed its own preview and removed this one (preview-supersede.ts). */
  | { state: "superseded"; url: string; byRunId: string; revision?: string };

export function previewPanel(
  events: LogEvent[],
  facts: Record<string, any>,
  opts: {
    executing: boolean;
    now: number;
    dashboardOrigin: string;
    frameBase?: string;
    /** The mark a newer run left when it removed this run's preview. */
    superseded?: { byRunId: string; revision?: string };
  },
): PreviewPanel {
  const input = record(record(events.find((e) => e.type === "run-started")?.data).input);
  const declared = input.preview === true || record(input.verification).preview !== undefined;
  const p = record(facts.preview);
  if (p.kind === undefined) {
    if (!declared) return { state: "none" };
    return opts.executing
      ? { state: "deploying" }
      : { state: "not-deployed", reason: "The run ended before a preview was deployed." };
  }
  if (p.kind === "failed") return { state: "failed", reason: String(p.reason ?? "") };
  if (p.kind !== "deployed") return { state: "not-deployed", reason: String(p.reason ?? "") };
  const url = safeLink(p.url);
  if (url === undefined || url.startsWith("/")) {
    return { state: "failed", reason: "The preview step recorded a URL this page will not open." };
  }
  const observed = record(facts.observeWindow);
  const rollback = record(facts.rollback);
  if (observed.kind === "worse" && record(observed.rollback).kind === "rolled-back") {
    return { state: "removed", url, reason: "The observe window judged the preview worse and tore it down." };
  }
  if (rollback.kind === "rolled-back" && rollback.scope === "preview") {
    return { state: "removed", url, reason: "The preview regressed and was removed by recovery." };
  }
  if (opts.superseded !== undefined) {
    return {
      state: "superseded",
      url,
      byRunId: opts.superseded.byRunId,
      ...(opts.superseded.revision !== undefined ? { revision: opts.superseded.revision } : {}),
    };
  }
  const expiresAt = typeof p.expiresAt === "string" && !Number.isNaN(Date.parse(p.expiresAt)) ? p.expiresAt : undefined;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= opts.now) return { state: "expired", url, expiresAt };
  let dashboard = opts.dashboardOrigin;
  try {
    dashboard = new URL(opts.dashboardOrigin).origin;
  } catch {
    // Compare as given.
  }
  const blocked =
    new URL(url).origin === dashboard
      ? "The preview shares this dashboard's origin, so it is not framed here: code in it would run with your session. Open it in a tab."
      : !frameAllowed(url, opts.frameBase)
        ? opts.frameBase === undefined
          ? "This dashboard frames only tailnet previews, and SHIP_PREVIEW_TAILNET_IP is not set on its web process. Open it in a tab."
          : `This dashboard frames only previews under ${opts.frameBase}, and this one is not. Open it in a tab.`
      : opts.dashboardOrigin.startsWith("https:") && url.startsWith("http:")
        ? "This dashboard is served over HTTPS and the preview over HTTP, so the browser would block the frame as mixed content. Open it in a tab."
        : undefined;
  return {
    state: "deployed",
    url,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  };
}
