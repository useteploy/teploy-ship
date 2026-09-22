// Tests for the product-journey harness library and one real grader,
// everything offline: no model, no network, no repo servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadManifest, validateManifest, buildDryRun, parseArgs, spendGateDecision,
  EXIT, PROBES, SCENARIO_TYPES
} from './eval-journeys-lib.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const graderDir = join(repoRoot, 'evals', 'product-journeys', 'graders');

async function realManifest() {
  return loadManifest(repoRoot);
}

test('the real manifest validates against fixtures, graders, README and schema', async () => {
  const manifest = await realManifest();
  const { ok, errors } = await validateManifest(manifest, { repoRoot, graderDir });
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

test('the real manifest covers all 12 S02 types once, across 3 families, with both traps', async () => {
  const manifest = await realManifest();
  assert.equal(manifest.scenarios.length, 12);
  const types = manifest.scenarios.map(s => s.type).sort();
  assert.deepEqual(types, [...SCENARIO_TYPES].sort());
  assert.deepEqual(new Set(manifest.scenarios.map(s => s.family)), new Set(['small-site', 'ui-api-db', 'unfamiliar-service']));
  const negatives = manifest.scenarios.filter(s => s.negativeControl);
  assert.equal(negatives.length, 2);
  assert.ok(negatives.every(n => typeof n.trap === 'string' && n.trap.length > 0));
  const applied = new Set(manifest.scenarios.flatMap(s => s.probes));
  assert.deepEqual([...applied].sort(), [...PROBES].sort());
});

test('duplicate scenario ids are rejected', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.scenarios.push(structuredClone(broken.scenarios[0]));
  const { ok, errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.includes('duplicate scenario id')));
});

test('a missing fixture directory is rejected', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.families['small-site'].fixture = 'evals/product-journeys/fixtures/does-not-exist';
  broken.scenarios.filter(s => s.family === 'small-site').forEach(s => { s.fixture = broken.families['small-site'].fixture; });
  const { errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.ok(errors.some(e => e.includes('fixture directory missing')));
});

test('an unknown probe is rejected', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.scenarios[0].probes = ['smoke-bomb'];
  const { errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.ok(errors.some(e => e.includes('unknown probe "smoke-bomb"')));
});

test('fewer than two negative controls are rejected', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.scenarios.forEach(s => { delete s.negativeControl; });
  const { errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.ok(errors.some(e => e.includes('at least 2 negativeControl')));
});

test('a missing grader file is rejected', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.scenarios[0].grader = 'graders/does-not-exist.mjs';
  const { errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.ok(errors.some(e => e.includes('grader missing')));
});

test('README table drift is rejected in both directions', async () => {
  const manifest = await realManifest();
  const broken = structuredClone(manifest);
  broken.scenarios.push({ ...structuredClone(broken.scenarios[0]), id: 'pj-s-extra', type: 'extra-type' });
  const { errors } = await validateManifest(broken, { repoRoot, graderDir });
  assert.ok(errors.some(e => e.includes('pj-s-extra: missing from README.md scenario table')));
});

test('dry-run plans carry the prompt, checks, probes, fixture and grader', async () => {
  const manifest = await realManifest();
  const scenario = manifest.scenarios.find(s => s.id === 'pj-b-api-defect');
  const plan = buildDryRun(manifest, scenario);
  assert.equal(plan.scenarioId, 'pj-b-api-defect');
  assert.equal(plan.negativeControl, true);
  assert.match(plan.taskPrompt, /duplicate title/);
  assert.ok(plan.checks.length >= 4);
  assert.match(plan.notExecuted, /dry-run only/);
  assert.equal(plan.fixture.testCommand !== null, true);
});

test('argument parsing: unknown flag, relative grader dir, missing values', () => {
  assert.ok(parseArgs(['--nonsense']).errors.some(e => e.includes('unknown argument')));
  assert.ok(parseArgs(['--grader-dir', 'relative/path']).errors.some(e => e.includes('absolute')));
  assert.ok(parseArgs(['--scenario']).errors.some(e => e.includes('requires a value')));
  assert.deepEqual(parseArgs(['--list']).mode, 'list');
  assert.deepEqual(parseArgs(['--scenario', 'pj-s-copy', '--dry-run']), {
    mode: 'scenario', scenario: 'pj-s-copy', dryRun: true, graderDir: null, authorizeSpend: false, errors: []
  });
});

test('spend gate: dry-run passes, unauthorized refuses with exit 2, authorized stops at exit 3', () => {
  const dry = spendGateDecision(parseArgs(['--scenario', 'pj-s-copy', '--dry-run']));
  assert.equal(dry.action, 'dry-run');
  const refuse = spendGateDecision(parseArgs(['--scenario', 'pj-s-copy']));
  assert.equal(refuse.action, 'refuse');
  assert.equal(refuse.exitCode, EXIT.SPEND_REFUSED);
  assert.match(refuse.message, /--i-authorize-spend/);
  const wired = spendGateDecision(parseArgs(['--scenario', 'pj-s-copy', '--i-authorize-spend']));
  assert.equal(wired.action, 'not-wired');
  assert.equal(wired.exitCode, EXIT.NOT_WIRED);
  assert.match(wired.message, /execution intentionally not wired in this slice/);
});

test('grader separation: pj-s-copy loads from an out-of-tree grader dir, passes a worked tree, fails the pristine fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-lib-test-'));
  try {
    const outOfTreeGraders = join(dir, 'journey-graders');
    cpSync(graderDir, outOfTreeGraders, { recursive: true });
    const fixture = join(repoRoot, 'evals', 'product-journeys', 'fixtures', 'small-site');

    const grader = await import(pathToFileURL(join(outOfTreeGraders, 'pj-s-copy.mjs')).href);
    assert.equal(typeof grader.grade, 'function');

    const pristine = await grader.grade({ workDir: fixture, fixture, scenario: {} });
    assert.equal(pristine.pass, false, 'pristine fixture must fail the copy grader');

    const worked = join(dir, 'worked');
    cpSync(fixture, worked, { recursive: true });
    for (const page of ['index.html', 'about.html']) {
      const path = join(worked, page);
      writeFileSync(path, readFileSync(path, 'utf8').replace('>About<', '>Our story<'));
    }
    writeFileSync(join(worked, 'about.html'), readFileSync(join(worked, 'about.html'), 'utf8')
      .replace('<title>About — Tideline Woodworks</title>', '<title>Our story — Tideline Woodworks</title>'));

    const graded = await grader.grade({ workDir: worked, fixture, scenario: {} });
    assert.deepEqual(graded.reasons, []);
    assert.equal(graded.pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
