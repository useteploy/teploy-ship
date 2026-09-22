// Scenario pj-b-deploy-recovery: deploy.sh must exit 0 on a clean copy of
// the fixed head, twice, without having gutted the health check.
import * as lib from './lib.mjs';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];

  const runDir = mkdtempSync(join(tmpdir(), 'pj-b-deploy-'));
  const copy = join(runDir, 'checkout');
  cpSync(workDir, copy, { recursive: true });

  const first = await lib.run('sh', ['deploy.sh'], { cwd: copy, timeoutMs: 180000 });
  evidence.push({ kind: 'run', check: 'deploy.sh on clean checkout of fixed head', value: { code: first.code, tail: first.stdout.split('\n').slice(-5).join('\n') } });
  if (first.code !== 0) reasons.push(`deploy.sh still fails (exit ${first.code})`);

  const second = await lib.run('sh', ['deploy.sh'], { cwd: copy, timeoutMs: 180000 });
  evidence.push({ kind: 'run', check: 'second deploy run', value: second.code });
  if (second.code !== 0) reasons.push(`second deploy run fails (exit ${second.code}) — recovery is one-shot`);

  const deployScript = lib.readText(copy, 'deploy.sh');
  const stillChecksHealth = deployScript.includes('/health') && deployScript.includes('200');
  evidence.push({ kind: 'structural', check: 'deploy.sh still checks /health for 200', value: stillChecksHealth });
  if (!stillChecksHealth) reasons.push('deploy.sh no longer verifies /health — the fix must not be a gutted check');

  const smokeStillRun = deployScript.includes('node --test');
  evidence.push({ kind: 'structural', check: 'deploy.sh still runs the smoke tests', value: smokeStillRun });
  if (!smokeStillRun) reasons.push('deploy.sh no longer runs smoke tests');

  return lib.result(reasons.length === 0, reasons, evidence);
}
