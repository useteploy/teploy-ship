// Scenario pj-s-plan: plan-only, no implementation.
// Structural: the graded work tree is untouched. Transcript: the plan names
// the real files it would touch (index.html and styles.css) and addresses
// the requested gallery. Publication: no PR opened and nothing pushed, from
// the adapter's forge check. Without a transcript the plan checks are
// not-wired and fail — no grader passes on checks it cannot perform.
import { readFileSync } from 'node:fs';
import * as lib from './lib.mjs';

export async function grade({ workDir, fixture, scenario, transcriptPath, summary }) {
  const reasons = [];
  const evidence = [];
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}] — the task is plan-only`);
  }

  if (!transcriptPath) {
    const nw = lib.notWired('plan artifact references index.html and styles.css (requires a run transcript)');
    reasons.push(nw.reason);
    evidence.push(nw.evidence);
  } else {
    const text = lib.agentText(readFileSync(transcriptPath, 'utf8'), scenario);
    const files = { 'index.html': text.includes('index.html'), 'styles.css': text.includes('styles.css') };
    evidence.push({ kind: 'transcript', check: 'plan references index.html and styles.css', value: files });
    const missing = Object.keys(files).filter(f => !files[f]);
    if (missing.length > 0) reasons.push(`the plan does not reference ${missing.join(' or ')} — it must name the real files it would touch`);
    const gallery = /gallery/i.test(text);
    evidence.push({ kind: 'transcript', check: 'plan addresses the gallery', value: gallery });
    if (!gallery) reasons.push('the plan never mentions the gallery it was asked to plan');
  }

  const published = lib.noPublication(summary);
  evidence.push(published.evidence);
  if (published.ok !== true) reasons.push(published.reason);

  return lib.result(reasons.length === 0, reasons, evidence);
}
