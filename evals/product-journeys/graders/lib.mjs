// Shared helpers for product-journey graders. Node stdlib only, plus
// relative imports inside graders/ so the directory can be copied out of
// tree and still work.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const JUNK = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);

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

export function result(pass, reasons, evidence) {
  return { pass, reasons, evidence };
}
