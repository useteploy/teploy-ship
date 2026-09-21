#!/usr/bin/env node
/** Audit exactly the lockfiles Docker installs, including its SSR toolchain. */
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const stage = mkdtempSync(join(tmpdir(), 'ship-deployment-audit-'));
try {
  mkdirSync(join(stage, 'web'));
  for (const [name, cwd] of [['ship', stage], ['web', join(stage, 'web')]]) {
    copyFileSync(join(source, `package.${name}.json`), join(cwd, 'package.json'));
    copyFileSync(join(source, `package-lock.${name}.json`), join(cwd, 'package-lock.json'));
    console.log(`Auditing deployed ${name} dependency tree`);
    const result = spawnSync('npm', ['audit', '--audit-level=high'], { cwd, stdio: 'inherit', timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
