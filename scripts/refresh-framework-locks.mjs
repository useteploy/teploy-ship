#!/usr/bin/env node
// Refresh development and production registry locks only after the release exists.
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertNoPendingPublication, publishPair, recoverPublication } from './framework-lock-publication.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, stdio: 'inherit' });
const lockFiles = ['web/pnpm-lock.yaml', 'deploy/package-lock.web.json'];
if (process.argv.length > 2) {
  if (process.argv.length !== 3 || process.argv[2] !== '--recover') throw new Error('Usage: refresh-framework-locks.mjs [--recover]');
  console.log(recoverPublication(root, lockFiles) ? 'Lock publication recovered; inspect both locks before rerunning refresh.' : 'No pending lock publication.');
  process.exit(0);
}
assertNoPendingPublication(root);
// Fail before changing any tracked lockfile. CLI also requires create 0.1.9.
for (const name of ['@neutron-build/core@0.3.2', '@neutron-build/cli@0.3.2', '@neutron-build/create@0.1.9']) {
  run('npm', ['view', name, 'dist.integrity'], root);
}
const stage = mkdtempSync(join(tmpdir(), 'ship-framework-locks-'));
try {
  mkdirSync(join(stage, 'web'));
  copyFileSync(join(root, 'package.json'), join(stage, 'package.json'));
  copyFileSync(join(root, 'web/package.json'), join(stage, 'web/package.json'));
  copyFileSync(join(root, 'web/pnpm-lock.yaml'), join(stage, 'web/pnpm-lock.yaml'));
  run('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'], join(stage, 'web'));
  const npmStage = join(stage, 'production');
  mkdirSync(join(npmStage, 'web'), { recursive: true });
  copyFileSync(join(root, 'deploy/package.ship.json'), join(npmStage, 'package.json'));
  copyFileSync(join(root, 'deploy/package-lock.ship.json'), join(npmStage, 'package-lock.json'));
  copyFileSync(join(root, 'deploy/package.web.json'), join(npmStage, 'web/package.json'));
  copyFileSync(join(root, 'deploy/package-lock.web.json'), join(npmStage, 'web/package-lock.json'));
  for (const cwd of [npmStage, join(npmStage, 'web')]) {
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
  }
  const lock = JSON.parse(readFileSync(join(npmStage, 'web/package-lock.json'), 'utf8'));
  for (const [name, version] of [['core', '0.3.2'], ['cli', '0.3.2'], ['create', '0.1.9']]) {
    const entry = lock.packages[`node_modules/@neutron-build/${name}`];
    if (entry?.version !== version || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/')) {
      throw new Error(`Invalid registry release lock for ${name}`);
    }
  }
  // Publish generated files only after every resolver and assertion succeeded.
  publishPair(root, [
    { file: lockFiles[0], source: join(stage, 'web/pnpm-lock.yaml') },
    { file: lockFiles[1], source: join(npmStage, 'web/package-lock.json') },
  ]);
  console.log('Framework locks refreshed. Install, test, build and review the registry diff before deployment.');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
