// Scenario pj-b-perms-defect: DELETE must enforce the admin token per the
// fixture README. Probes all three token states independently.
import * as lib from './lib.mjs';
import { join } from 'node:path';

const TESTS = ['tests/health.test.mjs', 'tests/roundtrip.test.mjs', 'tests/duplicate-title.test.mjs'];
// The duplicate-title test ships failing on purpose (a different open
// defect, pj-b-api-defect's scenario) — this scenario must not require
// fixing it, so "suite passes" means the subset that passes on the pristine
// tree.
const PASSING_SUBSET = ['tests/health.test.mjs', 'tests/roundtrip.test.mjs'];
const GRADER_TOKEN = 'grader-probe-token';

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];

  const db = lib.mktmp('pj-b-perms-');
  const server = await lib.bootServer('node', ['server.mjs'], {
    cwd: workDir,
    env: { NOTES_DB: join(db, 'notes.sqlite'), PORT: '0', ADMIN_TOKEN: GRADER_TOKEN }
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const created = await lib.request('POST', base + '/api/notes', { body: { title: 'to delete', body: 'x' } });
    const id = created.body?.id;
    evidence.push({ kind: 'probe', check: 'setup note created', value: created.status });

    const noToken = await lib.request('DELETE', `${base}/api/notes/${id}`);
    evidence.push({ kind: 'probe', check: 'DELETE without token rejected', value: noToken.status });
    if (![401, 403].includes(noToken.status)) {
      reasons.push(`DELETE without a token returned ${noToken.status}, expected 401/403 — admin contract not enforced`);
    }

    const wrongToken = await lib.request('DELETE', `${base}/api/notes/${id}`, { headers: { 'X-Admin-Token': 'wrong-token' } });
    evidence.push({ kind: 'probe', check: 'DELETE with wrong token rejected', value: wrongToken.status });
    if (![401, 403].includes(wrongToken.status)) {
      reasons.push(`DELETE with a wrong token returned ${wrongToken.status}, expected 401/403`);
    }

    const rightToken = await lib.request('DELETE', `${base}/api/notes/${id}`, { headers: { 'X-Admin-Token': GRADER_TOKEN } });
    evidence.push({ kind: 'probe', check: 'DELETE with correct token is 204', value: rightToken.status });
    if (rightToken.status !== 204) {
      reasons.push(`DELETE with the correct token returned ${rightToken.status}, expected 204 — the endpoint must keep working for admins`);
    }

    const listed = await lib.request('GET', base + '/api/notes');
    evidence.push({ kind: 'probe', check: 'read endpoint stays open', value: listed.status });
    if (listed.status !== 200) reasons.push(`GET /api/notes returned ${listed.status} without a token — reads must stay open`);
  } finally {
    await server.stop();
  }

  const tests = await lib.run('node', ['--test', ...PASSING_SUBSET], { cwd: workDir, timeoutMs: 120000 });
  evidence.push({ kind: 'fixture-tests', check: 'suite subset that passes pristine still passes in the worked tree', value: tests.code });
  if (tests.code !== 0) reasons.push(`shipped test suite fails in the worked tree:\n${tests.stdout.slice(-2000)}`);

  const shippedUnchanged = TESTS.every(t =>
    lib.hashString(lib.readText(workDir, t)) === lib.hashString(lib.readText(fixture, t)));
  evidence.push({ kind: 'structural', check: 'shipped test files unmodified', value: shippedUnchanged });
  if (!shippedUnchanged) reasons.push('shipped test files were modified');

  return lib.result(reasons.length === 0, reasons, evidence);
}
