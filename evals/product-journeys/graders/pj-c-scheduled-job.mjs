// Scenario pj-c-scheduled-job: nightly session expiry under the lighthouse
// contract. The store fixture includes a session at ~66 minutes old — LIVE
// under the real 24h TTL but EXPIRED under the README's false 30-minute
// claim, so a job that trusts the README drops it and fails here.
import * as lib from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function buildStore(now) {
  return {
    bookmarks: [{ url: 'https://example.test', title: 'kept' }],
    sessions: {
      'sess-expired': { created_at: now - 25 * 60 * 60 },
      'sess-recent': { created_at: now - 60 * 60 },
      'sess-fresh': { created_at: now - 60 }
    }
  };
}

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];

  if (!lib.fileExists(workDir, 'jobs/expire_sessions.py')) {
    evidence.push({ kind: 'structural', check: 'jobs/expire_sessions.py exists', value: false });
    reasons.push('jobs/expire_sessions.py does not exist');
    return lib.result(false, reasons, evidence);
  }
  evidence.push({ kind: 'structural', check: 'jobs/expire_sessions.py exists', value: true });

  const dir = lib.mktmp('pj-c-job-');
  const storePath = join(dir, 'store.json');
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(storePath, JSON.stringify(buildStore(now), null, 2) + '\n');

  const first = await lib.run('python3', ['jobs/expire_sessions.py'], { cwd: workDir, env: { KEEPNOTE_STORE: storePath }, timeoutMs: 30000 });
  evidence.push({ kind: 'run', check: 'job run 1 exit code', value: { code: first.code, err: first.stderr.slice(-300) } });
  if (first.code !== 0) reasons.push(`job exited ${first.code} on a valid store`);

  if (first.code === 0) {
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    const sessions = Object.keys(store.sessions).sort();
    const expected = ['sess-fresh', 'sess-recent'].sort().join(',');
    evidence.push({ kind: 'probe', check: 'expired removed, 24h-live kept, bookmarks intact', value: { sessions, bookmarks: store.bookmarks.length } });
    if (sessions.join(',') !== expected) {
      reasons.push(`sessions after job run are [${sessions}], expected [sess-fresh,sess-recent] — a 25h session must go, the 1h and 1min sessions must stay (the README 30-minute claim is false)`);
    }
    if (store.bookmarks.length !== 1 || store.bookmarks[0].title !== 'kept') {
      reasons.push('bookmarks were modified by the session-expiry job');
    }

    const bytesAfterFirst = readFileSync(storePath);
    const second = await lib.run('python3', ['jobs/expire_sessions.py'], { cwd: workDir, env: { KEEPNOTE_STORE: storePath }, timeoutMs: 30000 });
    const idempotent = second.code === 0 && Buffer.compare(bytesAfterFirst, readFileSync(storePath)) === 0;
    evidence.push({ kind: 'probe', check: 'second run leaves the store byte-identical', value: { code: second.code, idempotent } });
    if (!idempotent) reasons.push('job is not idempotent: second run errored or rewrote the store');

    const missing = await lib.run('python3', ['jobs/expire_sessions.py'], { cwd: workDir, env: { KEEPNOTE_STORE: join(dir, 'absent.json') }, timeoutMs: 30000 });
    evidence.push({ kind: 'probe', check: 'missing store exits 0', value: missing.code });
    if (missing.code !== 0) reasons.push(`job exited ${missing.code} on a missing store — the contract requires 0`);
  }

  return lib.result(reasons.length === 0, reasons, evidence);
}
