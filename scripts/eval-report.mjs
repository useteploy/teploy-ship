#!/usr/bin/env node
// Recount product-journey evaluation results from the retained records.
//
// Why this exists: a headline number ("21 passes, 13 failures, two
// human-gated harness errors over 36 attempts") is only worth quoting if
// something in the repo derives it. This script reads every
// results/**/result.json, assigns each an outcome class exactly as
// eval-journeys-lib.mjs does (the recorded `outcome`, else outcomeOf() on the
// first attempt), and prints raw counts per class. It never writes, moves or
// deletes a result: it is a reader.
//
// Rules the report enforces, because the plan depends on them:
//  - unknown / harness-error / authority-hold are not pass and not fail; they
//    are listed in EXCLUSIONS and kept out of the model-quality denominator
//    (pass + fail).
//  - supplementary files beside a record (regrade-*.json,
//    reclassification-*.json, other artifacts/*.json annotations) are listed
//    but never replace or alter the original record's class.
//  - cost is priced or unknown; unknown is never summed as zero, and a priced
//    amount of exactly 0 is flagged as suspect.
//
// Usage: node scripts/eval-report.mjs [--results DIR] [--format markdown|json|both]
//                                     [--date YYYY-MM-DD]

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTCOMES, outcomeOf } from './eval-journeys-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS = resolve(HERE, '..', 'evals', 'product-journeys', 'results');

// Latencies under a second are not an agent run; the retained set contains
// records of 0 ms and 1 ms. They are reported, not folded into statistics.
const SUSPECT_LATENCY_MS = 1000;

function readJsonSafe(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { error: error.message };
  }
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

// results/<run>/<scenario>/result.json. Walk by listing so a stray file or a
// scenario directory without a record is simply skipped, never an error.
function discover(root) {
  const found = [];
  if (!isDir(root)) return found;
  for (const run of readdirSync(root).sort()) {
    const runDir = join(root, run);
    if (!isDir(runDir)) continue;
    for (const scenario of readdirSync(runDir).sort()) {
      const dir = join(runDir, scenario);
      if (!isDir(dir)) continue;
      const resultPath = join(dir, 'result.json');
      if (existsSync(resultPath)) found.push({ run, scenario, dir, resultPath });
    }
  }
  return found;
}

function supplementaryFor(dir, root) {
  const out = [];
  const artifacts = join(dir, 'artifacts');
  if (!isDir(artifacts)) return out;
  for (const name of readdirSync(artifacts).sort()) {
    if (!name.endsWith('.json') || name === 'grader-output.json') continue;
    const kind = /^regrade-/.test(name) ? 'regrade'
      : /^reclassification-/.test(name) ? 'reclassification'
      : 'annotation';
    const parsed = readJsonSafe(join(artifacts, name));
    const body = parsed.value ?? {};
    out.push({
      path: relative(root, join(artifacts, name)).split(sep).join('/'),
      kind,
      unreadable: parsed.error ?? null,
      // What the supplement claims, reported as a claim: it never changes the
      // original record's class.
      claimedOutcome: body.reclassifiedOutcome ?? (kind === 'regrade' && typeof body.pass === 'boolean' ? (body.pass ? 'pass' : 'fail') : null),
      reason: typeof body.reason === 'string' ? body.reason : (typeof body.assessment === 'string' ? body.assessment : null)
    });
  }
  return out;
}

// The record's class and where it came from. A record that cannot be graded
// for lack of fields is `unknown` with the missing fields named: never pass,
// never fail.
function classify(record) {
  const problems = [];
  const fa = record.firstAttempt;
  if (fa === null || typeof fa !== 'object' || typeof fa.pass !== 'boolean') problems.push('firstAttempt.pass');
  if (record.outcome !== undefined) {
    if (!OUTCOMES.includes(record.outcome)) {
      return { outcome: 'unknown', source: 'invalid-recorded', problems: [...problems, `outcome=${JSON.stringify(record.outcome)}`] };
    }
    return { outcome: record.outcome, source: 'recorded', problems };
  }
  if (problems.length > 0) return { outcome: 'unknown', source: 'underivable', problems };
  const derived = outcomeOf({ pass: fa.pass, reasons: fa.graderReasons, endedBy: fa.endedBy });
  return { outcome: derived, source: 'derived', problems };
}

function stats(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: sorted.length,
    min: sorted[0],
    median,
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    max: sorted[sorted.length - 1]
  };
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

const EXCLUSION_WHY = {
  unknown: 'unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.',
  'harness-error': 'harness-error: the harness, not the agent, ended the attempt. Not a model-quality datum.',
  'authority-hold': 'authority-hold: the run parked on a decision the evaluation may not take; left pending on purpose. Counted separately.'
};

export function buildReport(resultsRoot = DEFAULT_RESULTS) {
  const root = resolve(resultsRoot);
  const found = discover(root);
  const records = [];
  const unreadable = [];

  for (const f of found) {
    const rel = relative(root, f.resultPath).split(sep).join('/');
    const parsed = readJsonSafe(f.resultPath);
    const supplements = supplementaryFor(f.dir, root);
    if (parsed.error) {
      unreadable.push({ path: rel, run: f.run, scenario: f.scenario, error: parsed.error, supplements });
      continue;
    }
    const r = parsed.value;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      unreadable.push({ path: rel, run: f.run, scenario: f.scenario, error: 'result.json is not an object', supplements });
      continue;
    }
    const c = classify(r);
    const interventions = Array.isArray(r.interventions) ? r.interventions : null;
    records.push({
      path: rel,
      runId: typeof r.runId === 'string' ? r.runId : f.run,
      runDir: f.run,
      scenarioId: typeof r.scenarioId === 'string' ? r.scenarioId : f.scenario,
      outcome: c.outcome,
      outcomeSource: c.source,
      missingFields: c.problems,
      recordedOutcome: r.outcome ?? null,
      firstAttemptPass: typeof r.firstAttempt?.pass === 'boolean' ? r.firstAttempt.pass : null,
      eventualSuccessPass: typeof r.eventualSuccess?.pass === 'boolean' ? r.eventualSuccess.pass : null,
      endedBy: r.firstAttempt?.endedBy ?? null,
      graderReasons: Array.isArray(r.firstAttempt?.graderReasons) ? r.firstAttempt.graderReasons : [],
      interventions: interventions === null ? null : interventions.map(i => i?.kind ?? 'unspecified'),
      rescue: r.rescue && typeof r.rescue === 'object' ? { needed: r.rescue.needed === true, provided: r.rescue.provided === true } : null,
      latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      cost: r.cost && (r.cost.status === 'priced' || r.cost.status === 'unknown')
        ? { status: r.cost.status, amount: Number.isFinite(r.cost.amount) ? r.cost.amount : null, currency: r.cost.currency ?? null }
        : null,
      hold: r.hold ?? null,
      supplements
    });
  }

  const counts = Object.fromEntries(OUTCOMES.map(o => [o, records.filter(r => r.outcome === o).length]));
  const graded = records.filter(r => r.outcome === 'pass' || r.outcome === 'fail');

  // Consistency: a recorded outcome that disagrees with the derivation from
  // the same record's first attempt is reported, never silently preferred.
  const derivedOf = r => outcomeOf({ pass: r.firstAttemptPass, reasons: r.graderReasons, endedBy: r.endedBy ?? undefined });
  const disagreements = records
    .filter(r => r.recordedOutcome !== null && r.firstAttemptPass !== null && derivedOf(r) !== r.recordedOutcome)
    .map(r => ({ path: r.path, recorded: r.recordedOutcome, derivedFromFirstAttempt: derivedOf(r) }));

  // Compare against the per-run summary.json totals where present.
  const summaryMismatches = [];
  for (const run of [...new Set(found.map(f => f.run))]) {
    const sp = join(root, run, 'summary.json');
    if (!existsSync(sp)) continue;
    const s = readJsonSafe(sp);
    if (s.error || !s.value?.totals) continue;
    const mine = records.filter(r => r.runDir === run);
    for (const o of OUTCOMES) {
      const theirs = s.value.totals[o];
      if (theirs === undefined) continue;
      const ours = mine.filter(r => r.outcome === o).length;
      if (theirs !== ours) summaryMismatches.push({ run, outcome: o, summaryTotals: theirs, recount: ours });
    }
  }

  const firstAttempt = {
    gradedRecords: graded.length,
    passed: graded.filter(r => r.firstAttemptPass === true).length,
    failed: graded.filter(r => r.firstAttemptPass === false).length,
    notRecorded: graded.filter(r => r.firstAttemptPass === null).length
  };
  const eventual = {
    gradedRecords: graded.length,
    passed: graded.filter(r => r.eventualSuccessPass === true).length,
    failed: graded.filter(r => r.eventualSuccessPass === false).length,
    notRecorded: graded.filter(r => r.eventualSuccessPass === null).length,
    note: 'eventualSuccess is success without rescue; a grader pass with a rescue intervention is not counted.'
  };

  const kinds = {};
  let withIv = 0; let ivNotRecorded = 0; let ivTotal = 0;
  for (const r of records) {
    if (r.interventions === null) { ivNotRecorded++; continue; }
    if (r.interventions.length > 0) withIv++;
    for (const k of r.interventions) { kinds[k] = (kinds[k] ?? 0) + 1; ivTotal++; }
  }
  const interventions = {
    total: ivTotal,
    byKind: kinds,
    recordsWithAny: withIv,
    recordsNotRecorded: ivNotRecorded,
    rescue: {
      needed: records.filter(r => r.rescue?.needed).length,
      provided: records.filter(r => r.rescue?.provided).length,
      notRecorded: records.filter(r => r.rescue === null).length
    }
  };

  const priced = records.filter(r => r.cost?.status === 'priced' && r.cost.amount !== null);
  const pricedNoAmount = records.filter(r => r.cost?.status === 'priced' && r.cost.amount === null);
  const unknownCost = records.filter(r => r.cost?.status === 'unknown');
  const missingCost = records.filter(r => r.cost === null);
  const currencies = [...new Set(priced.map(r => r.cost.currency ?? 'unspecified'))];
  const zeroPriced = priced.filter(r => r.cost.amount === 0);
  const cost = {
    pricedRecords: priced.length,
    unknownRecords: unknownCost.length,
    pricedWithoutAmount: pricedNoAmount.length,
    missingRecords: missingCost.length,
    currencies,
    // A floor, not a total: unknown records are not zero.
    pricedSum: round6(priced.reduce((a, r) => a + r.cost.amount, 0)),
    pricedSumIsLowerBound: unknownCost.length + pricedNoAmount.length + missingCost.length > 0,
    suspectZeroPriced: zeroPriced.map(r => r.path)
  };

  const lat = records.filter(r => r.latencyMs !== null);
  const suspectLat = lat.filter(r => r.latencyMs < SUSPECT_LATENCY_MS);
  const ok = lat.filter(r => r.latencyMs >= SUSPECT_LATENCY_MS);
  const latency = {
    thresholdMs: SUSPECT_LATENCY_MS,
    all: stats(ok.map(r => r.latencyMs)),
    gradedOnly: stats(ok.filter(r => r.outcome === 'pass' || r.outcome === 'fail').map(r => r.latencyMs)),
    suspect: suspectLat.map(r => ({ path: r.path, latencyMs: r.latencyMs })),
    notRecorded: records.length - lat.length
  };

  const exclusions = [];
  for (const r of records) {
    if (r.outcome === 'pass' || r.outcome === 'fail') continue;
    exclusions.push({
      path: r.path,
      kind: r.outcome,
      reason: EXCLUSION_WHY[r.outcome],
      detail: r.missingFields.length > 0 ? `missing/invalid fields: ${r.missingFields.join(', ')}` : (r.graderReasons[0] ?? null),
      outcomeSource: r.outcomeSource
    });
  }
  for (const u of unreadable) {
    exclusions.push({ path: u.path, kind: 'unreadable', reason: 'unreadable: result.json could not be parsed; it has no class and is in no count.', detail: u.error, outcomeSource: null });
  }
  for (const r of [...records, ...unreadable.map(u => ({ path: u.path, supplements: u.supplements }))]) {
    for (const s of r.supplements) {
      exclusions.push({
        path: s.path,
        kind: s.kind,
        reason: s.kind === 'annotation'
          ? 'supplementary annotation: listed for context; never a record, never counted.'
          : `supplementary ${s.kind}: listed, never replaces the original record. The original's class stands in all counts.`,
        detail: [`original: ${r.path}`, s.claimedOutcome ? `supplement claims: ${s.claimedOutcome}` : null, s.reason].filter(Boolean).join(' | '),
        outcomeSource: null
      });
    }
  }

  // What supplements say the class would be. Reported next to the counts so a
  // reader can see the sensitivity, but applied to nothing.
  const supplementClaims = [];
  for (const r of records) {
    for (const sp of r.supplements) {
      if (sp.claimedOutcome && sp.claimedOutcome !== r.outcome) {
        supplementClaims.push({ original: r.path, originalOutcome: r.outcome, supplement: sp.path, kind: sp.kind, claimedOutcome: sp.claimedOutcome, applied: false });
      }
    }
  }

  // Group by run and by scenario.
  const byRun = {};
  const byScenario = {};
  for (const r of records) {
    (byRun[r.runId] ??= []).push(r);
    (byScenario[r.scenarioId] ??= []).push(r);
  }
  const tally = list => Object.fromEntries(OUTCOMES.map(o => [o, list.filter(r => r.outcome === o).length]));
  const runs = Object.keys(byRun).sort().map(id => ({
    runId: id,
    records: byRun[id].map(r => ({ scenarioId: r.scenarioId, outcome: r.outcome })),
    counts: tally(byRun[id])
  }));
  const scenarios = Object.keys(byScenario).sort().map(id => {
    const list = byScenario[id];
    const c = tally(list);
    return { scenarioId: id, attempts: list.length, counts: c, graded: c.pass + c.fail };
  });

  return {
    resultsRoot: relative(process.cwd(), root).split(sep).join('/') || '.',
    recordsFound: found.length,
    recordsCounted: records.length,
    unreadable: unreadable.length,
    runs: runs.length,
    counts,
    modelQuality: {
      denominator: graded.length,
      pass: counts.pass,
      fail: counts.fail,
      passRate: graded.length > 0 ? round6(counts.pass / graded.length) : null,
      note: 'denominator is pass + fail only; unknown, harness-error and authority-hold are excluded (see exclusions).'
    },
    authorityHold: {
      count: counts['authority-hold'],
      records: records.filter(r => r.outcome === 'authority-hold').map(r => ({ path: r.path, hold: r.hold }))
    },
    outcomeSources: {
      recorded: records.filter(r => r.outcomeSource === 'recorded').length,
      derived: records.filter(r => r.outcomeSource === 'derived').length,
      other: records.filter(r => !['recorded', 'derived'].includes(r.outcomeSource)).length
    },
    firstAttempt,
    eventualSuccess: eventual,
    interventions,
    cost,
    latency,
    consistency: { recordedVsDerivedDisagreements: disagreements, summaryTotalsMismatches: summaryMismatches },
    exclusions,
    supplementClaims,
    runsDetail: runs,
    scenariosDetail: scenarios,
    records: records.map(r => ({
      path: r.path, runId: r.runId, scenarioId: r.scenarioId, outcome: r.outcome, outcomeSource: r.outcomeSource,
      firstAttemptPass: r.firstAttemptPass, eventualSuccessPass: r.eventualSuccessPass, endedBy: r.endedBy,
      latencyMs: r.latencyMs, cost: r.cost
    }))
  };
}

function table(headers, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(report, { date = null } = {}) {
  const c = report.counts;
  const out = [];
  out.push(`# Product-journey evaluation recount${date ? ` (${date})` : ''}`);
  out.push('');
  out.push(`Source: \`${report.resultsRoot}\`. Records found: ${report.recordsFound}; counted: ${report.recordsCounted}; unreadable: ${report.unreadable}; runs: ${report.runs}.`);
  out.push(`Outcome class source: recorded ${report.outcomeSources.recorded}, derived ${report.outcomeSources.derived} (older records lack \`outcome\`; derived with outcomeOf from eval-journeys-lib.mjs), other ${report.outcomeSources.other}.`);
  out.push('');
  out.push('## Raw counts per outcome class');
  out.push('');
  out.push(table(['class', 'records'], [...Object.entries(c).map(([k, v]) => [k, v]), ['total counted', report.recordsCounted]]));
  out.push('');
  out.push('## Model-quality view');
  out.push('');
  const mq = report.modelQuality;
  out.push(`Denominator (pass + fail): **${mq.denominator}**. Pass: ${mq.pass}. Fail: ${mq.fail}. Pass rate: ${mq.passRate === null ? 'n/a' : `${(mq.passRate * 100).toFixed(1)}%`}.`);
  out.push(mq.note);
  out.push('');
  out.push(`First-attempt success (graded records): ${report.firstAttempt.passed} pass, ${report.firstAttempt.failed} not-pass, ${report.firstAttempt.notRecorded} not recorded, of ${report.firstAttempt.gradedRecords}.`);
  out.push(`Eventual success (no rescue): ${report.eventualSuccess.passed} pass, ${report.eventualSuccess.failed} not-pass, ${report.eventualSuccess.notRecorded} not recorded, of ${report.eventualSuccess.gradedRecords}.`);
  out.push('');
  out.push('## Authority holds (reported separately)');
  out.push('');
  out.push(`Count: ${report.authorityHold.count}. Not a pass, not a failure, not a harness malfunction; excluded from the denominator.`);
  for (const h of report.authorityHold.records) out.push(`- \`${h.path}\` hold: ${cell(JSON.stringify(h.hold))}`);
  out.push('');
  out.push('## Interventions and rescue');
  out.push('');
  const iv = report.interventions;
  out.push(`Interventions: ${iv.total} total over ${iv.recordsWithAny} record(s); not recorded on ${iv.recordsNotRecorded}. By kind: ${Object.keys(iv.byKind).length ? Object.entries(iv.byKind).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}.`);
  out.push(`Rescue: needed ${iv.rescue.needed}, provided ${iv.rescue.provided}, field absent on ${iv.rescue.notRecorded} record(s).`);
  out.push('');
  out.push('## Cost');
  out.push('');
  const co = report.cost;
  out.push(`Priced: ${co.pricedRecords}. Unknown: ${co.unknownRecords}. Priced without an amount: ${co.pricedWithoutAmount}. No cost field: ${co.missingRecords}. Currencies: ${co.currencies.join(', ') || 'none'}.`);
  out.push(`Sum over priced records only: ${co.pricedSum}${co.pricedSumIsLowerBound ? ' (a lower bound: unknown-cost records are NOT zero and are not in this sum)' : ''}.`);
  out.push(co.suspectZeroPriced.length
    ? `Suspect: ${co.suspectZeroPriced.length} priced record(s) carry an amount of exactly 0, which more likely means usage was not yet readable than that the run was free:\n${co.suspectZeroPriced.map(p => `- \`${p}\``).join('\n')}`
    : 'No priced record carries an amount of exactly 0.');
  out.push('');
  out.push('## Latency');
  out.push('');
  const la = report.latency;
  const fmt = s => s.n === 0 ? 'no data' : `n=${s.n}, min ${s.min} ms, median ${s.median} ms, mean ${s.mean} ms, max ${s.max} ms`;
  out.push(`All records at or above ${la.thresholdMs} ms: ${fmt(la.all)}.`);
  out.push(`Graded (pass/fail) only: ${fmt(la.gradedOnly)}.`);
  out.push(la.suspect.length ? `Excluded as implausible (< ${la.thresholdMs} ms): ${la.suspect.map(s => `\`${s.path}\` (${s.latencyMs} ms)`).join(', ')}.` : 'No implausible latencies.');
  if (la.notRecorded) out.push(`Latency absent on ${la.notRecorded} record(s).`);
  out.push('');
  out.push('## By run');
  out.push('');
  out.push(table(['run', ...OUTCOMES, 'scenarios'], report.runsDetail.map(r => [r.runId, ...OUTCOMES.map(o => r.counts[o]), r.records.map(x => `${x.scenarioId}:${x.outcome}`).join(', ')])));
  out.push('');
  out.push('## By scenario');
  out.push('');
  out.push(table(['scenario', 'attempts', ...OUTCOMES, 'graded (pass+fail)'], report.scenariosDetail.map(s => [s.scenarioId, s.attempts, ...OUTCOMES.map(o => s.counts[o]), s.graded])));
  out.push('');
  out.push('## Consistency checks');
  out.push('');
  const cs = report.consistency;
  out.push(cs.recordedVsDerivedDisagreements.length
    ? `Recorded outcome differs from the derivation on the same record's first attempt (recorded value is used):\n${cs.recordedVsDerivedDisagreements.map(d => `- \`${d.path}\`: recorded ${d.recorded}, derived ${d.derivedFromFirstAttempt}`).join('\n')}`
    : 'Every recorded outcome agrees with the derivation from its first attempt.');
  out.push('');
  out.push(cs.summaryTotalsMismatches.length
    ? `summary.json totals that differ from this recount:\n${cs.summaryTotalsMismatches.map(m => `- ${m.run} ${m.outcome}: summary ${m.summaryTotals}, recount ${m.recount}`).join('\n')}`
    : 'Every per-run summary.json total agrees with this recount.');
  out.push('');
  out.push('## EXCLUSIONS');
  out.push('');
  out.push(`Not counted in the model-quality denominator (pass + fail), or not a record at all. ${report.exclusions.length} item(s).`);
  out.push('');
  out.push(report.exclusions.length
    ? table(['item', 'kind', 'why', 'detail'], report.exclusions.map(e => [`\`${e.path}\``, e.kind, cell(e.reason), cell(e.detail)]))
    : 'None.');
  out.push('');
  out.push('## Supplement claims (listed, not applied)');
  out.push('');
  out.push(report.supplementClaims.length
    ? table(['original', 'counted as', 'supplement', 'supplement claims'], report.supplementClaims.map(x => [`\`${x.original}\``, x.originalOutcome, `\`${x.supplement}\``, x.claimedOutcome]))
    : 'No supplement claims a different class than its original record.');
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { results: DEFAULT_RESULTS, format: 'both', date: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') opts.results = argv[++i];
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['markdown', 'json', 'both'].includes(opts.format)) throw new Error(`--format must be markdown, json or both`);
  if (!opts.results) throw new Error('--results needs a directory');
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const report = buildReport(opts.results);
  if (opts.format !== 'json') process.stdout.write(renderMarkdown(report, { date: opts.date }) + '\n');
  if (opts.format === 'both') process.stdout.write('\n## Report (JSON)\n\n```json\n');
  if (opts.format !== 'markdown') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (opts.format === 'both') process.stdout.write('```\n');
}
