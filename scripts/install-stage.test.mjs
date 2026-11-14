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
    const files = ['Dockerfile', '.teployignore', '.dockerignore', 'teploy.example.yml'];
    for (const file of files) writeFileSync(join(source, file), readFileSync(join(root, file)));
    const artifacts = ['src/cli.ts', 'src/worker.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
      'deploy/package.ship.json', 'deploy/package-lock.ship.json',
      'deploy/package.web.json', 'deploy/package-lock.web.json', 'web/src/routes/index.tsx',
      'web/public/favicon.svg', 'web/package.json', 'web/pnpm-lock.yaml',
      'web/index.html', 'web/tsconfig.json', 'web/vite.config.ts', 'web/neutron.config.ts',
      'patches/@neutron-build__agents.patch'];
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

// SHIP-03: the stranger's install stood up Nucleus v1.1.1 (unauthenticated)
// two weeks after production left it for PostgreSQL. Pin the shape.
test('the minimal install deploys the PostgreSQL store, with a password, not Nucleus', () => {
  const example = readFileSync(join(root, 'teploy.example.yml'), 'utf8');
  const live = example.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.match(live, /^ {2}web: web --store postgres\b/m);
  assert.match(live, /^ {2}worker: worker --store postgres\b/m);
  assert.match(live, /^ {4}image: pgvector\/pgvector:[0-9.]+-pg17$/m, 'the pinned pgvector pg17 build the template uses');
  assert.match(live, /POSTGRES_PASSWORD: secret:SHIP_DB_PASSWORD/);
  assert.match(live, /NUCLEUS_URL: postgres:\/\/ship@ship-postgres:5432\/ship/);
  assert.doesNotMatch(live, /NUCLEUS_URL: postgres:\/\/[^@\s]*:[^@\s]*@/, 'the password rides PGPASSWORD, never the URL');
  assert.doesNotMatch(live, /NUCLEUS_ALLOW_NO_AUTH|neutron-build\/nucleus/, 'Nucleus is a commented opt-in only');
});

test('install.sh generates every secret the minimal install reads, under the current names', () => {
  const script = readFileSync(join(root, 'install.sh'), 'utf8');
  for (const key of ['SHIP_WEB_TOKEN', 'SHIP_SESSION_SECRET', 'SHIP_WEBHOOK_SECRET', 'SHIP_CONFIG_KEY']) {
    assert.match(script, new RegExp(`for key in [^\\n]*\\b${key}\\b`), `${key} is generated`);
  }
  assert.match(script, /sec_put SHIP_DB_PASSWORD "\$\{db_password\}"/);
  assert.match(script, /sec_put PGPASSWORD "\$\{db_password\}"/, 'one password, under both names that read it');
  assert.match(script, /OBSERVE_ENDPOINT: /);
  assert.doesNotMatch(script, /echo "  OBSERVE_URL:/, 'the deprecated name is not written');
  assert.doesNotMatch(script, /^install_version=\$\(git /m, 'a tarball without .git must still deploy');
  // --help prints the header, which carries the no-sandbox trust model (SHIP-07).
  const help = spawnSync('bash', [join(root, 'install.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /TRUST MODEL/);
});
