import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ShipClient, ShipHTTPError } from '../examples/http-client.mjs';

test('independent client preserves refusals, decisions and cancellation state over HTTP', async () => {
  const requests = [];
  let responseMode = 'normal';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer test-only') { res.writeHead(401); res.end('unauthorized'); return; }
    if (responseMode === 'foreign') { res.writeHead(303, { location: 'http://example.invalid/runs/run-foreign' }); res.end(); return; }
    if (responseMode === 'denied') { res.writeHead(303, { location: '/runs/run-one?denied=steer' }); res.end(); return; }
    if (responseMode === 'fork-refused') { res.writeHead(303, { location: '/runs/run-one?messageError=' + encodeURIComponent('fork refused (FORK_SOURCE_NOT_SETTLED): run run-one is running') }); res.end(); return; }
    if (req.url.endsWith('/decide')) {
      const decision = JSON.parse(body);
      res.writeHead(decision.event_name === 'current' ? 200 : 409, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision.event_name === 'current' ? { ok: true } : { error: 'stale decision' })); return;
    }
    if (req.url.endsWith('/workspace')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ meta: { status: 'cancelling' } })); return; }
    res.writeHead(303, { location: '/runs/run-one' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ship = new ShipClient(origin, 'test-only');
    const request = { task: 'explain', repo: 'https://example.invalid/repo', journey: 'investigate', requestId: 'persisted-id' };
    assert.equal(await ship.create(request), 'run-one');
    assert.equal(await ship.create(request), 'run-one');
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(new URLSearchParams(requests[0].body).get('requestId'), 'persisted-id');
    assert.deepEqual(await ship.decide('run-one', { eventName: 'current', approved: false, reason: 'owner declined' }), { ok: true });
    assert.equal(JSON.parse(requests.at(-1).body).approved, false);
    const before = requests.length;
    await assert.rejects(ship.decide('run-one', { eventName: 'old', approved: true }), e => e instanceof ShipHTTPError && e.status === 409);
    assert.equal(requests.length, before + 1, 'does not retry a stale decision');
    assert.equal((await ship.cancel('run-one')).meta.status, 'cancelling');
    // DF1: the fork call posts the fork intent like a follow-up, and a refusal
    // the route sends back as a messageError surfaces as the client's error.
    assert.equal(await ship.fork('run-one', { message: 'fork it', requestId: 'persisted-id' }), 'run-one');
    const forkBody = new URLSearchParams(requests.at(-1).body);
    assert.equal(forkBody.get('intent'), 'fork');
    assert.equal(forkBody.get('message'), 'fork it');
    assert.equal(forkBody.get('requestId'), 'persisted-id');
    assert.throws(() => ship.fork('run-one', { message: '' }), /message and stable requestId are required/);
    responseMode = 'fork-refused';
    await assert.rejects(ship.fork('run-one', { message: 'again', requestId: 'persisted-id' }), /FORK_SOURCE_NOT_SETTLED/);
    responseMode = 'normal';
    await assert.rejects(new ShipClient(origin, 'wrong').workspace('run-one'), e => e.status === 401);
    responseMode = 'foreign';
    await assert.rejects(ship.create(request), /unexpected redirect/);
    responseMode = 'denied';
    await assert.rejects(ship.cancel('run-one'), /steer/);
    assert.throws(() => ship.decide('run-one', { approved: true }), /eventName/);
    assert.throws(() => ship.workspace('../settings'), /Invalid Ship run ID/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
