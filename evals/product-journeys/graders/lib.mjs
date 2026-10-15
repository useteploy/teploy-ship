// Shared helpers for product-journey graders. Node stdlib only, plus
// relative imports inside graders/ so the directory can be copied out of
// tree and still work.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

// 'mock-responses' holds harness-canned mock outputs inside the fixture
// trees: never fixture content, never visible to the evaluated agent (the
// runner excludes it when staging), never counted by a snapshot.
const JUNK = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', 'mock-responses']);

export function mktmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (JUNK.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

export function hashString(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function snapshot(dir) {
  const snap = {};
  for (const rel of walkFiles(dir)) {
    if (rel.endsWith('.sqlite') || rel.startsWith('staging/') || rel === 'store.json') continue;
    snap[rel] = hashString(readFileSync(join(dir, rel), 'utf8'));
  }
  return snap;
}

export function diffSnapshots(before, after) {
  const added = [], removed = [], changed = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { added, removed, changed, unchanged: Object.keys(before).filter(k => before[k] === after[k]) };
}

export function readText(dir, rel) {
  return readFileSync(join(dir, rel), 'utf8');
}

export function fileExists(dir, rel) {
  try {
    return statSync(join(dir, rel)).isFile();
  } catch {
    return false;
  }
}

export function run(cmd, args, { cwd, env = {}, timeoutMs = 60000 } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: stderr + String(err) }); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

// Boot a server that prints "listening <port>" on stdout.
// Returns { port, stop } or throws on timeout/exit.
export async function bootServer(cmd, args, { cwd, env = {}, timeoutMs = 15000 } = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
  const port = await new Promise((resolvePromise, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not announce a port within ${timeoutMs}ms`)), timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited early: ${code}`)); });
    child.stdout.on('data', d => {
      out += d;
      const match = out.match(/listening (\d+)/);
      if (match) { clearTimeout(timer); child.removeAllListeners('exit'); resolvePromise(Number(match[1])); }
    });
  });
  return {
    port,
    stop() {
      child.kill('SIGTERM');
      return new Promise(r => child.on('exit', r));
    }
  };
}

export async function request(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// A not-wired check: real today, absent until execution wiring lands.
// Graders report these as failing reasons on purpose — no grader passes on
// checks it cannot actually perform.
export function notWired(check) {
  return {
    reason: `not-wired: ${check} (requires execution wiring; not graded in this slice)`,
    evidence: { kind: 'not-wired', check }
  };
}

// The agent's words only: the task prompt is echoed into a Ship transcript
// (the Task line, the requester's message, a follow-up's context), and a
// grader must never credit the agent with text it was given.
export function agentText(transcript, scenario) {
  let text = String(transcript ?? '');
  const prompt = scenario?.taskPrompt;
  if (typeof prompt === 'string' && prompt !== '') text = text.split(prompt).join(' ');
  return text;
}

// Sentence-ish units for co-occurrence checks. File names like README.md:10
// carry no following space, so they are not split. JSON-escaped newlines
// (a transcript's Outcome line) and JSON field boundaries (a findings entry's
// title vs its detail) split too, so two fields never read as one sentence.
export function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+|\\n|\\?",\s*\\?"/).map(s => s.trim()).filter(Boolean);
}

// Read-only scenarios: nothing may be published. The ship adapter reports
// `prOpened` from the run's outcome and `pushed` from the forge (a ship/<run>
// branch or a captured PR head); both must be false.
export function noPublication(summary) {
  if (summary && summary.prOpened === false && summary.pushed === false) {
    return { ok: true, evidence: { kind: 'adapter-reported', check: 'no PR opened, nothing pushed', value: { prOpened: false, pushed: false } } };
  }
  if (summary && (summary.prOpened === true || summary.pushed === true)) {
    return { ok: false, reason: `the run published: prOpened=${summary.prOpened} pushed=${summary.pushed} — the task is read-only`, evidence: { kind: 'adapter-reported', check: 'no PR opened, nothing pushed', value: { prOpened: summary.prOpened, pushed: summary.pushed } } };
  }
  const nw = notWired('no PR opened and nothing pushed (the adapter did not report both prOpened and pushed)');
  return { ok: null, reason: nw.reason, evidence: nw.evidence };
}

export function result(pass, reasons, evidence) {
  return { pass, reasons, evidence };
}

// ── browser-required grading (S12 acceptance) ─────────────────────────────
// The pj-d-live-board grader's ground truth is its OWN headless render of the
// served worked tree — never a grep of the files, never the agent's summary.
// That needs a real browser engine. Discovery is honest and layered: a
// playwright module if one is resolvable (PLAYWRIGHT_MODULE overrides the
// name), else a Chrome/Chromium binary from CHROME_BIN/CHROMIUM_BIN or the
// usual install paths. None found → null, and the grader says not-wired
// rather than pretending.

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

export function findChromeBinary() {
  for (const candidate of [process.env.CHROME_BIN, process.env.CHROMIUM_BIN, ...CHROME_CANDIDATES]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

let playwrightProbe = null;
export async function browserEngine() {
  if (playwrightProbe === null) {
    playwrightProbe = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
      .then(() => ({ kind: 'playwright' }))
      .catch(() => {
        const bin = findChromeBinary();
        return bin === null ? false : { kind: 'chrome', bin };
      });
  }
  return playwrightProbe === false ? null : playwrightProbe;
}

/**
 * Serve a directory over loopback HTTP so a page's client-side JavaScript
 * actually runs (file:// is not a fair stand-in for the product's pages).
 * Content types cover the fixture families; anything else is octet-stream.
 */
export function serveDir(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/plain', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    const file = resolve(dir, clean === '' ? 'index.html' : clean);
    if (file !== dir && !file.startsWith(dir + sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let body;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise(resolvePromise => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ port: server.address().port, stop: () => new Promise(r => server.close(r)) }));
  });
}

/**
 * One headless look: load the URL in a real engine, let the page's scripts
 * run, return the serialized DOM. The chrome path uses --dump-dom with a
 * virtual-time budget so client-side rendering settles deterministically.
 */
export async function renderURL(engine, url) {
  if (engine.kind === 'playwright') {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({
      ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
      ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {})
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(500);
      return await page.content();
    } finally {
      await browser.close();
    }
  }
  const profile = mkdtempSync(join(tmpdir(), 'pj-grader-chrome-'));
  const child = spawn(engine.bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const timedOut = new Promise(r => setTimeout(() => child.kill('SIGKILL'), 45000));
  const code = await Promise.race([new Promise(r => child.on('close', r)), timedOut.then(() => 'timeout')]);
  if (code !== 0) throw new Error(`headless chrome exited ${code}: ${err.slice(0, 300)}`);
  return out;
}

/** The text content of one element id in a serialized DOM, or null. */
export function elementText(html, id) {
  const m = html.match(new RegExp(`<([a-z0-9]+)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, 'i'));
  if (m === null) return null;
  const decode = s => s
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return decode(m[2]).replace(/\s+/g, ' ').trim();
}
