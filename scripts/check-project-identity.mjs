#!/usr/bin/env node
// Run against an isolated Nucleus instance, after pnpm build. Never launches runs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NucleusPgwire } from '../dist/nucleus-pgwire.js';
import { NucleusProjectStore } from '../dist/projects.js';

if (process.env.SHIP_ISOLATED_CHECK !== '1' || !process.env.NUCLEUS_URL) {
  throw new Error('Set SHIP_ISOLATED_CHECK=1 and NUCLEUS_URL for an isolated test engine');
}
const db = new NucleusPgwire(process.env.NUCLEUS_URL, 'project-identity-check');
const store = new NucleusProjectStore(db);
const repo = `identity-proof/${randomUUID()}`;
const project = { repo, autoMerge: false, autoDeploy: false };
const urls = [`https://github.com/${repo}`, `https://forge.example/${repo}`];
try {
  const outcomes = await Promise.allSettled(urls.map(url => store.set({ ...project, url })));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const saved = await store.forRepo(repo);
  const other = urls.find(url => url !== saved.url);
  assert.equal((await db.query('SELECT repo FROM ship_projects WHERE repo = $1', [repo])).length, 1);
  await assert.rejects(store.forRepo(other), /identity conflicts/);
  await assert.rejects(store.set({ ...project, url: other }), /identity conflicts/);
  await assert.rejects(store.remove(other), /identity conflicts/);
  await store.set({ ...saved, label: 'updated' });
  assert.equal((await store.forRepo(saved.url)).label, 'updated');

  // Inject an edit after the identity read and before the conditional write.
  // Real engine semantics must preserve the concurrent writer's bytes.
  const exec = db.exec.bind(db);
  let inject = true;
  db.exec = async (sql, params) => {
    if (inject && sql.startsWith('UPDATE ship_projects SET doc')) {
      inject = false;
      const { repo: _repo, ...doc } = { ...saved, label: 'concurrent' };
      await db.query('UPDATE ship_projects SET doc = $1 WHERE repo = $2', [JSON.stringify(doc), repo]);
    }
    return exec(sql, params);
  };
  await assert.rejects(store.set({ ...saved, label: 'stale' }), /changed during update/);
  assert.equal((await store.forRepo(saved.url)).label, 'concurrent');
  db.exec = exec;
  await store.remove(saved.url);
  assert.equal(await store.forRepo(repo), null);
  console.log('Nucleus identity: concurrent registration, origin isolation, conditional update and removal passed');
} finally {
  // Only the uniquely named row created by this probe.
  await db.query('DELETE FROM ship_projects WHERE repo = $1', [repo]);
  await db.close();
}
