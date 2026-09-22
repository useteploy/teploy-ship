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
//   node scripts/eval-journeys.mjs --scenario <id> --i-authorize-spend \
//     [--adapter mock|ship] [--fixture-root <dir>] [--results-root <dir>] \
//     [--grader-dir /abs/path] [--ship-repo <url>]
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  repoRootFrom, loadManifest, validateManifest, buildDryRun,
  parseArgs, spendGateDecision, createMockAdapter, createShipAdapter,
  runScenario, AdapterRefusal, EXIT
} from './eval-journeys-lib.mjs';

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

const scenario = manifest.scenarios.find(s => s.id === args.scenario);
if (!scenario) {
  die(`runner: unknown scenario ${args.scenario}; use --list`, EXIT.USAGE);
}

const gate = spendGateDecision(args);
if (gate.action === 'refuse') {
  die(gate.message, gate.exitCode);
}

if (gate.action === 'dry-run') {
  const plan = buildDryRun(manifest, scenario);
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
  adapter = createShipAdapter({ repo: args.shipRepo });
} else {
  die(`runner: unknown adapter ${args.adapter}`, EXIT.USAGE);
}

let execution;
try {
  execution = await runScenario({ repoRoot, manifest, scenario, adapter, graderDir, fixtureRoot, resultsRoot });
} catch (err) {
  if (err instanceof AdapterRefusal) die(err.message, EXIT.ADAPTER_REFUSED);
  die(`runner: execution failed before recording: ${err.message}`, EXIT.USAGE);
}

const { record, outDir } = execution;
rmSync(execution.workDir, { recursive: true, force: true });
console.error(`runner: scenario ${record.scenarioId} adapter=${record.adapter} pass=${record.firstAttempt.pass} endedBy=${record.firstAttempt.endedBy} latencyMs=${record.latencyMs} cost=${record.cost.status}`);
console.error(`runner: record ${join(outDir, 'result.json')} — transcript preserved under ${join(outDir, 'preserve')}`);
console.log(JSON.stringify(record, null, 2));
process.exit(EXIT.OK);
