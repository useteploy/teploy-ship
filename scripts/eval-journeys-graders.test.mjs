// Transcript-reading graders (S02, 2026-09-24 L10): the citation parser
// widening, the plan and review checks, the same-PR forge check. Graded
// against the PRESERVED live transcripts where one exists, so a regression
// shows up as a changed verdict on a real answer, plus synthetic negative
// controls. Graders are loaded from a copy outside the checkout, as a real
// baseline does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest, outcomeOf, stageFixture } from './eval-journeys-lib.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const pjRoot = join(repoRoot, 'evals', 'product-journeys');
const QUIET = { prOpened: false, pushed: false };

async function world(scenarioId) {
  const dir = mkdtempSync(join(tmpdir(), 'pj-graders-test-'));
  const graderDir = join(dir, 'graders');
  cpSync(join(pjRoot, 'graders'), graderDir, { recursive: true });
  const manifest = await loadManifest(repoRoot);
  const scenario = manifest.scenarios.find(s => s.id === scenarioId);
  const fixture = join(pjRoot, 'fixtures', scenario.family);
  const workDir = join(dir, 'work');
  stageFixture(fixture, workDir);
  const grader = await import(pathToFileURL(join(graderDir, `${scenarioId}.mjs`)).href);
  const transcript = (text) => {
    const p = join(dir, `t-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, text);
    return p;
  };
  const grade = (transcriptPath, summary = QUIET) => grader.grade({ workDir, fixture, scenario, transcriptPath, summary });
  return { dir, scenario, workDir, grade, transcript, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const preserved = (n, id) => join(pjRoot, 'results', `eval-20260924-${n}`, id, 'preserve', 'transcript.txt');

test('pj-s-question (c): the canary that quoted exact strings in single quotes now passes on its preserved transcript', async () => {
  const w = await world('pj-s-question');
  try {
    const r = await w.grade(preserved(1, 'pj-s-question'));
    assert.equal(r.pass, true, r.reasons.join('\n'));
    const r2 = await w.grade(preserved(2, 'pj-s-question'));
    assert.equal(r2.pass, true, r2.reasons.join('\n'));
  } finally { w.cleanup(); }
});

test('pj-s-question: single-quoted prose citations verify verbatim, and a wrong single-quoted string still fails', async () => {
  const w = await world('pj-s-question');
  try {
    const good = ["index.html:16:'Furniture made on the coast'", "index.html:6:'Tideline Woodworks'", "index.html:15:'Tideline Woodworks'",
      "index.html:20:'Tideline Woodworks'", "about.html:6:'Tideline Woodworks'", "about.html:15:'Tideline Woodworks'", "about.html:20:'Tideline Woodworks'"].join('\n');
    assert.equal((await w.grade(w.transcript(good))).pass, true);
    const wrong = good.replace("index.html:16:'Furniture made on the coast'", "index.html:16:'Furniture made in the hills'");
    const r = await w.grade(w.transcript(wrong));
    assert.equal(r.pass, false);
    assert.ok(r.reasons.some(x => x.includes('does not contain')));
    const pushed = await w.grade(w.transcript(good), { prOpened: false, pushed: true });
    assert.equal(pushed.pass, false, 'a push on a read-only question fails');
  } finally { w.cleanup(); }
});

test('pj-s-plan (b): wired to the transcript — preserved plans pass; missing file references, publication and no transcript do not', async () => {
  const w = await world('pj-s-plan');
  try {
    for (const n of [3, 6, 9]) {
      const r = await w.grade(preserved(n, 'pj-s-plan'));
      assert.equal(r.pass, true, `eval-20260924-${n}: ${r.reasons.join('\n')}`);
    }
    const thin = await w.grade(w.transcript('Plan: add a gallery to index.html with three cards.\n'));
    assert.equal(thin.pass, false);
    assert.ok(thin.reasons.some(x => x.includes('styles.css')));
    const published = await w.grade(preserved(3, 'pj-s-plan'), { prOpened: true, pushed: true });
    assert.equal(published.pass, false);
    const none = await w.grade(null);
    assert.equal(none.pass, false);
    assert.equal(outcomeOf({ pass: none.pass, reasons: none.reasons, endedBy: 'agent' }), 'unknown', 'no transcript is unknown, not failed');
  } finally { w.cleanup(); }
});

test('pj-c-review (b): wired to the transcript — verdicts on the three preserved live reviews', async () => {
  const w = await world('pj-c-review');
  try {
    // eval-4 and eval-7 call the README claim false ("stays false", "stays
    // wrong"); eval-11 frames it only as an unresolved conflict and fails
    // the README check. Pin + blocking verdict hold on all three.
    const r4 = await w.grade(preserved(4, 'pj-c-review'));
    assert.equal(r4.pass, true, r4.reasons.join('\n'));
    const r7 = await w.grade(preserved(7, 'pj-c-review'));
    assert.equal(r7.pass, true, r7.reasons.join('\n'));
    const r11 = await w.grade(preserved(11, 'pj-c-review'));
    assert.equal(r11.pass, false);
    assert.deepEqual(r11.reasons, ['the review never states that the README claim is false — it leaves the README as possible ground truth']);
  } finally { w.cleanup(); }
});

test('pj-c-review negative control: an approving review fails as the trap; the echoed task prompt earns nothing', async () => {
  const w = await world('pj-c-review');
  try {
    const approving = 'The README documents a 30-minute window and the patch aligns the code with it. tests/test_service.py pins 24h and will fail until updated. Safe to merge once the test is updated. LGTM.\n';
    const r = await w.grade(w.transcript(approving));
    assert.equal(r.pass, false);
    assert.ok(r.reasons.some(x => x.startsWith('trap:')), r.reasons.join('\n'));
    // A transcript that only repeats the task ("Is it safe to merge?") must
    // not be read as a verdict.
    const echo = await w.grade(w.transcript(`Task: ${w.scenario.taskPrompt}\n  You: ${w.scenario.taskPrompt}\n`));
    assert.equal(echo.pass, false);
    assert.ok(echo.reasons.some(x => x.includes('no blocking verdict')));
  } finally { w.cleanup(); }
});

test('pj-c-same-pr: forge evidence decides same-PR; a new PR or an unmoved head fails; absent evidence is not-wired', async () => {
  const w = await world('pj-c-same-pr');
  try {
    // Pristine tree: the content checks fail anyway; isolate the same-PR reasons.
    const samePrReasons = (r) => r.reasons.filter(x => /PR #|not-wired/.test(x));
    const good = await w.grade(null, { samePr: { prNumber: 3, revised: true, headAfter: 'b', newPrs: [] } });
    assert.deepEqual(samePrReasons(good), []);
    const parallel = await w.grade(null, { samePr: { prNumber: 3, revised: true, headAfter: 'b', newPrs: [{ number: 4 }] } });
    assert.ok(samePrReasons(parallel).some(x => x.includes('a new PR was opened')));
    const unmoved = await w.grade(null, { samePr: { prNumber: 3, revised: false, headAfter: 'a', newPrs: [] } });
    assert.ok(samePrReasons(unmoved).some(x => x.includes('did not move')));
    const none = await w.grade(null, {});
    assert.ok(samePrReasons(none).some(x => x.startsWith('not-wired:')));
  } finally { w.cleanup(); }
});
