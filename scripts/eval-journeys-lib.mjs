// Product-journey harness library: manifest validation, dry-run planning,
// argument and spend-gate logic. Pure-ish (fs access only through paths it
// is given or resolves from repoRoot) so scripts/eval-journeys-lib.test.mjs
// can exercise everything without a model, a server or the network.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

export const EXIT = { OK: 0, USAGE: 1, SPEND_REFUSED: 2, NOT_WIRED: 3 };

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
    expects: scenario.expects,
    notExecuted: 'runner: dry-run only — no model, no server, no spend'
  };
}

export function parseArgs(argv) {
  const args = { mode: null, scenario: null, dryRun: false, graderDir: null, authorizeSpend: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.mode = 'list';
    else if (a === '--manifest') args.mode = 'manifest';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--i-authorize-spend') args.authorizeSpend = true;
    else if (a === '--scenario') {
      const next = argv[++i];
      if (!next) args.errors.push('--scenario requires a value');
      else args.scenario = next;
    } else if (a === '--grader-dir') {
      const next = argv[++i];
      if (!next) args.errors.push('--grader-dir requires a value');
      else if (!isAbsolute(next)) args.errors.push(`--grader-dir must be an absolute path, got ${next}`);
      else args.graderDir = next;
    } else {
      args.errors.push(`unknown argument: ${a}`);
    }
  }
  if (args.mode === null && args.scenario) args.mode = 'scenario';
  if (args.mode === null && args.errors.length === 0) {
    args.errors.push('nothing to do: pass --list, --manifest, or --scenario <id> [--dry-run]');
  }
  return args;
}

// Real-run gating. Returns the decision the CLI must act on — the CLI adds
// no logic of its own.
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
  return {
    action: 'not-wired',
    exitCode: EXIT.NOT_WIRED,
    message: 'runner: execution intentionally not wired in this slice'
  };
}
