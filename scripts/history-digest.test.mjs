import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Run the operator script with only its database and event-store imports replaced.
// No live credentials or production data are needed to exercise a failed read.
const source = (await readFile(new URL('./history-digest.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('createHash', 'NucleusPgwire', 'NucleusEventStore', 'console', 'process', source);

async function digest(load, output) {
  class Database {
    streams = {};
    async query() { return [{ run_id: 'run-a', status: 'waiting' }]; }
  }
  class Events { load = load; }
  await run(createHash, Database, Events, { log: (value) => output.push(JSON.parse(value)) }, { env: {} });
}

test('history read failure aborts without printing a successful digest', async () => {
  const output = [];
  await assert.rejects(digest(async () => { throw new Error('store unavailable'); }, output), /store unavailable/);
  assert.deepEqual(output, []);
});

test('successful history checks are stable and detect changed events', async () => {
  const output = [];
  await digest(async () => [{ seq: 1, data: 'original' }], output);
  await digest(async () => [{ seq: 1, data: 'original' }], output);
  await digest(async () => [{ seq: 1, data: 'changed' }], output);
  assert.deepEqual(output[0], output[1]);
  assert.equal(output[0].events, 1);
  assert.deepEqual(output[0].waiting, ['run-a']);
  assert.notEqual(output[0].historySHA256, output[2].historySHA256);
});
