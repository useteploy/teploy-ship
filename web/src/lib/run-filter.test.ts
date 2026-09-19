import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterRuns, runCategory } from './run-filter.js';
const runs = [
  { runId: 'run-one', task: 'Fix checkout', model: 'glm', status: 'running' },
  { runId: 'run-two', task: 'Fix checkout tests', model: 'claude', status: 'waiting' },
  { runId: 'run-three', task: 'Update docs', model: 'glm', status: 'failed' },
];
test('run search intersects status and matches task, model or ID without case sensitivity', () => {
  assert.deepEqual(filterRuns(runs, 'waiting', ' CHECKOUT ').map(r => r.runId), ['run-two']);
  assert.equal(filterRuns(runs, 'all', 'CLAUDE').length, 1);
  assert.equal(filterRuns(runs, 'all', 'run-three')[0]?.status, 'failed');
  assert.equal(filterRuns(runs, 'completed', '').length, 0);
  assert.equal(filterRuns(runs, 'all', '').length, 3);
});
test('active includes queued, sleeping, retrying and cancellation in progress', () => {
  for (const status of ['queued', 'sleeping', 'retrying', 'cancelling']) assert.equal(runCategory(status), 'active');
  assert.equal(runCategory('cancelled'), 'cancelled');
});
