import { randomUUID } from "node:crypto";
import { threadHistory, workspaceInspection, refreshForgeIfStale } from "./workspace.server.js";
import type { WorkspaceReply } from "../../../dist/workspace-requests.js";
import {
  loadTakeover,
  mayAcquireTakeover,
  takeoverHistoryKey,
  takeoverReplyKey,
  type TakeoverRecord,
  type TakeoverSession,
} from "../../../dist/takeover.js";
import { workspaceRecovery, conversation, diffSnapshots, evidence, previewPanel } from "./workspace.js";
import type { Message, DiffSnapshot, Evidence, PreviewPanel } from "./workspace.js";
import { publicOrigin } from "./oidc.server.js";
import { previewFrameBase } from "./preview-frame.server.js";
import { costUSD, isPricedModel, pendingQuestion, verificationFactsFromEvents } from "./ship.server.js";
import { typicalDuration } from "./expect.js";
import type { Typical } from "./expect.js";
import { isAskEvent } from "teploy-ship/ask";
import type { RunMeta, ScanFinding } from "teploy-ship/runtime";
import { shipRuntime } from "./store.server.js";
import { currentUser } from "./session.server.js";
import { may } from "./authority.server.js";
import { runOutcome, toTimeline, recordedSteps } from "./timeline.js";
import type { RunOutcome, TimelineItem, RecordedStep } from "./timeline.js";
import { startSpan } from "./observe.server.js";
import { ProjectIdentityError } from "../../../dist/projects.js";

export interface RunData {
  followUpRequestId: string;
  userMessage?: string;
  journey?: string;
  forge: WorkspaceReply | null;
  workspace: WorkspaceReply | null;
  recovery: ReturnType<typeof workspaceRecovery>;
  ancestors: { runId: string; task: string; messages: Message[] }[];
  view: string;
  messages: Message[];
  snapshots: DiffSnapshot[];
  evidence: Evidence;
  /** The run page's preview panel state, decided server-side (expiry uses the server clock). */
  previewPanel: PreviewPanel;
  parentRunId?: string;
  taskRootRunId?: string;
  canSteer: boolean;
  canLaunch: boolean;
  planSupported: boolean;
  requirePlanReview: boolean;
  hasPr: boolean;
  messageError: string | null;
  meta: RunMeta | null;
  items: TimelineItem[];
  outcome: RunOutcome;
  costUSD: number;
  /** False when the model is absent from the pricing table and the cost is a ceiling, not a price. */
  costPriced: boolean;
  /** True when the run consumed a quota Ship cannot price (P5-3): counted on Spend, never a dollar figure. */
  costUnpriced: boolean;
  runId: string;
  eventCount: number;
  /** The agent's proposed plan, when this run is parked on plan approval. */
  plan?: string;
  /**
   * What a scan run found (L2 / D3), read off its `scan-findings` step.
   *
   * A scan opens no pull request, so without this the run page shows a
   * completed run with no deliverable on it at all — which is exactly how the
   * prompt-only MVP managed to produce seven scans nobody could read.
   */
  findings: ScanFinding[];
  /** Why entries were dropped, or why no array was found. Shown when non-empty. */
  findingsNotes: string[];
  /** The merged change's delivery record (Package B), when one exists. */
  delivery?: {
    state: string;
    repo?: string;
    mergedSha?: string;
    reviewedHead?: string;
    destination?: string;
    recoveryVersion?: string;
    artifactDigest?: string;
    actor?: string;
    reason?: string;
    /** S15 wired health: healthy/degraded/unknown + why, never silent. */
    health?: string;
    healthReason?: string;
    /** Additive rollback receipts (the operation rides, never a state change). */
    rollback?: { state: string; actor: string; reason: string; requestedAt: string; finishedAt?: string; evidence?: string };
  };
  deliveryError?: string;
  /** True when this run is a scan, even if it found nothing. */
  isScan: boolean;
  /** Steerable run (input.steer): show the steer box while active. */
  steerable: boolean;
  /** Steer notes sent but not yet consumed by a turn. */
  steerPending: string[];
  /** Every step-completed event, ordered — the log's index (see timeline.ts). */
  steps: RecordedStep[];
  /** ?decision=stale|taken — read server-side so the banner survives hydration. */
  decision: string | null;
  /** ?cancel=failed */
  cancelFailed: boolean;
  /** ?denied=approve|steer — the authority grant this account lacks. */
  denied: string | null;
  /** The agent's question, when this run is parked on an ```ask. */
  question?: string;
  /** What the run is doing right now (live.ts), while it executes. */
  live: { phase: string; turn?: number; detail?: string; updatedAt: string } | null;
  /** Median duration of earlier completed runs on the same repo, when there are enough. */
  typical: Typical | null;
  /** When this run was enqueued, for the elapsed line. */
  createdAt?: string;
  /** Package C: writable-workspace takeover state for this run's sandbox. */
  takeover: {
    /** True when the run is parked at a decision the resumed agent consumes, a workspace exists, and no lease is held. */
    available: boolean;
    /** Why not, when available is false and someone might expect otherwise. */
    reason?: string;
    record?: { holder: string; expiresAt: string; acquiredAt: string; pathsWritten: string[]; execsRun: string[]; browserOps?: string[] };
    /** The last mediated operation's result (any holder), for the panel. */
    reply?: { id: string; kind: string; at: string; output?: string; error?: string; truncated?: boolean; running?: boolean; path?: string; browser?: { image?: string; url?: string; width?: number; height?: number; format?: string } };
    history: TakeoverSession[];
    /** The project's declared tests command — the only exec takeover may run. */
    testsCommand?: string;
  };
  /** ?takeover=pending — a takeover operation was requested; the worker answers within a sweep. */
  takeoverPending: boolean;
  /** ?tab= — the workspace panel tab the holder had open (console/editor/browser/changes/handback). */
  takeoverTab: "console" | "editor" | "browser" | "changes" | "handback";
  /** The signed-in user's name, so the card can say "held by you". */
  viewer: string | null;
}

/**
 * The `scan-findings` step's recorded result (a ParsedFindings).
 *
 * Read from the STEP rather than from the run's output because a scan that is
 * still running, or that failed after its findings were recorded, has the step
 * and no output. Shape-checked field by field: this is JSON out of an event
 * log, and a log written by an older build is a normal thing to be reading.
 */
function findingsFrom(events: { type: string; name?: string; data?: unknown }[]): { findings: ScanFinding[]; notes: string[] } {
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const result = (step?.data as { result?: unknown } | undefined)?.result as
    | { findings?: unknown; errors?: unknown; found?: unknown }
    | undefined;
  if (result === undefined) return { findings: [], notes: [] };
  const findings = Array.isArray(result.findings)
    ? result.findings.filter((f): f is ScanFinding => typeof f === "object" && f !== null && typeof (f as ScanFinding).title === "string")
    : [];
  const notes = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  return { findings, notes };
}

/** The plan-think step's recorded text ({text, usage} or a bare string). */
function planFrom(events: { type: string; name?: string; data?: unknown }[]): string | undefined {
  const step = events.find((e) => e.type === "step-completed" && e.name === "plan-think");
  if (step === undefined) return undefined;
  const result = (step.data as { result?: unknown } | undefined)?.result;
  if (typeof result === "string") return result;
  const text = (result as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

// This is the one route with an open reliability question (b7d5db3: a run
// page occasionally 500'd with the trigger never pinned down), so it gets a
// trace span in addition to the ErrorBoundary every route already has —
// no-op unless OBSERVE_URL/OBSERVE_API_KEY are set.
export async function runData({ params, request }: { params: { id: string }; request: Request }): Promise<RunData> {
  const runId = params.id;
  const query = new URL(request.url).searchParams;
  const span = startSpan("GET /runs/:id", { "run.id": runId });
  try {
    const runtime = await shipRuntime();
    const [meta, events, ranOn, steerNotes] = await Promise.all([
      runtime.loadMeta(runId),
      runtime.store.load(runId),
      runtime.placement.get(runId),
      runtime.steer.pending(runId).catch(() => []),
    ]);
    if (meta !== null && ranOn !== null) meta.ranOn = ranOn;
    const outcome = runOutcome(events);
    const cost = costUSD(meta?.model ?? "", outcome.usage);
    const started = events.find((e) => e.type === "run-started");
    const steerable =
      (started?.data as { input?: { steer?: boolean } } | undefined)?.input?.steer === true;
    const plan = planFrom(events);
    const scanned = findingsFrom(events);
    const executing = meta !== null && !["completed", "failed", "cancelled", "cancelling"].includes(meta.status);
    const question = meta?.eventName !== undefined && isAskEvent(meta.eventName) ? pendingQuestion(events) : undefined;
    // Advisory reads, never allowed to fail the page: a missing live row is
    // "nothing to show", and the expectation is a courtesy.
    const live = executing ? await runtime.live.get(runId).catch(() => null) : null;
    const repo = (started?.data as { input?: { repo?: string } } | undefined)?.input?.repo;
    let typical: Typical | null = null;
    if (repo !== undefined) {
      try {
        const [stats, runs] = await Promise.all([runtime.repoStats.list(repo), runtime.listMeta({ limit: 300 })]);
        typical = typicalDuration(runs, new Set(stats.map((s) => s.runId)), runId);
      } catch {
        typical = null;
      }
    }
    let projectError: string | null = null;
    const currentProject = repo ? await runtime.projects.forRepo(repo).catch(error => {
      if (!(error instanceof ProjectIdentityError)) throw error;
      projectError = error.message;
      return null;
    }) : null;
    // Historical events remain readable even when current project identity
    // needs repair. This advisory read grants no authority to start new work.
    const planSupported = projectError === null && (currentProject?.harness ?? process.env.SHIP_HARNESS ?? "native") === "native";
    const facts = verificationFactsFromEvents(events);
    const reviewedHead = (started?.data as any)?.input?.mode === "scan" ? (events.find(e => e.type === "step-completed" && e.name === "repo-setup")?.data as any)?.result?.headSha : undefined;
    if (facts.pr || typeof (started?.data as any)?.input?.pr === "number") {
      const principal = await currentUser(request);
      if (principal) await refreshForgeIfStale(runtime, runId, principal.user).catch(() => {});
    }
    const history = await threadHistory(runtime, runId);
    const forgeRaw = await runtime.config.get("SHIP_FORGE_STATE_" + runId);
    // Package C: the takeover state — live lease record, last mediated
    // reply, bounded session history. Advisory reads only; the action route
    // holds the authority and the worker holds the credential.
    const takeoverRecord = await loadTakeover(runtime, runId).catch(() => null);
    const takeoverReplyRaw = await runtime.config.get(takeoverReplyKey(runId)).catch(() => undefined);
    let takeoverReply: RunData["takeover"]["reply"] | undefined;
    if (takeoverReplyRaw) {
      try {
        const parsed = JSON.parse(takeoverReplyRaw) as WorkspaceReply;
        takeoverReply = {
          id: parsed.id,
          kind: parsed.kind ?? "",
          at: parsed.at,
          ...(parsed.path !== undefined ? { path: parsed.path } : {}),
          ...(parsed.output !== undefined ? { output: parsed.output } : {}),
          ...(parsed.error !== undefined ? { error: parsed.error } : {}),
          ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
          ...(parsed.running !== undefined ? { running: parsed.running } : {}),
          ...(parsed.browser !== undefined && typeof parsed.browser === "object" && parsed.browser !== null
            ? {
                browser: {
                  ...(typeof parsed.browser.image === "string" ? { image: parsed.browser.image } : {}),
                  ...(typeof parsed.browser.url === "string" ? { url: parsed.browser.url } : {}),
                  ...(typeof parsed.browser.width === "number" ? { width: parsed.browser.width } : {}),
                  ...(typeof parsed.browser.height === "number" ? { height: parsed.browser.height } : {}),
                  ...(typeof parsed.browser.format === "string" ? { format: parsed.browser.format } : {}),
                },
              }
            : {}),
        };
      } catch {
        // unreadable reply — omit
      }
    }
    let takeoverHistory: TakeoverSession[] = [];
    const takeoverHistoryRaw = await runtime.config.get(takeoverHistoryKey(runId)).catch(() => undefined);
    if (takeoverHistoryRaw) {
      try {
        const parsed = JSON.parse(takeoverHistoryRaw) as unknown;
        if (Array.isArray(parsed)) takeoverHistory = parsed.filter((s): s is TakeoverSession => typeof s?.holder === "string");
      } catch {
        // unreadable history — omit
      }
    }
    const takeoverGate = mayAcquireTakeover(meta);
    const testsCommand = currentProject?.testCommand ?? currentProject?.verification?.tests;
    // The merged change's delivery record (Package B): advisory read for the
    // card; the approve action is the authority boundary, not this loader.
    const deliveryRecord = (await runtime.deliveryRecords?.get(runId).catch(() => null)) ?? null;
    const data: RunData = {
      userMessage: (started?.data as any)?.input?.userMessage,
      journey: (started?.data as any)?.input?.journey,
      forge: forgeRaw ? JSON.parse(forgeRaw) : null,
      workspace: await workspaceInspection(runtime, runId),
      recovery: workspaceRecovery(events),
      ancestors: history.slice(0,-1).map(h => ({ runId: h.runId, task: h.task, messages: conversation(h.events).slice(-20) })),
      view: ['conversation','review','changes','verification','files','activity'].includes(query.get('view') ?? '') ? query.get('view')! : 'conversation',
      messages: conversation(events),
      snapshots: diffSnapshots(events),
      evidence: evidence(facts, reviewedHead),
      previewPanel: previewPanel(events, facts, { executing, now: Date.now(), dashboardOrigin: publicOrigin(request), frameBase: previewFrameBase() }),
      hasPr: facts.pr !== undefined || typeof (started?.data as any)?.input?.pr === "number",
      parentRunId: typeof (started?.data as any)?.input?.parentRunId === 'string' ? (started?.data as any).input.parentRunId : undefined,
      taskRootRunId: typeof (started?.data as any)?.taskRootRunId === 'string' ? (started?.data as any).taskRootRunId : undefined,
      canSteer: await may('steer', await currentUser(request)),
      planSupported,
      requirePlanReview: currentProject?.requirePlanReview === true,
      canLaunch: projectError === null && await may('approve', await currentUser(request)),
      messageError: query.get('messageError') ?? projectError,
      ...(deliveryRecord !== null
        ? {
            delivery: {
              state: deliveryRecord.state,
              ...(deliveryRecord.repo !== undefined ? { repo: deliveryRecord.repo } : {}),
              ...(deliveryRecord.mergedSha !== undefined ? { mergedSha: deliveryRecord.mergedSha } : {}),
              ...(deliveryRecord.reviewedHead !== undefined ? { reviewedHead: deliveryRecord.reviewedHead } : {}),
              ...(deliveryRecord.destination !== undefined ? { destination: deliveryRecord.destination } : {}),
              ...(deliveryRecord.recoveryVersion !== undefined ? { recoveryVersion: deliveryRecord.recoveryVersion } : {}),
              ...(deliveryRecord.artifactDigest !== undefined ? { artifactDigest: deliveryRecord.artifactDigest } : {}),
              ...(deliveryRecord.actor !== undefined ? { actor: deliveryRecord.actor } : {}),
              ...(deliveryRecord.reason !== undefined ? { reason: deliveryRecord.reason } : {}),
              ...(deliveryRecord.health !== undefined ? { health: deliveryRecord.health } : {}),
              ...(deliveryRecord.healthReason !== undefined ? { healthReason: deliveryRecord.healthReason } : {}),
              ...(deliveryRecord.rollback !== undefined ? { rollback: deliveryRecord.rollback } : {}),
            },
          }
        : {}),
      ...(query.get("deliveryError") !== null ? { deliveryError: query.get("deliveryError") ?? undefined } : {}),
      meta,
      items: toTimeline(events),
      outcome,
      costUSD: cost,
      // A harness that priced its own usage is priced whatever the table says.
      costPriced: isPricedModel(meta?.model ?? "") || typeof outcome.usage?.costUSD === "number",
      costUnpriced: outcome.usage?.priced === false,
      runId,
      followUpRequestId: randomUUID(),
      eventCount: events.length,
      ...(plan !== undefined ? { plan } : {}),
      findings: scanned.findings,
      findingsNotes: scanned.notes,
      isScan: (started?.data as { input?: { mode?: string } } | undefined)?.input?.mode === "scan",
      steerable,
      steerPending: steerNotes.map((n) => n.text),
      steps: recordedSteps(events),
      decision: query.get("decision"),
      cancelFailed: query.get("cancel") === "failed",
      denied: query.get("denied"),
      ...(question !== undefined ? { question } : {}),
      live: live === null ? null : { phase: live.phase, ...(live.turn !== undefined ? { turn: live.turn } : {}), ...(live.detail !== undefined ? { detail: live.detail } : {}), updatedAt: live.updatedAt },
      typical,
      ...(meta?.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
      takeover: {
        available: takeoverRecord === null && takeoverGate.ok,
        ...(takeoverRecord === null && !takeoverGate.ok ? { reason: takeoverGate.reason } : {}),
        ...(takeoverRecord !== null
          ? {
              record: {
                holder: takeoverRecord.holder,
                expiresAt: takeoverRecord.expiresAt,
                acquiredAt: takeoverRecord.acquiredAt,
                pathsWritten: takeoverRecord.pathsWritten,
                execsRun: takeoverRecord.execsRun,
                ...(takeoverRecord.browserOps !== undefined ? { browserOps: takeoverRecord.browserOps } : {}),
              },
            }
          : {}),
        ...(takeoverReply !== undefined ? { reply: takeoverReply } : {}),
        history: takeoverHistory,
        ...(typeof testsCommand === "string" && testsCommand !== "" ? { testsCommand } : {}),
      },
      takeoverPending: query.get("takeover") === "pending",
      takeoverTab: (["console", "editor", "browser", "changes", "handback"] as const).includes(
        (query.get("tab") ?? "console") as "console",
      )
        ? ((query.get("tab") ?? "console") as "console" | "editor" | "browser" | "changes" | "handback")
        : "console",
      viewer: (await currentUser(request))?.user ?? null,
    };
    span.end("ok", { "run.status": meta?.status ?? "unknown", "run.event_count": events.length });
    return data;
  } catch (err) {
    span.end("error");
    throw err;
  }
}
