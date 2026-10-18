import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  scanFlags, renderFlags, parseFlagsDoc, descriptionsFromDeploy,
  mergeDescriptions, checkFlags, defaultFromContext, acceptedFromContext
} from './flag-reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'flag-reference.mjs');

// A throwaway repo with one file per read shape, so the scanner runs against
// real files and never against this repository.
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'flag-reference-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'src', 'fixtures'), { recursive: true });
  mkdirSync(join(root, 'web', 'src', 'routes'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });

  writeFileSync(join(root, 'src', 'a.ts'), `export const FLAG_CONST = "SHIP_BRACKET_CONST";
function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[name] ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
function value(name: string) {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : "not set";
}
export function reads(env: NodeJS.ProcessEnv, x: string, id: string) {
  const a = process.env.SHIP_DIRECT;
  const b = env.SHIP_PARAM;
  const c = env["SHIP_BRACKET"];
  const d = env[FLAG_CONST];
  const e = (env[\`SHIP_TPL_\${x}\`] ?? "").trim();
  const name = \`SHIP_INDIRECT_\${id}\`;
  const f = env[name];
  const g = envFlag("SHIP_HELPER_BOOL");
  const h = value("SHIP_LOCAL_HELPER");
  const cfg = {
    first: value("SHIP_NO_DEFAULT"),
    label: value("SHIP_LABELLED") || "Single sign-on",
  };
  process.env.SHIP_ASSIGNED_WRITE = "no";
  const mode = (env.SHIP_THREE_STATE ?? "").trim().toLowerCase();
  return mode === "shadow" ? "shadow" : mode === "on" ? "on" : "off";
}
`);
  writeFileSync(join(root, 'src', 'b.ts'), `const raw = process.env.SHIP_DEFAULTED ?? 300;
const s = process.env.SHIP_STRING_DEFAULT || "fallback";
const exact = (process.env.SHIP_EXACT_ON ?? "") === "on";
`);

  writeFileSync(join(root, 'web', 'src', 'routes', 'page.tsx'), `export function page() {
  const a = process.env.SHIP_WEB_ONLY;
  const b = process.env.SHIP_BOTH_SIDES;
  return { a, b };
}
`);
  writeFileSync(join(root, 'src', 'shared.ts'), `export function workerSide(env: NodeJS.ProcessEnv) {
  return env.SHIP_BOTH_SIDES;
}
`);
  writeFileSync(join(root, 'scripts', 'tool.mjs'), 'const n = Number(process.env.SHIP_SCRIPT_KNOB || 42);\n');
  // Must not be scanned: tests and fixtures.
  writeFileSync(join(root, 'src', 'a.test.ts'), 'const x = process.env.SHIP_IN_A_TEST;\n');
  writeFileSync(join(root, 'src', 'fixtures', 'fake.ts'), 'const x = process.env.SHIP_IN_FIXTURES;\n');
  writeFileSync(join(root, 'docs', 'DEPLOY.md'), `# Deploy

| Variable | Default | What it does |
|---|---|---|
| \`SHIP_BRACKET_CONST\` | unset | Described in DEPLOY. |
| \`SHIP_ONE\`, \`SHIP_TWO\` | unset | One row, two keys. |
| \`SHIP_TPL_<NAME>\` | unset | Pattern row for the template read. |
`);
  return root;
}

const scanKeys = root => [...scanFlags(root).keys()].sort();

test('finds every read shape: member, bracket, const, templates, helpers', () => {
  const root = fixtureRoot();
  const keys = scanKeys(root);
  for (const k of [
    'SHIP_DIRECT', 'SHIP_PARAM', 'SHIP_BRACKET', 'SHIP_BRACKET_CONST',
    'SHIP_TPL_<...>', 'SHIP_INDIRECT_<...>', 'SHIP_HELPER_BOOL',
    'SHIP_LOCAL_HELPER', 'SHIP_NO_DEFAULT', 'SHIP_LABELLED',
    'SHIP_THREE_STATE', 'SHIP_DEFAULTED', 'SHIP_STRING_DEFAULT',
    'SHIP_EXACT_ON', 'SHIP_WEB_ONLY', 'SHIP_BOTH_SIDES', 'SHIP_SCRIPT_KNOB'
  ]) {
    assert.ok(keys.includes(k), `${k} should be found (has: ${keys.join(', ')})`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('negative control: tests, fixtures and assignment writes are not reads', () => {
  const root = fixtureRoot();
  const keys = scanKeys(root);
  assert.ok(!keys.includes('SHIP_IN_A_TEST'), 'test files are excluded');
  assert.ok(!keys.includes('SHIP_IN_FIXTURES'), 'fixtures are excluded');
  assert.ok(!keys.includes('SHIP_ASSIGNED_WRITE'), 'an assignment target is a write, not a read');
  rmSync(root, { recursive: true, force: true });
});

test('side is a file-location heuristic: web, worker, both', () => {
  const root = fixtureRoot();
  const entries = scanFlags(root);
  assert.equal([...entries.get('SHIP_WEB_ONLY').sides][0], 'web');
  assert.equal([...entries.get('SHIP_SCRIPT_KNOB').sides][0], 'worker');
  const both = entries.get('SHIP_BOTH_SIDES').sides;
  assert.ok(both.has('web') && both.has('worker'), 'read in both trees is both');
  const row = renderRowFor(renderFlags(entries, new Map()), 'SHIP_BOTH_SIDES');
  assert.match(row, /\| both \|/);
  rmSync(root, { recursive: true, force: true });
});

test('defaults come from the read own fallbacks, never a neighbour line', () => {
  const root = fixtureRoot();
  const rows = renderedRows(root);
  assert.match(rows.get('SHIP_DEFAULTED'), /\| 300 \|/);
  assert.match(rows.get('SHIP_STRING_DEFAULT'), /\| "fallback" \|/);
  assert.match(rows.get('SHIP_NO_DEFAULT'), /\| see source \|/, 'no fallback on its own line');
  assert.match(rows.get('SHIP_LABELLED'), /\| "Single sign-on" \|/);
  assert.match(rows.get('SHIP_NO_DEFAULT'), /see source/, 'the labelled neighbour borrowed nothing');
  rmSync(root, { recursive: true, force: true });
});

test('accepted values come from helper grammar and the read own comparisons', () => {
  const root = fixtureRoot();
  const rows = renderedRows(root);
  assert.match(rows.get('SHIP_HELPER_BOOL'), /\| 1\/true\/yes \|/);
  assert.match(rows.get('SHIP_EXACT_ON'), /\| on \|/);
  assert.match(rows.get('SHIP_THREE_STATE'), /\| on\/shadow \|/, 'grammar on the statement after the assignment');
  rmSync(root, { recursive: true, force: true });
});

test('probe units: defaults and grammar from a line of context', () => {
  assert.equal(defaultFromContext(' ?? 300)'), '300');
  assert.equal(defaultFromContext(' || "teploy")'), '"teploy"');
  assert.equal(defaultFromContext(' ? raw : 3;'), '3');
  assert.equal(defaultFromContext(', "Single sign-on"),'), undefined);
  assert.equal(acceptedFromContext(' === "on" ? "on" : "off";'), 'off/on');
  assert.equal(acceptedFromContext('', '  return /^(on|1|true)$/i.test(('), '1/on/true');
});

function renderedRows(root) {
  const entries = scanFlags(root);
  const rows = new Map();
  for (const line of renderFlags(entries, new Map()).split('\n')) {
    const m = line.match(/^\| `([^`]+)` \|/);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

function renderRowFor(doc, key) {
  const line = doc.split('\n').find(l => l.startsWith(`| \`${key}\` |`));
  if (!line) throw new Error(`no row for ${key}`);
  return line;
}

test('render then parse round-trips descriptions, including escaped pipes', () => {
  const root = fixtureRoot();
  const entries = scanFlags(root);
  const descs = new Map([['SHIP_DIRECT', 'a `code` and a raw | pipe']]);
  const doc = renderFlags(entries, descs);
  const back = parseFlagsDoc(doc);
  assert.equal(back.get('SHIP_DIRECT'), 'a `code` and a raw | pipe');
  assert.equal(back.get('SHIP_PARAM'), 'TODO');
  rmSync(root, { recursive: true, force: true });
});

test('regeneration merges descriptions by key, so hand edits survive', () => {
  const root = fixtureRoot();
  const entries = scanFlags(root);
  // First generation: DEPLOY fills what it names, the rest TODO.
  const deployText = readFileSync(join(root, 'docs/DEPLOY.md'), 'utf8');
  const first = mergeDescriptions(entries, '', deployText);
  assert.equal(first.get('SHIP_BRACKET_CONST'), 'Described in DEPLOY.');
  assert.equal(first.get('SHIP_ONE'), 'One row, two keys.');
  assert.equal(first.get('SHIP_TWO'), 'One row, two keys.', 'a comma-list row describes both keys');
  assert.equal(first.get('SHIP_TPL_<...>'), 'Pattern row for the template read.', 'a DEPLOY <NAME> row fills the scanned pattern row');
  // A DEPLOY-only key never gains a row: rows come from the scan, not the import.
  assert.ok(!renderFlags(entries, first).split('\n').some(l => l.startsWith('| `SHIP_ONE` |')), 'unread DEPLOY keys stay rowless');
  // A hand edit lands in the doc; the second generation must keep it.
  first.set('SHIP_DIRECT', 'hand-written');
  const doc = renderFlags(entries, first);
  const second = mergeDescriptions(entries, doc, deployText);
  assert.equal(second.get('SHIP_DIRECT'), 'hand-written');
  assert.equal(second.get('SHIP_BRACKET_CONST'), 'Described in DEPLOY.', 'DEPLOY import survives too');
  assert.equal(renderFlags(entries, second), doc, 'regeneration is byte-stable once descriptions exist');
  rmSync(root, { recursive: true, force: true });
});

test('DEPLOY import: descriptionsFromDeploy reads only key-named table rows', () => {
  const d = descriptionsFromDeploy(`| Piece | What | How |
|---|---|---|
| \`ship\` (web + worker) | dashboard | \`teploy deploy\` |
| \`SHIP_ROW_KEY\` | unset | The description. |
`);
  assert.ok(!d.has('ship'), 'lowercase prose rows are not keys');
  assert.equal(d.get('SHIP_ROW_KEY'), 'The description.');
});

test('negative control: checkFlags fails on a missing row and on a stale row', () => {
  const root = fixtureRoot();
  const entries = scanFlags(root);
  const doc = renderFlags(entries, mergeDescriptions(entries, '', ''));
  const rows = parseFlagsDoc(doc);
  assert.deepEqual(checkFlags(entries, rows), [], 'in sync is clean');

  const missing = parseFlagsDoc(doc.replace(/^\| `SHIP_DIRECT` .*$/m, ''));
  const missingErrors = checkFlags(entries, missing);
  assert.ok(missingErrors.some(e => e.rule === 'missing-row' && e.message.includes('SHIP_DIRECT')));

  const stale = parseFlagsDoc(doc + '\n| `SHIP_RENAMED_AWAY` | see source | see source | src/a.ts:1 | worker | leftover |\n');
  const staleErrors = checkFlags(entries, stale);
  assert.ok(staleErrors.some(e => e.rule === 'stale-row' && e.message.includes('SHIP_RENAMED_AWAY')));
  rmSync(root, { recursive: true, force: true });
});

test('the CLI writes the doc, then --check passes; drift exits 1', () => {
  const root = fixtureRoot();
  const doc = join(root, 'docs', 'FLAGS.md');
  const run = args => spawnSync(process.execPath, [SCRIPT, ...args, '--root', root, '--doc', doc], { encoding: 'utf8' });

  const gen = run([]);
  assert.equal(gen.status, 0, gen.stderr);
  assert.match(readFileSync(doc, 'utf8'), /\| `SHIP_DIRECT` \|/);

  const ok = run(['--check']);
  assert.equal(ok.status, 0, ok.stderr);

  // A key read by the code but missing from the doc fails CI.
  writeFileSync(doc, readFileSync(doc, 'utf8').replace(/^\| `SHIP_PARAM` .*$/m, ''));
  const missing = run(['--check']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /FAIL \[missing-row\] SHIP_PARAM/);

  // A row naming a key the code no longer reads fails CI.
  writeFileSync(doc, readFileSync(doc, 'utf8') + '\n| `SHIP_GONE_NOW` | see source | see source | src/a.ts:1 | worker | stale |\n');
  const stale = run(['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /FAIL \[stale-row\] SHIP_GONE_NOW/);

  rmSync(root, { recursive: true, force: true });
});

test('negative control: the scanner does not read its own documentation', () => {
  const repo = resolve(HERE, '..');
  const keys = scanKeys(repo);
  assert.ok(!keys.includes('KEY'), 'the header comment mentioning process.env.KEY is not a flag');
  assert.ok(!keys.includes('SHIP_<...>'), 'the header comment mentioning the SHIP_${...} shape is not a flag');
});
