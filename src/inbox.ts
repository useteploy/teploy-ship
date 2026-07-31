import type { WorkflowEvent } from "@neutron-build/workflow";

import type { RunMeta } from "./run-store.js";

/**
 * Ship's producer for the Teploy inbox contract (`_internal/INBOX_CONTRACT.md`
 * in the Teploy umbrella). The inbox is a read-side projection: everything
 * here is derived on demand from RunMeta and the existing event log, nothing
 * new is written, and deleting the feed loses nothing.
 *
 * The contract's load-bearing rule is that Ship observes parks but must never
 * cause them. Nothing in this file touches the approval policy — widening it
 * to make the feed richer would steer headless runs away from actions they
 * would otherwise take (see the denial message in agent.ts) and cost solve
 * rate on the benchmarks.
 */

export const INBOX_SCHEMA = "teploy.inbox/v1";
export const INBOX_SOURCE = "teploy-ship";

export type InboxState = "pending" | "running" | "blocked" | "succeeded" | "failed" | "canceled";

export type InboxAttention = "decision" | "failure" | "info";

export interface InboxAction {
  label: string;
  /**
   * argv, never a shell string — no shell is involved on the consumer side.
   * `{placeholder}` tokens are substituted as whole argv elements, so a
   * reason containing spaces or quotes can never become extra arguments.
   */
  run: string[];
}

export interface InboxNeeds {
  prompt: string;
  actions: InboxAction[];
}

export interface InboxItem {
  schema: string;
  source: string;
  id: string;
  kind: string;
  title: string;
  state: InboxState;
  attention: InboxAttention;
  since: string;
  updated_at: string;
  needs?: InboxNeeds;
  context?: Record<string, string>;
  link?: string;
}

export interface InboxFeed {
  schema: string;
  items: InboxItem[];
  /** True when terminal items were dropped by the caps below. */
  truncated?: boolean;
}

/** Terminal items older than this are dropped — the feed is a queue, not an archive. */
const TERMINAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_MAX_ITEMS = 100;

/**
 * Ship's run statuses onto the contract's six. Ship spells it "cancelled" and
 * the contract "canceled"; the mapping is the only place that difference is
 * allowed to exist. An unrecognized status becomes "pending" rather than
 * throwing — a feed that renders is worth more than one that 500s because a
 * new status appeared upstream.
 */
export function stateOf(status: string): InboxState {
  switch (status) {
    case "completed":
      return "succeeded";
    case "waiting":
      return "blocked";
    case "cancelled":
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return "pending";
  }
}

export function attentionOf(state: InboxState): InboxAttention {
  if (state === "blocked") return "decision";
  if (state === "failed") return "failure";
  return "info";
}

export function isTerminal(state: InboxState): boolean {
  return state === "succeeded" || state === "failed" || state === "canceled";
}

/**
 * The first fenced block of a turn's think step is the action the agent chose
 * to run, so it is also what an approval is being asked about. Same extraction
 * the web timeline does; duplicated rather than shared because the web app is
 * a separate build and src/ must not import from it.
 */
function actionOf(text: string): string {
  const fence = /```([^\n]*)\n([\s\S]*?)```/.exec(text);
  if (fence === null) return "";
  const info = (fence[1] ?? "").trim();
  const first = (fence[2] ?? "").trim().split("\n")[0] ?? "";
  // An info string carrying an argument already says what the turn does
  // ("create CHANGELOG.md"); the body would just repeat it.
  if (info.includes(" ")) return info;
  if (first === "") return info;
  return info === "" ? first : `${info}: ${first}`;
}

function thinkText(result: unknown): string {
  // Logs predating telemetry recorded the bare string; both shapes replay.
  if (typeof result === "object" && result !== null && "text" in result) {
    return String((result as { text: unknown }).text);
  }
  return String(result ?? "");
}

/**
 * What a parked run is waiting on, read out of its own log. `eventName` is
 * `turn-<n>-approval`, so the action under review is the fenced block from
 * `turn-<n>-think`. Returns undefined when the log cannot answer — a run can
 * be parked with its think step unreadable, and an item with a vague prompt
 * still belongs in the queue.
 */
export function pendingAction(events: WorkflowEvent[], eventName: string): string | undefined {
  const turn = /^turn-(\d+)-approval$/.exec(eventName)?.[1];
  if (turn === undefined) return undefined;
  const stepName = `turn-${turn}-think`;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "step-completed" || event.name !== stepName) continue;
    const action = actionOf(thinkText((event.data as { result?: unknown } | undefined)?.result));
    return action === "" ? undefined : action;
  }
  return undefined;
}

/** Newlines would break the contract's one-line-title rule. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function contextOf(meta: RunMeta): Record<string, string> | undefined {
  const context: Record<string, string> = {};
  if (meta.model !== "") context.model = meta.model;
  if (meta.ranOn !== undefined) context.ran_on = meta.ranOn;
  if (meta.source !== undefined) context.source = meta.source;
  if (meta.workspace !== undefined) context.workspace = meta.workspace;
  return Object.keys(context).length === 0 ? undefined : context;
}

export interface ItemOptions {
  /** Pending action text for a parked run, from `pendingAction`. */
  action?: string;
  /** Base URL of Ship's web UI, when one is configured. */
  webBase?: string;
}

/**
 * A run parks on one of two things and the difference matters to whoever is
 * deciding: `plan-approval` asks "is this the right approach", a turn approval
 * asks "may I run this specific command". Flattening both into "waiting for
 * approval" is how someone rubber-stamps a destructive action.
 */
function promptFor(meta: RunMeta, action?: string): string {
  if (meta.eventName === "plan-approval") return "Review the agent's plan before it acts.";
  if (action !== undefined) return `Approve this action? ${action}`;
  return "This run is parked waiting for approval.";
}

export function toItem(meta: RunMeta, options: ItemOptions = {}): InboxItem {
  const state = stateOf(meta.status);
  const context = contextOf(meta);
  const item: InboxItem = {
    schema: INBOX_SCHEMA,
    source: INBOX_SOURCE,
    id: meta.runId,
    kind: "agent-run",
    title: oneLine(meta.task),
    state,
    attention: attentionOf(state),
    // Best available answer for "entered this state": a park or a finish
    // stamps updatedAt, while a still-running item has only ever moved once.
    since: state === "running" || state === "pending" ? meta.createdAt : meta.updatedAt,
    updated_at: meta.updatedAt,
  };
  if (state === "blocked") {
    item.needs = {
      prompt: promptFor(meta, options.action),
      actions: [
        { label: "approve", run: ["teploy-ship", "approve", meta.runId] },
        { label: "deny", run: ["teploy-ship", "deny", meta.runId, "{reason}"] },
      ],
    };
  }
  if (context !== undefined) item.context = context;
  if (options.webBase !== undefined) item.link = `${options.webBase.replace(/\/$/, "")}/runs/${meta.runId}`;
  return item;
}

export interface FeedOptions {
  webBase?: string;
  /** Injected so the caller owns store choice (file vs Nucleus) and cleanup. */
  loadEvents?: (runId: string) => Promise<WorkflowEvent[]>;
  now?: number;
}

/**
 * Build the feed from every known run. Open items are always included; the
 * terminal tail is capped so a long-lived worker's history does not become
 * the payload. Only parked runs pay for an event-log read.
 */
export async function buildFeed(metas: RunMeta[], options: FeedOptions = {}): Promise<InboxFeed> {
  const now = options.now ?? Date.now();
  const open: InboxItem[] = [];
  const terminal: InboxItem[] = [];

  for (const meta of metas) {
    const state = stateOf(meta.status);
    if (isTerminal(state) && now - Date.parse(meta.updatedAt) > TERMINAL_MAX_AGE_MS) continue;
    let action: string | undefined;
    if (state === "blocked" && meta.eventName !== undefined && options.loadEvents !== undefined) {
      try {
        action = pendingAction(await options.loadEvents(meta.runId), meta.eventName);
      } catch {
        // An unreadable log costs the prompt detail, not the item.
      }
    }
    const item = toItem(meta, {
      ...(action !== undefined ? { action } : {}),
      ...(options.webBase !== undefined ? { webBase: options.webBase } : {}),
    });
    (isTerminal(item.state) ? terminal : open).push(item);
  }

  const rank: Record<InboxAttention, number> = { decision: 0, failure: 1, info: 2 };
  // Oldest first inside a band: the thing blocked longest is the thing
  // quietly costing the most.
  const order = (a: InboxItem, b: InboxItem): number =>
    rank[a.attention] - rank[b.attention] || a.since.localeCompare(b.since);

  const keptTerminal = terminal.sort(order).slice(0, TERMINAL_MAX_ITEMS);
  const feed: InboxFeed = {
    schema: INBOX_SCHEMA,
    items: [...open.sort(order), ...keptTerminal],
  };
  if (keptTerminal.length < terminal.length) feed.truncated = true;
  return feed;
}
