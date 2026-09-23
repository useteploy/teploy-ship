// Cheap fake-store test for the history probe: file mode needs only a temp
// TEPLOY_SHIP_STATE, and fileRuntime() is the real store the CLI uses — the
// probe's nucleus path is the same measureHistory() over a different runtime,
// and is exercised by the isolated-engine check-* scripts' pattern instead
// (it requires a live Nucleus, which this suite does not assume).
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileRuntime } from '../dist/runtime.js';
import { measureHistory } from './measure-history.mjs';

test('measureHistory counts runs and events and reports latencies over a real file store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ship-measure-history-test-'));
  const previous = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  try {
    const runtime = fileRuntime();
    const now = new Date().toISOString();
    const perRun = { 'run-a': 3, 'run-b': 7, 'run-c': 1 };
    for (const [runId, events] of Object.entries(perRun)) {
      await runtime.saveMeta({ runId, task: `task ${runId}`, status: 'completed', model: 'test', createdAt: now, updatedAt: now });
      for (let seq = 0; seq < events; seq++) {
        await runtime.store.append(runId, { type: 'step-succeeded', at: now, seq, data: {} });
      }
    }

    const report = await measureHistory(runtime, { repeats: 2 });

    assert.equal(report.enumeration.totalRuns, 3);
    assert.equal(report.enumeration.truncated, false);
    assert.equal(report.streams.runsRead, 3);
    assert.equal(report.streams.totalEvents, 3 + 7 + 1);
    assert.equal(report.runsPage.repeats, 2);
    assert.equal(report.runsPage.samplesMs.length, 2);
    assert.ok(report.runsPage.medianMs >= 0);
    assert.ok(report.streams.loadMs.p50 >= 0);
    assert.ok(report.streams.loadMs.max >= report.streams.loadMs.p50);
    assert.deepEqual(
      [report.streams.eventsPerRun.min, report.streams.eventsPerRun.median, report.streams.eventsPerRun.max],
      [1, 3, 7],
    );
  } finally {
    if (previous === undefined) delete process.env.TEPLOY_SHIP_STATE;
    else process.env.TEPLOY_SHIP_STATE = previous;
  }
});

test('measureHistory handles an empty store without dividing by zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ship-measure-history-empty-'));
  const previous = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  try {
    const report = await measureHistory(fileRuntime(), { repeats: 1 });
    assert.equal(report.enumeration.totalRuns, 0);
    assert.equal(report.streams.totalEvents, 0);
    assert.equal(report.streams.loadMs, null);
    assert.equal(report.streams.eventsPerRun, null);
    assert.equal(report.runsPage.returned, 0);
  } finally {
    if (previous === undefined) delete process.env.TEPLOY_SHIP_STATE;
    else process.env.TEPLOY_SHIP_STATE = previous;
  }
});
