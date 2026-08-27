import { RepoNotAllowedError, proposeExternal } from "teploy-ship/runtime";
import type { ProposeInput } from "teploy-ship/runtime";

import { incidentTaskFromObserveAlert, observeAlertKey, repoForObserveService } from "teploy-ship";

import { shipRuntime } from "./store.server.js";

/**
 * Shared plumbing for the public webhook receivers (Forgejo, GitHub, Slack,
 * Linear). These four routes are the only unauthenticated-at-the-middleware
 * surface Ship exposes, so the things every one of them must do live here
 * rather than being re-implemented (and drifting) four times.
 */

/** Default cap on a webhook body, before any signature work. Override with SHIP_WEBHOOK_MAX_BYTES. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function maxWebhookBytes(): number {
  const raw = Number(process.env.SHIP_WEBHOOK_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_BYTES;
}

export class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

/**
 * Read a request body with a hard ceiling.
 *
 * `await request.text()` buffers whatever an unauthenticated client sends
 * BEFORE the HMAC can reject it, so body size is attacker-chosen and the
 * signature check is a CPU multiplier on top. Streaming with a running total
 * lets us hang up early: Content-Length is rejected outright when it is over
 * the limit, and a chunked body is abandoned the moment it crosses.
 */
export async function readCappedBody(request: Request, limit = maxWebhookBytes()): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit);

  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) throw new BodyTooLarge(limit);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** One guarded JSON parse, so a malformed body is a 400 and never a 500. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Has this exact delivery been processed before?
 *
 * An HMAC authenticates bytes; it says nothing about freshness, so a captured
 * delivery can be replayed forever. Every forge stamps a unique delivery id
 * (X-GitHub-Delivery, X-Forgejo-Delivery / X-Gitea-Delivery) — recording it
 * before acting turns "signed" into "signed and seen once".
 *
 * Returns true when the delivery is NEW (caller should proceed). Recording is
 * atomic, so two concurrent deliveries of the same id collapse to one winner.
 */
export async function claimDelivery(source: string, deliveryId: string | null): Promise<boolean> {
  if (deliveryId === null || deliveryId.trim() === "") return true; // nothing to dedupe on
  const runtime = await shipRuntime();
  return runtime.deliveries.claim(source, deliveryId.trim());
}

export function firstHeader(request: Request, ...names: string[]): string | null {
  for (const name of names) {
    const value = request.headers.get(name);
    if (value !== null && value !== "") return value;
  }
  return null;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Propose a task from a verified webhook and turn the outcome into a response.
 *
 * This lives here rather than in the route modules for a build reason worth
 * knowing: a route module's default export goes into the CLIENT bundle, and
 * anything it imports goes with it. `proposeExternal` reaches the runtime,
 * which reaches node:fs — so importing it directly from a route breaks the
 * browser build ("join is not exported by __vite-browser-external"). Modules
 * named *.server.ts are excluded from that graph, so the node-only call has to
 * sit behind one. Same reason PLAN_EVENT has its own dependency-free module.
 *
 * A refused repository becomes a 403 naming the allowlist rather than a silent
 * drop, because "nothing happened" is indistinguishable from Ship being broken.
 */
export async function proposeFromWebhook(input: ProposeInput): Promise<Response> {
  const runtime = await shipRuntime();
  try {
    const { created, task } = await proposeExternal(runtime, input);
    return json(created ? 201 : 200, { ok: true, taskId: task.taskId, created });
  } catch (error) {
    if (error instanceof RepoNotAllowedError) {
      return json(403, { title: "repository not allowed", detail: error.message });
    }
    throw error;
  }
}


/**
 * Verify an Observe webhook signature.
 *
 * Observe signs Stripe-style: `X-Observe-Signature: sha256=<lowercase hex of
 * HMAC-SHA256(secret, "<unix-seconds>.<raw body>")>` with the timestamp
 * repeated in `X-Observe-Timestamp`
 * (teploy-observe/internal/platform/webhooks.go:134-161). Binding the
 * timestamp INTO the signed message is what makes the freshness check below
 * meaningful — an attacker replaying a captured body cannot move the clock
 * without invalidating the MAC.
 *
 * Freshness matters more here than on the forge receivers, because Observe
 * stamps no delivery id, so `claimDelivery` has nothing of its own to dedupe
 * on. The window is SHIP_OBSERVE_MAX_SKEW_S seconds either side of now
 * (default 300); a body older than that is refused even with a valid MAC.
 *
 * Returns null on success, or the response to send.
 */
export async function verifyObserveSignature(request: Request, body: string, secret: string): Promise<Response | null> {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const signature = request.headers.get("x-observe-signature") ?? "";
  const timestamp = request.headers.get("x-observe-timestamp") ?? "";
  // An unsigned delivery lands here as two empty headers: Observe omits both
  // when its stored secret is blank (webhooks.go:141). Ship requires the
  // secret, so that delivery must be refused rather than treated as "no
  // signature to check".
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad observe signature" });
  }
  // Checked AFTER the MAC, so the value being range-checked is one Observe
  // actually signed rather than a header any caller can set.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return json(401, { title: "bad observe signature timestamp" });
  const skew = Number(process.env.SHIP_OBSERVE_MAX_SKEW_S);
  const window = Number.isFinite(skew) && skew > 0 ? skew : 300;
  if (Math.abs(Date.now() / 1000 - sent) > window) {
    return json(401, { title: "observe delivery is outside the freshness window", detail: `${window}s` });
  }
  return null;
}

/**
 * The repository an Observe alert is about, as a CLONE URL.
 *
 * Two hops, and both are needed. The evidence store answers service → repo
 * SLUG (`repoForObserveService`, src/evidence.ts) because that is the key
 * every evidence and telemetry record is filed under; a run needs a URL to
 * clone. The project record is the only place a slug's clone URL is written
 * (`Project.url`, src/projects.ts:35), so a repo configured through the legacy
 * `evidence set` path with no project record resolves to a slug and no URL —
 * which correctly yields an UNBOUND proposal rather than a run pointed at a
 * repository Ship cannot clone.
 *
 * Returns undefined for no match, an ambiguous match, or a slug with no URL.
 */
export async function observeRepoFor(payload: Parameters<typeof observeAlertKey>[0]): Promise<string | undefined> {
  const key = observeAlertKey(payload);
  if (key === "") return undefined;
  const runtime = await shipRuntime();
  const slug = repoForObserveService(await runtime.evidence.list(), key);
  if (slug === null) return undefined;
  const project = await runtime.projects.forRepo(slug);
  return project?.url;
}

/** Re-exported so the receiver route imports one module. */
export { incidentTaskFromObserveAlert };
