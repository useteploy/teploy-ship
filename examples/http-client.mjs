import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** A dependency-free Node 22 client for Ship's existing HTTP surfaces. */
export class ShipHTTPError extends Error {
  constructor(status, operation, detail) {
    super(`${operation}: HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.status = status;
  }
}

export class ShipClient {
  #base;
  #token;
  constructor(baseURL, token) {
    const base = new URL(baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
        base.search || base.hash || base.pathname !== '/') throw new Error('Use a Ship HTTP(S) origin');
    if (!token || /[\r\n]/.test(token)) throw new Error('A Ship bearer token is required');
    this.#base = base.origin;
    this.#token = token;
  }
  async #request(path, init = {}) {
    // No automatic mutation retries: a lost response may hide a completed act.
    return fetch(`${this.#base}${path}`, {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, authorization: `Bearer ${this.#token}` },
    });
  }
  #runPath(runId) {
    if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw new Error('Invalid Ship run ID');
    return `/runs/${runId}`;
  }
  async #form(path, fields, operation) {
    const response = await this.#request(path, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const location = response.headers.get('location') ?? '';
    const url = new URL(location || '/', this.#base);
    const refusal = url.searchParams.get('error') || url.searchParams.get('messageError') ||
      url.searchParams.get('denied') || (url.searchParams.get('cancel') === 'failed' ? 'cancel failed' : '');
    const match = url.pathname.match(/^\/runs\/(run-[A-Za-z0-9-]+)$/);
    if (![302, 303].includes(response.status) || url.origin !== this.#base || !match || refusal) {
      throw new ShipHTTPError(response.status, operation, refusal || 'request refused or unexpected redirect');
    }
    return match[1];
  }
  async #json(path, init, operation) {
    const response = await this.#request(path, init);
    if (!response.ok) {
      // Keep 401/403/409 as refusals. In particular, 409 never means approved.
      throw new ShipHTTPError(response.status, operation, (await response.text()).slice(0, 500));
    }
    return response.json();
  }
  create({ task, repo, journey = 'change', requestId }) {
    if (!task || !repo || !requestId) throw new Error('task, repo and stable requestId are required');
    return this.#form('/', { intent: 'new-run', task, repo, journey, requestId }, 'create run');
  }
  workspace(runId) {
    return this.#json(`/api${this.#runPath(runId)}/workspace`, {}, 'read workspace');
  }
  decide(runId, { eventName, approved, reason, answer, plan }) {
    if (!eventName || typeof approved !== 'boolean') throw new Error('Reviewed eventName and explicit approved boolean are required');
    return this.#json(`/api${this.#runPath(runId)}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_name: eventName, approved, reason, answer, plan }),
    }, 'decide run');
  }
  async cancel(runId) {
    const returned = await this.#form(this.#runPath(runId), { intent: 'cancel' }, 'request cancellation');
    if (returned !== runId) throw new Error('Cancellation returned a different run');
    // Acceptance is not settlement: inspect the authoritative current state.
    return this.workspace(runId);
  }
  followUp(runId, { message, journey = 'change', requestId, target = 'base', eventName }) {
    if (!message || !requestId) throw new Error('message and stable requestId are required');
    return this.#form(this.#runPath(runId), {
      intent: 'follow-up', message, journey, requestId, target,
      ...(eventName ? { eventName } : {}),
    }, 'follow-up');
  }
}

// ---- Event verification (webhook receivers) -------------------------------
// A port of verifyEvent/EventDedupe from src/tool-manifest.ts, kept dependency
// free. Only meaningful when the Ship operator set SHIP_EVENT_ENVELOPE=on and a
// notify secret: Ship then adds X-Teploy-Event and X-Teploy-Event-Signature to
// each run webhook (body and X-Teploy-Signature unchanged).

/** Bounded set of seen event ids (FIFO eviction). */
export class EventDedupe {
  #seen = new Set();
  #capacity;
  constructor(capacity = 10_000) { this.#capacity = capacity; }
  has(id) { return this.#seen.has(id); }
  add(id) {
    this.#seen.add(id);
    if (this.#seen.size > this.#capacity) this.#seen.delete(this.#seen.values().next().value);
  }
}

/**
 * Verify one delivery. `headers` is a plain object with lower-cased names.
 * Order: authenticate, freshness, parse, major version, body binding, dedupe.
 * Only an event that passed everything is remembered, so a forged one cannot
 * poison the dedupe set. A duplicate returns { ok: true, duplicate: true }:
 * acknowledge it (2xx) and do nothing. Returns { ok: false, reason } otherwise.
 */
export function verifyEvent(headers, body, secret, { nowMs = Date.now(), replayWindowMs = 300_000, dedupe } = {}) {
  const envelope = headers['x-teploy-event'];
  const signature = headers['x-teploy-event-signature'];
  const timestamp = headers['x-teploy-timestamp'];
  if (typeof envelope !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'no-envelope' };
  const sig = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!sig) return { ok: false, reason: 'malformed-signature' };
  if (!/^\d{1,12}$/.test(timestamp ?? '')) return { ok: false, reason: 'bad-timestamp' };
  if (!secret) return { ok: false, reason: 'bad-signature' };
  const expected = createHmac('sha256', secret).update(`${timestamp}.${envelope}`).digest();
  const given = Buffer.from(sig[1], 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad-signature' };
  if (Math.abs(nowMs - Number(timestamp) * 1000) > replayWindowMs) return { ok: false, reason: 'expired' };
  let event;
  try { event = JSON.parse(envelope); } catch { return { ok: false, reason: 'malformed-body' }; }
  if (!event || typeof event !== 'object' || typeof event.eventId !== 'string' || event.eventId === '' ||
      typeof event.type !== 'string' || typeof event.schemaVersion !== 'string' || !Number.isInteger(event.cursor) ||
      event.cursor < 0 || typeof event.occurredAt !== 'string') return { ok: false, reason: 'malformed-envelope' };
  const version = /^(\d+)\.(\d+)/.exec(event.schemaVersion);
  if (!version) return { ok: false, reason: 'malformed-envelope' };
  if (Number(version[1]) !== 1) return { ok: false, reason: 'unsupported-major' };
  // The envelope travels in headers; this ties it to the body actually received.
  if (event.data?.payloadSha256 !== createHash('sha256').update(body).digest('hex')) return { ok: false, reason: 'body-mismatch' };
  if (dedupe?.has(event.eventId)) return { ok: true, duplicate: true, eventId: event.eventId };
  dedupe?.add(event.eventId);
  return { ok: true, duplicate: false, event };
}
