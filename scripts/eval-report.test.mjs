import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { buildReport, renderMarkdown } from './eval-report.mjs';

// Synthetic results trees in temp dirs: no real record is read or touched.
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'eval-report-'));
  return {
    root,
    add(run, scenario, record, artifacts = {}) {
      const dir = join(root, run, scenario);
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'result.json'), typeof record === 'string' ? record : JSON.stringify({ ...record, runId: record.runId === 'r' ? run : record.runId, scenarioId: record.scenarioId === 'pj-s-question' ? scenario : record.scenarioId }));
      for (const [name, body] of Object.entries(artifacts)) writeFileSync(join(dir, 'artifacts', name), JSON.stringify(body));
    },
    done() { rmSync(root, { recursive: true, force: true }); }
  };
}

function rec(over = {}) {
  return {
    scenarioId: 'pj-s-question', runId: 'r', firstAttempt: { pass: true, graderReasons: [], endedBy: 'agent' },
    eventualSuccess: { pass: true }, interventions: [], rescue: { needed: false, provided: false },
    latencyMs: 60000, cost: { status: 'priced', amount: 0.01, currency: 'USD' }, ...over
  };
}

test('each outcome class is counted exactly once and unknown is neither pass nor fail', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'pass' }));
    t.add('r1', 'pj-s-b', rec({ outcome: 'fail', firstAttempt: { pass: false, graderReasons: ['wrong'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    t.add('r2', 'pj-s-c', rec({ outcome: 'unknown', firstAttempt: { pass: false, graderReasons: ['not-wired: x'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    t.add('r2', 'pj-s-d', rec({ outcome: 'harness-error', firstAttempt: { pass: false, graderReasons: ['adapter failed'], endedBy: 'harness-error' }, eventualSuccess: { pass: false } }));
    t.add('r3', 'pj-s-e', rec({ outcome: 'authority-hold', hold: { runId: 'x', event: 'change-approval' }, firstAttempt: { pass: false, graderReasons: [], endedBy: 'authority-hold' }, eventualSuccess: { pass: false } }));
    const r = buildReport(t.root);
    assert.deepEqual(r.counts, { pass: 1, fail: 1, unknown: 1, 'harness-error': 1, 'authority-hold': 1 });
    assert.equal(r.modelQuality.denominator, 2);
    assert.equal(r.modelQuality.passRate, 0.5);
    assert.equal(r.authorityHold.count, 1);
    assert.deepEqual(r.exclusions.map(e => e.kind).sort(), ['authority-hold', 'harness-error', 'unknown']);
  } finally { t.done(); }
});

test('negative control: an unknown record is in no pass or fail count and no denominator', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'unknown', firstAttempt: { pass: false, graderReasons: ['not-wired: y'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    const r = buildReport(t.root);
    assert.equal(r.counts.pass, 0);
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.unknown, 1);
    assert.equal(r.modelQuality.denominator, 0);
    assert.equal(r.modelQuality.passRate, null);
    assert.equal(r.firstAttempt.gradedRecords, 0);
    // Even an unknown record whose first attempt claims pass: true is not a pass.
    const t2 = tree();
    try {
      t2.add('r1', 'pj-s-a', rec({ outcome: 'unknown' }));
      const r2 = buildReport(t2.root);
      assert.equal(r2.counts.pass, 0);
      assert.equal(r2.modelQuality.denominator, 0);
    } finally { t2.done(); }
  } finally { t.done(); }
});

test('older records without outcome are derived exactly as outcomeOf does', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec());
    t.add('r1', 'pj-s-b', rec({ firstAttempt: { pass: false, graderReasons: ['no citations'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    t.add('r1', 'pj-s-c', rec({ firstAttempt: { pass: false, graderReasons: ['not-wired: a', 'not-wired: b'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    // One real reason mixed with not-wired is a failure, not unknown.
    t.add('r1', 'pj-s-d', rec({ firstAttempt: { pass: false, graderReasons: ['not-wired: a', 'wrong answer'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    t.add('r1', 'pj-s-e', rec({ firstAttempt: { pass: false, graderReasons: ['adapter failed: fetch'], endedBy: 'harness-error' }, eventualSuccess: { pass: false } }));
    const r = buildReport(t.root);
    assert.deepEqual(r.counts, { pass: 1, fail: 2, unknown: 1, 'harness-error': 1, 'authority-hold': 0 });
    assert.equal(r.outcomeSources.derived, 5);
    assert.equal(r.outcomeSources.recorded, 0);
  } finally { t.done(); }
});

test('regrade and reclassification files are listed but never change the original class', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'fail', firstAttempt: { pass: false, graderReasons: ['x'], endedBy: 'agent' }, eventualSuccess: { pass: false } }),
      { 'regrade-better.json': { pass: true, reason: 'lexical fix' }, 'grader-output.json': { pass: false }, 'note.json': { reason: 'context' } });
    t.add('r1', 'pj-s-b', rec({ outcome: 'harness-error', firstAttempt: { pass: false, graderReasons: [], endedBy: 'harness-error' }, eventualSuccess: { pass: false } }),
      { 'reclassification-hold.json': { reclassifiedOutcome: 'authority-hold', reason: 'parked' } });
    const r = buildReport(t.root);
    assert.deepEqual(r.counts, { pass: 0, fail: 1, unknown: 0, 'harness-error': 1, 'authority-hold': 0 });
    const kinds = r.exclusions.map(e => e.kind);
    assert.ok(kinds.includes('regrade') && kinds.includes('reclassification') && kinds.includes('annotation'));
    // grader-output.json is the grader's own file, not a supplement.
    assert.ok(!r.exclusions.some(e => e.path.endsWith('grader-output.json')));
    assert.deepEqual(r.supplementClaims.map(c => [c.claimedOutcome, c.applied]).sort(), [['authority-hold', false], ['pass', false]]);
  } finally { t.done(); }
});

test('missing fields yield unknown, never pass or fail, and are named', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', { scenarioId: 'pj-s-a', runId: 'r1' });
    t.add('r1', 'pj-s-b', rec({ outcome: 'bogus-class' }));
    const r = buildReport(t.root);
    assert.equal(r.counts.unknown, 2);
    assert.equal(r.counts.pass + r.counts.fail, 0);
    assert.match(r.exclusions.find(e => e.path.includes('pj-s-a')).detail, /firstAttempt\.pass/);
    assert.match(r.exclusions.find(e => e.path.includes('pj-s-b')).detail, /bogus-class/);
    assert.equal(r.cost.missingRecords, 2 - r.cost.pricedRecords - r.cost.unknownRecords);
    assert.equal(r.interventions.recordsNotRecorded, 1);
    assert.equal(r.latency.notRecorded, 1);
  } finally { t.done(); }
});

test('an unparseable result.json is listed as unreadable and counted nowhere', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', '{ not json');
    t.add('r1', 'pj-s-b', rec({ outcome: 'pass' }));
    const r = buildReport(t.root);
    assert.equal(r.recordsFound, 2);
    assert.equal(r.recordsCounted, 1);
    assert.equal(r.unreadable, 1);
    assert.ok(r.exclusions.some(e => e.kind === 'unreadable'));
  } finally { t.done(); }
});

test('unknown cost is never summed as zero and a priced zero is flagged suspect', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'pass', cost: { status: 'priced', amount: 0.25, currency: 'USD' } }));
    t.add('r1', 'pj-s-b', rec({ outcome: 'pass', cost: { status: 'priced', amount: 0, currency: 'USD' } }));
    t.add('r1', 'pj-s-c', rec({ outcome: 'pass', cost: { status: 'unknown', reason: 'no telemetry' } }));
    const r = buildReport(t.root);
    assert.equal(r.cost.pricedRecords, 2);
    assert.equal(r.cost.unknownRecords, 1);
    assert.equal(r.cost.pricedSum, 0.25);
    assert.equal(r.cost.pricedSumIsLowerBound, true);
    assert.deepEqual(r.cost.suspectZeroPriced, ['r1/pj-s-b/result.json']);
    assert.match(renderMarkdown(r), /lower bound/);
  } finally { t.done(); }
});

test('first attempt vs eventual success, interventions, rescue and latency', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'pass' }));
    // grader passed but a rescue made eventual success false.
    t.add('r1', 'pj-s-b', rec({ outcome: 'pass', eventualSuccess: { pass: false }, interventions: [{ kind: 'rescue', at: 't', note: 'n' }, { kind: 'clarification', at: 't', note: 'n' }], rescue: { needed: true, provided: true }, latencyMs: 120000 }));
    t.add('r1', 'pj-s-c', rec({ outcome: 'pass', latencyMs: 1 }));
    const r = buildReport(t.root);
    assert.equal(r.firstAttempt.passed, 3);
    assert.equal(r.eventualSuccess.passed, 2);
    assert.equal(r.eventualSuccess.failed, 1);
    assert.deepEqual(r.interventions.byKind, { rescue: 1, clarification: 1 });
    assert.equal(r.interventions.rescue.provided, 1);
    assert.equal(r.latency.all.n, 2);
    assert.equal(r.latency.suspect.length, 1);
    assert.equal(r.latency.all.median, 90000);
  } finally { t.done(); }
});

test('grouping by run and scenario, summary.json disagreement surfaced, no file is modified', () => {
  const t = tree();
  try {
    t.add('r1', 'pj-s-a', rec({ outcome: 'unknown', firstAttempt: { pass: false, graderReasons: ['not-wired: z'], endedBy: 'agent' }, eventualSuccess: { pass: false } }));
    t.add('r2', 'pj-s-a', rec({ outcome: 'pass' }));
    writeFileSync(join(t.root, 'r1', 'summary.json'), JSON.stringify({ totals: { pass: 0, fail: 1, unknown: 0 } }));
    const hash = () => {
      const h = createHash('sha256');
      const walk = d => readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else h.update(p).update(readFileSync(p));
      });
      walk(t.root);
      return h.digest('hex');
    };
    const before = hash();
    const r = buildReport(t.root);
    renderMarkdown(r);
    assert.equal(hash(), before);
    assert.deepEqual(r.runsDetail.map(x => x.runId), ['r1', 'r2']);
    assert.equal(r.scenariosDetail[0].attempts, 2);
    assert.deepEqual(r.consistency.summaryTotalsMismatches, [
      { run: 'r1', outcome: 'fail', summaryTotals: 1, recount: 0 },
      { run: 'r1', outcome: 'unknown', summaryTotals: 0, recount: 1 }
    ]);
    const md = renderMarkdown(r);
    assert.match(md, /## EXCLUSIONS/);
    assert.match(md, /## By run/);
  } finally { t.done(); }
});

test('an empty or missing results directory reports zero without throwing', () => {
  const r = buildReport(join(tmpdir(), 'eval-report-does-not-exist'));
  assert.equal(r.recordsFound, 0);
  assert.equal(r.modelQuality.passRate, null);
});
