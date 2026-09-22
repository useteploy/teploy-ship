// Scenario pj-s-plan: plan-only, no implementation.
// Structural: work tree untouched. Plan-artifact checks are
// transcript-dependent and not wired in this slice.
import * as lib from './lib.mjs';

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}] — the task is plan-only`);
  }
  const references = lib.notWired('plan artifact references index.html and styles.css');
  reasons.push(references.reason);
  evidence.push(references.evidence);
  const pr = lib.notWired('no PR opened');
  reasons.push(pr.reason);
  evidence.push(pr.evidence);
  return lib.result(false, reasons, evidence);
}
