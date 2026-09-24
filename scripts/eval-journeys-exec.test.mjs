// Execution-path tests for the product-journey harness: adapter selection
// and refusals, fixture staging, grader invocation from an out-of-tree
// grader dir, result-record shape vs results/schema.json, transcript
// preservation, and the mock pass / mock-fail paths. Everything runs in
// temp directories — no real state is touched, no model is invoked, no
// network leaves the process (the ship adapter sees a fake fetch only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadManifest, parseArgs, runScenario, createMockAdapter,
  parseMockResponse, nextRunId, schemaValidationErrors, stageFixture, AdapterRefusal
} from './eval-journeys-lib.mjs';
import { createShipAdapter } from './eval-journeys-ship.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const pjRoot = join(repoRoot, 'evals', 'product-journeys');

// A hermetic world: fixture root and grader dir copied out of tree, results
// redirected to temp. Nothing writes inside the repo.
function hermeticWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'pj-exec-test-'));
  const fixtureRoot = join(dir, 'fixtures');
  cpSync(join(pjRoot, 'fixtures'), fixtureRoot, { recursive: true });
  const graderDir = join(dir, 'journey-graders');
  cpSync(join(pjRoot, 'graders'), graderDir, { recursive: true });
  const resultsRoot = join(dir, 'results');
  return { dir, fixtureRoot, graderDir, resultsRoot };
}

async function runOne(world, scenarioId, adapter = createMockAdapter({ repoRoot })) {
  const manifest = await loadManifest(repoRoot);
  const scenario = manifest.scenarios.find(s => s.id === scenarioId);
  return runScenario({
    repoRoot, manifest, scenario, adapter,
    graderDir: world.graderDir, fixtureRoot: world.fixtureRoot, resultsRoot: world.resultsRoot
  });
}

const schema = JSON.parse(readFileSync(join(pjRoot, 'results', 'schema.json'), 'utf8'));

test('a passing patch cannot hide a moved main or a mismatched captured revision', async () => {
  for (const [extra, reason] of [
    [{ fixtureRepo: { mainMoved: true } }, /fixture main moved/],
    [{ captured: { sha: 'actual', expected: 'recorded' } }, /captured PR revision/]
  ]) {
    const world = hermeticWorld();
    try {
      const mock = createMockAdapter({ repoRoot });
      const adapter = { name: 'mock', async runTask(ctx) {
        const result = await mock.runTask(ctx);
        return { ...result, summary: { ...result.summary, ...extra } };
      } };
      const { record, workDir } = await runOne(world, 'pj-s-copy', adapter);
      assert.equal(record.firstAttempt.pass, false);
      assert.match(record.firstAttempt.graderReasons.join('\n'), reason);
      rmSync(workDir, { recursive: true, force: true });
    } finally { rmSync(world.dir, { recursive: true, force: true }); }
  }
});

test('parseArgs: scenario lists, repeat, ship-repos and intake parse and validate', () => {
  const a = parseArgs(['--scenario', 'pj-s-copy,pj-s-question', '--i-authorize-spend', '--repeat', '3',
    '--adapter', 'ship', '--ship-repos', '/abs/repos.json', '--ship-intake', 'scan']);
  assert.deepEqual(a.scenarios, ['pj-s-copy', 'pj-s-question']);
  assert.equal(a.repeat, 3);
  assert.equal(a.shipRepos, '/abs/repos.json');
  assert.equal(a.shipIntake, 'scan');
  assert.deepEqual(a.errors, []);
  assert.equal(parseArgs(['--scenario', 'all']).scenarios[0], 'all');
  assert.ok(parseArgs(['--scenario', 'x', '--repeat', '0']).errors.some(e => e.includes('--repeat')));
  assert.ok(parseArgs(['--scenario', 'x', '--ship-repos', 'rel.json']).errors.some(e => e.includes('absolute')));
  assert.ok(parseArgs(['--scenario', 'x', '--ship-intake', 'nope']).errors.some(e => e.includes('--ship-intake')));
  assert.ok(parseArgs(['--scenario', 'a,b', '--dry-run']).errors.some(e => e.includes('single scenario')));
});

test('parseArgs: adapter flag validates, defaults to mock, ship-repo/roots parse', () => {
  assert.equal(parseArgs(['--scenario', 'pj-s-copy', '--i-authorize-spend']).adapter, 'mock');
  const ship = parseArgs(['--scenario', 'pj-s-copy', '--i-authorize-spend', '--adapter', 'ship',
    '--fixture-root', '/tmp/f', '--results-root', '/tmp/r', '--ship-repo', 'https://forge/tyler/canary']);
  assert.equal(ship.adapter, 'ship');
  assert.equal(ship.fixtureRoot, '/tmp/f');
  assert.equal(ship.resultsRoot, '/tmp/r');
  assert.equal(ship.shipRepo, 'https://forge/tyler/canary');
  assert.ok(parseArgs(['--adapter', 'nope']).errors.some(e => e.includes('unknown adapter nope')));
});

test('parseMockResponse: sections, edits, summary; bad summary and escaping edits throw', () => {
  const parsed = parseMockResponse('<<<transcript>>>\nhello\n<<<summary>>>\n{"prOpened": false}\n<<<edit:a/b.txt>>>\nline1\nline2\n');
  assert.equal(parsed.transcript, 'hello\n');
  assert.deepEqual(parsed.summary, { prOpened: false });
  assert.equal(parsed.edits['a/b.txt'], 'line1\nline2\n');
  assert.throws(() => parseMockResponse('<<<summary>>>\n{nope\n'), /unparseable/);
  assert.throws(() => parseMockResponse('<<<edit:../escape.txt>>>\nx\n'), /escapes the work tree/);
  assert.throws(() => parseMockResponse('<<<edit:/abs.txt>>>\nx\n'), /escapes the work tree/);
});

test('mock adapter: canned response applies edits and parses summary; uncanned writes an honest failing transcript', async () => {
  const world = hermeticWorld();
  try {
    const manifest = await loadManifest(repoRoot);
    const adapter = createMockAdapter({ repoRoot });
    const work = mkdtempSync(join(tmpdir(), 'pj-mock-adapter-'));
    stageFixture(join(world.fixtureRoot, 'small-site'), work);
    const tdir = mkdtempSync(join(tmpdir(), 'pj-mock-tdir-'));

    const canned = await adapter.runTask({
      scenario: manifest.scenarios.find(s => s.id === 'pj-s-copy'),
      fixtureDir: join(world.fixtureRoot, 'small-site'),
      workDir: work, transcriptDir: tdir
    });
    assert.equal(canned.summary.prOpened, false);
    assert.equal(canned.summary.canned, true);
    assert.match(readFileSync(canned.transcriptPath, 'utf8'), /pj-s-copy/);
    assert.match(readFileSync(join(work, 'index.html'), 'utf8'), />Our story</);
    assert.doesNotMatch(readFileSync(join(work, 'styles.css'), 'utf8'), /Our story/);
    assert.equal(existsSync(join(work, 'mock-responses')), false, 'canned responses must never be staged into the work tree');

    rmSync(work, { recursive: true, force: true });
    const fresh = mkdtempSync(join(tmpdir(), 'pj-mock-adapter-'));
    stageFixture(join(world.fixtureRoot, 'small-site'), fresh);
    const uncanned = await adapter.runTask({
      scenario: manifest.scenarios.find(s => s.id === 'pj-s-feature'),
      fixtureDir: join(world.fixtureRoot, 'small-site'),
      workDir: fresh, transcriptDir: tdir
    });
    assert.match(readFileSync(uncanned.transcriptPath, 'utf8'), /MOCK: no response canned/);
    assert.equal(uncanned.summary.canned, false);
    assert.equal(existsSync(join(fresh, 'contact.html')), false, 'uncanned mock must leave the tree pristine');
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('schema validator catches what it claims to catch', () => {
  const good = {
    scenarioId: 'pj-s-copy', family: 'small-site', runId: 'eval-20260922-1',
    harnessRevision: 'x', fixtureRevision: 'x',
    firstAttempt: { pass: true, graderReasons: [], endedBy: 'agent' },
    eventualSuccess: { pass: true }, interventions: [], latencyMs: 12,
    cost: { status: 'unknown', reason: 'r' },
    verifiedEvidence: [], claimedEvidence: [], artifacts: [], preserve: { dir: 'preserve/' }
  };
  assert.deepEqual(schemaValidationErrors(good, schema), []);
  assert.ok(schemaValidationErrors({ ...good, scenarioId: 'nope' }, schema).some(e => e.includes('does not match')));
  assert.ok(schemaValidationErrors({ ...good, cost: { status: 'guessed' } }, schema).some(e => e.includes('is not one of')));
  assert.ok(schemaValidationErrors({ ...good, latencyMs: 1.5 }, schema).some(e => e.includes('expected integer')));
  const dropped = { ...good };
  delete dropped.preserve;
  assert.ok(schemaValidationErrors(dropped, schema).some(e => e.includes('missing required property preserve')));
});

test('mock PASS end to end: pj-s-copy stages, edits, grades from an out-of-tree grader dir, records per schema, preserves the transcript', async () => {
  const world = hermeticWorld();
  try {
    const { record, outDir, workDir } = await runOne(world, 'pj-s-copy');
    assert.equal(record.firstAttempt.pass, true, JSON.stringify(record.firstAttempt.graderReasons));
    assert.equal(record.firstAttempt.endedBy, 'agent');
    assert.equal(record.adapter, 'mock');
    assert.equal(record.cost.status, 'unknown');
    assert.match(record.cost.reason, /never guessed/);
    assert.equal(Number.isInteger(record.latencyMs), true);
    assert.match(record.runId, /^eval-\d{8}-1$/);
    assert.deepEqual(schemaValidationErrors(record, schema), []);
    assert.equal(readFileSync(join(outDir, 'result.json'), 'utf8').includes('"scenarioId": "pj-s-copy"'), true);
    const transcript = readFileSync(join(outDir, 'preserve', 'transcript.txt'), 'utf8');
    assert.match(transcript, /pj-s-copy/);
    assert.equal(existsSync(join(outDir, 'artifacts', 'grader-output.json')), true);
    assert.match(readFileSync(join(workDir, 'index.html'), 'utf8'), />Our story</);
    assert.equal(existsSync(join(workDir, 'mock-responses')), false, 'staging must exclude canned responses');
    const rollup = JSON.parse(readFileSync(join(world.resultsRoot, record.runId, 'summary.json'), 'utf8'));
    assert.equal(rollup.totals.pass, 1);
    assert.equal(record.outcome, 'pass');
    assert.deepEqual(record.rescue, { needed: false, provided: false, notes: [] });
    assert.match(record.fixtureRevision, /^sha256:[0-9a-f]{64}$/);
    rmSync(workDir, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('mock PASS end to end: pj-s-question grades transcript citations against the fixture', async () => {
  const world = hermeticWorld();
  try {
    const { record, outDir, workDir } = await runOne(world, 'pj-s-question');
    assert.equal(record.firstAttempt.pass, true, JSON.stringify(record.firstAttempt.graderReasons));
    assert.deepEqual(schemaValidationErrors(record, schema), []);
    const pr = record.verifiedEvidence.find(e => e.check === 'no PR opened, nothing pushed');
    assert.deepEqual(pr.value, { prOpened: false, pushed: false });
    assert.equal(record.outcome, 'pass');
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('mock FAIL end to end: an uncanned scenario produces a correct failing record and preserved transcript', async () => {
  const world = hermeticWorld();
  try {
    const { record, outDir, workDir } = await runOne(world, 'pj-s-feature');
    assert.equal(record.firstAttempt.pass, false);
    assert.equal(record.firstAttempt.endedBy, 'agent');
    assert.ok(record.firstAttempt.graderReasons.length > 0);
    assert.equal(record.eventualSuccess.pass, false);
    assert.equal(record.outcome, 'fail');
    assert.deepEqual(schemaValidationErrors(record, schema), []);
    const transcript = readFileSync(join(outDir, 'preserve', 'transcript.txt'), 'utf8');
    assert.match(transcript, /MOCK: no response canned/);
    assert.equal(existsSync(join(workDir, 'contact.html')), false, 'pristine tree — the failure is real, not simulated');
    rmSync(workDir, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('runId increments within a results root; ship-adapter refusal propagates before anything is recorded', async () => {
  const world = hermeticWorld();
  try {
    const first = await runOne(world, 'pj-s-copy');
    const second = await runOne(world, 'pj-s-question');
    assert.notEqual(first.runId, second.runId);
    assert.equal(second.runId.endsWith('-2'), true);
    // One invocation = one run executing one scenario; the roll-up merges per run.
    const dayDirs = readdirSync(world.resultsRoot).filter(d => d.startsWith('eval-'));
    assert.equal(dayDirs.length, 2);

    await assert.rejects(
      () => runOne(world, 'pj-s-question', createShipAdapter({ env: {} })),
      err => err instanceof AdapterRefusal
    );
    const after = readdirSync(world.resultsRoot).filter(d => d.startsWith('eval-'));
    assert.equal(after.length, 2, 'a refused adapter writes nothing');
    rmSync(first.workDir, { recursive: true, force: true });
    rmSync(second.workDir, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('a failing grader invocation is recorded as a harness error, not lost', async () => {
  const world = hermeticWorld();
  try {
    const manifest = await loadManifest(repoRoot);
    const brokenGraders = mkdtempSync(join(tmpdir(), 'pj-broken-graders-'));
    const { record } = await runScenario({
      repoRoot, manifest,
      scenario: manifest.scenarios.find(s => s.id === 'pj-s-copy'),
      adapter: createMockAdapter({ repoRoot }),
      graderDir: brokenGraders, // no grader file here: import fails
      fixtureRoot: world.fixtureRoot, resultsRoot: world.resultsRoot
    });
    assert.equal(record.firstAttempt.pass, false);
    assert.equal(record.firstAttempt.endedBy, 'harness-error');
    assert.equal(record.outcome, 'harness-error');
    assert.ok(record.firstAttempt.graderReasons.some(r => r.includes('grader invocation failed') || r.includes('Cannot find')));
    assert.deepEqual(schemaValidationErrors(record, schema), []);
    rmSync(brokenGraders, { recursive: true, force: true });
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('nextRunId is date-stamped and collision-free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-runid-'));
  try {
    const now = new Date(2026, 8, 22, 10, 0);
    assert.equal(nextRunId(dir, now), 'eval-20260922-1');
    mkdirSync(join(dir, 'eval-20260922-1'));
    assert.equal(nextRunId(dir, now), 'eval-20260922-2');
    const tomorrow = new Date(2026, 8, 23, 10, 0);
    assert.equal(nextRunId(dir, tomorrow), 'eval-20260923-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
