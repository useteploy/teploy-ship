import { RepoNotAllowedError, proposeExternal } from "teploy-ship/runtime";
import type { ProposeInput } from "teploy-ship/runtime";

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
