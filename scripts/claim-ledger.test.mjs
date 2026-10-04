import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkLedger, renderLedger, staleEvidence, loadLedger } from './claim-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'claim-ledger.mjs');
const REV = 'a'.repeat(40);

// A throwaway repo root with one source file and one test file, so path and
// test-name rules run against real files and never against this repository.
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'claim-ledger-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src/a.test.ts'), 'test("a holds", () => {});\n');
  return root;
}

function claim(over = {}) {
  return {
    id: 'c.one', claim: 'A holds.', scope: 'unit', status: 'supported', limitations: [],
    evidence: [
      { class: 'implementation', path: 'src/a.ts' },
      { class: 'automated', path: 'src/a.test.ts', test: 'a holds', revision: REV }
    ],
    ...over
  };
}
const ledger = (...claims) => ({ schema: 1, claims });
const rules = (l, root) => checkLedger(l, { root }).map(e => e.rule);

test('a well-formed ledger has no errors', () => {
  const root = fixtureRoot();
  assert.deepEqual(checkLedger(ledger(claim()), { root }), []);
});

test('negative control: a missing evidence path fails', () => {
  const root = fixtureRoot();
  const c = claim(); c.evidence[0].path = 'src/gone.ts';
  assert.ok(rules(ledger(c), root).includes('evidence-path'));
});

test('negative control: a supported claim with only implementation evidence fails', () => {
  const root = fixtureRoot();
  const c = claim({ evidence: [{ class: 'implementation', path: 'src/a.ts' }] });
  assert.ok(rules(ledger(c), root).includes('supported-needs-evidence'));
});

test('negative control: system evidence without an exact revision fails; revisionUnknown is allowed but counts for nothing', () => {
  const root = fixtureRoot();
  const sys = { class: 'system', path: 'src/a.ts' };
  assert.ok(rules(ledger(claim({ evidence: [sys] })), root).includes('revision'));
  assert.ok(rules(ledger(claim({ evidence: [{ ...sys, revision: 'abc1234' }] })), root).includes('revision'), 'short hash is not exact');
  const unknown = claim({ status: 'supported', evidence: [{ ...sys, revisionUnknown: true }] });
  const r = rules(ledger(unknown), root);
  assert.ok(!r.includes('revision'));
  assert.ok(r.includes('supported-needs-evidence'), 'unknown-revision system evidence cannot support a claim');
  const ok = claim({ evidence: [{ ...sys, revision: REV }] });
  assert.deepEqual(checkLedger(ledger(ok), { root }), []);
});

test('negative control: verified needs system evidence at an exact revision, not just automated', () => {
  const root = fixtureRoot();
  assert.ok(rules(ledger(claim({ verified: true })), root).includes('revision'));
  const withSystem = claim({ verified: true, evidence: [...claim().evidence, { class: 'system', path: 'src/a.ts', revision: REV }] });
  assert.deepEqual(checkLedger(ledger(withSystem), { root }), []);
  assert.ok(rules(ledger(claim({ verified: true, status: 'provisional', limitations: ['x'], evidence: withSystem.evidence })), root).includes('revision'), 'only supported claims may be verified');
});

test('negative control: duplicate ids fail', () => {
  const root = fixtureRoot();
  assert.ok(rules(ledger(claim(), claim()), root).includes('duplicate-id'));
});

test('negative control: a test name absent from the cited file fails', () => {
  const root = fixtureRoot();
  const c = claim(); c.evidence[1].test = 'a does not hold';
  assert.ok(rules(ledger(c), root).includes('test-name'));
  const noName = claim(); delete noName.evidence[1].test;
  assert.ok(rules(ledger(noName), root).includes('test-name'), 'automated evidence must name its test');
});

test('negative control: a superiority claim without comparative evidence fails, by wording and by flag', () => {
  const root = fixtureRoot();
  assert.ok(rules(ledger(claim({ claim: 'Ship is better than Other.' })), root).includes('comparative'));
  assert.ok(rules(ledger(claim({ comparative: true })), root).includes('comparative'));
  const withCmp = claim({ claim: 'Ship is better than Other.', evidence: [...claim().evidence, { class: 'comparative', path: 'src/a.ts' }] });
  assert.deepEqual(checkLedger(ledger(withCmp), { root }), []);
  const disclaimed = claim({ claim: 'We do not say Ship is better than Other.', status: 'disclaimed', limitations: ['no comparison exists'], evidence: [{ class: 'implementation', path: 'src/a.ts' }] });
  assert.deepEqual(checkLedger(ledger(disclaimed), { root }), [], 'a disclaimer is not a superiority claim');
});

test('negative control: provisional, open and disclaimed claims must state limitations', () => {
  const root = fixtureRoot();
  for (const status of ['provisional', 'open', 'disclaimed']) {
    assert.ok(rules(ledger(claim({ status, limitations: [] })), root).includes('limitations-visible'), status);
  }
});

test('unknown class, unknown status and missing fields are shape errors', () => {
  const root = fixtureRoot();
  const c = claim({ status: 'great' }); c.evidence[0].class = 'vibes';
  const r = rules(ledger(c, { id: 'c.two', evidence: [] }), root);
  assert.ok(r.filter(x => x === 'shape').length >= 3);
});

test('stale report lists evidence whose path changed since its revision, and unknown when the revision cannot be resolved', () => {
  const l = ledger(claim());
  const changed = staleEvidence(l, { root: '.', git: () => ['src/a.test.ts'] });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'changed');
  assert.deepEqual(staleEvidence(l, { root: '.', git: () => [] }), []);
  assert.equal(staleEvidence(l, { root: '.', git: () => null })[0].state, 'unknown');
});

test('render lists every claim with its status, limitations and shortened revision', () => {
  const md = renderLedger(ledger(claim({ limitations: ['only the fixture'] })));
  assert.match(md, /GENERATED/);
  assert.match(md, /## c\.one/);
  assert.match(md, /only the fixture/);
  assert.match(md, new RegExp(REV.slice(0, 12)));
  assert.doesNotMatch(md, new RegExp(REV));
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI: --check passes on a consistent fixture and fails when the generated view drifts, negative control', () => {
  const root = fixtureRoot();
  const file = join(root, 'ledger.json'), doc = join(root, 'LEDGER.md');
  writeFileSync(file, JSON.stringify(ledger(claim())));
  assert.equal(run(['--render', '--ledger', file, '--doc', doc, '--root', root]).status, 0);
  assert.equal(run(['--check', '--ledger', file, '--doc', doc, '--root', root]).status, 0);
  writeFileSync(doc, readFileSync(doc, 'utf8') + '\nhand edit\n');
  const r = run(['--check', '--ledger', file, '--doc', doc, '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /render-drift/);
  const bad = claim(); bad.evidence[0].path = 'nope';
  writeFileSync(file, JSON.stringify(ledger(bad)));
  assert.equal(run(['--check', '--ledger', file, '--doc', doc, '--root', root]).status, 1);
});

test('the repository ledger is consistent and its view is current', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(loadLedger(join(HERE, '..', 'docs/claims/ledger.json')).claims.length > 0);
});
