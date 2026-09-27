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
