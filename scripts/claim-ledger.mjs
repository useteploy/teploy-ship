#!/usr/bin/env node
// Claim-to-evidence ledger: mechanical consistency check and generated view.
//
// Why this exists: S20 requires that a release claim match the configuration
// and scope that was actually tested, that failures and limitations stay
// visible, and that nothing is called verified without exact-revision
// evidence. Prose does not enforce that; this script does, for the rules a
// machine can decide. docs/claims/ledger.json is the source of truth;
// docs/CLAIM_LEDGER.md is generated from it and `--check` fails when the two
// drift. It is a reader: it never edits the ledger.
//
// What it cannot decide: whether a cited test actually exercises the claim,
// or whether a limitation is complete. It checks that the path exists, that
// the named test is present in the file, and that the claim's status is not
// stronger than its evidence classes allow. A human still reads the entry.
//
// Evidence classes: implementation (the code or doc exists), automated (a
// test or probe in this repo), system (observed in a real system), human (a
// recorded observation), comparative (matched measurement against an
// alternative). Only automated and system evidence can make a claim
// `supported`; implementation alone never does.
//
// Usage: node scripts/claim-ledger.mjs --check [--stale [--strict]]
//        node scripts/claim-ledger.mjs --render
//   Options for fixtures: --ledger FILE --doc FILE --root DIR

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export const CLASSES = ['implementation', 'automated', 'system', 'human', 'comparative'];
export const STATUSES = ['supported', 'provisional', 'disclaimed', 'open'];
const EXACT_REV = /^[0-9a-f]{40}$/;
// Wording that asserts superiority; such a claim must carry comparative evidence.
const SUPERIORITY = /\b(better than|superior|outperforms?|beats|faster than|cheaper than|most capable|best[- ]in[- ]class)\b/i;

export function loadLedger(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Returns a list of {id, rule, message}. Empty list means consistent.
export function checkLedger(ledger, { root = REPO } = {}) {
  const errors = [];
  const err = (id, rule, message) => errors.push({ id, rule, message });
  if (!ledger || !Array.isArray(ledger.claims)) {
    err('(ledger)', 'shape', 'ledger.claims must be an array');
    return errors;
  }
  const seen = new Set();
  for (const c of ledger.claims) {
    const id = typeof c?.id === 'string' && c.id ? c.id : '(missing id)';
    if (id === '(missing id)') err(id, 'shape', 'claim has no id');
    else if (seen.has(id)) err(id, 'duplicate-id', `id "${id}" appears more than once`);
    seen.add(id);
    for (const f of ['claim', 'scope']) {
      if (typeof c?.[f] !== 'string' || !c[f].trim()) err(id, 'shape', `missing ${f}`);
    }
    if (!STATUSES.includes(c?.status)) err(id, 'shape', `status must be one of ${STATUSES.join(', ')}`);
    if (!Array.isArray(c?.evidence)) { err(id, 'shape', 'evidence must be an array'); continue; }
    if (!Array.isArray(c.limitations)) err(id, 'shape', 'limitations must be an array (empty is allowed only for supported claims)');
    if ((c.status === 'disclaimed' || c.status === 'open' || c.status === 'provisional') && !(c.limitations || []).length) {
      err(id, 'limitations-visible', `a ${c.status} claim must state its limitations`);
    }

    // Per-evidence rules.
    const counted = []; // evidence that may support the claim
    c.evidence.forEach((e, i) => {
      const at = `evidence[${i}]`;
      if (!CLASSES.includes(e?.class)) { err(id, 'shape', `${at}: class must be one of ${CLASSES.join(', ')}`); return; }
      if (typeof e.path !== 'string' || !e.path) { err(id, 'shape', `${at}: path is required`); return; }
      const abs = join(root, e.path);
      if (!existsSync(abs)) { err(id, 'evidence-path', `${at}: path does not exist: ${e.path}`); return; }
      if (e.test !== undefined) {
        let text = '';
        try { text = readFileSync(abs, 'utf8'); } catch { /* directory or unreadable */ }
        if (!e.test || !text.includes(e.test)) err(id, 'test-name', `${at}: test "${e.test}" not found in ${e.path}`);
      }
      if (e.class === 'automated' && !e.test) err(id, 'test-name', `${at}: automated evidence must name a test or probe`);
      const exact = typeof e.revision === 'string' && EXACT_REV.test(e.revision);
      if (e.revision != null && !exact) err(id, 'revision', `${at}: revision must be a full 40-character commit hash`);
      if ((e.class === 'system' || e.class === 'human') && !exact && e.revisionUnknown !== true) {
        err(id, 'revision', `${at}: ${e.class} evidence needs an exact revision (or revisionUnknown: true, which counts for nothing)`);
      }
      if (e.revisionUnknown === true && exact) err(id, 'revision', `${at}: revisionUnknown contradicts a recorded revision`);
      // Evidence that can back a claim: automated always (the revision just
      // records when it last ran); system/human only with an exact revision.
      if (e.class === 'automated' || ((e.class === 'system' || e.class === 'human') && exact) || e.class === 'comparative') counted.push(e);
    });

    const has = cls => counted.some(e => e.class === cls);
    const hasStrong = has('automated') || counted.some(e => e.class === 'system');
    if (c.status === 'supported' && !hasStrong) {
      err(id, 'supported-needs-evidence', 'a supported claim needs automated or system evidence (an exact-revision system record if system)');
    }
    if (c.verified === true) {
      if (c.status !== 'supported') err(id, 'revision', 'verified: true is only valid on a supported claim');
      if (!counted.some(e => e.class === 'system' && EXACT_REV.test(e.revision || ''))) {
        err(id, 'revision', 'verified: true needs system evidence at an exact revision');
      }
    }
    const wantsComparative = c.comparative === true || (c.status !== 'disclaimed' && c.status !== 'open' && SUPERIORITY.test(c.claim || ''));
    if (wantsComparative && !has('comparative')) {
      err(id, 'comparative', 'a comparative-superiority claim needs comparative evidence');
    }
  }
  return errors;
}

// Report-only: evidence whose cited path changed after its recorded revision.
// "Later changes invalidate relevant evidence" is a prompt to reverify, so
// this lists candidates; it does not decide what is still true.
export function staleEvidence(ledger, { root = REPO, git = defaultGit } = {}) {
  const out = [];
  for (const c of ledger.claims || []) {
    for (const e of c.evidence || []) {
      if (!e.revision) continue;
      const changed = git(root, e.revision, e.path);
      if (changed === null) out.push({ id: c.id, path: e.path, revision: e.revision, state: 'unknown' });
      else if (changed.length) out.push({ id: c.id, path: e.path, revision: e.revision, state: 'changed', files: changed });
    }
  }
  return out;
}

function defaultGit(root, rev, path) {
  try {
    const o = execFileSync('git', ['diff', '--name-only', rev, 'HEAD', '--', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return o.split('\n').filter(Boolean);
  } catch { return null; }
}

const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderLedger(ledger) {
  const L = [];
  L.push('# Claim ledger', '');
  L.push('<!-- GENERATED from docs/claims/ledger.json by scripts/claim-ledger.mjs --render. Do not edit by hand; `--check` fails if this file is out of date. -->', '');
  L.push(ledger.preamble || '', '');
  const by = s => ledger.claims.filter(c => c.status === s);
  L.push('| id | status | verified | claim |', '| --- | --- | --- | --- |');
  for (const c of ledger.claims) L.push(`| [${c.id}](#${c.id.replace(/[^a-z0-9-]/gi, '').toLowerCase()}) | ${c.status} | ${c.verified === true ? 'yes' : 'no'} | ${esc(c.claim)} |`);
  L.push('', `Counts: ${STATUSES.map(s => `${s} ${by(s).length}`).join(', ')}. Claims marked verified: ${ledger.claims.filter(c => c.verified === true).length}.`, '');
  for (const c of ledger.claims) {
    L.push(`## ${c.id}`, '');
    L.push(`**Status:** ${c.status}${c.verified === true ? ' (verified)' : ''}${c.owner ? `  **Owner:** ${c.owner}` : ''}`, '');
    L.push(c.claim, '', `**Scope / configuration:** ${c.scope}`, '');
    L.push('| class | path | test | revision |', '| --- | --- | --- | --- |');
    for (const e of c.evidence) {
      const rev = e.revision ? e.revision.slice(0, 12) : (e.revisionUnknown ? 'unknown (not counted)' : 'not recorded');
      L.push(`| ${e.class} | \`${e.path}\` | ${e.test ? esc(e.test) : ''} | ${rev} |`);
    }
    if ((c.limitations || []).length) {
      L.push('', '**Limitations:**', ...c.limitations.map(l => `- ${l}`));
    }
    if (c.notes) L.push('', c.notes);
    L.push('');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function parseArgs(argv) {
  const o = { ledger: join(REPO, 'docs/claims/ledger.json'), doc: join(REPO, 'docs/CLAIM_LEDGER.md'), root: REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--render') o.render = true;
    else if (a === '--stale') o.stale = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--ledger') o.ledger = resolve(argv[++i]);
    else if (a === '--doc') o.doc = resolve(argv[++i]);
    else if (a === '--root') o.root = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.check && !o.render) throw new Error('usage: claim-ledger.mjs --check [--stale [--strict]] | --render');
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  let ledger;
  try { ledger = loadLedger(o.ledger); } catch (e) { console.error(`cannot read ledger: ${e.message}`); process.exit(1); }
  if (o.render) {
    writeFileSync(o.doc, renderLedger(ledger));
    console.log(`wrote ${o.doc}`);
  }
  if (o.check) {
    const errors = checkLedger(ledger, { root: o.root });
    if (!existsSync(o.doc) || readFileSync(o.doc, 'utf8') !== renderLedger(ledger)) {
      errors.push({ id: '(view)', rule: 'render-drift', message: `${o.doc} is missing or out of date; run --render` });
    }
    for (const e of errors) console.error(`FAIL [${e.rule}] ${e.id}: ${e.message}`);
    let stale = [];
    if (o.stale) {
      stale = staleEvidence(ledger, { root: o.root });
      for (const s of stale) console.error(`STALE ${s.id}: ${s.path} ${s.state === 'unknown' ? 'revision not resolvable' : 'changed since ' + s.revision.slice(0, 12)}`);
    }
    console.log(`${ledger.claims.length} claims, ${errors.length} errors${o.stale ? `, ${stale.length} stale` : ''}`);
    process.exit(errors.length || (o.strict && stale.length) ? 1 : 0);
  }
}
