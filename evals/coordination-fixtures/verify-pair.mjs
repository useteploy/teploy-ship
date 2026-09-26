// Independent held-out contract: run against the two worked checkout paths.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [api, client, endpoint = '/sum'] = process.argv.slice(2);
if (!api || !client || !['/add', '/sum'].includes(endpoint)) throw new Error('usage: verify-pair.mjs API_DIR CLIENT_DIR [/add|/sum]');
const { server } = await import(pathToFileURL(resolve(api, 'server.mjs')));
const { calculate } = await import(pathToFileURL(resolve(client, 'client.mjs')));
const s = server(); await new Promise(r => s.listen(0, '127.0.0.1', r));
try {
  const base = `http://127.0.0.1:${s.address().port}`;
  for (const [a, b] of [[2, 5], [-4, 3], [0.5, 0.25]]) assert.equal(await calculate(base, a, b), a + b);
  const response = await fetch(base + endpoint, { method: 'POST', body: JSON.stringify({ a: 4, b: 9 }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { result: 13 });
  const removed = endpoint === '/sum' ? '/add' : '/sum';
  assert.equal((await fetch(base + removed, { method: 'POST', body: '{"a":1,"b":2}' })).status, 404);
  console.log(JSON.stringify({ verified: true, endpoint, realHTTP: true }));
} finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
