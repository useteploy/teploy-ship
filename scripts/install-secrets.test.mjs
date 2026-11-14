// install.sh, run end to end against a FAKE server: a `teploy` and an `ssh`
// on PATH that keep their state in a directory. What is pinned here is what a
// re-run does to an install that already exists — the part nobody can observe
// from a single fresh pass:
//
//   - the database password is reused (bundle, else the server's secret
//     store), and a server that runs ship-postgres without a recorded
//     password is refused rather than handed a new one;
//   - `teploy secret get` prints a "Connecting to …" banner on stdout and
//     fails for a key that is not set — the banner must never be taken for
//     the value (it was, for SHIP_DB_PASSWORD and PGPASSWORD);
//   - the generated secrets are not rotated underneath a running install by a
//     re-run that lost the bundle;
//   - an existing Ship on Nucleus is refused, including when plain ssh could
//     not ask until teploy had enrolled the host key;
//   - no secret value reaches the script's output.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// The stdout shapes are teploy-cli v0.1.55's: a banner line, then the value;
// a missing key prints the banner and exits non-zero.
const FAKE_TEPLOY = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_STATE/teploy.log"
args=("$@"); i=0
while [ $i -lt \${#args[@]} ]; do case "\${args[$i]}" in --project-dir|--host|--user) i=$((i+2));; *) break;; esac; done
cmd="\${args[$i]}"; sub="\${args[$((i+1))]:-}"
case "$cmd $sub" in
  "secret get") echo "Connecting to root@fake..."; k="\${args[$((i+2))]}"; f="$FAKE_STATE/secret-$k"
    if [ -f "$f" ]; then cat "$f"; else echo "Error: secret not found: $k" >&2; exit 1; fi ;;
  "secret set") echo "Connecting to root@fake..."; j=$((i+2))
    while [ $j -lt \${#args[@]} ]; do kv="\${args[$j]}"; printf '%s\\n' "\${kv#*=}" > "$FAKE_STATE/secret-\${kv%%=*}"; j=$((j+1)); done ;;
  setup*) touch "$FAKE_STATE/host-known"; echo "setup ok" ;;
  deploy*) touch "$FAKE_STATE/container-ship-postgres"; echo deployed ;;
  *) echo "fake teploy: $*" ;;
esac
`;

// Plain ssh in batch mode refuses a host it has never seen (state file
// "host-unknown" present and "host-known" absent).
const FAKE_SSH = `#!/bin/bash
if [ -f "$FAKE_STATE/host-unknown" ] && [ ! -f "$FAKE_STATE/host-known" ]; then echo "Host key verification failed." >&2; exit 255; fi
cmd="\${@: -1}"
case "$cmd" in
  *"docker inspect ship-nucleus"*"echo present"*) if [ -f "$FAKE_STATE/container-ship-nucleus" ]; then echo present; else echo absent; fi ;;
  *"docker inspect ship-postgres"*) [ -f "$FAKE_STATE/container-ship-postgres" ] ;;
  *"systemctl is-active"*) exit 3 ;;
  *) exit 0 ;;
esac
`;

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ship-install-secrets-'));
  const repo = join(temp, 'repo'), bin = join(temp, 'bin'), state = join(temp, 'state');
  for (const dir of [repo, join(repo, 'deploy'), bin, state]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'install.sh'), join(repo, 'install.sh'));
  copyFileSync(join(root, 'package.json'), join(repo, 'package.json'));
  // Staging is covered by install-stage.test.mjs; here it only has to succeed.
  writeFileSync(join(repo, 'deploy/stage-install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(bin, 'teploy'), FAKE_TEPLOY);
  writeFileSync(join(bin, 'ssh'), FAKE_SSH);
  chmodSync(join(bin, 'teploy'), 0o755);
  chmodSync(join(bin, 'ssh'), 0o755);
  const bundle = join(temp, 'bundle.env');
  const install = (...extra) =>
    spawnSync('bash', [join(repo, 'install.sh'), '--host', '192.0.2.10', '--yes', '--secrets-file', bundle, ...extra, 'box'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp, TMPDIR: temp, FAKE_STATE: state, ANTHROPIC_API_KEY: 'sk-model-KEYVALUE-0123456789', SHIP_GIT_TOKEN: 'git-TOKENVALUE-0123456789' },
    });
  const values = () =>
    Object.fromEntries(
      readFileSync(bundle, 'utf8')
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  const stored = (key) => (existsSync(join(state, `secret-${key}`)) ? readFileSync(join(state, `secret-${key}`), 'utf8').trim() : undefined);
  return { temp, state, bundle, install, values, stored };
}

const GENERATED = ['SHIP_WEB_TOKEN', 'SHIP_SESSION_SECRET', 'SHIP_WEBHOOK_SECRET', 'SHIP_CONFIG_KEY'];

test('install.sh: a fresh install generates every secret, prints none of them, and a re-run changes none', () => {
  const f = fixture();
  try {
    const first = f.install();
    assert.equal(first.status, 0, first.stderr);
    const a = f.values();
    for (const key of [...GENERATED, 'SHIP_DB_PASSWORD']) assert.match(a[key] ?? '', /^[0-9a-f]{64}$/, key);
    assert.equal(a.PGPASSWORD, a.SHIP_DB_PASSWORD, 'the accessory and the clients read one password');
    assert.equal(statSync(f.bundle).mode & 0o777, 0o600);
    for (const [key, value] of Object.entries(a)) {
      assert.ok(!(first.stdout + first.stderr).includes(value), `${key} was printed`);
      assert.equal(f.stored(key), value, `${key} reached the server's secret store`);
    }
    const second = f.install();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(f.values(), a, 'a re-run with the bundle changes nothing');
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test('install.sh: a re-run without the bundle takes every secret from the server, and rotates none', () => {
  const f = fixture();
  try {
    assert.equal(f.install().status, 0);
    const a = f.values();
    rmSync(f.bundle);
    const again = f.install();
    assert.equal(again.status, 0, again.stderr);
    const b = f.values();
    for (const key of [...GENERATED, 'SHIP_DB_PASSWORD', 'PGPASSWORD']) assert.equal(b[key], a[key], `${key} was rotated underneath a running install`);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test('install.sh: a running ship-postgres whose password is recorded nowhere is refused — the banner is not a password', () => {
  const f = fixture();
  try {
    assert.equal(f.install().status, 0);
    rmSync(f.bundle);
    rmSync(join(f.state, 'secret-SHIP_DB_PASSWORD'));
    rmSync(join(f.state, 'secret-PGPASSWORD'));
    const again = f.install();
    assert.notEqual(again.status, 0, 'must refuse rather than invent a password the database would reject');
    assert.match(again.stderr, /already runs ship-postgres/);
    assert.equal(f.stored('SHIP_DB_PASSWORD'), undefined, 'nothing was written to the secret store');
    assert.equal(f.stored('PGPASSWORD'), undefined);
    for (const name of readdirSync(f.state).filter((n) => n.startsWith('secret-'))) {
      assert.ok(!readFileSync(join(f.state, name), 'utf8').includes('Connecting to'), `${name} holds teploy's banner`);
    }
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test('install.sh: an existing Ship on Nucleus is refused, also when ssh could only ask after provisioning', () => {
  for (const hostUnknown of [false, true]) {
    const f = fixture();
    try {
      writeFileSync(join(f.state, 'container-ship-nucleus'), '');
      if (hostUnknown) writeFileSync(join(f.state, 'host-unknown'), '');
      const result = f.install();
      assert.notEqual(result.status, 0, `host unknown to ssh: ${hostUnknown}`);
      assert.match(result.stderr, /runs Ship on Nucleus/);
      const log = join(f.state, 'teploy.log');
      const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [];
      assert.ok(!calls.some((line) => /(^| )(deploy|secret set) /.test(line)), 'nothing was deployed and no secret was set');
      assert.equal(existsSync(join(f.state, 'container-ship-postgres')), false);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }
});
