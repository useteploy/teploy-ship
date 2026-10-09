import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoPendingPublication, publishPair, recoverPublication } from './framework-lock-publication.mjs';

// All fixtures are tiny, isolated files. No registry commands or tracked locks.
const files = ['web/pnpm-lock.yaml', 'deploy/package-lock.web.json'];
const originals = [Buffer.from('OLD-PNPM\n\0'), Buffer.from('OLD-NPM\r\n')];
const generated = [Buffer.from('NEW-PNPM\n'), Buffer.from('NEW-NPM\n')];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lock-publication-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pairs = files.map((file, i) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), originals[i]);
    const source = join(root, `source-${i}`);
    writeFileSync(source, generated[i]);
    return { file, source };
  });
  return { root, pairs };
}
function assertBytes(root, bytes = originals) {
  files.forEach((file, i) => assert.deepEqual(readFileSync(join(root, file)), bytes[i]));
}
function fault(phaseToFail, indexToFail, rollbackFails = false) {
  return (source, destination, phase, index) => {
    if ((phase === phaseToFail && index === indexToFail) || (rollbackFails && phase === 'rollback')) {
      throw Object.assign(new Error(`Injected EIO: ${phase} ${index}`), { code: 'EIO' });
    }
    renameSync(source, destination);
  };
}
for (const index of [0, 1]) {
  test(`replacement ${index + 1} failure restores exact original pair`, t => {
    const { root, pairs } = fixture(t);
    assert.throws(() => publishPair(root, pairs, { replace: fault('publish', index) }), /original lock bytes restored/);
    assertBytes(root);
    assertNoPendingPublication(root);
    assert.equal(existsSync(join(root, '.framework-lock-refresh')), false);
  });
}
test('rollback failure retains verified originals, blocks refresh, and supports recovery retry', t => {
  const { root, pairs } = fixture(t);
  assert.throws(() => publishPair(root, pairs, { replace: fault('publish', 1, true) }), /recovery material retained/);
  assertBytes(root, [generated[0], originals[1]]);
  originals.forEach((bytes, i) => assert.deepEqual(readFileSync(join(root, '.framework-lock-refresh', `${i}.original`)), bytes));
  assert.throws(() => assertNoPendingPublication(root), /Incomplete lock refresh/);
  assert.throws(() => recoverPublication(root, files, { replace: fault('rollback', 0) }), /Injected EIO/);
  assert.equal(existsSync(join(root, '.framework-lock-refresh/journal.json')), true);
  assert.equal(recoverPublication(root, files), true);
  assertBytes(root);
  assert.equal(recoverPublication(root, files), false);
});
test('successful publication installs exact generated pair and removes recovery material', t => {
  const { root, pairs } = fixture(t);
  publishPair(root, pairs);
  assertBytes(root, generated);
  assertNoPendingPublication(root);
  files.forEach(file => assert.equal(existsSync(join(root, `${file}.framework-refresh-new`)), false));
});
for (const afterIndex of [0, 1]) {
  test(`process interruption after replacement ${afterIndex + 1} is detected and recovers originals`, t => {
    const { root, pairs } = fixture(t);
    const module = new URL('./framework-lock-publication.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { renameSync } from 'node:fs';
      import { publishPair } from ${JSON.stringify(module)};
      publishPair(${JSON.stringify(root)}, ${JSON.stringify(pairs)}, { replace(source, destination, phase, index) {
        renameSync(source, destination);
        if (phase === 'publish' && index === ${afterIndex}) process.exit(73);
      }});
    `], { encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    assertBytes(root, afterIndex === 0 ? [generated[0], originals[1]] : generated);
    assert.throws(() => assertNoPendingPublication(root), /Incomplete lock refresh/);
    // Use the real operator CLI, copied to this fixture so its root is isolated.
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    for (const file of ['refresh-framework-locks.mjs', 'framework-lock-publication.mjs']) {
      writeFileSync(join(scripts, file), readFileSync(join(dirname(fileURLToPath(import.meta.url)), file)));
    }
    const recovery = spawnSync(process.execPath, [join(scripts, 'refresh-framework-locks.mjs'), '--recover'], { encoding: 'utf8' });
    assert.equal(recovery.status, 0, recovery.stderr);
    assertBytes(root);
    assertNoPendingPublication(root);
  });
}

for (const boundary of ['0.original', 'journal.json']) {
  test(`interrupted cleanup after ${boundary} retains completed pair and can finish`, t => {
    const { root, pairs } = fixture(t);
    const module = new URL('./framework-lock-publication.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const remove = fs.rmSync;
      fs.rmSync = (path, options) => {
        remove(path, options);
        if (String(path).endsWith(${JSON.stringify(boundary)})) process.exit(74);
      };
      syncBuiltinESMExports();
      const { publishPair } = await import(${JSON.stringify(module)});
      publishPair(${JSON.stringify(root)}, ${JSON.stringify(pairs)});
    `], { encoding: 'utf8' });
    assert.equal(child.status, 74, child.stderr);
    assertBytes(root, generated);
    assert.throws(() => assertNoPendingPublication(root), /Incomplete lock refresh/);
    assert.equal(recoverPublication(root, files), true);
    assertBytes(root, generated);
    assertNoPendingPublication(root);
  });
}
test('corrupt backup refuses recovery before changing either lock', t => {
  const { root, pairs } = fixture(t);
  assert.throws(() => publishPair(root, pairs, { replace: fault('publish', 1, true) }));
  writeFileSync(join(root, '.framework-lock-refresh/1.original'), 'corrupted');
  assert.throws(() => recoverPublication(root, files), /Corrupt backup/);
  assertBytes(root, [generated[0], originals[1]]);
  assert.equal(existsSync(join(root, '.framework-lock-refresh/0.original')), true);
});

for (const record of ['journal.json', 'complete.json']) {
  test(`interruption at ${record} record boundary recovers original bytes`, t => {
    const { root, pairs } = fixture(t);
    const module = new URL('./framework-lock-publication.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        // Journal interruption is before any backups; completion interruption
        // has both replacements but only a verified temporary completion file.
        if (String(destination).endsWith('/complete.json') && ${JSON.stringify(record)} === 'complete.json') process.exit(75);
        rename(source, destination);
        if (String(destination).endsWith('/journal.json') && ${JSON.stringify(record)} === 'journal.json') process.exit(75);
      };
      syncBuiltinESMExports();
      const { publishPair } = await import(${JSON.stringify(module)});
      publishPair(${JSON.stringify(root)}, ${JSON.stringify(pairs)});
    `], { encoding: 'utf8' });
    assert.equal(child.status, 75, child.stderr);
    assert.equal(recoverPublication(root, files), true);
    assertBytes(root);
    assertNoPendingPublication(root);
  });
}

test('normal CLI refuses an incomplete refresh before any registry command', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, '.framework-lock-refresh'));
  mkdirSync(join(root, 'scripts'));
  for (const file of ['refresh-framework-locks.mjs', 'framework-lock-publication.mjs']) {
    writeFileSync(join(root, 'scripts', file), readFileSync(join(dirname(fileURLToPath(import.meta.url)), file)));
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/refresh-framework-locks.mjs')], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Incomplete lock refresh detected/);
  assertBytes(root);
});
