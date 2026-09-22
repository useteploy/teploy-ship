// Scenario pj-s-question: grounded question about the static site.
// Structural: the work tree must be untouched. The citation checks are
// transcript-dependent and not wired in this slice.
import * as lib from './lib.mjs';

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}] — the task is answer-only`);
  }
  const citation = lib.notWired('every cited file:line:string occurrence verified verbatim against the fixture');
  reasons.push(citation.reason);
  evidence.push(citation.evidence);
  const count = lib.notWired('cited occurrence count matches an independent count (4 Tideline occurrences, 1 tagline)');
  reasons.push(count.reason);
  evidence.push(count.evidence);
  const pr = lib.notWired('no PR opened');
  reasons.push(pr.reason);
  evidence.push(pr.evidence);
  return lib.result(false, reasons, evidence);
}
