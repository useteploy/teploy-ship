/**
 * A4 — outbound notifications: one short Slack message when a run needs
 * a human (parked) or settles (completed/failed), linking back to the
 * dashboard. Opt-in via SHIP_SLACK_WEBHOOK_URL (an incoming-webhook URL);
 * SHIP_PUBLIC_URL makes the run links clickable. Notifications are
 * advisory — failures log and never touch the run.
 */

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
    const what = event.eventName === "plan-approval" ? "a plan review" : "an approval";
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
