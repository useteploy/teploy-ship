import type { ScanFinding } from "./findings.js";
import type { ChangeClass } from "./change-class.js";
import { rungsForWire, type Rung } from "./ladder.js";

/**
 * A4 — outbound notifications: one short Slack message when a run needs
 * a human (parked) or settles (completed/failed), linking back to the
 * dashboard. Opt-in via SHIP_SLACK_WEBHOOK_URL (an incoming-webhook URL);
 * SHIP_PUBLIC_URL makes the run links clickable. Notifications are
 * advisory — failures log and never touch the run.
 */

/**
 * Where a run's work came from (L1 / L7).
 *
 * The consumer this exists for is Akiroo: a run that started as one of its work
 * items has to be able to say so, or the item sits at "assigned" forever while
 * the pull request it produced goes unnoticed. `dedupe_key` is the intake key,
 * which is also how a consumer that missed the work_item_ref can still match a
 * run to the issue it came from.
 *
 * Populated for EVERY run since L7. It is materialised into the recorded run
 * input at enqueue (runtime.ts) and read back off the `run-started` event when
 * the notification is built (worker.ts), never re-derived at delivery time.
 * Intake-launched runs derive it from the task at launch — `source` and
 * `dedupeKey` verbatim, `workItemRef` recovered from the `Akiroo: ` footer
 * (src/akiroo.ts AKIROO_REF_MARKER) when the issue body carries one. Scan runs
 * that arrive on the Akiroo outbox carry it from the row. Akiroo keeps its
 * footer fallback off `task` for runs enqueued before this field existed.
 */
export interface RunOrigin {
  /** Intake source: forgejo | github | akiroo | scan | … */
  source: string;
  /** The intake dedupe key, e.g. forgejo:owner/repo#12. */
  dedupeKey: string;
  /** The originating work item, when the task came from a workspace. */
  workItemRef?: string;
}

export interface RunNotification {
  runId: string;
  status: string;
  /** Set when parked: which decision the run waits on. */
  eventName?: string;
  pr?: string;
  /** Repository the run is working in, when known. Machine consumers route on it. */
  repo?: string;
  /** One-line description of what the run is doing, when known. */
  task?: string;
  /** Where the task came from, when the launcher recorded it. */
  origin?: RunOrigin;
  /** Set on scan runs (L2 / L7). Absent means an ordinary fix run. */
  mode?: "scan";
  /** What a completed scan found. Absent unless the run recorded its findings step. */
  findings?: ScanReport;
  /**
   * What the change-class step recorded (contract 2). Absent on runs without
   * the gate — a consumer treats absent as "not classified", the same fact
   * the merge gate reads.
   */
  changeClass?: ChangeClass;
  /**
   * The verification block (contract 2): the recorded rungs and the
   * "what I did / verified / could not verify" paragraph. Present on runs
   * that recorded a class or a ladder; the rungs are the SAME list the run's
   * `ladder` step and the pull request carry.
   */
  verification?: { rungs: Rung[]; summary: string };
  /** How the merge question resolved, when it did (contract 2's `merged`). */
  merged?: boolean;
  /** The agent's own result status on a terminal run (see RunWebhookPayload.outcome). */
  outcome?: string;
}

/**
 * The findings block a completed scan carries to a consumer (L7). `summary` is
 * the run's final write-up; `errors` are the parse's drop reasons. Built by
 * scanReport(), which also enforces the wire budget.
 */
export interface ScanReport {
  found: boolean;
  findings: ScanFinding[];
  errors: string[];
  summary: string;
}

/** The whole signed payload stays under this; a receiver's body limit is the reason. */
export const WEBHOOK_PAYLOAD_LIMIT = 64 * 1024;
/** How much of the run's write-up travels. Enough to answer a question from; not the transcript. */
export const SCAN_SUMMARY_LIMIT = 8000;
const SCAN_TEXT_LIMIT = 2000;
const SCAN_TRUNCATED = "... [truncated by ship]";

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - SCAN_TRUNCATED.length)}${SCAN_TRUNCATED}`;
}

function reportBytes(report: ScanReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * Bound a scan's findings to the wire budget. Three passes, each recorded in
 * `errors` so a shortened report says it was shortened: the summary is
 * truncated to SCAN_SUMMARY_LIMIT always; then, only if the block still
 * exceeds `budget`, each finding's `detail` and `fix` are clipped; then trailing
 * findings are dropped until it fits. Findings are never reordered, so the
 * ones that survive are the ones the agent listed first.
 */
export function scanReport(
  parsed: { found: boolean; findings: ScanFinding[]; errors: string[] },
  summary: string,
  budget: number = WEBHOOK_PAYLOAD_LIMIT - 8 * 1024,
): ScanReport {
  const report: ScanReport = {
    found: parsed.found,
    findings: parsed.findings.map((f) => ({ ...f })),
    errors: [...parsed.errors],
    summary: clip(summary, SCAN_SUMMARY_LIMIT),
  };
  if (reportBytes(report) <= budget) return report;
  report.findings = report.findings.map((f) => ({
    ...f,
    detail: clip(f.detail, SCAN_TEXT_LIMIT),
    ...(f.fix !== undefined ? { fix: clip(f.fix, SCAN_TEXT_LIMIT) } : {}),
  }));
  report.errors.push(`finding detail/fix text was truncated to ${SCAN_TEXT_LIMIT} chars to fit the webhook payload`);
  const total = report.findings.length;
  while (reportBytes(report) > budget && report.findings.length > 0) report.findings.pop();
  if (report.findings.length < total) {
    report.errors.push(`${total - report.findings.length} of ${total} finding(s) dropped to fit the webhook payload; read /api/runs/<id>/findings for all of them`);
  }
  return report;
}

export interface Notifier {
  enabled: boolean;
  /**
   * Deliver, resolving true only when the receiver accepted it. Callers use
   * that to decide whether the outbox entry can be settled — a fire-and-forget
   * void return could not distinguish "sent" from "lost".
   */
  runEvent(event: RunNotification, deliveryId?: string): Promise<boolean>;
}

/**
 * Fan out to several notifiers. Slack and a machine consumer want the same
 * events in different shapes, so they are separate notifiers rather than one
 * with a format flag — a Slack message is prose for a person, a webhook is a
 * record for a program, and conflating them produces something bad at both.
 *
 * enabled is true when ANY member is, so the worker's `if (notify.enabled)`
 * guard keeps working unchanged.
 */
export function multiNotifier(notifiers: Notifier[]): Notifier {
  const active = notifiers.filter((n) => n.enabled);
  return {
    enabled: active.length > 0,
    async runEvent(event, deliveryId) {
      // All-or-nothing: if any member failed, the entry stays owed and the
      // retry re-delivers to everyone. Receivers dedupe on the delivery id.
      const results = await Promise.all(active.map((n) => n.runEvent(event, deliveryId)));
      return results.every(Boolean);
    },
  };
}

export function formatRunNotification(event: RunNotification, publicUrl?: string): string {
  const link =
    publicUrl !== undefined && publicUrl !== ""
      ? `${publicUrl.replace(/\/+$/, "")}/runs/${event.runId}`
      : event.runId;
  if (event.status === "waiting") {
    const what =
      event.eventName === "plan-approval"
        ? "a plan review"
        : event.eventName === "approve-merge"
          ? "a merge decision"
          : "an approval";
    return `Ship run ${event.runId} is parked on ${what} — ${link}`;
  }
  if (event.status === "failed") {
    return `Ship run ${event.runId} FAILED — ${link}`;
  }
  const pr = event.pr !== undefined ? ` → ${event.pr}` : "";
  return `Ship run ${event.runId} ${event.status}${pr} — ${link}`;
}

/** Statuses worth a ping: human-needed or terminal. */
export function notifiable(status: string): boolean {
  return status === "waiting" || status === "completed" || status === "failed" || status === "cancelled";
}

export function slackNotifier(options?: {
  webhookUrl?: string;
  publicUrl?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Notifier {
  const webhookUrl = options?.webhookUrl ?? process.env.SHIP_SLACK_WEBHOOK_URL ?? "";
  const publicUrl = options?.publicUrl ?? process.env.SHIP_PUBLIC_URL ?? "";
  const log = options?.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (webhookUrl === "") return { enabled: false, runEvent: async () => true };
  return {
    enabled: true,
    async runEvent(event) {
      if (!notifiable(event.status)) return true;
      try {
        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: formatRunNotification(event, publicUrl) }),
        });
        if (!response.ok) log(`[notify] slack webhook ${response.status}`);
        return response.ok;
      } catch (error) {
        log(`[notify] slack webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}

/**
 * The signed webhook notifier — a machine consumer of run lifecycle events.
 *
 * Where slackNotifier sends prose for a person to read, this sends a record for
 * a program to act on: the run's identity, status, and (when parked) which
 * decision it is waiting for. That last field is the load-bearing one — a
 * consumer that wants to offer "approve" needs to know an approval is pending
 * and be able to name it back.
 *
 * Signed with the scheme every teploy product uses:
 *
 *   X-Teploy-Timestamp: <unix seconds>
 *   X-Teploy-Signature: sha256=hex(HMAC-SHA256(secret, timestamp + "." + body))
 *
 * teploy-cli (internal/notify/sign.go), teploy-dash (internal/alert/alert.go)
 * and teploy-observe sign identically, so a receiver of all of them writes one
 * verifier. Signing the timestamp together with the body is what lets that
 * receiver bound replay. Duplicated rather than shared because these are
 * separate runtimes; if it changes it changes everywhere or receivers break.
 *
 * An unset secret sends unsigned. That is deliberate for parity with the other
 * products, but a receiver that verifies will reject it — so prefer setting one.
 *
 * Configured with SHIP_NOTIFY_URL + SHIP_NOTIFY_SECRET, deliberately NOT
 * SHIP_WEBHOOK_SECRET: that one already exists and means the opposite thing —
 * the secret Forgejo signs its INBOUND deliveries to us with
 * (web/src/routes/hooks/forgejo.tsx). Sharing one value between "how a forge
 * proves itself to us" and "how we prove ourselves to a workspace" would either
 * force both systems onto the same secret or silently break whichever was
 * configured second.
 *
 * Advisory, like the Slack notifier: a delivery failure logs and never touches
 * the run. A run must not fail because something downstream was unreachable.
 */
export interface RunWebhookPayload {
  run_id: string;
  status: string;
  /** The event name to deliver a decision to, when parked. */
  event_name?: string;
  pr?: string;
  repo?: string;
  task?: string;
  /** Where the run can be inspected, when SHIP_PUBLIC_URL is configured. */
  url?: string;
  /** snake_case on the wire, matching every other field on this payload. */
  origin?: { source: string; dedupe_key: string; work_item_ref?: string };
  /** "scan" on scan runs; absent otherwise (L7). */
  mode?: "scan";
  /** Present on a scan run that recorded its findings step (L7). */
  findings?: ScanReport;
  /**
   * Contract 2 (additive): the change's class and the verification block.
   * FIELD NAMES ARE LOAD-BEARING across repos — Akiroo's Today card keys its
   * producer on exactly `change_class` and `verification.rungs` — so they
   * extend additively and never rename.
   */
  change_class?: ChangeClass;
  verification?: { rungs: Rung[]; summary: string };
  /** True when the pull request ended up merged, by the gate or by an approval. */
  merged?: boolean;
  /**
   * The agent's own result status on a terminal run — "finished",
   * "max-steps", "budget-exhausted", "plan-rejected" — as distinct from
   * `status`, which says only whether the workflow ended ("completed") or
   * threw ("failed"). A run that hit its turn limit is "completed" on the
   * wire; this is what says it did not finish. Additive: absent on parks.
   */
  outcome?: string;
}

export function runWebhookPayload(event: RunNotification, publicUrl?: string): RunWebhookPayload {
  const base = publicUrl !== undefined && publicUrl !== "" ? publicUrl.replace(/\/+$/, "") : "";
  return {
    run_id: event.runId,
    status: event.status,
    ...(event.eventName !== undefined ? { event_name: event.eventName } : {}),
    ...(event.pr !== undefined ? { pr: event.pr } : {}),
    ...(event.repo !== undefined ? { repo: event.repo } : {}),
    ...(event.task !== undefined ? { task: event.task } : {}),
    ...(base !== "" ? { url: `${base}/runs/${event.runId}` } : {}),
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.origin !== undefined
      ? {
          origin: {
            source: event.origin.source,
            dedupe_key: event.origin.dedupeKey,
            ...(event.origin.workItemRef !== undefined ? { work_item_ref: event.origin.workItemRef } : {}),
          },
        }
      : {}),
    ...(event.mode !== undefined ? { mode: event.mode } : {}),
    ...(event.findings !== undefined ? { findings: event.findings } : {}),
    ...(event.changeClass !== undefined ? { change_class: event.changeClass } : {}),
    // rungsForWire bounds each rung's detail so the whole payload stays a
    // record, not a log; the summary is already ≤2000 by its own budget
    // (verification-summary.ts SUMMARY_LIMIT).
    ...(event.verification !== undefined
      ? { verification: { rungs: rungsForWire(event.verification.rungs), summary: event.verification.summary } }
      : {}),
    ...(event.merged !== undefined ? { merged: event.merged } : {}),
  };
}

/** Computes the signature headers for a body. Empty secret signs nothing. */
export async function signWebhookBody(
  secret: string,
  body: string,
  nowSeconds?: number,
): Promise<Record<string, string>> {
  if (secret === "") return {};
  const ts = String(nowSeconds ?? Math.floor(Date.now() / 1000));
  const { createHmac } = await import("node:crypto");
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "X-Teploy-Timestamp": ts, "X-Teploy-Signature": `sha256=${mac}` };
}

export function webhookNotifier(options?: {
  webhookUrl?: string;
  secret?: string;
  publicUrl?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Notifier {
  const webhookUrl = options?.webhookUrl ?? process.env.SHIP_NOTIFY_URL ?? "";
  const secret = options?.secret ?? process.env.SHIP_NOTIFY_SECRET ?? "";
  const publicUrl = options?.publicUrl ?? process.env.SHIP_PUBLIC_URL ?? "";
  const log = options?.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (webhookUrl === "") return { enabled: false, runEvent: async () => true };
  return {
    enabled: true,
    async runEvent(event, deliveryId) {
      if (!notifiable(event.status)) return true;
      const body = JSON.stringify(runWebhookPayload(event, publicUrl));
      try {
        const headers = await signWebhookBody(secret, body);
        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Retries are at-least-once by design; this lets a receiver
            // recognise a repeat instead of acting on it twice.
            ...(deliveryId !== undefined ? { "X-Teploy-Delivery": deliveryId } : {}),
            ...headers,
          },
          body,
        });
        if (!response.ok) log(`[notify] webhook ${response.status}`);
        return response.ok;
      } catch (error) {
        log(`[notify] webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}

/**
 * L8 — the two record-shaped events Ship sends Akiroo that are NOT about a
 * run, on the same signed URL as the run webhook (contracts 1 and 4).
 *
 * `project` acknowledges a `project` outbox row: registered or failed, the
 * settings hash echoed so Akiroo can show "managed" vs drift, and whether the
 * forge webhook exists. `revert` says a merged Ship pull request was reverted
 * on the forge; Akiroo demotes the project's authority and appends its
 * decision log. Both are `kind`-tagged so a receiver that also takes run
 * events can route on one field; a run event carries no `kind`.
 */
export interface ProjectAckPayload {
  kind: "project";
  status: "registered" | "failed";
  project_ref: string;
  settings_hash: string;
  webhook: boolean;
  error?: string;
}

export interface RevertPayload {
  kind: "revert";
  /** Clone URL of the repository. */
  repo: string;
  /** The reverted (Ship) pull request. */
  pr: string;
  /** The pull request that carried the revert, when there was one. */
  revert_pr?: string;
  origin?: { source: string; dedupe_key: string; work_item_ref?: string };
}

export interface ProjectNotifier {
  enabled: boolean;
  project(ack: ProjectAckPayload): Promise<boolean>;
  revert(event: RevertPayload): Promise<boolean>;
}

/**
 * Delivers kind-tagged records to SHIP_NOTIFY_URL, signed like runWebhook.
 * Kept beside webhookNotifier rather than folded into it: that one is a
 * Notifier over RunNotification and flows through the durable outbox; these
 * are one-shot acks whose retry is the sender's (a project row is re-sent by
 * Akiroo on the next edit; a revert is re-detected on the next delivery).
 */
export function projectNotifier(options?: {
  webhookUrl?: string;
  secret?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): ProjectNotifier {
  const webhookUrl = options?.webhookUrl ?? process.env.SHIP_NOTIFY_URL ?? "";
  const secret = options?.secret ?? process.env.SHIP_NOTIFY_SECRET ?? "";
  const log = options?.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const fetchImpl = options?.fetchImpl ?? fetch;
  const deliver = async (payload: ProjectAckPayload | RevertPayload): Promise<boolean> => {
    if (webhookUrl === "") {
      log(`[notify] ${payload.kind} event dropped: SHIP_NOTIFY_URL is not set`);
      return false;
    }
    const body = JSON.stringify(payload);
    try {
      const headers = await signWebhookBody(secret, body);
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      if (!response.ok) log(`[notify] ${payload.kind} webhook ${response.status}`);
      return response.ok;
    } catch (error) {
      log(`[notify] ${payload.kind} webhook failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return { enabled: webhookUrl !== "", project: deliver, revert: deliver };
}
