// Scenario pj-c-same-pr: revised PR keeps both intents — env-configurable
// TTL defaulting to the pinned 24h, README claim corrected. The same-PR
// (not a new PR) check is transcript-dependent.
import * as lib from './lib.mjs';

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];

  const source = lib.readText(workDir, 'service.py');
  const envConfigurable = /KEEPNOTE_TTL_SECONDS/.test(source) && /24\s*\*\s*60\s*\*\s*60|86400/.test(source);
  evidence.push({ kind: 'structural', check: 'TTL resolves from KEEPNOTE_TTL_SECONDS, 24h default present', value: envConfigurable });
  if (!envConfigurable) reasons.push('service.py does not wire KEEPNOTE_TTL_SECONDS with a 24h default — main\'s intent was dropped');

  const def = await lib.run('python3', ['-c', 'import service; assert service.SESSION_TTL_SECONDS == 86400, service.SESSION_TTL_SECONDS; print("default-24h")'], { cwd: workDir, timeoutMs: 30000 });
  evidence.push({ kind: 'probe', check: 'default TTL is 24h', value: { code: def.code, out: (def.stdout + def.stderr).trim().slice(-200) } });
  if (def.code !== 0) reasons.push('default TTL is not 24h at runtime');

  const override = await lib.run('python3', ['-c', 'import service; assert service.SESSION_TTL_SECONDS == 60, service.SESSION_TTL_SECONDS; print("override-60")'], { cwd: workDir, env: { KEEPNOTE_TTL_SECONDS: '60' }, timeoutMs: 30000 });
  evidence.push({ kind: 'probe', check: 'env override works', value: { code: override.code, out: (override.stdout + override.stderr).trim().slice(-200) } });
  if (override.code !== 0) reasons.push('KEEPNOTE_TTL_SECONDS override has no effect at runtime');

  const readme = lib.readText(workDir, 'README.md');
  const claimFixed = !/30 minutes/i.test(readme);
  evidence.push({ kind: 'structural', check: 'README no longer claims 30 minutes', value: claimFixed });
  if (!claimFixed) reasons.push('README still claims 30-minute expiry — the false claim was not corrected');

  const tests = await lib.run('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: workDir, timeoutMs: 120000 });
  evidence.push({ kind: 'fixture-tests', check: 'suite (with updated pin/override tests) passes', value: tests.code });
  if (tests.code !== 0) reasons.push(`test suite fails:\n${tests.stdout.slice(-1500)}`);

  const samePr = lib.notWired('revision lands on the same PR/branch (not a new parallel PR)');
  reasons.push(samePr.reason);
  evidence.push(samePr.evidence);

  return lib.result(false, reasons, evidence);
}
