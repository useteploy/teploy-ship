import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from './client.mjs';

test('client sends the Add contract and returns its result', async () => {
  const result = await calculate('http://api.example.test', 2, 5, async (url, options) => {
    assert.equal(url.pathname, '/add'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { a: 2, b: 5 });
    return Response.json({ result: 7 });
  });
  assert.equal(result, 7);
});
test('client surfaces API refusal', async () => {
  await assert.rejects(calculate('http://api.example.test', 2, 5, async () => new Response('', { status: 503 })), /503/);
});
