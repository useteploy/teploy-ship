/**
 * The task thread view (steering slice B): one read-only, thread-shaped
 * picture of a follow-up chain — the runs a task is made of, ordered by
 * follow-up, with each run's steer notes and ask parks beside it.
 *
 * Ship's steering primitives all existed before this module: parentRunId /
 * taskRootRunId link follow-ups (task-session.ts), steer notes are drained
 * per turn into recorded steps (steer.ts, durable.ts), and ```ask parks and
 * their answers are events in the run's own log (ask.ts). What did not exist
 * was a way to SEE them as one thread: an operator reading run N of a task
 * had the "Continues" link up and the conversation's folded ancestors, but no
 * next-run navigation and no single place showing what was steered or asked
 * across the chain.
 *
 * READ-ONLY, and this slice keeps it that way on purpose: no new write
 * surface rides along with the view. Everything here is projected from
 * records other surfaces already own — the event log (lineage, drained steer
 * steps, ask parks, delivered answers), RunMeta (status, model, dates) and
 * the steer store's pending() (notes not yet drained). No new tables, no
 * parallel store: where a query helper exists this uses it — taskRootRunId
 * resolves the anchor, listMeta supplies the bounded recent-run window the
 * descendants are found in, and steer.pending is the only steer read.
 *
 * Flag: SHIP_THREAD_VIEW, on unless explicitly off. When off the API answers
 * 503 and the run page mounts nothing, so flag-off output is byte-for-byte
 * what it was.
 */
import { isAskEvent } from "teploy-ship/ask";
import { parseAction, parseReply } from "../../../dist/actions.js";
import { taskRootRunId as resolveTaskRoot } from "../../../dist/task-session.js";
import { replyDialectOf } from "./workspace.js";
import type { HeldNote, SteerNote } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";
import type { WorkflowEvent } from "@neutron-build/workflow";

/** on/off gate, same shape as missionViewEnabled (mission-view.ts), but
 * self-typed: web's ProcessEnv declares no keys, so a Pick<> would demand an
 * ambient augmentation this package does not carry. */
export function threadViewEnabled(env: { SHIP_THREAD_VIEW?: string } = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.SHIP_THREAD_VIEW ?? "").trim());
}

/**
 * How many recent runs the descendant scan reads. Bounded because the scan
 * loads each candidate's log to read its lineage — the parent link lives in
 * run-started, not in RunMeta, so this is the read the store offers. Same
 * order of magnitude as the run page's own "typical duration" read (300) and
 * listMeta's default page (200). When the window is full, `truncated` says
 * so rather than letting the chain look complete.
 */
export const THREAD_SCAN_LIMIT = 300;

/** threadHistory's bound (workspace.server.ts): the ancestor walk stops here too. */
const ANCESTOR_LIMIT = 20;

export interface SteerNoteView {
  text: string;
  /** When the note was sent (pending) or claimed by a turn (delivered). */
  at: string;
  state: "delivered" | "pending" | "undelivered";
  /** The turn that claimed a delivered note — the drain's own keying. */
  turn?: number;
  /**
   * How the operator asked for it to be applied (D2, SHIP_STEER_REPLY):
   * `steer` at the next turn boundary, `queue` at the agent's next
   * checkpoint, `interrupt` at the next safe point. ABSENT means `steer`, so
   * a plain note serialises exactly as it did before D2.
   */
  mode?: "queue" | "interrupt";
  /**
   * An interrupt's effect on the action it landed on (S11): `not-done` (it
   * never ran), `done` (ran to its end), `unknown` (cancelled part-way), or
   * `none` (nothing was running). Absent on non-interrupts and pending ones.
   */
  effect?: "not-done" | "done" | "unknown" | "none";
}

/**
 * The agent's ```reply into the thread (D2). Read off the recorded think
 * text with the run's own dialect, so it is exactly what the loop saw — and
 * ONLY off think steps: command output, files and pages are never parsed
 * for replies, and nothing here can ever be rendered as an operator note.
 */
export interface AgentReplyView {
  text: string;
  at: string;
  turn: number;
}

export interface AskParkView {
  /** The park's event name — the id an answer must quote. */
  event: string;
  /** The question from the think step's ```ask block; null when unreadable. */
  question: string | null;
  at: string;
  /** The delivered answer; null while the park is still waiting. */
  answer: { text: string | null; at: string; by?: string } | null;
}

export interface ThreadRunView {
  runId: string;
  parentRunId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  /** Harness id recorded at enqueue ("native" when the run predates the field). */
  harness: string;
  /** The run-completed summary; null while unfinished or failed. */
  summary: string | null;
  steers: SteerNoteView[];
  asks: AskParkView[];
  /**
   * Agent replies, oldest first — present only on runs whose input admitted
   * them (input.steerReply), so a flag-off run's thread is byte-identical.
   */
  replies?: AgentReplyView[];
  /**
   * DF1 (SHIP_FORK): the run this one was forked from, present only on runs
   * whose input recorded one — absent on every earlier run, so the view
   * serialises exactly as it did before forks existed.
   */
  forkOf?: { runId: string; sha?: string };
  /**
   * DS1 (SHIP_STACKED_PRS): the run this one is stacked on (its pull request
   * opened against that run's branch), present only on runs whose input
   * recorded one — absent on every non-stacked run, so the view serialises
   * exactly as it did before stacks existed.
   */
  stackedOn?: { runId: string; pr?: number; branch?: string; sha?: string };
}

export interface ThreadView {
  /** The id the caller asked about (any member of the chain). */
  run: string;
  /** The chain's anchor — what every member resolves to via taskRootRunId. */
  root: string;
  /** Root first, then follow-up order (createdAt, ties by runId for determinism). */
  runs: ThreadRunView[];
  /** True when a bound (ancestor walk or scan window) may have cut the chain. */
  truncated: boolean;
}

/** What runThread reads — structural so the route and the tests share one shape. */
export interface ThreadDeps {
  store: { load(runId: string): Promise<WorkflowEvent[]> };
  loadMeta(runId: string): Promise<RunMeta | null>;
  listMeta(options?: { limit?: number }): Promise<RunMeta[]>;
  steer: { pending(runId: string): Promise<SteerNote[]>; pendingHeld?(runId: string): Promise<HeldNote[]> };
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A step-completed event's recorded result, whatever shape it took. */
function resultOf(event: WorkflowEvent): unknown {
  return record(event.data).result;
}

const STEER_STEP = /^(?:attempt-\d+-)?turn-(\d+)-steer$/;
/** Notes an external harness drained for its round-N resume (harness-external.ts). */
const EXTERNAL_STEER_STEP = /^(?:attempt-\d+-)?harness-steer-(\d+)$/;
/** An external harness's closing record: notes it accepted and never delivered (harness-external.ts). */
const STEER_UNDELIVERED_STEP = /^(?:attempt-\d+-)?harness-steer-undelivered$/;
const HELD_STEP = /^(?:attempt-\d+-)?turn-(\d+)-(?:finish-)?held$/;
const EXEC_STEP = /^(?:attempt-\d+-)?turn-(\d+)-exec$/;
const THINK_STEP = /^(?:attempt-\d+-)?turn-(\d+)-think$/;

/**
 * Delivered steer notes are a step result — `turn-N-steer` records the
 * string array the turn drained (durable.ts), replay-stable exactly because
 * the store is read once. Pending ones are still only in the steer store;
 * pending() is the read. The crash window steer.ts documents (a note stamped
 * for a turn whose step never committed) is visible on replay, not here.
 */
export function steerHistory(
  events: readonly WorkflowEvent[],
  pending: readonly SteerNote[],
  pendingHeld: readonly HeldNote[] = [],
): SteerNoteView[] {
  const out: SteerNoteView[] = [];
  for (const event of events) {
    if (event.type !== "step-completed") continue;
    if (STEER_UNDELIVERED_STEP.test(event.name ?? "")) {
      const lost = resultOf(event);
      if (Array.isArray(lost)) for (const text of lost) if (typeof text === "string" && text !== "") out.push({ text, at: event.at, state: "undelivered" });
      continue;
    }
    const ext = EXTERNAL_STEER_STEP.exec(event.name ?? "");
    if (ext !== null) {
      const result = resultOf(event);
      if (!Array.isArray(result)) continue;
      for (const text of result) {
        if (typeof text === "string" && text !== "") out.push({ text, at: event.at, state: "delivered" });
      }
      continue;
    }
    const steer = STEER_STEP.exec(event.name ?? "");
    if (steer !== null) {
      const result = resultOf(event);
      if (!Array.isArray(result)) continue;
      for (const text of result) {
        if (typeof text === "string" && text !== "") out.push({ text, at: event.at, state: "delivered", turn: Number(steer[1]) });
      }
      continue;
    }
    // D2 held messages: `turn-N-held` / `turn-N-finish-held` record the
    // queued messages and boundary interrupts a checkpoint released.
    const held = HELD_STEP.exec(event.name ?? "");
    if (held !== null) {
      const result = resultOf(event);
      if (!Array.isArray(result)) continue;
      for (const item of result) {
        const r = record(item);
        if (typeof r.text !== "string" || (r.mode !== "queue" && r.mode !== "interrupt")) continue;
        out.push({
          text: r.text,
          at: event.at,
          state: "delivered",
          turn: Number(held[1]),
          mode: r.mode,
          ...(r.mode === "interrupt" ? { effect: "none" as const } : {}),
        });
      }
      continue;
    }
    // ...and interrupts that landed on an action, recorded on its exec result.
    const exec = EXEC_STEP.exec(event.name ?? "");
    if (exec !== null) {
      const interrupt = record(record(resultOf(event)).interrupt);
      const effect = interrupt.effect;
      if (!Array.isArray(interrupt.notes) || (effect !== "not-done" && effect !== "done" && effect !== "unknown")) continue;
      for (const text of interrupt.notes) {
        if (typeof text === "string") out.push({ text, at: event.at, state: "delivered", turn: Number(exec[1]), mode: "interrupt", effect });
      }
    }
  }
  for (const note of pending) out.push({ text: note.text, at: note.createdAt, state: "pending" });
  for (const note of pendingHeld) out.push({ text: note.text, at: note.createdAt, state: "pending", mode: note.mode });
  return out;
}

/**
 * Agent replies (D2): every ```reply the loop accepted, parsed from the
 * `turn-N-think` results with the dialect the run's input recorded. A run
 * whose input never admitted replies has none, whatever its text contains —
 * the same answer the loop gave it.
 */
/** Did the run's recorded input admit ```reply (input.steerReply)? */
export function admitsReplies(events: readonly WorkflowEvent[]): boolean {
  const started = events.find((e) => e.type === "run-started");
  return record(record(started?.data).input).steerReply === true;
}

export function replyHistory(events: readonly WorkflowEvent[]): AgentReplyView[] {
  const started = events.find((e) => e.type === "run-started");
  const input = record(record(started?.data).input);
  if (input.steerReply !== true) return [];
  // The same dialect settings conversation() uses (workspace.ts) — both
  // surfaces render what the loop's own parseReply delivered.
  const dialect = replyDialectOf(input);
  const out: AgentReplyView[] = [];
  for (const event of events) {
    if (event.type !== "step-completed") continue;
    const think = THINK_STEP.exec(event.name ?? "");
    if (think === null) continue;
    const result = resultOf(event);
    const raw = typeof result === "string" ? result : typeof record(result).text === "string" ? (record(result).text as string) : null;
    if (raw === null) continue;
    const text = parseReply(raw, dialect);
    if (text !== null) out.push({ text, at: event.at, turn: Number(think[1]) });
  }
  return out;
}

/**
 * Every ```ask park with its question and, once delivered, its answer —
 * pendingQuestion (ask.ts) answers this for the LAST park only; the thread
 * wants the whole history. The question is read the same way pendingQuestion
 * reads it: backwards from the park to its think step, parsed out of the
 * ```ask block. The answer is the event-received carrying the same name; an
 * approval's reason IS an answer (AskDecisionPayload), and approved=false
 * with no text is "the operator did not answer".
 */
export function askHistory(events: readonly WorkflowEvent[]): AskParkView[] {
  const parks: AskParkView[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== "event-waiting" || !isAskEvent(event.name)) continue;
    const thinkName = `${event.name!.replace(/-ask$/, "")}-think`;
    let question: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const think = events[j]!;
      if (think.type !== "step-completed" || think.name !== thinkName) continue;
      const result = resultOf(think);
      const raw = typeof result === "string" ? result : typeof record(result).text === "string" ? (record(result).text as string) : null;
      if (raw === null) break;
      const action = parseAction(raw);
      if (action.kind === "ask") question = action.question;
      break;
    }
    let answer: AskParkView["answer"] = null;
    for (let j = i + 1; j < events.length && answer === null; j++) {
      const received = events[j]!;
      if (received.type !== "event-received" || received.name !== event.name) continue;
      const payload = record(record(received.data).payload);
      const text = typeof payload.answer === "string" && payload.answer !== ""
        ? payload.answer
        : typeof payload.reason === "string" && payload.reason !== ""
          ? payload.reason
          : null;
      answer = {
        text,
        at: received.at,
        ...(typeof payload.by === "string" && payload.by !== "" ? { by: payload.by } : {}),
      };
    }
    parks.push({ event: event.name!, question, at: event.at, answer });
  }
  return parks;
}

/** The harness a run was enqueued for, from the recorded input — never a guess. */
export function harnessLabel(events: readonly WorkflowEvent[]): string {
  const started = events.find((e) => e.type === "run-started");
  const input = record(record(started?.data).input);
  const id = record(input.harness).id;
  if (typeof id === "string" && id !== "") return id;
  const attempts = Array.isArray(input.harnessAttempts)
    ? input.harnessAttempts.map((a) => (typeof record(a).id === "string" ? (record(a).id as string) : "")).filter((s) => s !== "")
    : [];
  if (attempts.length > 0) return [...new Set(attempts)].join(" / ");
  return "native";
}

/**
 * A run's recorded fork lineage (DF1), shape-checked off its input like every
 * other field this module reads out of a log. Undefined on a non-fork.
 */
export function forkOfInput(events: readonly WorkflowEvent[]): ThreadRunView["forkOf"] {
  const started = events.find((e) => e.type === "run-started");
  const fork = record(record(record(started?.data).input).forkOf);
  const runId = fork.runId;
  if (typeof runId !== "string" || runId === "") return undefined;
  const sha = fork.sha;
  return { runId, ...(typeof sha === "string" && sha !== "" ? { sha } : {}) };
}

/**
 * A run's recorded stack lineage (DS1), shape-checked off its input like every
 * other field this module reads out of a log — the same rule forkOfInput
 * states for forks. Undefined on a non-stacked run.
 */
export function stackedOnInput(events: readonly WorkflowEvent[]): ThreadRunView["stackedOn"] {
  const started = events.find((e) => e.type === "run-started");
  const stack = record(record(record(started?.data).input).stack);
  const runId = stack.runId;
  if (typeof runId !== "string" || runId === "") return undefined;
  const pr = Number(stack.pr);
  const branch = stack.branch;
  const sha = stack.sha;
  return {
    runId,
    ...(Number.isSafeInteger(pr) && pr > 0 ? { pr } : {}),
    ...(typeof branch === "string" && branch !== "" ? { branch } : {}),
    ...(typeof sha === "string" && sha !== "" ? { sha } : {}),
  };
}

/** The run-completed summary, bounded like threadHistory bounds it. */
function summaryOf(events: readonly WorkflowEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "run-completed") continue;
    const output = record(event.data).output;
    const text = record(output).agentSummary ?? record(output).summary;
    if (typeof text === "string" && text !== "") return text.slice(0, 6000);
  }
  return null;
}

/**
 * The whole thread for one run id. Resolves the anchor with taskRootRunId,
 * walks the ancestors with the same bound threadHistory uses, and finds the
 * descendants inside listMeta's bounded window: a family member either
 * records the anchor (every run since taskRootRunId existed) or walks up to
 * one (legacy chains). Candidates older than the root are skipped without a
 * log read — a follow-up cannot be created before its parent.
 *
 * Returns null when the id names no run the store knows (the route 404s).
 */
export async function runThread(deps: ThreadDeps, runId: string): Promise<ThreadView | null> {
  const eventsOf = new Map<string, WorkflowEvent[]>();
  const loadEvents = async (id: string): Promise<WorkflowEvent[]> => {
    const cached = eventsOf.get(id);
    if (cached !== undefined) return cached;
    const events = await deps.store.load(id);
    eventsOf.set(id, events);
    return events;
  };
  const startedOf = (events: readonly WorkflowEvent[]) =>
    events.find((e) => e.type === "run-started") as
      | { data?: { taskRootRunId?: unknown; input?: { parentRunId?: unknown } } }
      | undefined;

  const current = await loadEvents(runId);
  if (startedOf(current) === undefined) return null;
  const root = await resolveTaskRoot(deps.store, runId);

  // Up: the chain this run descends from, oldest first, bounded like the
  // conversation's context window. The anchor resolution above already
  // proved these runs exist and carry no cycle. A walk that stops at the
  // bound with a parent still unvisited means the chain is longer than the
  // bound — reported as truncated, never shown as complete.
  const upward: string[] = [runId];
  const seen = new Set<string>([runId]);
  let walkTruncated = false;
  for (let depth = 0; depth < ANCESTOR_LIMIT; depth++) {
    const id = upward[0]!;
    const parent = startedOf(await loadEvents(id))?.data?.input?.parentRunId;
    if (parent === undefined) break;
    if (typeof parent !== "string" || seen.has(parent)) break;
    if (depth === ANCESTOR_LIMIT - 1) walkTruncated = true;
    upward.unshift(parent);
    seen.add(parent);
  }

  // Down: family members inside the bounded recent-run window. Ordered
  // oldest-first so a legacy member's own children meet an already-complete
  // member set in one pass.
  const members = new Set<string>(upward);
  const recent = await deps.listMeta({ limit: THREAD_SCAN_LIMIT });
  const truncated = walkTruncated || recent.length >= THREAD_SCAN_LIMIT;
  const rootMeta = await deps.loadMeta(root);
  const rootCreated = rootMeta?.createdAt ?? "";
  const candidates = recent
    .filter((m) => !members.has(m.runId) && (rootCreated === "" || m.createdAt >= rootCreated))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.runId < b.runId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  for (const candidate of candidates) {
    const events = await loadEvents(candidate.runId);
    const started = startedOf(events);
    if (started === undefined) continue;
    const parent = started.data?.input?.parentRunId;
    const forked = forkOfInput(events);
    const stacked = stackedOnInput(events);
    // A member either names the anchor (runs since taskRootRunId existed),
    // hangs off a member by parentRunId (legacy chains), or — a fork (DF1) —
    // records forkOf lineage to one. A fork is a new task root, so the anchor
    // test cannot catch it, but it belongs in the thread it came from. So does
    // a stack (DS1): a stacked run stands alone as a task the same way, and
    // its lineage names the member it rides.
    if (
      started.data?.taskRootRunId === root ||
      (typeof parent === "string" && members.has(parent)) ||
      (forked !== undefined && members.has(forked.runId)) ||
      (stacked !== undefined && members.has(stacked.runId))
    ) {
      members.add(candidate.runId);
    }
  }

  const ids = [...members].sort((a, b) => {
    const ma = upward.indexOf(a);
    const mb = upward.indexOf(b);
    // Ancestors keep the walked order (a parent always precedes its child);
    // the rest fall to createdAt, ties by runId.
    if (ma !== -1 && mb !== -1) return ma - mb;
    if (ma !== -1) return -1;
    if (mb !== -1) return 1;
    const ca = recent.find((m) => m.runId === a)?.createdAt ?? "";
    const cb = recent.find((m) => m.runId === b)?.createdAt ?? "";
    return ca === cb ? (a < b ? -1 : 1) : ca < cb ? -1 : 1;
  });

  const runs: ThreadRunView[] = [];
  for (const id of ids) {
    const events = await loadEvents(id);
    const started = startedOf(events);
    const meta = (recent.find((m) => m.runId === id) ?? (await deps.loadMeta(id)) ?? {
      runId: id,
      task: "",
      status: "unknown",
      model: "",
      createdAt: events[0]?.at ?? "",
      updatedAt: events[events.length - 1]?.at ?? "",
    }) as RunMeta;
    const parent = started?.data?.input?.parentRunId;
    const forkOf = forkOfInput(events);
    const stackedOn = stackedOnInput(events);
    // Pending notes are only readable for a run that could still drain them;
    // a terminal run has none, and skipping the read keeps the scan bounded.
    const terminal = ["completed", "failed", "cancelled"].includes(meta.status);
    const pending = terminal ? [] : await deps.steer.pending(id).catch(() => []);
    const pendingHeld = terminal || deps.steer.pendingHeld === undefined ? [] : await deps.steer.pendingHeld(id).catch(() => []);
    runs.push({
      runId: id,
      parentRunId: typeof parent === "string" ? parent : null,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      model: meta.model,
      harness: harnessLabel(events),
      summary: summaryOf(events),
      steers: steerHistory(events, pending, pendingHeld),
      asks: askHistory(events),
      ...(admitsReplies(events) ? { replies: replyHistory(events) } : {}),
      ...(forkOf !== undefined ? { forkOf } : {}),
      ...(stackedOn !== undefined ? { stackedOn } : {}),
    });
  }
  return { run: runId, root, runs, truncated };
}
