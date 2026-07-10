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
}

export interface Notifier {
  enabled: boolean;
  runEvent(event: RunNotification): void;
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
  if (webhookUrl === "") return { enabled: false, runEvent: () => {} };
  return {
    enabled: true,
    runEvent(event) {
      if (!notifiable(event.status)) return;
      void fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatRunNotification(event, publicUrl) }),
      })
        .then((response) => {
          if (!response.ok) log(`[notify] slack webhook ${response.status}`);
        })
        .catch((error) => log(`[notify] slack webhook failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  };
}
