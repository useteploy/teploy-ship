#!/usr/bin/env node
/** Audit exactly the lockfiles Docker installs, including its SSR toolchain.
 *  Advisories listed in deploy/audit-exceptions.json (each with its reason and
 *  the condition that removes it) are reported but do not fail the audit; the
 *  web tree's pnpm auditConfig.ignoreGhsas must list exactly the same ids. */
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const exceptions = JSON.parse(readFileSync(join(source, 'audit-exceptions.json'), 'utf8'));
const excepted = new Set(exceptions.map((e) => e.ghsa));
const webIgnores = JSON.parse(readFileSync(join(source, '..', 'web', 'package.json'), 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? [];
if ([...excepted].sort().join() !== [...webIgnores].sort().join()) {
  console.error('deploy/audit-exceptions.json and web/package.json pnpm.auditConfig.ignoreGhsas disagree');
  process.exitCode = 1;
}
const SEVERE = new Set(['high', 'critical']);
const stage = mkdtempSync(join(tmpdir(), 'ship-deployment-audit-'));
try {
  mkdirSync(join(stage, 'web'));
  for (const [name, cwd] of [['ship', stage], ['web', join(stage, 'web')]]) {
    copyFileSync(join(source, `package.${name}.json`), join(cwd, 'package.json'));
    copyFileSync(join(source, `package-lock.${name}.json`), join(cwd, 'package-lock.json'));
    console.log(`Auditing deployed ${name} dependency tree`);
    const result = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    let report;
    try { report = JSON.parse(result.stdout); } catch { console.error(result.stdout, result.stderr); process.exitCode = 1; continue; }
    if (report.error) { console.error(report.error); process.exitCode = 1; continue; }
    for (const vuln of Object.values(report.vulnerabilities ?? {})) {
      for (const via of vuln.via) {
        if (typeof via !== 'object' || !SEVERE.has(via.severity)) continue;
        const ghsa = String(via.url ?? '').split('/').pop();
        if (excepted.has(ghsa)) { console.log(`  excepted ${via.severity} ${via.name} ${ghsa} (deploy/audit-exceptions.json)`); continue; }
        console.error(`  ${via.severity} ${via.name} ${ghsa}: ${via.title}`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
