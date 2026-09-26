import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from './server.mjs';

test('Add HTTP contract', async (t) => {
  const s = server(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = (body, path = '/add') => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
  assert.deepEqual(await (await call({ a: 2, b: 5 })).json(), { result: 7 });
  assert.equal((await call({ a: '2', b: 5 })).status, 400);
  assert.equal((await call({ a: 2, b: 5 }, '/missing')).status, 404);
});
