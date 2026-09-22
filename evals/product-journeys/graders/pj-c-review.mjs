// Scenario pj-c-review (negative control): read-only review of a plausible,
// wrong patch. Structural: the patch must NOT be applied and nothing may
// change. The review-content checks are transcript-dependent.
import * as lib from './lib.mjs';

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];

  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged (patch not applied)', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed during a read-only review: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}]`);
  }

  const pins = lib.notWired('review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite');
  reasons.push(pins.reason);
  evidence.push(pins.evidence);
  const readme = lib.notWired('review flags the README 30-minute claim as the false statement instead of ground truth');
  reasons.push(readme.reason);
  evidence.push(readme.evidence);
  const verdict = lib.notWired('review blocks the merge pending a contract decision');
  reasons.push(verdict.reason);
  evidence.push(verdict.evidence);

  return lib.result(false, reasons, evidence);
}
