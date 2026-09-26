import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('fresh install stages the minimal config and all Docker inputs without operator files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ship-install-test-'));
  try {
    const source = join(temp, 'source'), stage = join(temp, 'stage');
    mkdirSync(source); mkdirSync(stage);
    const files = ['Dockerfile', '.teployignore', 'teploy.example.yml'];
    for (const file of files) writeFileSync(join(source, file), readFileSync(join(root, file)));
    const artifacts = ['dist/cli.js', 'deploy/package.ship.json', 'deploy/package-lock.ship.json',
      'deploy/package.web.json', 'deploy/package-lock.web.json', 'web/dist/index.html',
      'web/src/routes/index.tsx', 'web/index.html', 'web/tsconfig.json', 'web/vite.config.ts', 'web/neutron.config.ts'];
    for (const file of artifacts) {
      mkdirSync(join(source, file, '..'), { recursive: true });
      writeFileSync(join(source, file), 'fixture');
    }
    writeFileSync(join(source, 'teploy.install.yml'), 'server: example.internal\n');
    for (const file of ['teploy.yml', 'ship-secrets.env', 'private-notes.txt']) writeFileSync(join(source, file), 'DO NOT COPY');
    const result = spawnSync('bash', [join(root, 'deploy/stage-install.sh'), source, stage], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(stage, 'teploy.yml'), 'utf8'), readFileSync(join(root, 'teploy.example.yml'), 'utf8'));
    assert.equal(existsSync(join(stage, 'ship-secrets.env')), false);
    assert.equal(existsSync(join(stage, 'private-notes.txt')), false);
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
      const sources = line.split(/\s+/).slice(1, -1);
      for (const path of sources) assert.ok(existsSync(join(stage, path)), `missing Docker input ${path}`);
    }
    const retry = spawnSync('bash', [join(root, 'deploy/stage-install.sh'), source, stage], { encoding: 'utf8' });
    assert.notEqual(retry.status, 0, 'must refuse a nonempty destination');
    assert.match(retry.stderr, /must be empty/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
