#!/usr/bin/env node
// History measurement probe (docs/RETENTION.md). Opens the same store the CLI
// opens — file via TEPLOY_SHIP_STATE, or Nucleus via --nucleus-url/NUCLEUS_URL
// (connecting exactly as the CLI does, including its at-connect migration
// check) — and measures runs-list latency, per-run event stream latency, and
// total counts. It READS EVERY RUN'S EVENT LOG: run it against a restored copy
// or off-peak, never against a busy production store. Prints a dated table and
// writes a JSON record. No model calls, no writes beyond the optional
// migration no-op every CLI connect already performs.
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fileRuntime, nucleusRuntime } from '../dist/runtime.js';

const PAGE_REPEATS_DEFAULT = 5;
const ENUM_START = 1000;
const ENUM_CAP = 200_000;

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

/**
 * Measure one open runtime. Returns the report object (also what the test
 * exercises); the caller attaches store identity and prints/writes it.
 */
export async function measureHistory(runtime, options = {}) {
  const repeats = Math.max(1, options.repeats ?? PAGE_REPEATS_DEFAULT);

  // 1. The dashboard's runs-list read, repeated: the page every operator
  //    surface starts from.
  const pageSamples = [];
  let page = [];
  for (let i = 0; i < repeats; i++) {
    const r = await timed(() => runtime.listMeta());
    pageSamples.push(r.ms);
    page = r.value;
  }

  // 2. Full enumeration: listMeta has no cursor, so raise the limit until the
  //    page stops growing. On the file runtime listMeta() is already unbounded.
  let limit = ENUM_START;
  let all = page;
  let enumMs = null;
  for (;;) {
    const r = await timed(() => runtime.listMeta({ limit }));
    enumMs = r.ms;
    all = r.value;
    if (all.length < limit || limit >= ENUM_CAP) break;
    limit = Math.min(limit * 2, ENUM_CAP);
  }
  if (all.length >= ENUM_CAP) {
    process.stderr.write(`warning: enumeration hit the ${ENUM_CAP}-run cap; totals are a floor\n`);
  }

  // 3. Every run's event stream: latency per load, events per run, totals.
  const streamMs = [];
  const eventsPerRun = [];
  for (const meta of all) {
    const r = await timed(() => runtime.store.load(meta.runId));
    streamMs.push(r.ms);
    eventsPerRun.push(Array.isArray(r.value) ? r.value.length : 0);
  }
  const totalEvents = eventsPerRun.reduce((a, b) => a + b, 0);

  return {
    runsPage: {
      repeats,
      pageLimit: page.length === 0 ? null : Math.min(page.length, 200),
      returned: page.length,
      samplesMs: pageSamples.map(m => Math.round(m * 1000) / 1000),
      medianMs: Math.round(median(pageSamples) * 1000) / 1000,
    },
    enumeration: {
      totalRuns: all.length,
      limitRequested: limit,
      ms: enumMs === null ? null : Math.round(enumMs * 1000) / 1000,
      truncated: all.length >= ENUM_CAP,
    },
    streams: {
      runsRead: streamMs.length,
      totalEvents,
      loadMs: streamMs.length === 0 ? null : {
        p50: Math.round(quantile(streamMs, 0.5) * 1000) / 1000,
        p90: Math.round(quantile(streamMs, 0.9) * 1000) / 1000,
        max: Math.round(Math.max(...streamMs) * 1000) / 1000,
      },
      eventsPerRun: eventsPerRun.length === 0 ? null : {
        min: Math.min(...eventsPerRun),
        median: median(eventsPerRun),
        max: Math.max(...eventsPerRun),
      },
    },
  };
}

function usage() {
  return [
    'usage: node scripts/measure-history.mjs [--store file|nucleus] [--nucleus-url URL]',
    '                                     [--repeats N] [--out FILE] --confirm',
    '',
    '  --store        file (default) or nucleus — same resolution as the CLI',
    '  --nucleus-url  Nucleus URL (else NUCLEUS_URL env)',
    '  --repeats      runs-list samples (default 5)',
    '  --out          JSON output path (default ship-history-measurement-<date>.json)',
    '  --confirm      acknowledge the read-everything guidance below',
    '',
    'This probe reads EVERY run\'s event log against the store you point it at.',
    'Run it against a restored copy, or off-peak on the live store. It launches',
    'no runs and writes nothing except its own JSON report.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = name => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  if (!argv.includes('--confirm')) {
    console.error(usage());
    console.error('\nrefusing to run without --confirm');
    process.exit(1);
  }

  const storeKind = flag('store') ?? 'file';
  let runtime;
  let target;
  if (storeKind === 'file') {
    runtime = fileRuntime();
    target = process.env.TEPLOY_SHIP_STATE ?? '~/.local/state/teploy-ship (default)';
  } else if (storeKind === 'nucleus') {
    const url = flag('nucleus-url') ?? process.env.NUCLEUS_URL;
    if (!url) {
      console.error('--store nucleus needs --nucleus-url or NUCLEUS_URL');
      process.exit(1);
    }
    target = url;
    runtime = await nucleusRuntime(url, `measure-${hostname()}-${process.pid}`);
  } else {
    console.error(`unknown --store: ${storeKind} (expected file or nucleus)`);
    process.exit(1);
  }

  const repeats = Number(flag('repeats')) || PAGE_REPEATS_DEFAULT;
  const report = await measureHistory(runtime, { repeats });
  const full = {
    at: new Date().toISOString(),
    store: { kind: storeKind, target },
    ...report,
  };

  const out = flag('out') ?? `ship-history-measurement-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(out, JSON.stringify(full, null, 2) + '\n');

  const d = full;
  console.log(`Ship history measurement — ${d.at}`);
  console.log(`store: ${d.store.kind} (${d.store.target})`);
  console.log('');
  console.log('what                     value');
  console.log('------------------------ -------------------------------------------');
  console.log(`runs-list page           ${d.runsPage.medianMs} ms median over ${d.runsPage.repeats} reads (${d.runsPage.returned} returned)`);
  console.log(`full enumeration         ${d.enumeration.totalRuns} runs in ${d.enumeration.ms} ms (limit ${d.enumeration.limitRequested}${d.enumeration.truncated ? ', TRUNCATED' : ''})`);
  if (d.streams.loadMs) {
    console.log(`event stream per run     p50 ${d.streams.loadMs.p50} ms / p90 ${d.streams.loadMs.p90} ms / max ${d.streams.loadMs.max} ms`);
    console.log(`events per run           median ${d.streams.eventsPerRun.median} / max ${d.streams.eventsPerRun.max}`);
  }
  console.log(`total events             ${d.streams.totalEvents}`);
  console.log(`json record              ${out}`);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  await main();
}
