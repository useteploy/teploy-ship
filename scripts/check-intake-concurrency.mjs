#!/usr/bin/env node
// Exercise real Nucleus guard visibility with a deliberately delayed insert.
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
const input = { source:'team-request', kind:'task', title:'Isolated concurrency proof', dedupeKey:key };
const query = db.query.bind(db);
let release;
let entered;
const held = new Promise(resolve => { release = resolve; });
const inserting = new Promise(resolve => { entered = resolve; });
let winner;
try {
  db.query = async (sql, params) => {
    if (sql.startsWith('INSERT INTO ship_tasks')) { entered(); await held; }
    return query(sql, params);
  };
  winner = store.propose(input);
  await Promise.race([inserting, winner.then(() => { throw new Error('Insert was not held'); })]);
  await assert.rejects(store.propose(input), /still being recorded/);
  release();
  const first = await winner;
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
  const rows = await query('SELECT task_id FROM ship_tasks WHERE dedupe_key = $1',[key]);
  assert.equal(rows.length,1);
  console.log('Nucleus intake: delayed insert, retry deduplication and concurrent launch claims passed');
} finally {
  release();
  await winner?.catch(() => {});
  db.query = query;
  await query('DELETE FROM ship_tasks WHERE dedupe_key = $1',[key]);
  await db.close();
}
