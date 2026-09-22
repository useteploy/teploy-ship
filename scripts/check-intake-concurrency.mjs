#!/usr/bin/env node
// Exercise real Nucleus primary-key uniqueness with a deliberately delayed insert.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NucleusPgwire } from '../dist/nucleus-pgwire.js';
import { NucleusIntakeStore } from '../dist/intake.js';
if (process.env.SHIP_ISOLATED_CHECK !== '1' || !process.env.NUCLEUS_URL) {
  throw new Error('Set SHIP_ISOLATED_CHECK=1 and NUCLEUS_URL for an isolated test engine');
}
const db = new NucleusPgwire(process.env.NUCLEUS_URL, 'intake-concurrency-check');
const store = new NucleusIntakeStore(db);
const key = `intake-proof:${randomUUID()}`;
const legacyKey = key + ':legacy';
const input = { source:'team-request', kind:'task', title:'Isolated concurrency proof', dedupeKey:key };
const query = db.query.bind(db);
let release;
let entered;
const held = new Promise(resolve => { release = resolve; });
const inserting = new Promise(resolve => { entered = resolve; });
let winner;
try {
  let delayed = false;
  db.query = async (sql, params) => {
    if (!delayed && sql.startsWith('INSERT INTO ship_tasks_v2')) { delayed = true; entered(); await held; }
    return query(sql, params);
  };
  winner = store.propose(input);
  await Promise.race([inserting, winner.then(() => { throw new Error('Insert was not held'); })]);
  const overtaking = await store.propose(input);
  assert.equal(overtaking.created,true);
  release();
  const first = await winner;
  assert.equal(first.created,false);
  assert.equal(first.task.taskId,overtaking.task.taskId);
  db.query = query;
  const retries = await Promise.all(Array.from({length:10}, () => store.propose(input)));
  assert.ok(retries.every(r => !r.created && r.task.taskId === first.task.taskId));
  const claims = await Promise.all(Array.from({length:10}, (_,i) => store.claim(first.task.taskId,`proof-run-${i}`)));
  assert.equal(claims.filter(Boolean).length,1);
  await store.setState(first.task.taskId,'dismissed');
  const dismissedRetry = await store.propose(input);
  assert.equal(dismissedRetry.created,false);
  assert.equal(dismissedRetry.task.taskId,first.task.taskId);
  assert.equal(dismissedRetry.task.state,'dismissed');
  const rows = await query('SELECT task_id FROM ship_tasks_v2 WHERE dedupe_key = $1',[key]);
  assert.equal(rows.length,1);
  const legacyId = `task-proof-${randomUUID()}`;
  const now = new Date().toISOString();
  await query(`INSERT INTO ship_tasks (task_id,source,kind,title,dedupe_key,state,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[legacyId,'forgejo','issue','Legacy record',legacyKey,'proposed',now,now]);
  const legacyInput = {...input,source:'forgejo',dedupeKey:legacyKey};
  assert.equal((await store.propose(legacyInput)).task.taskId,legacyId);
  assert.equal(await store.claim(legacyId,'proof-legacy-run'),true);
  assert.equal((await store.get(legacyId)).runId,'proof-legacy-run');
  await store.setState(legacyId,'dismissed');
  const reopened = await Promise.all(Array.from({length:10},()=>store.propose(legacyInput)));
  assert.equal(reopened.filter(r=>r.created).length,1);
  assert.equal(new Set(reopened.map(r=>r.task.taskId)).size,1);
  await store.setState(reopened[0].task.taskId,'dismissed');
  const next = await Promise.all(Array.from({length:10},()=>store.propose(legacyInput)));
  assert.equal(next.filter(r=>r.created).length,1);
  assert.equal(new Set(next.map(r=>r.task.taskId)).size,1);
  assert.notEqual(next[0].task.taskId,reopened[0].task.taskId);
  console.log('Nucleus intake: paused writer, retry/dismissal, concurrent claims, legacy updates and two reopen generations passed');
} finally {
  release();
  await winner?.catch(() => {});
  db.query = query;
  for (const table of ['ship_tasks','ship_tasks_v2']) for (const ownKey of [key,legacyKey]) {
    await query(`DELETE FROM ${table} WHERE dedupe_key = $1`,[ownKey]);
  }
  await db.close();
}
