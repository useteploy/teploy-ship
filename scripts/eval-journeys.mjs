#!/usr/bin/env node
// S02 product-journey harness runner. Everything around execution; no
// execution. Proves wiring with --list / --manifest / --scenario --dry-run,
// and refuses real runs at a spend gate (exit 2), and even when authorized
// refuses to invoke a model in this slice (exit 3) — the orchestrator wires
// execution after review.
//
// Usage:
//   node scripts/eval-journeys.mjs --list
//   node scripts/eval-journeys.mjs --manifest [--grader-dir /abs/path]
//   node scripts/eval-journeys.mjs --scenario <id> --dry-run
//   node scripts/eval-journeys.mjs --scenario <id> [--i-authorize-spend]  # gated / not wired
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repoRootFrom, loadManifest, validateManifest, buildDryRun,
  parseArgs, spendGateDecision, EXIT
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
  console.log(`runner: ${manifest.scenarios.length} scenarios, 0 executed (execution not wired in this slice)`);
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
if (gate.action === 'refuse' || gate.action === 'not-wired') {
  die(gate.message, gate.exitCode);
}

const plan = buildDryRun(manifest, scenario);
console.log(JSON.stringify(plan, null, 2));
console.error('runner: dry-run only — proved the wiring, ran nothing.');
process.exit(EXIT.OK);
