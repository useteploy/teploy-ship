#!/usr/bin/env node
// S02 product-journey harness runner. List/manifest/dry-run prove wiring;
// real execution is complete in code but gated: it refuses without
// --i-authorize-spend (exit 2), and the ship adapter separately refuses
// without its env contract (exit 3). The mock adapter (default) runs the
// whole path — staging, execution, grading, result records — without ever
// invoking a model.
//
// Usage:
//   node scripts/eval-journeys.mjs --list
//   node scripts/eval-journeys.mjs --manifest [--grader-dir /abs/path]
//   node scripts/eval-journeys.mjs --scenario <id> --dry-run
//   node scripts/eval-journeys.mjs --scenario <id>[,<id>...|all] --i-authorize-spend \
//     [--adapter mock|ship] [--repeat N] [--fixture-root <dir>] [--results-root <dir>] \
//     [--grader-dir /abs/path] [--ship-repos /abs/repos.json] [--ship-repo <url>] \
//     [--ship-intake request|scan]
//
// Several scenarios (or `all`) run sequentially into ONE eval run id per
// repeat; `--repeat N` makes N such run ids. A scenario that could not be
// executed is reported as not-run in the batch summary, distinct from a
// recorded failure.
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  repoRootFrom, loadManifest, validateManifest, buildDryRun,
  parseArgs, spendGateDecision, createMockAdapter,
  runScenario, nextRunId, AdapterRefusal, EXIT
} from './eval-journeys-lib.mjs';
import { createShipAdapter } from './eval-journeys-ship.mjs';

const repoRoot = repoRootFrom(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

function die(message, code = EXIT.USAGE) {
  console.error(message.startsWith('runner:') ? message : `runner: ${message}`);
  process.exit(code);
}

if (args.errors.length > 0) {
  die('runner: ' + args.errors.join('; '), EXIT.USAGE);
}

const graderDir = args.graderDir ?? join(repoRoot, 'evals', 'product-journeys', 'graders');
if (args.graderDir) {
  console.error(`runner: using out-of-tree grader dir ${args.graderDir}`);
} else if (args.mode === 'scenario' && !args.dryRun) {
  console.error('runner: WARNING: in-tree graders are agent-readable; real baselines copy graders/ out of tree (see evals/product-journeys/graders/README.md)');
}

let manifest;
try {
  manifest = await loadManifest(repoRoot);
} catch (err) {
  die(`runner: cannot load manifest: ${err.message}`, EXIT.USAGE);
}

if (args.mode === 'list') {
  for (const s of manifest.scenarios) {
    const flag = s.negativeControl ? ' [negative control]' : '';
    const probes = s.probes.length > 0 ? `  probes: ${s.probes.join(', ')}` : '';
    console.log(`${s.id}  (${s.family}, ${s.type})${flag}${probes}`);
  }
  console.log(`runner: ${manifest.scenarios.length} scenarios, 0 executed (list mode runs nothing)`);
  process.exit(EXIT.OK);
}

if (args.mode === 'manifest') {
  const { ok, errors } = await validateManifest(manifest, { repoRoot, graderDir });
  if (ok) {
    console.log(`runner: manifest valid — ${manifest.scenarios.length} scenarios, fixtures, graders, README table and results schema consistent`);
    process.exit(EXIT.OK);
  }
  die('runner: manifest invalid:\n  ' + errors.join('\n  '), EXIT.USAGE);
}

const wanted = args.scenarios.length === 1 && args.scenarios[0] === 'all' ? manifest.scenarios.map(s => s.id) : args.scenarios;
const scenarios = [];
for (const id of wanted) {
  const found = manifest.scenarios.find(s => s.id === id);
  if (!found) die(`runner: unknown scenario ${id}; use --list`, EXIT.USAGE);
  scenarios.push(found);
}

const gate = spendGateDecision(args);
if (gate.action === 'refuse') {
  die(gate.message, gate.exitCode);
}

if (gate.action === 'dry-run') {
  const plan = buildDryRun(manifest, scenarios[0]);
  console.log(JSON.stringify(plan, null, 2));
  console.error('runner: dry-run only — proved the wiring, ran nothing.');
  process.exit(EXIT.OK);
}

// gate.action === 'execute': the real path, adapter by adapter.
const fixtureRoot = resolve(args.fixtureRoot ?? join(repoRoot, 'evals', 'product-journeys', 'fixtures'));
const resultsRoot = resolve(args.resultsRoot ?? join(repoRoot, 'evals', 'product-journeys', 'results'));

let adapter;
if (args.adapter === 'mock') {
  adapter = createMockAdapter({ repoRoot });
} else if (args.adapter === 'ship') {
  // A real agent run must never be graded by graders it could have read.
  if (!args.graderDir) die('runner: the ship adapter requires --grader-dir /abs/path (graders copied out of the checkout)', EXIT.USAGE);
  let repos = null;
  if (args.shipRepos) {
    try { repos = JSON.parse(readFileSync(args.shipRepos, 'utf8')); } catch (err) { die(`runner: cannot read --ship-repos: ${err.message}`, EXIT.USAGE); }
  }
  adapter = createShipAdapter({ repo: args.shipRepo, repos, intake: args.shipIntake });
} else {
  die(`runner: unknown adapter ${args.adapter}`, EXIT.USAGE);
}

const batch = [];
for (let r = 0; r < args.repeat; r++) {
  const runId = nextRunId(resultsRoot);
  const notRun = [];
  for (const scenario of scenarios) {
    let execution;
    try {
      execution = await runScenario({ repoRoot, manifest, scenario, adapter, graderDir, fixtureRoot, resultsRoot, runId });
    } catch (err) {
      const why = err instanceof AdapterRefusal ? err.message : `execution failed before recording: ${err.message}`;
      console.error(`runner: ${scenario.id} NOT RUN — ${why}`);
      notRun.push({ id: scenario.id, reason: why });
      if (scenarios.length === 1) die(why, err instanceof AdapterRefusal ? EXIT.ADAPTER_REFUSED : EXIT.USAGE);
      continue;
    }
    const { record, outDir } = execution;
    rmSync(execution.workDir, { recursive: true, force: true });
    const cost = record.cost.status === 'priced' ? `$${record.cost.amount}` : 'unknown';
    console.error(`runner: ${runId} ${record.scenarioId} adapter=${record.adapter} outcome=${record.outcome} endedBy=${record.firstAttempt.endedBy} latencyMs=${record.latencyMs} cost=${cost} rescueNeeded=${record.rescue.needed}`);
    console.error(`runner: record ${join(outDir, 'result.json')} — transcript preserved under ${join(outDir, 'preserve')}`);
    if (scenarios.length === 1 && args.repeat === 1) console.log(JSON.stringify(record, null, 2));
  }
  if (notRun.length > 0) {
    const summaryPath = join(resultsRoot, runId, 'summary.json');
    const rollup = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : { runId, adapter: adapter.name, scenarios: [], totals: {} };
    rollup.notRun = notRun;
    mkdirSync(join(resultsRoot, runId), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(rollup, null, 2) + '\n');
  }
  batch.push({ runId, notRun });
}
if (scenarios.length > 1 || args.repeat > 1) {
  console.log(JSON.stringify({ batch, scenarios: scenarios.map(s => s.id) }, null, 2));
}
process.exit(EXIT.OK);
