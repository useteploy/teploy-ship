// Product-journey harness library: manifest validation, dry-run planning,
// argument and spend-gate logic, plus the execution path (fixture staging,
// injectable agent adapters, grader invocation, result records). Pure-ish
// (fs access only through paths it is given or resolves from repoRoot) so
// scripts/eval-journeys-lib.test.mjs and scripts/eval-journeys-exec.test.mjs
// can exercise everything without a model, a server or the network.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCENARIO_TYPES = [
  'question',
  'plan',
  'copy-design-change',
  'feature',
  'api-defect',
  'permissions-defect',
  'db-migration',
  'dependency-update',
  'independent-review',
  'same-pr-conflict-revision',
  'scheduled-job',
  'failed-deployment-recovery'
];

export const PROBES = ['interruption', 'stale-approval', 'permissions'];

export const EXIT = { OK: 0, USAGE: 1, SPEND_REFUSED: 2, ADAPTER_REFUSED: 3 };

export const ADAPTERS = ['mock', 'ship'];

// Ship's own request types (src/journeys.ts): the adapter launches each
// scenario as the journey a person would pick in the composer.
export const SHIP_JOURNEYS = ['change', 'investigate', 'plan', 'review'];

// A record's outcome keeps four states apart. `unknown` is a grade the
// harness could not perform (every failing reason is not-wired); it is never
// counted as a failure or a pass. Scenarios that were not executed have no
// record at all and are reported as not-run by the batch summary.
export const OUTCOMES = ['pass', 'fail', 'unknown', 'harness-error'];

export function outcomeOf({ pass, reasons, endedBy }) {
  if (endedBy === 'harness-error') return 'harness-error';
  if (pass) return 'pass';
  const list = reasons ?? [];
  if (list.length > 0 && list.every(r => String(r).startsWith('not-wired:'))) return 'unknown';
  return 'fail';
}

export function repoRootFrom(scriptPath) {
  return resolve(scriptPath, '..', '..');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadManifest(repoRoot) {
  return readJson(join(repoRoot, 'evals', 'product-journeys', 'manifest.json'));
}

// Validate manifest <-> fixtures <-> graders <-> README <-> results schema
// consistency. Checks are file-existence and shape only: no scenario runs,
// no servers, no model.
export async function validateManifest(manifest, { repoRoot, graderDir }) {
  const errors = [];
  const scenarios = manifest.scenarios ?? [];

  if (scenarios.length !== 12) {
    errors.push(`expected exactly 12 scenarios, found ${scenarios.length}`);
  }

  const ids = new Set();
  for (const s of scenarios) {
    if (!s.id || !/^pj-[sbc]-[a-z-]+$/.test(s.id)) errors.push(`bad scenario id: ${JSON.stringify(s.id)}`);
    if (ids.has(s.id)) errors.push(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);

    const family = manifest.families?.[s.family];
    if (!family) {
      errors.push(`${s.id}: unknown family ${JSON.stringify(s.family)}`);
    } else {
      const fixturePath = join(repoRoot, family.fixture);
      if (!existsSync(fixturePath)) errors.push(`${s.id}: fixture directory missing: ${family.fixture}`);
      if (s.fixture !== family.fixture) errors.push(`${s.id}: scenario fixture ${s.fixture} does not match family fixture ${family.fixture}`);
    }

    if (!Array.isArray(s.checks) || s.checks.length === 0) errors.push(`${s.id}: checks[] must be non-empty`);
    if (!Array.isArray(s.probes)) errors.push(`${s.id}: probes[] must be an array`);
    for (const p of s.probes ?? []) {
      if (!PROBES.includes(p)) errors.push(`${s.id}: unknown probe ${JSON.stringify(p)} (known: ${PROBES.join(', ')})`);
    }
    if (!s.taskPrompt || typeof s.taskPrompt !== 'string') errors.push(`${s.id}: missing taskPrompt`);
    if (!s.expects?.mustNotInclude || s.expects.mustNotInclude.length === 0) errors.push(`${s.id}: expects.mustNotInclude must be non-empty`);

    const journey = s.ship?.journey;
    if (!SHIP_JOURNEYS.includes(journey)) errors.push(`${s.id}: ship.journey must be one of ${SHIP_JOURNEYS.join(', ')}`);
    const readOnly = ['question', 'plan', 'independent-review'].includes(s.type);
    if (journey !== undefined && readOnly !== (journey !== 'change')) errors.push(`${s.id}: ship.journey ${journey} does not match a ${readOnly ? 'read-only' : 'change'} scenario`);
    if (s.ship?.setup !== undefined) {
      const st = s.ship.setup;
      if (st.kind !== 'same-pr') errors.push(`${s.id}: unknown ship.setup.kind ${JSON.stringify(st.kind)}`);
      for (const k of ['prPatch', 'mainPatch', 'prTitle', 'mainTitle', 'reviewTask']) {
        if (typeof st[k] !== 'string' || st[k] === '') errors.push(`${s.id}: ship.setup.${k} is required`);
      }
      for (const k of ['prPatch', 'mainPatch']) {
        if (typeof st[k] === 'string' && family && !existsSync(join(repoRoot, family.fixture, st[k]))) errors.push(`${s.id}: ship.setup.${k} missing in the fixture: ${st[k]}`);
      }
    }

    if (s.grader) {
      const graderPath = join(graderDir, s.grader.replace(/^graders\//, ''));
      if (!existsSync(graderPath)) errors.push(`${s.id}: grader missing in grader dir: ${s.grader} (looked at ${graderPath})`);
    } else {
      errors.push(`${s.id}: no grader declared`);
    }
  }

  const typeCounts = {};
  for (const s of scenarios) typeCounts[s.type] = (typeCounts[s.type] ?? 0) + 1;
  for (const type of SCENARIO_TYPES) {
    if (typeCounts[type] !== 1) errors.push(`scenario type ${type} appears ${typeCounts[type] ?? 0} times, expected exactly 1`);
  }
  for (const type of Object.keys(typeCounts)) {
    if (!SCENARIO_TYPES.includes(type)) errors.push(`unknown scenario type: ${type}`);
  }

  const negatives = scenarios.filter(s => s.negativeControl);
  if (negatives.length < 2) errors.push(`expected at least 2 negativeControl scenarios, found ${negatives.length}`);
  for (const n of negatives) {
    if (!n.trap) errors.push(`${n.id}: negativeControl without a documented trap`);
  }

  const probeCoverage = new Set(scenarios.flatMap(s => s.probes ?? []));
  for (const p of PROBES) {
    if (!probeCoverage.has(p)) errors.push(`probe ${p} is never applied by any scenario`);
  }

  const familiesUsed = new Set(scenarios.map(s => s.family));
  for (const f of Object.keys(manifest.families ?? {})) {
    if (!familiesUsed.has(f)) errors.push(`family ${f} has no scenarios`);
  }

  const schemaPath = join(repoRoot, 'evals', 'product-journeys', 'results', 'schema.json');
  if (!existsSync(schemaPath)) {
    errors.push('results/schema.json missing');
  } else {
    try { await readJson(schemaPath); } catch (e) { errors.push(`results/schema.json does not parse: ${e.message}`); }
  }

  const readmePath = join(repoRoot, 'evals', 'product-journeys', 'README.md');
  let readme = '';
  try { readme = await readFile(readmePath, 'utf8'); } catch { errors.push('evals/product-journeys/README.md missing'); }
  if (readme) {
    for (const s of scenarios) {
      if (!readme.includes(`| ${s.id} |`)) errors.push(`${s.id}: missing from README.md scenario table`);
    }
    const readmeIds = [...readme.matchAll(/^\| (pj-[sbc]-[a-z-]+) \|/gm)].map(m => m[1]);
    for (const id of readmeIds) {
      if (!ids.has(id)) errors.push(`README table row ${id} has no manifest scenario`);
    }
    if (readmeIds.length !== scenarios.length) {
      errors.push(`README table has ${readmeIds.length} scenario rows, manifest has ${scenarios.length}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildDryRun(manifest, scenario) {
  const family = manifest.families[scenario.family];
  return {
    scenarioId: scenario.id,
    type: scenario.type,
    title: scenario.title,
    family: scenario.family,
    negativeControl: Boolean(scenario.negativeControl),
    trap: scenario.trap ?? null,
    fixture: {
      path: family.fixture,
      testCommand: family.testCommand
    },
    taskPrompt: scenario.taskPrompt,
    checks: scenario.checks,
    probes: scenario.probes,
    grader: scenario.grader,
    ship: scenario.ship ?? null,
    expects: scenario.expects,
    notExecuted: 'runner: dry-run only — no model, no server, no spend'
  };
}

export function parseArgs(argv) {
  const args = {
    mode: null, scenario: null, scenarios: [], dryRun: false, graderDir: null, authorizeSpend: false,
    adapter: 'mock', fixtureRoot: null, resultsRoot: null, shipRepo: null, shipRepos: null,
    shipIntake: 'request', repeat: 1, errors: []
  };
  let i = 0;
  function value(flag) {
    const next = argv[++i];
    if (!next) args.errors.push(`${flag} requires a value`);
    return next ?? null;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.mode = 'list';
    else if (a === '--manifest') args.mode = 'manifest';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--i-authorize-spend') args.authorizeSpend = true;
    else if (a === '--scenario') args.scenario = value('--scenario');
    else if (a === '--adapter') {
      const name = value('--adapter');
      if (name && !ADAPTERS.includes(name)) args.errors.push(`unknown adapter ${name} (known: ${ADAPTERS.join(', ')})`);
      else if (name) args.adapter = name;
    } else if (a === '--grader-dir') {
      const next = value('--grader-dir');
      if (next && !isAbsolute(next)) args.errors.push(`--grader-dir must be an absolute path, got ${next}`);
      else if (next) args.graderDir = next;
    } else if (a === '--fixture-root') args.fixtureRoot = value('--fixture-root');
    else if (a === '--results-root') args.resultsRoot = value('--results-root');
    else if (a === '--ship-repo') args.shipRepo = value('--ship-repo');
    else if (a === '--ship-repos') {
      const next = value('--ship-repos');
      if (next && !isAbsolute(next)) args.errors.push(`--ship-repos must be an absolute path, got ${next}`);
      else if (next) args.shipRepos = next;
    } else if (a === '--ship-intake') {
      const next = value('--ship-intake');
      if (next && !['request', 'scan'].includes(next)) args.errors.push(`unknown --ship-intake ${next} (known: request, scan)`);
      else if (next) args.shipIntake = next;
    } else if (a === '--repeat') {
      const next = Number(value('--repeat'));
      if (!Number.isInteger(next) || next < 1 || next > 10) args.errors.push('--repeat must be an integer from 1 to 10');
      else args.repeat = next;
    } else {
      args.errors.push(`unknown argument: ${a}`);
    }
  }
  if (args.scenario) args.scenarios = args.scenario.split(',').map(x => x.trim()).filter(Boolean);
  if (args.mode === null && args.scenario) args.mode = 'scenario';
  if (args.dryRun && args.scenarios.length > 1) args.errors.push('--dry-run takes a single scenario');
  if (args.mode === null && args.errors.length === 0) {
    args.errors.push('nothing to do: pass --list, --manifest, or --scenario <id> [--dry-run]');
  }
  return args;
}

// Real-run gating. Returns the decision the CLI must act on — the CLI adds
// no logic of its own. An authorized real run is EXECUTED (mock adapter by
// default; the ship adapter refuses separately unless its env contract is
// met — see createShipAdapter).
export function spendGateDecision(args) {
  if (args.mode !== 'scenario') return { action: 'pass-through', exitCode: null };
  if (args.dryRun) return { action: 'dry-run', exitCode: null };
  if (!args.authorizeSpend) {
    return {
      action: 'refuse',
      exitCode: EXIT.SPEND_REFUSED,
      message: 'runner: real runs spend money and are gated. Re-run with --i-authorize-spend after review.'
    };
  }
  return { action: 'execute', exitCode: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Execution path: fixture staging, agent adapters, grading, result records.
// No adapter in this file ever invokes a model by itself; the ship adapter
// only speaks HTTP to a Ship instance the caller pointed it at, and refuses
// unless the spend flag (enforced above) plus its env contract are met.
// ─────────────────────────────────────────────────────────────────────────

export class AdapterRefusal extends Error {
  constructor(message) {
    super(`ship adapter refuses: ${message}`);
    this.name = 'AdapterRefusal';
  }
}

export class ShipRunError extends Error {
  constructor(message, { transcriptPath = null } = {}) {
    super(message);
    this.name = 'ShipRunError';
    this.transcriptPath = transcriptPath;
  }
}

// Canned mock responses and other harness bookkeeping live inside the
// fixture trees but are NOT fixture content: the evaluated agent must never
// see them, and graders must not count them as fixture bytes.
const STAGE_EXCLUDE = new Set(['mock-responses', '.git', 'node_modules', '__pycache__', '.DS_Store']);

export function stageFixture(fixtureDir, workDir) {
  cpSync(fixtureDir, workDir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return !STAGE_EXCLUDE.has(name) || src === fixtureDir;
    }
  });
}

// ── mock adapter ─────────────────────────────────────────────────────────
// Loads a canned response from
//   evals/product-journeys/fixtures/<family-dir>/mock-responses/<id>.txt
// (relative to the real repo, never the staged workDir). Format:
//
//   <<<transcript>>>
//   ...plausible transcript text (the only section graders read)...
//   <<<summary>>>
//   {"prOpened": false, "claims": ["..."]}
//   <<<edit:relative/path.html>>>
//   full new file content (joined with newlines, one trailing newline)
//
// Sections are optional except transcript; edits are applied to workDir so
// structural graders see a genuinely worked tree. With no canned file the
// adapter writes an honest "MOCK: no response canned" transcript and changes
// nothing — graders must fail that, which is exactly what the mock-fail
// tests assert.

export function parseMockResponse(text) {
  const sections = { transcript: [] };
  let current = 'transcript';
  // A file's final newline is a terminator, not a content line.
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  for (const line of lines) {
    const marker = line.match(/^<<<([A-Za-z0-9_.\/:-]*)>>>$/);
    if (marker) {
      current = marker[1] === '' ? 'transcript' : marker[1];
      sections[current] = sections[current] ?? [];
      continue;
    }
    sections[current] = sections[current] ?? [];
    sections[current].push(line);
  }
  const flatten = (lines) => (lines.length === 0 ? '' : lines.join('\n') + '\n');
  const transcript = flatten(sections.transcript ?? []);
  let summary = {};
  if ((sections.summary ?? []).length > 0) {
    try {
      summary = JSON.parse(sections.summary.join('\n'));
    } catch (err) {
      throw new Error(`canned mock response has an unparseable <<<summary>>> block: ${err.message}`);
    }
  }
  const edits = {};
  for (const key of Object.keys(sections)) {
    if (!key.startsWith('edit:')) continue;
    const rel = key.slice('edit:'.length);
    if (rel === '' || isAbsolute(rel) || rel.split('/').includes('..')) {
      throw new Error(`canned mock response edit path escapes the work tree: ${JSON.stringify(rel)}`);
    }
    edits[rel] = flatten(sections[key]);
  }
  return { transcript, summary, edits };
}

export function createMockAdapter({ repoRoot } = {}) {
  if (!repoRoot) throw new Error('mock adapter requires repoRoot');
  return {
    name: 'mock',
    async runTask({ scenario, fixtureDir, workDir, transcriptDir }) {
      const familyDir = basename(fixtureDir);
      const cannedPath = join(repoRoot, 'evals', 'product-journeys', 'fixtures', familyDir, 'mock-responses', `${scenario.id}.txt`);
      let transcript, summary, edits = {};
      if (existsSync(cannedPath)) {
        const parsed = parseMockResponse(readFileSync(cannedPath, 'utf8'));
        transcript = parsed.transcript;
        summary = { canned: true, ...parsed.summary };
        edits = parsed.edits;
      } else {
        transcript = `MOCK: no response canned for ${scenario.id} — the mock adapter proves plumbing; a grader must fail this transcript.\n`;
        summary = { canned: false };
      }
      for (const [rel, content] of Object.entries(edits)) {
        writeFileSync(join(workDir, rel), content);
      }
      const dir = transcriptDir ?? mkdtempSync(join(tmpdir(), 'pj-mock-'));
      mkdirSync(dir, { recursive: true });
      const transcriptPath = join(dir, 'transcript.txt');
      writeFileSync(transcriptPath, transcript);
      return { transcriptPath, summary: { prOpened: false, pushed: false, ...summary } };
    }
  };
}

// ── ship adapter ─────────────────────────────────────────────────────────
// Lives in eval-journeys-ship.mjs (HTTP against a real Ship, forge access for
// the worked tree). It imports AdapterRefusal, ShipRunError and hashTree from
// here; nothing here imports it back.

// ── revisions, run ids, records ──────────────────────────────────────────

export function gitHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export function hashTree(dir) {
  const rels = [];
  (function walk(d, base = d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (STAGE_EXCLUDE.has(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, base);
      else if (entry.isFile()) rels.push(full.slice(base.length + 1));
    }
  })(dir);
  rels.sort();
  const hash = createHash('sha256');
  for (const rel of rels) {
    hash.update(rel);
    hash.update('\0');
    hash.update(createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex'));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function nextRunId(resultsRoot, now = new Date()) {
  const date = `${String(now.getFullYear()).padStart(4, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  let max = 0;
  if (existsSync(resultsRoot)) {
    for (const entry of readdirSync(resultsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(new RegExp(`^eval-${date}-(\\d+)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `eval-${date}-${max + 1}`;
}

// Minimal draft-07 subset validator (type/required/properties/enum/pattern/
// minimum/items) — enough to hold result records to results/schema.json
// without pulling in a dependency.
export function schemaValidationErrors(value, schema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type !== undefined) {
    const t = schema.type;
    const ok = t === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
      : t === 'array' ? Array.isArray(value)
      : t === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : t === 'number' ? typeof value === 'number'
      : t === 'boolean' ? typeof value === 'boolean'
      : t === 'string' ? typeof value === 'string'
      : t === 'null' ? value === null
      : true;
    if (!ok) errors.push(`${at}: expected ${t}, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${at}: ${value} is below minimum ${schema.minimum}`);
  }
  if (Array.isArray(schema.required) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${at}: missing required property ${key}`);
    }
  }
  if (schema.properties !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...schemaValidationErrors(value[key], sub, `${at}.${key}`));
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...schemaValidationErrors(value[i], schema.items, `${at}[${i}]`));
    }
  }
  return errors;
}

// ── the executor ─────────────────────────────────────────────────────────

export async function runScenario({ repoRoot, manifest, scenario, adapter, graderDir, fixtureRoot, resultsRoot, runId: fixedRunId = null }) {
  const family = manifest.families[scenario.family];
  const fixtureDir = join(fixtureRoot, basename(family.fixture));
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture directory missing for ${scenario.family}: ${fixtureDir}`);
  }
  const runId = fixedRunId ?? nextRunId(resultsRoot);
  const outDir = join(resultsRoot, runId, scenario.id);
  const preserveDir = join(outDir, 'preserve');
  const artifactsDir = join(outDir, 'artifacts');
  const workDir = mkdtempSync(join(tmpdir(), `pj-${scenario.id}-`));
  const transcriptDir = mkdtempSync(join(tmpdir(), 'pj-transcript-'));
  const startedAt = new Date().toISOString();

  stageFixture(fixtureDir, workDir);

  let transcriptPath = null;
  let summary = {};
  let endedBy = 'agent';
  let adapterError = null;
  const t0 = Date.now();
  try {
    const result = await adapter.runTask({ scenario, fixtureDir, workDir, transcriptDir, attemptId: `${runId}-${scenario.id}` });
    transcriptPath = result.transcriptPath;
    summary = result.summary ?? {};
  } catch (err) {
    if (err instanceof AdapterRefusal) {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(transcriptDir, { recursive: true, force: true });
      throw err;
    }
    adapterError = err;
    endedBy = 'harness-error';
    transcriptPath = err.transcriptPath ?? null;
  }
  const latencyMs = Date.now() - t0;

  let graded = { pass: false, reasons: [], evidence: [] };
  try {
    const graderPath = join(graderDir, scenario.grader.replace(/^graders\//, ''));
    const grader = await import(pathToFileURL(graderPath).href);
    if (typeof grader.grade !== 'function') throw new Error(`${scenario.grader} does not export grade()`);
    graded = await grader.grade({ workDir, fixture: fixtureDir, scenario, transcriptPath, summary });
  } catch (err) {
    endedBy = 'harness-error';
    graded = {
      pass: false,
      reasons: [`grader invocation failed: ${err.message}`],
      evidence: []
    };
  }
  if (adapterError !== null) {
    graded = {
      pass: false,
      reasons: [`adapter failed: ${adapterError.message}`, ...graded.reasons],
      evidence: graded.evidence
    };
  }
  // A correct-looking patch does not excuse an unauthorized merge or grading
  // a different revision from the one the run actually produced.
  if (summary.fixtureRepo?.mainMoved === true) {
    graded.pass = false;
    graded.reasons.push('fixture main moved during the run; evaluation never authorizes merges');
  }
  if (summary.captured?.expected && summary.captured.sha !== summary.captured.expected) {
    graded.pass = false;
    graded.reasons.push('captured PR revision does not match the run evidence');
  }

  mkdirSync(preserveDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  let transcriptText = null;
  if (transcriptPath !== null && existsSync(transcriptPath)) {
    transcriptText = readFileSync(transcriptPath, 'utf8');
  } else {
    transcriptText = adapterError !== null
      ? `HARNESS ERROR: adapter threw before producing a transcript: ${adapterError.message}\n`
      : `HARNESS ERROR: adapter returned no transcript path.\n`;
  }
  writeFileSync(join(preserveDir, 'transcript.txt'), transcriptText);
  const graderOutput = { scenarioId: scenario.id, grader: scenario.grader, ...graded };
  writeFileSync(join(artifactsDir, 'grader-output.json'), JSON.stringify(graderOutput, null, 2) + '\n');

  const claims = Array.isArray(summary.claims) ? summary.claims : [];
  const interventions = Array.isArray(summary.interventions) ? summary.interventions : [];
  const outcome = outcomeOf({ pass: graded.pass, reasons: graded.reasons, endedBy });
  // Rescue = information a person supplied to get the task done. The
  // baseline never supplies it (asks are declined), so `provided` is false by
  // construction; `needed` records that the run asked for it.
  const asked = interventions.filter(i => i.kind === 'clarification');
  const rescue = {
    needed: asked.length > 0,
    provided: interventions.some(i => i.kind === 'rescue'),
    notes: asked.map(i => i.note)
  };
  const record = {
    scenarioId: scenario.id,
    family: scenario.family,
    runId,
    harnessRevision: gitHead(repoRoot),
    fixtureRevision: hashTree(fixtureDir),
    adapter: adapter.name,
    outcome,
    firstAttempt: { pass: graded.pass, graderReasons: graded.reasons, endedBy },
    eventualSuccess: { pass: graded.pass && endedBy === 'agent' && !rescue.provided },
    interventions,
    rescue,
    latencyMs,
    cost: summary.cost?.status === 'priced' || summary.cost?.status === 'unknown'
      ? summary.cost
      : { status: 'unknown', reason: adapterError !== null ? `adapter failed before reporting cost: ${adapterError.message}` : 'the adapter reported no cost; cost is never guessed' },
    verifiedEvidence: (graded.evidence ?? []).map(e => ({ check: e.check ?? e.kind ?? 'check', value: e.value })),
    claimedEvidence: claims.map(c => ({ claim: String(c), verdict: 'unverified' })),
    artifacts: ['preserve/transcript.txt', 'artifacts/grader-output.json'],
    preserve: { dir: 'preserve/' },
    probesApplied: [],
    gradedAt: new Date().toISOString(),
    startedAt
  };
  for (const key of ['shipRuns', 'fixtureRepo', 'captured', 'samePr', 'disposition', 'pollRetries', 'journey', 'intake']) {
    if (summary[key] !== undefined) (record.ship ??= {})[key] = summary[key];
  }
  const schema = await readJson(join(repoRoot, 'evals', 'product-journeys', 'results', 'schema.json'));
  const schemaErrors = schemaValidationErrors(record, schema);
  if (schemaErrors.length > 0) {
    throw new Error(`result record does not match results/schema.json:\n  ${schemaErrors.join('\n  ')}`);
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(record, null, 2) + '\n');

  const summaryPath = join(resultsRoot, runId, 'summary.json');
  let rollup = { runId, adapter: adapter.name, startedAt, completedAt: record.gradedAt, scenarios: [], totals: {} };
  if (existsSync(summaryPath)) {
    try { rollup = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { /* keep fresh rollup */ }
  }
  rollup.scenarios = rollup.scenarios.filter(s => s.id !== scenario.id);
  rollup.scenarios.push({
    id: scenario.id, outcome, pass: record.firstAttempt.pass, latencyMs,
    costUSD: record.cost.status === 'priced' ? record.cost.amount : null,
    rescueNeeded: rescue.needed, interventions: interventions.length,
    result: `${runId}/${scenario.id}/result.json`
  });
  rollup.totals = Object.fromEntries(OUTCOMES.map(o => [o, rollup.scenarios.filter(s => (s.outcome ?? (s.pass ? 'pass' : 'fail')) === o).length]));
  rollup.completedAt = record.gradedAt;
  writeFileSync(summaryPath, JSON.stringify(rollup, null, 2) + '\n');

  rmSync(transcriptDir, { recursive: true, force: true });
  return { record, runId, outDir, workDir, graderOutput };
}
