// Grader sensitivity (S02): runs the WHOLE variant x scenario matrix against
// the real graders (out-of-tree copy, as a baseline does) and asserts the
// property the programme asks for: every wrong-but-plausible variant is
// rejected for the reason it targets, every correct reference is accepted.
// Also pins the harness itself with negative controls: a grader that passes
// everything must turn the matrix red, and misclassification is caught.
//
// Slow by design (boots servers, runs python, three deploy.sh runs per
// deploy-recovery variant); no model, no network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, TRANSCRIPT_GRADED, classify, renderMarkdown, runMatrix, summarize, variantsFor, browserEngineAvailable } from './grader-sensitivity.mjs';
import { loadManifest } from './eval-journeys-lib.mjs';

const pjRoot = join(REPO_ROOT, 'evals', 'product-journeys');
// 2026-10-15: the committed report moves to a new dated file (13 scenarios,
// including the browser-required pj-d-live-board) rather than rewriting the
// 2026-10-03 record — result records are additive-only.
const REPORT = join(pjRoot, 'GRADER_SENSITIVITY_2026-10-15.md');
const matrix = await runMatrix();
const summary = summarize(matrix);
const engine = await browserEngineAvailable();

test('every manifest scenario has a correct reference and at least two wrong variants', async () => {
  const manifest = await loadManifest(REPO_ROOT);
  assert.equal(manifest.scenarios.length, 13);
  for (const s of manifest.scenarios) {
    const variants = variantsFor(pjRoot, s.id);
    assert.ok(variants.filter(v => v.kind === 'correct').length >= 1, `${s.id}: at least one correct reference`);
    assert.ok(variants.filter(v => v.kind === 'wrong').length >= 2, `${s.id}: at least two wrong variants`);
    assert.ok(variants.every(v => ['correct', 'wrong', 'known-limit'].includes(v.kind)), `${s.id}: variant kinds`);
    assert.ok(variants.filter(v => v.kind === 'wrong').every(v => typeof v.failsWith === 'string' && v.failsWith.length > 0), `${s.id}: each wrong variant names the reason it must fail with`);
  }
  // Without a headless engine the browserRequired scenario is honestly
  // untested; with one (the environment the committed report was generated
  // in) nothing may be untested at all.
  if (engine) {
    assert.deepEqual(matrix.untested, []);
  } else {
    assert.deepEqual(matrix.untested.map(u => u.id), ['pj-d-live-board']);
    assert.match(matrix.untested[0].reason, /browserRequired scenario and no headless browser engine/);
  }
  for (const id of TRANSCRIPT_GRADED) assert.ok(manifest.scenarios.some(s => s.id === id));
});

test('the whole matrix: no wrong variant passes, no correct reference fails, every rejection is for the targeted reason', () => {
  const bad = matrix.rows.filter(r => r.status !== 'ok' && r.status !== 'known-limit');
  assert.deepEqual(bad.map(r => `${r.status} ${r.scenario}/${r.variant}: ${r.reasons[0] ?? 'passed'}`), []);
  assert.equal(summary.escaped, 0);
  assert.equal(summary.wrongReason, 0);
  assert.equal(summary.referencesRejected, 0);
  assert.equal(summary.limitsClosed, 0);
  assert.equal(summary.clean, true);
});

for (const row of matrix.rows) {
  test(`${row.scenario} / ${row.variant} (${row.kind}): grader ${row.kind === 'wrong' ? 'FAILS' : 'PASSES'} it`, () => {
    if (row.kind === 'wrong') assert.equal(row.pass, false, 'a wrong variant passed the grader');
    else assert.equal(row.pass, true, row.reasons.join('\n'));
  });
}

test('the committed report states the same totals as a fresh run', () => {
  if (!engine) {
    // Without a headless engine the browserRequired scenario drops out of a
    // fresh run, so the committed (engine-present) totals cannot match here.
    // That is an environmental limit, not a report drift; say so loudly.
    assert.match(matrix.untested[0]?.reason ?? '', /browserRequired/, 'the only permitted mismatch cause is the missing engine');
    return;
  }
  const text = readFileSync(REPORT, 'utf8');
  const section = (md) => md.split('## Totals')[1].split('## Matrix')[0].trim();
  assert.equal(section(text), section(renderMarkdown(matrix)));
  assert.equal(text.includes('NOT CLEAN'), false);
});

test('harness negative control: graders that pass everything turn the matrix red (every wrong variant escapes)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-sensitivity-stub-'));
  try {
    for (const f of readdirSync(join(pjRoot, 'graders'))) {
      if (f === 'lib.mjs' || f === 'README.md') continue;
      writeFileSync(join(dir, f), 'export async function grade() { return { pass: true, reasons: [], evidence: [] }; }\n');
    }
    const stub = await runMatrix({ only: 'pj-s-copy', graderDir: dir });
    const s = summarize(stub);
    assert.equal(s.escaped, s.wrong);
    assert.ok(s.escaped >= 2);
    assert.equal(s.clean, false);
    assert.ok(stub.rows.filter(r => r.kind === 'wrong').every(r => r.status === 'ESCAPED'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('harness negative control: classify tells escaped, rejected-good, wrong-reason, limit-closed apart', () => {
  const wrong = { kind: 'wrong', failsWith: 'styles\\.css changed' };
  assert.equal(classify(wrong, { pass: true, reasons: [] }), 'ESCAPED');
  assert.equal(classify(wrong, { pass: false, reasons: ['unrelated breakage'] }), 'WRONG-REASON');
  assert.equal(classify(wrong, { pass: false, reasons: ['styles.css changed — outside scope'] }), 'ok');
  assert.equal(classify({ kind: 'correct' }, { pass: false, reasons: ['x'] }), 'REJECTED-GOOD');
  assert.equal(classify({ kind: 'correct' }, { pass: true, reasons: [] }), 'ok');
  assert.equal(classify({ kind: 'known-limit' }, { pass: true, reasons: [] }), 'known-limit');
  assert.equal(classify({ kind: 'known-limit' }, { pass: false, reasons: ['now rejected'] }), 'LIMIT-CLOSED');
});

test('harness negative control: a broken reference (correct variant that is actually wrong) is reported, not hidden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pj-sensitivity-root-'));
  try {
    // A throwaway repo copy holding only what runMatrix reads, with the copy
    // scenario's "correct" reference sabotaged to leave about.html's title alone.
    const fake = join(root, 'evals', 'product-journeys');
    mkdirSync(fake, { recursive: true });
    const { cpSync } = await import('node:fs');
    for (const entry of ['manifest.json', 'graders', 'fixtures']) cpSync(join(pjRoot, entry), join(fake, entry), { recursive: true });
    cpSync(join(pjRoot, 'mutants', 'pj-s-copy'), join(fake, 'mutants', 'pj-s-copy'), { recursive: true });
    cpSync(join(pjRoot, 'mutants', 'pj-s-copy', 'nav-only-title-untouched', 'files'), join(fake, 'mutants', 'pj-s-copy', 'reference', 'files'), { recursive: true });
    const out = await runMatrix({ repoRoot: root, only: 'pj-s-copy' });
    const ref = out.rows.find(r => r.variant === 'reference');
    assert.equal(ref.status, 'REJECTED-GOOD');
    assert.equal(summarize(out).clean, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
