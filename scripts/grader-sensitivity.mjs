#!/usr/bin/env node
// Grader sensitivity (S02, 2026-10-03). The product-journeys graders are
// shown to fail on their pristine fixtures, but a grader that only rejects
// "nothing was done" can still wave through a plausible WRONG fix. This
// harness feeds each grader hand-written wrong-but-plausible solutions and
// one correct reference per scenario, and reports variant x scenario ->
// pass/fail.
//
// A variant lives in evals/product-journeys/mutants/<scenario>/<variant>/:
//   variant.json   { kind: "correct"|"wrong", description, failsWith?, summary?, delete? }
//   files/         overlay copied over the staged pristine fixture (full files)
//   transcript.txt (transcript-graded scenarios only) the agent's words
//
// Each variant is staged exactly as the runner stages a work tree
// (stageFixture), then graded by a COPY of graders/ outside the checkout,
// loaded the way a real baseline loads it. No model, no network, no spend.
//
// Verdicts: a wrong variant must FAIL, and must fail for the reason it was
// written to hit (`failsWith`, a regex over the grader's reasons) — a mutant
// that fails because it is broken in some unrelated way proves nothing. The
// correct reference must PASS. Anything else is a finding and exits 1.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest, stageFixture } from './eval-journeys-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..');

// Scenarios whose acceptance is read off the transcript: variants carry a
// transcript.txt and (optionally) a tree overlay for "changed the tree".
export const TRANSCRIPT_GRADED = ['pj-s-question', 'pj-s-plan', 'pj-c-review'];

const QUIET = { prOpened: false, pushed: false };
// same-PR: the forge evidence is covered by scripts/eval-journeys-graders.test.mjs;
// content variants hold it constant (and good) so only the tree is on trial.
const SAME_PR_GOOD = { samePr: { prNumber: 3, revised: true, headAfter: 'b', newPrs: [] } };

export function variantsFor(pjRoot, scenarioId) {
  const dir = join(pjRoot, 'mutants', scenarioId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const vdir = join(dir, e.name);
      const meta = JSON.parse(readFileSync(join(vdir, 'variant.json'), 'utf8'));
      return { name: e.name, dir: vdir, ...meta };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'correct' ? -1 : 1));
}

function defaultSummary(scenarioId) {
  return scenarioId === 'pj-c-same-pr' ? { ...SAME_PR_GOOD } : { ...QUIET };
}

export async function gradeVariant({ pjRoot, graderDir, manifest, scenario, variant }) {
  const family = manifest.families[scenario.family];
  const fixture = join(pjRoot, 'fixtures', basename(family.fixture));
  const scratch = mkdtempSync(join(tmpdir(), 'pj-sensitivity-'));
  const workDir = join(scratch, 'work');
  try {
    stageFixture(fixture, workDir);
    for (const rel of variant.delete ?? []) rmSync(join(workDir, rel), { recursive: true, force: true });
    const overlay = join(variant.dir, 'files');
    if (existsSync(overlay)) cpSync(overlay, workDir, { recursive: true });
    const transcript = join(variant.dir, 'transcript.txt');
    const transcriptPath = existsSync(transcript) ? transcript : null;
    if (TRANSCRIPT_GRADED.includes(scenario.id) && transcriptPath === null) {
      throw new Error(`${scenario.id}/${variant.name}: transcript-graded scenario needs a transcript.txt`);
    }
    const summary = variant.summary ?? defaultSummary(scenario.id);
    const grader = await import(pathToFileURL(join(graderDir, `${scenario.id}.mjs`)).href);
    let graded;
    try {
      graded = await grader.grade({ workDir, fixture, scenario, transcriptPath, summary });
    } catch (err) {
      graded = { pass: false, reasons: [`grader invocation failed: ${err.message}`], evidence: [] };
    }
    return graded;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Classify one graded variant. status is one of:
//   ok              wrong variant rejected for its intended reason / correct accepted
//   ESCAPED         wrong variant PASSED the grader (grader too weak)
//   REJECTED-GOOD   the correct reference FAILED (grader too strict, or reference broken)
//   WRONG-REASON    wrong variant failed, but not for the reason it targets
//   known-limit     a documented limit: the grader accepts this ON PURPOSE (variant
//                   description says why); not counted as wrong, never hidden
//   LIMIT-CLOSED    a known-limit variant now fails: the grader changed, update the record
export function classify(variant, graded) {
  const reasons = graded.reasons ?? [];
  if (variant.kind === 'correct') {
    return graded.pass ? 'ok' : 'REJECTED-GOOD';
  }
  if (variant.kind === 'known-limit') {
    return graded.pass ? 'known-limit' : 'LIMIT-CLOSED';
  }
  if (graded.pass) return 'ESCAPED';
  if (variant.failsWith && !reasons.some(r => new RegExp(variant.failsWith).test(r))) return 'WRONG-REASON';
  return 'ok';
}

// `graderDir` exists so the harness's own tests can swap in a grader that passes
// everything and prove the matrix then reports escapes (it must not stay green).
export async function runMatrix({ repoRoot = REPO_ROOT, only = null, graderDir: graderOverride = null } = {}) {
  const pjRoot = join(repoRoot, 'evals', 'product-journeys');
  const manifest = await loadManifest(repoRoot);
  const scratch = mkdtempSync(join(tmpdir(), 'pj-sensitivity-graders-'));
  let graderDir = graderOverride;
  if (graderDir === null) {
    graderDir = join(scratch, 'graders');
    cpSync(join(pjRoot, 'graders'), graderDir, { recursive: true });
  }
  const rows = [];
  const untested = [];
  try {
    for (const scenario of manifest.scenarios) {
      if (only && scenario.id !== only) continue;
      const variants = variantsFor(pjRoot, scenario.id);
      if (variants.length === 0) {
        untested.push({ id: scenario.id, reason: 'no variants on disk' });
        continue;
      }
      for (const variant of variants) {
        const graded = await gradeVariant({ pjRoot, graderDir, manifest, scenario, variant });
        rows.push({
          scenario: scenario.id,
          graded: TRANSCRIPT_GRADED.includes(scenario.id) ? 'transcript' : 'work tree',
          variant: variant.name,
          kind: variant.kind,
          description: variant.description,
          failsWith: variant.failsWith ?? null,
          pass: graded.pass === true,
          status: classify(variant, graded),
          reasons: graded.reasons ?? []
        });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { rows, untested, scenarios: manifest.scenarios.map(s => s.id) };
}

export function summarize({ rows, untested }) {
  const wrong = rows.filter(r => r.kind === 'wrong');
  const correct = rows.filter(r => r.kind === 'correct');
  const limits = rows.filter(r => r.kind === 'known-limit');
  const count = (list, status) => list.filter(r => r.status === status).length;
  const scenarios = [...new Set(rows.map(r => r.scenario))];
  return {
    scenariosCovered: scenarios.length,
    scenariosUntested: untested.length,
    variants: rows.length,
    wrong: wrong.length,
    wrongRejected: wrong.length - count(wrong, 'ESCAPED'),
    wrongRejectedForIntendedReason: count(wrong, 'ok'),
    escaped: count(wrong, 'ESCAPED'),
    wrongReason: count(wrong, 'WRONG-REASON'),
    knownLimits: limits.length,
    limitsClosed: count(limits, 'LIMIT-CLOSED'),
    references: correct.length,
    referencesAccepted: count(correct, 'ok'),
    referencesRejected: count(correct, 'REJECTED-GOOD'),
    clean: rows.every(r => r.status === 'ok' || r.status === 'known-limit') && untested.length === 0
  };
}

// What the first run of this matrix found, recorded in the report because the
// graders were fixed afterwards and a clean matrix would otherwise hide that it
// ever failed. Measured against the graders as they were at origin/main
// 2291711, with the variant set as first written (11 escapes of 60 wrong
// variants; the feature placeholder variant was later reclassified, see below).
export const FINDINGS = [
  '## Grader defects this matrix found (fixed in the same change)',
  '',
  'Run against the graders as merged at 2291711, 11 wrong variants PASSED. Ten were real grader defects and are fixed',
  '(each fix is minimal and has its exposing variant as a permanent regression test); one is a documented limit.',
  'Results already recorded under `results/` are NOT rewritten and were not re-graded: they keep the verdicts the',
  'graders of the day gave. The tightened graders apply to runs from now on.',
  '',
  '| # | scenario | exposing variant | what the old grader missed | fix |',
  '| --- | --- | --- | --- | --- |',
  '| 1 | pj-b-deploy-recovery | health-check-deleted, health-check-hard-coded-green, health-failure-ignored | "still checks /health for 200" was `includes(\'/health\') && includes(\'200\')` over the script text, satisfied by the header comment, so a deleted, forced-green or ignored health gate passed | comments stripped before the string checks, plus a behavioural probe: with the booted server forced to answer 503 on /health, deploy.sh must exit non-zero |',
  '| 2 | pj-b-deploy-recovery | server-health-always-200 | making the server\'s /health lie (200 with pending migrations, test deleted) passed | probe: server /health on an unmigrated database must be 503 (README contract) |',
  '| 3 | pj-b-perms-defect | forbidden-403-not-401 | accepted 401 OR 403 although the manifest check says 401 for missing and wrong token | exactly 401 |',
  '| 4 | pj-b-api-defect | catch-all-409 | the manifest forbids "catch-all error responses that erase status semantics", but only the duplicate path was probed, so `catch { 409 }` passed | probe: a malformed JSON body must not return 409 |',
  '| 5 | pj-b-db-migration | edits-migration-001-in-place | the pre-existing-database probe used a v1 database with NO recorded migrations, so editing the shipped 001 in place passed although databases that already applied 001 never get the column | second probe: a database that already recorded the shipped migrations must still gain pinned (forward-only) |',
  '| 6 | pj-c-same-pr | readme-30-minute-hyphenated | README check was `!/30 minutes/`, so "30-minute window" or "30 min" survived as the false claim | pattern widened to 30/thirty + minute(s)/min with space or hyphen |',
  '| 7 | pj-c-scheduled-job | bypasses-service-store-io | manifest: "reading the store only through service.load_store/save_store"; a job parsing store.json directly behaved identically on every probe and passed | trace probe: a copy of service.py logs load_store/save_store calls; the job must make both |',
  '| 8 | pj-s-plan | plan-contains-applied-diff | manifest: "the plan contains no applied diff"; the grader never looked, so a transcript carrying a unified diff of the implementation passed | unified-diff headers/hunks in the agent text fail |',
  '',
  'A ninth defect, of the mirror class, was found later by the live S02 batch (2026-10-03/04) rather than by this',
  'matrix: pj-s-question rejected CORRECT answers whose citation layout it did not understand (file and line number',
  'separated by the word "line", exact string after a dash or under a colon-ended heading) — eval-20261003-3/4 and',
  'eval-20261004-1 all failed with "the tagline line is not cited" while citing it verbatim. Fixed by signpost citation',
  'extraction with the verbatim and coverage checks untouched; pinned by the batch-form-reference (must pass) and',
  'batch-form-paraphrased-tagline (must fail) variants. Supplementary regrades beside the three records, originals',
  'never modified.',
  '',
  'Known limit, not a defect (pj-s-feature / marked-placeholders-accepted-by-design): a contact page whose address and',
  'hours are explicitly marked placeholders passes. That is deliberate. The fixture holds no street address, and the live',
  'run eval-20260924-16 correctly declined to invent one and shipped exactly that. Requiring a digit-led street address',
  'would reject the honest behaviour. The matrix pins that it still passes (a `known-limit` row turning to FAIL is',
  'flagged `LIMIT-CLOSED` so the record gets revisited).',
  '',
  '## What this matrix does not prove',
  '',
  '- The variants are hand-written and finite. A clean matrix means these 60 specific wrong fixes are rejected, not that no wrong fix can pass.',
  '- `pj-s-question`, `pj-s-plan`, `pj-c-review` are graded from the transcript, so their variants are wrong TRANSCRIPTS (plus tree overlays for "changed a file"). The review grader is lexical by design; a review that games the wording is not covered.',
  '- `pj-c-same-pr` content variants hold the forge evidence good; the forge checks (new PR, unmoved head, absent evidence) are covered by `scripts/eval-journeys-graders.test.mjs`.',
  '- The deploy-recovery reference migrates inside deploy.sh (what the 2026-09-24 live run did); other legitimate fixes are not enumerated.',
  '- No live agent ran. This measures graders, not Ship.',
  ''
];

const oneLine = (s, n = 120) => {
  const first = String(s ?? '').split('\n')[0].replaceAll('|', '\\|').replaceAll(/\/tmp\/[^\s]*/g, '<tmp>');
  return first.length > n ? first.slice(0, n - 1) + '…' : first;
};

export function renderMarkdown(matrix, { date = '2026-10-03' } = {}) {
  const s = summarize(matrix);
  const lines = [];
  lines.push(`# Grader sensitivity — ${date}`, '');
  lines.push('Generated by `node scripts/grader-sensitivity.mjs --write evals/product-journeys/GRADER_SENSITIVITY_2026-10-03.md`.',
    'Not hand-edited. Historical result records under `results/` are untouched; this',
    'matrix grades hand-written variants in `mutants/`, never a live run.', '');
  lines.push('## Totals', '');
  lines.push(`- scenarios covered: ${s.scenariosCovered} of ${matrix.scenarios.length}` + (s.scenariosUntested ? ` (untested: ${matrix.untested.map(u => u.id).join(', ')})` : ''));
  lines.push(`- variants graded: ${s.variants} (${s.wrong} wrong, ${s.references} correct references, ${s.knownLimits} documented known limits)`);
  lines.push(`- wrong variants rejected: ${s.wrongRejected} of ${s.wrong}; rejected for the reason they target: ${s.wrongRejectedForIntendedReason} of ${s.wrong}`);
  lines.push(`- wrong variants that PASSED the grader (escaped): ${s.escaped}`);
  lines.push(`- wrong variants rejected for an unrelated reason: ${s.wrongReason}`);
  lines.push(`- documented known limits (grader accepts on purpose, see below): ${s.knownLimits}`);
  lines.push(`- correct references accepted: ${s.referencesAccepted} of ${s.references}`);
  lines.push(`- verdict: ${s.clean ? 'CLEAN' : 'NOT CLEAN — see rows marked ESCAPED / REJECTED-GOOD / WRONG-REASON'}`, '');
  lines.push('Status key: `ok` = wrong variant rejected for its targeted reason, or correct reference accepted;',
    '`ESCAPED` = a wrong variant passed (grader too weak); `REJECTED-GOOD` = the correct reference failed;',
    '`WRONG-REASON` = a wrong variant failed, but not on the check it was written to hit;',
    '`known-limit` = a documented case the grader accepts on purpose (excluded from the wrong-variant counts).', '');
  lines.push('## Matrix', '');
  lines.push('| scenario | graded on | variant | kind | grader | status | first reason from the grader |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of matrix.rows) {
    lines.push(`| ${r.scenario} | ${r.graded} | ${r.variant} | ${r.kind} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.status} | ${r.pass ? '—' : oneLine(r.reasons[0])} |`);
  }
  lines.push('');
  lines.push('## Variant descriptions', '');
  let current = null;
  for (const r of matrix.rows) {
    if (r.scenario !== current) { current = r.scenario; lines.push(`### ${current}`, ''); }
    lines.push(`- \`${r.variant}\` (${r.kind}): ${r.description}`);
  }
  lines.push('');
  lines.push(...FINDINGS);
  if (matrix.untested.length > 0) {
    lines.push('## Untested', '');
    for (const u of matrix.untested) lines.push(`- ${u.id}: ${u.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main(argv) {
  const only = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : null;
  const writeTo = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : null;
  const matrix = await runMatrix({ only });
  const s = summarize(matrix);
  for (const r of matrix.rows) {
    console.log(`${r.status.padEnd(13)} ${r.scenario.padEnd(22)} ${r.variant.padEnd(32)} ${r.kind.padEnd(8)} grader=${r.pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(JSON.stringify(s));
  if (writeTo) writeFileSync(resolve(writeTo), renderMarkdown(matrix));
  const rowsOk = matrix.rows.every(r => r.status === 'ok' || r.status === 'known-limit');
  return only ? (rowsOk ? 0 : 1) : (s.clean ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err); process.exit(2); });
}
