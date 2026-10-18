import type { EventVendor } from "../event-rules.js";
import type { VendorAdapter } from "./adapter.js";
import { sentryAdapter } from "./sentry.js";
import { datadogAdapter } from "./datadog.js";
import { pagerdutyAdapter } from "./pagerduty.js";
import { jiraAdapter } from "./jira.js";
import { gitlabAdapter } from "./gitlab.js";

/**
 * E7 EV4 — the vendor adapter registry. A registered event source whose
 * record declares one of these vendors is verified and mapped by that
 * adapter at `/hooks/events/<source>`; a source with no vendor speaks the
 * generic S24 envelope of EV2. Everything stays behind SHIP_EVENT_RULES.
 */
export const VENDOR_ADAPTERS: Record<EventVendor, VendorAdapter> = {
  sentry: sentryAdapter,
  datadog: datadogAdapter,
  pagerduty: pagerdutyAdapter,
  jira: jiraAdapter,
  gitlab: gitlabAdapter,
};

export function eventVendorAdapter(vendor: EventVendor): VendorAdapter {
  return VENDOR_ADAPTERS[vendor];
}

/**
 * True when the vendor's signature itself covers a timestamp, so verify()
 * already enforces a hard freshness window. Every other vendor delivery
 * (unsigned timestamp) gets the route's SOFT freshness check instead: the
 * mapped event's occurredAt against maxAgeSeconds, with replays stopped by
 * the delivery claim on the vendor's own id.
 */
export function vendorSignatureCoversTimestamp(vendor: EventVendor, auth: "hmac" | "shared-secret"): boolean {
  // GitLab's signing token is the only scheme here that binds the timestamp
  // into the signed message ("<id>.<timestamp>.<body>", Standard Webhooks).
  return vendor === "gitlab" && auth === "hmac";
}

export { DATADOG_PAYLOAD_TEMPLATE } from "./datadog.js";
