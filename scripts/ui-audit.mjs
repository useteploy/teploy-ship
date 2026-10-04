#!/usr/bin/env node
// Repeatable automated interface and accessibility audit (programme slice S10).
//
// Starts the BUILT dashboard (`dist/cli.js web`, i.e. web/dist) against a
// seeded temporary file store, then visits every core route at 390, 768 and
// 1440 px plus two 200%-zoom equivalents and records objective, mechanically
// checkable defects: overflow, undersized targets, missing names/labels,
// heading skips, landmarks, focus indicators, text contrast computed from
// computed styles, tab order and keyboard traps, and axe-core when it can be
// loaded locally.
//
// This is AUTOMATED EVIDENCE. It is not usability research, it observes no
// user, and a clean run proves only that these specific rules did not fire.
//
// Usage (from the repo root, after `pnpm run build` and `cd web && pnpm run build`):
//   node scripts/ui-audit.mjs [--out DIR] [--routes substr,substr] [--viewports 390,1440]
//                             [--no-axe] [--keep-state]
// Env: PLAYWRIGHT_MODULE (path to playwright-core), CHROMIUM_PATH, AXE_CORE (path to axe.min.js).
// Writes ui-audit.json and ui-audit.md into --out (default: a temp dir, printed).
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {aggregate, analyzeTabOrder, evaluateContrast, hasFocusIndicator, headingIssues, renderMarkdown, targetTooSmall} from './ui-audit-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };

const VIEWPORTS = [
  {name: '390', width: 390, height: 844, dpr: 2},
  {name: '768', width: 768, height: 1024, dpr: 2},
  {name: '1440', width: 1440, height: 900, dpr: 1},
  // 200% browser zoom on a 1440 / 390 screen leaves a 720 / 195 CSS px layout
  // viewport. This emulates the layout consequence (reflow), not text-only zoom.
  {name: '1440@200%', width: 720, height: 450, dpr: 2},
  {name: '390@200%', width: 195, height: 422, dpr: 4},
];

// ---------- environment resolution ----------
function resolveFrom(spec, bases) {
  for (const base of bases) {
    try { return createRequire(join(base, 'x.js')).resolve(spec); } catch { /* try next */ }
  }
  return null;
}
const bases = [root, join(root, 'web'), '/opt/node-tools', process.cwd()];
async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, resolveFrom('playwright-core', bases), resolveFrom('playwright', bases)].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c.startsWith('/') ? pathToFileURL(c).href : c); } catch { /* next */ }
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_MODULE (never run `playwright install`)');
}
function loadAxe() {
  const path = process.env.AXE_CORE || resolveFrom('axe-core/axe.min.js', bases);
  if (!path || !existsSync(path)) return {available: false, reason: 'axe-core not resolvable locally and CDNs are not reachable; set AXE_CORE=/path/to/axe.min.js'};
  const source = readFileSync(path, 'utf8');
  const version = /axe v([\d.]+)/.exec(source.slice(0, 400))?.[1] ?? 'unknown';
  return {available: true, source, version, path};
}

async function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => ok(port)); });
    s.on('error', fail);
  });
}

// ---------- seeding ----------
const now = () => new Date().toISOString();
async function seed(runtime) {
  const {enqueueRun} = await import(pathToFileURL(join(root, 'dist/runtime.js')).href);
  const repo = 'https://github.com/team/repo';
  const append = async (runId, type, name, data) => {
    const seq = (await runtime.store.load(runId)).length;
    await runtime.store.append(runId, {v: 1, seq, at: now(), type, ...(name ? {name} : {}), data});
  };
  const setStatus = async (runId, patch) => { const m = await runtime.loadMeta(runId); await runtime.saveMeta({...m, ...patch, updatedAt: now()}); };
  const base = {model: 'test-model', source: 'manual', trust: 'operator', repo};
  const ids = {};

  ids.waiting = 'run-ui-waiting';
  await enqueueRun(runtime, {...base, runId: ids.waiting, task: 'Fix the date parser so ISO week dates round-trip'});
  await append(ids.waiting, 'step-completed', 'repo-pr', {result: {number: 41, url: `${repo}/pull/41`}});
  await append(ids.waiting, 'event-waiting', 'approve-merge', {});
  await setStatus(ids.waiting, {status: 'waiting', eventName: 'approve-merge'});

  ids.finished = 'run-ui-finished';
  await enqueueRun(runtime, {...base, runId: ids.finished, task: 'Add retry with backoff to the webhook sender'});
  await append(ids.finished, 'step-completed', 'repo-pr', {result: {number: 42, url: `${repo}/pull/42`}});
  await append(ids.finished, 'run-completed', undefined, {output: {status: 'done', summary: 'Added bounded exponential backoff with jitter and tests.', pr: `${repo}/pull/42`, turns: 6, costUSD: 0.42}});
  await setStatus(ids.finished, {status: 'completed'});

  ids.failed = 'run-ui-failed';
  await enqueueRun(runtime, {...base, runId: ids.failed, task: 'Migrate the build to the new bundler'});
  await append(ids.failed, 'run-failed', undefined, {error: 'git push rejected: protected branch requires a pull request'});
  await setStatus(ids.failed, {status: 'failed'});

  ids.scan = 'run-ui-scan';
  await enqueueRun(runtime, {...base, runId: ids.scan, task: 'Audit the auth middleware for session fixation', mode: 'scan'});
  await append(ids.scan, 'step-completed', 'scan-findings', {result: {found: 2, errors: ['one finding had no file and was dropped'], findings: [
    {id: 'f1', title: 'Session id not rotated on login', severity: 'high', file: 'src/session.ts', line: 88, detail: 'The session id issued before login is kept after authentication.'},
    {id: 'f2', title: 'Cookie lacks SameSite', severity: 'low', file: 'src/cookie.ts', line: 12, detail: 'Set SameSite=Lax explicitly.'},
  ]}});
  await append(ids.scan, 'run-completed', undefined, {output: {status: 'done', summary: 'Two findings.', turns: 3}});
  await setStatus(ids.scan, {status: 'completed'});

  ids.followup = 'run-ui-followup';
  await enqueueRun(runtime, {...base, runId: ids.followup, parentRunId: ids.finished, userMessage: 'Also add a jitter test', task: 'Follow-up: also add a jitter test'});
  await append(ids.followup, 'run-completed', undefined, {output: {status: 'done', summary: 'Added the jitter test.', turns: 2}});
  await setStatus(ids.followup, {status: 'completed'});

  ids.child = 'run-ui-followup-2';
  await enqueueRun(runtime, {...base, runId: ids.child, parentRunId: ids.followup, userMessage: 'Document the retry knobs', task: 'Follow-up: document the retry knobs'});
  await setStatus(ids.child, {status: 'running'});
  return ids;
}

function routesFor(ids) {
  const r = (path, auth = true) => ({path, auth});
  const run = (id) => encodeURIComponent(id);
  return [
    r('/'), r('/runs'), r('/runs?view=reviews'), r('/attention'), r('/incidents'), r('/coordination'),
    r('/projects'), r('/projects?view=sources'), r('/projects?view=knowledge'), r('/setup'), r('/workflows'),
    r('/bulletin-admin'), r('/fleet'), r('/fleet?view=spend'), r('/settings'), r('/settings?view=models'),
    r('/settings?view=integrations'), r('/settings?view=team'), r('/settings?view=system'), r('/policies'),
    r('/account'), r('/recovery'),
    // /events is a Server-Sent Events stream, not a page: it never finishes loading, so it is not audited.
    ...[ids.waiting, ids.finished, ids.failed, ids.scan, ids.followup, ids.child].flatMap((id) => [
      r(`/runs/${run(id)}`),
      ...(id === ids.waiting || id === ids.finished || id === ids.scan ? ['review', 'changes', 'verification', 'files', 'activity'].map((v) => r(`/runs/${run(id)}?view=${v}`)) : []),
    ]),
    r('/runs/run-does-not-exist'), r('/no-such-page'),
    r('/login', false),
  ];
}

// ---------- in-page collector (serialised into the browser) ----------
function collect(opts) {
  const vw = innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      // Content of a closed <details> is not rendered; only its own summary is.
      if (n.tagName === 'DETAILS' && !n.open && el !== n && el.closest('summary')?.parentElement !== n) return false;
    }
    return true;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    else if (!el.id && el.parentElement && el.parentElement !== document.body) {
      const pc = [...el.parentElement.classList].slice(0, 1);
      s = `${el.parentElement.tagName.toLowerCase()}${pc.length ? '.' + pc[0] : ''} > ${s}`;
    }
    for (const a of ['name', 'type', 'href']) {
      const v = el.getAttribute(a);
      if (v !== null && v !== '') s += `[${a}=${v.length > 40 ? v.slice(0, 40) + '...' : v}]`;
    }
    return s;
  };
  const text = (el) => (el.innerText ?? el.textContent ?? '').trim();
  const byIdText = (ids) => ids.split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean).map(text).join(' ').trim();
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb && byIdText(lb)) return {name: byIdText(lb), via: 'aria-labelledby'};
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return {name: al.trim(), via: 'aria-label'};
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map(text).join(' ').trim();
      if (t) return {name: t, via: 'label'};
    }
    if (el.tagName === 'IMG' && el.getAttribute('alt') !== null) return {name: el.getAttribute('alt'), via: 'alt'};
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) && el.value) return {name: el.value, via: 'value'};
    if (el.tagName === 'INPUT' && el.type === 'image' && el.alt) return {name: el.alt, via: 'alt'};
    if (['A', 'BUTTON', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role')) {
      const t = text(el) || [...el.querySelectorAll('img[alt],svg[aria-label],[aria-label]')].map((n) => n.getAttribute('alt') ?? n.getAttribute('aria-label')).join(' ').trim();
      if (t) return {name: t, via: 'content'};
    }
    if (el.title && el.title.trim()) return {name: el.title.trim(), via: 'title'};
    if (el.placeholder && el.placeholder.trim()) return {name: el.placeholder.trim(), via: 'placeholder'};
    return {name: '', via: ''};
  };

  const out = {
    lang: document.documentElement.getAttribute('lang') || '',
    title: document.title,
    overflow: {doc: document.documentElement.scrollWidth - vw, body: document.body ? document.body.scrollWidth - vw : 0},
    wide: [], small: [], unnamed: [], placeholderOnly: [], unlabeled: [], badImg: [],
    headings: [], landmarks: {main: 0, nav: 0, banner: 0, navUnnamed: 0}, contrast: [], unmeasuredContrast: 0, skipLink: false,
  };

  // elements wider than the viewport that no scroll container clips
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    if (!visible(el)) continue;
    let clipped = false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX !== 'visible') { const pr = n.getBoundingClientRect(); if (pr.right <= vw + 1 && pr.left >= -1) { clipped = true; break; } }
      if (s.position === 'fixed') { clipped = false; break; }
    }
    if (!clipped) out.wide.push({sel: describe(el), width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right)});
  }
  out.wide = out.wide.slice(0, 12);

  // interactive: size and names
  const interactiveSel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(interactiveSel)) {
    if (!visible(el) || el.disabled) continue;
    // A bare tabindex (a keyboard-focusable scroll region such as <pre>) is not a
    // control: it has no pointer target to size and no role to name.
    if (el.matches('[tabindex]') && !el.matches('a[href],button,input,select,textarea,summary,[role]')) continue;
    let r = el.getBoundingClientRect();
    if (el.matches('input[type=checkbox],input[type=radio]') && el.labels?.length) {
      for (const l of el.labels) { const lr = l.getBoundingClientRect(); if (lr.width * lr.height > r.width * r.height) r = lr; }
    }
    let inlineInText = false;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
      const parent = el.parentElement;
      const own = [...parent.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
      inlineInText = own.length > 0;
    }
    out.small.push({sel: describe(el), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, inlineInText});
    const n = nameOf(el);
    const formControl = el.matches('input,select,textarea');
    if (n.name === '') (formControl ? out.unlabeled : out.unnamed).push({sel: describe(el)});
    else if (n.via === 'placeholder') out.placeholderOnly.push({sel: describe(el)});
    else if (n.via === 'title' && formControl) out.placeholderOnly.push({sel: describe(el), via: 'title'});
  }
  out.small = out.small.filter((s) => s.width < 24 || s.height < 24);

  for (const el of document.querySelectorAll('img,svg[role=img],[role=img]')) {
    if (!visible(el)) continue;
    const decorative = el.getAttribute('alt') === '' || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'presentation';
    if (decorative) continue;
    if (!nameOf(el).name) out.badImg.push({sel: describe(el)});
  }

  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')) {
    if (!visible(h)) continue;
    const lvl = h.getAttribute('aria-level') ? +h.getAttribute('aria-level') : /^H\d$/.test(h.tagName) ? +h.tagName[1] : 2;
    out.headings.push({level: lvl, text: text(h).slice(0, 50), empty: text(h) === ''});
  }

  out.landmarks.main = document.querySelectorAll('main,[role=main]').length;
  out.landmarks.banner = document.querySelectorAll('header,[role=banner]').length;
  for (const n of document.querySelectorAll('nav,[role=navigation]')) { out.landmarks.nav++; if (!nameOf(n).name) out.landmarks.navUnnamed++; }
  out.skipLink = !!document.querySelector('a[href^="#"].skip,a.skip-link,a[href="#main-content"],a[href="#main"]');

  // contrast samples: one per element that owns a non-blank text node
  const canvas = getComputedStyle(document.documentElement).backgroundColor;
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName) || !visible(el)) continue;
    if (el.closest('[disabled],[aria-disabled=true]')) continue;
    const cs = getComputedStyle(el);
    const layers = [];
    let opacity = 1, indeterminate = false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      opacity *= parseFloat(s.opacity);
      if (s.backgroundImage !== 'none') indeterminate = true;
      layers.push(s.backgroundColor);
      if (/^rgb\(/.test(s.backgroundColor)) break;
    }
    if (indeterminate) { out.unmeasuredContrast++; continue; }
    const key = [cs.color, layers.join('|'), cs.fontSize, cs.fontWeight, opacity, describe(el)].join('#');
    if (!seen.has(key)) seen.set(key, {sel: describe(el), color: cs.color, layers, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, opacity, canvas, sample: node.textContent.trim().slice(0, 40)});
  }
  out.contrast = [...seen.values()];
  return out;
}

// ---------- keyboard walk (driven from Node) ----------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
async function tagFocusables(page) {
  return page.evaluate((sel) => {
    const out = [];
    document.querySelectorAll('[data-uia]').forEach((e) => e.removeAttribute('data-uia'));
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let hidden = false;
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden') { hidden = true; break; }
        if (n.tagName === 'DETAILS' && !n.open && el.closest('summary')?.parentElement !== n) { hidden = true; break; }
      }
      if (hidden) continue;
      // Tab visits ONE radio per named group (arrow keys move within it): the
      // checked one, else the first. Counting the rest would report them as unreachable.
      if (el.matches('input[type=radio]') && el.name) {
        const group = [...document.querySelectorAll('input[type=radio]')].filter((r) => r.name === el.name && r.form === el.form && !r.disabled);
        const target = group.find((r) => r.checked) ?? group[0];
        if (target !== el) continue;
      }
      el.setAttribute('data-uia', String(out.length));
      out.push(String(out.length));
    }
    return out;
  }, FOCUSABLE);
}
const SIG_KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'backgroundColor', 'color', 'textDecorationLine'];
async function walkTabOrder(page, expected) {
  // Reset the sequential-focus start point to the top: a page that autofocuses
  // a field (login) would otherwise start the walk mid-page.
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  const stops = [];
  const noIndicator = [];
  // tagFocusables stamps data-uia so stops have stable ids; it is removed again
  // by the caller so it never shows up in axe targets or selectors.
  const limit = expected.length * 4 + 10; // composite controls (time inputs) take several presses
  // Focus is never moved programmatically: calling blur() then focus() would
  // reset a composite control such as <input type=time> to its first field and
  // fake a keyboard trap. An element's focused style is read while it has
  // focus; its unfocused style is read on the NEXT press, once focus moved on.
  let last = null;
  const judge = (blurred) => {
    if (last !== null && blurred !== null && !hasFocusIndicator(last.focused, blurred)) noIndicator.push(last.sel);
  };
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const {cur, prevBlurred} = await page.evaluate((keys) => {
      const sig = (e) => { const st = getComputedStyle(e); return Object.fromEntries(keys.map((k) => [k, st[k]])); };
      const el = document.activeElement;
      const prev = window.__uiaPrev;
      const none = !el || el === document.body || el === document.documentElement;
      const prevBlurred = prev && prev.isConnected && prev !== el ? sig(prev) : null;
      if (none) { window.__uiaPrev = null; return {cur: null, prevBlurred}; }
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += `#${el.id}`;
      const cls = [...el.classList].slice(0, 2);
      if (cls.length) sel += `.${cls.join('.')}`;
      if (el.getAttribute('name')) sel += `[name=${el.getAttribute('name')}]`;
      if (el.getAttribute('href')) sel += `[href=${el.getAttribute('href').slice(0, 40)}]`;
      window.__uiaPrev = el;
      return {cur: {id: el.getAttribute('data-uia') ?? `x:${sel}`, sel, focused: sig(el)}, prevBlurred};
    }, SIG_KEYS);
    judge(prevBlurred);
    if (cur === null) { stops.push(null); break; }
    if (last === null || last.id !== cur.id) last = cur;
    stops.push(cur.id);
    if (stops.indexOf(cur.id) !== stops.length - 1 && stops[stops.length - 2] !== cur.id) break;
  }
  if (flag('debug-tab')) console.error('tab stops', page.url(), JSON.stringify(stops));
  return {...analyzeTabOrder(stops, expected), noIndicator: [...new Set(noIndicator)], presses: stops.length};
}

// ---------- axe ----------
async function runAxe(page, axe) {
  await page.addScriptTag({content: axe.source});
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']}});
    return r.violations.map((v) => ({id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' '))}));
  });
}

// ---------- main ----------
async function main() {
  if (!existsSync(join(root, 'dist/cli.js')) || !existsSync(join(root, 'web/dist'))) {
    throw new Error('Build first: `pnpm run build` at the root and `cd web && pnpm run build`.');
  }
  const outDir = flag('out') && flag('out') !== true ? resolve(flag('out')) : await mkdtemp(join(tmpdir(), 'ui-audit-out-'));
  await mkdir(outDir, {recursive: true});
  const stateDir = await mkdtemp(join(tmpdir(), 'ui-audit-state-'));
  const token = `ui-audit-${Date.now()}`;
  process.env.TEPLOY_SHIP_STATE = stateDir;
  process.env.SHIP_STORE = 'file';
  const {fileRuntime} = await import(pathToFileURL(join(root, 'dist/runtime.js')).href);
  const runtime = await fileRuntime();
  const ids = await seed(runtime);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, 'dist/cli.js'), 'web', '--store', 'file', '--port', String(port)], {
    detached: true, stdio: 'ignore', env: {...process.env, SHIP_WEB_TOKEN: token, SHIP_STORE: 'file', TEPLOY_SHIP_STATE: stateDir},
  });
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default?.chromium;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({...(executablePath ? {executablePath} : {}), args: ['--no-sandbox']});
  const axe = flag('no-axe') ? {available: false, reason: 'disabled with --no-axe'} : loadAxe();
  const viewports = typeof flag('viewports') === 'string' ? VIEWPORTS.filter((v) => String(flag('viewports')).split(',').includes(v.name)) : VIEWPORTS;
  const only = typeof flag('routes') === 'string' ? String(flag('routes')).split(',') : null;
  let routes = routesFor(ids);
  if (only) routes = routes.filter((r) => only.some((o) => r.path.includes(o)));

  const findings = [];
  const pages = [];
  const unreachable = [];
  const axeRows = [];
  const add = (route, viewport, rule, severity, selector, detail) => findings.push({route, viewport, rule, severity, selector, detail});
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = (await fetch(`${base}/login`)).ok; } catch { /* not up yet */ }
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error('web app did not start');

    for (const vp of viewports) {
      const authed = await browser.newContext({viewport: {width: vp.width, height: vp.height}, deviceScaleFactor: vp.dpr, extraHTTPHeaders: {authorization: `Bearer ${token}`}, bypassCSP: true});
      const anon = await browser.newContext({viewport: {width: vp.width, height: vp.height}, deviceScaleFactor: vp.dpr, bypassCSP: true});
      for (const route of routes) {
        const page = await (route.auth ? authed : anon).newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
          const response = await page.goto(base + route.path, {waitUntil: 'load', timeout: 20000});
          const status = response?.status() ?? 0;
          // 404 pages are audited as the error state they are; anything else non-200 is unreachable.
          const expectedMissing = route.path === '/no-such-page' || route.path === '/runs/run-does-not-exist';
          if (status !== 200 && !(expectedMissing && status === 404)) {
            if (vp === viewports[0]) unreachable.push({route: route.path, reason: `HTTP ${status}`});
            await page.close();
            continue;
          }
          await page.waitForTimeout(500);
          const key = route.path;
          const data = await page.evaluate(collect, {});
          pages.push({route: key, viewport: vp.name, status});
          for (const e of errors) add(key, vp.name, 'page-error', 'error', 'window', e.slice(0, 160));
          if (data.overflow.doc > 1) add(key, vp.name, 'horizontal-overflow', 'error', 'document', `scrollWidth exceeds viewport by ${data.overflow.doc}px`);
          for (const w of data.wide) add(key, vp.name, 'element-wider-than-viewport', 'warn', w.sel, `box ${w.left}..${w.right} in a ${vp.width}px viewport`);
          for (const s of data.small) if (targetTooSmall(s)) add(key, vp.name, 'tap-target-under-24px', 'warn', s.sel, `${s.width}x${s.height}px`);
          for (const u of data.unnamed) add(key, vp.name, 'control-no-accessible-name', 'error', u.sel, '');
          for (const u of data.unlabeled) add(key, vp.name, 'form-control-no-label', 'error', u.sel, '');
          for (const u of data.placeholderOnly) add(key, vp.name, 'form-control-placeholder-or-title-only', 'warn', u.sel, u.via ?? 'placeholder');
          for (const u of data.badImg) add(key, vp.name, 'image-no-alt', 'error', u.sel, '');
          if (!data.lang) add(key, vp.name, 'html-no-lang', 'error', 'html', '');
          if (!data.title.trim()) add(key, vp.name, 'document-no-title', 'error', 'title', '');
          if (data.landmarks.main !== 1) add(key, vp.name, 'landmark-main', 'error', 'main', `${data.landmarks.main} main landmarks`);
          if (data.landmarks.nav === 0 && route.auth) add(key, vp.name, 'landmark-nav', 'warn', 'nav', 'no navigation landmark');
          if (data.landmarks.navUnnamed > 1) add(key, vp.name, 'landmark-nav-unnamed', 'warn', 'nav', `${data.landmarks.navUnnamed} unnamed navs`);
          for (const h of data.headings) if (h.empty) add(key, vp.name, 'heading-empty', 'error', `h${h.level}`, '');
          for (const i of headingIssues(data.headings.map((h) => h.level))) add(key, vp.name, i.rule, 'warn', 'headings', i.detail);
          pages[pages.length - 1].contrastSamples = data.contrast.length;
          for (const c of data.contrast) {
            const res = evaluateContrast({color: c.color, layers: c.layers, fallback: c.canvas, fontSize: c.fontSize, fontWeight: c.fontWeight, opacity: c.opacity});
            if (res === null) { continue; }
            if (!res.pass) add(key, vp.name, 'text-contrast', 'error', c.sel, `${c.color} on ${c.layers.find((l) => /^rgb\(/.test(l)) ?? c.canvas}: ${res.ratio}:1, needs ${res.required}:1 (${c.fontSize}px/${c.fontWeight})`);
          }
          // keyboard
          const expected = await tagFocusables(page);
          const walk = await walkTabOrder(page, expected);
          if (walk.trap) add(key, vp.name, 'keyboard-trap', 'error', walk.trap, 'Tab revisited this element before leaving the page');
          if (walk.unreached.length) add(key, vp.name, 'tab-order-unreached', 'error', `${walk.unreached.length} of ${expected.length} controls`, `Tab did not reach them within ${walk.presses} presses`);
          for (const sel of walk.noIndicator) add(key, vp.name, 'focus-indicator-missing', 'error', sel, 'no outline, shadow, border, background or colour change on focus');
          await page.evaluate(() => document.querySelectorAll('[data-uia]').forEach((e) => e.removeAttribute('data-uia')));
          pages[pages.length - 1].tabStops = expected.length;
          pages[pages.length - 1].unmeasuredContrast = data.unmeasuredContrast;
          // axe on the extremes only: it is the slowest check and the middle widths add little
          if (axe.available && ['390', '1440'].includes(vp.name)) {
            const violations = await runAxe(page, axe);
            for (const v of violations) {
              axeRows.push({route: key, viewport: vp.name, ...v});
              add(key, vp.name, `axe:${v.id}`, v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warn', v.targets[0] ?? '', `${v.help} (${v.nodes} node${v.nodes === 1 ? '' : 's'}, ${v.impact})`);
            }
          }
        } catch (e) {
          if (vp === viewports[0]) unreachable.push({route: route.path, reason: `audit error: ${String(e.message).split('\n')[0]}`});
        }
        await page.close();
      }
      await authed.close();
      await anon.close();
    }
  } finally {
    await browser.close();
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
    if (!flag('keep-state')) await rm(stateDir, {recursive: true, force: true});
  }

  const rows = aggregate(findings);
  const meta = {generatedAt: new Date().toISOString(), routes: routes.length, viewports, seededRuns: ids, nodeVersion: process.version, axe: axe.available ? {version: axe.version} : {unavailable: axe.reason}};
  const report = {meta, pages, unreachable, findings: rows.map((r) => ({...r})), axe: axeRows};
  await writeFile(join(outDir, 'ui-audit.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'ui-audit.md'), renderMarkdown({meta, pages, rows, unreachable, axe: axe.available ? {available: true, version: axe.version, source: axe.path} : axe}));
  const errors = rows.filter((r) => r.severity === 'error').length;
  console.log(`ui-audit: ${pages.length} page loads, ${rows.length} distinct findings (${errors} errors), ${unreachable.length} unreachable. Report: ${outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
