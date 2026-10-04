#!/usr/bin/env node
// S03 rehearsal: prove migration 008 + the requirements store against a REAL
// Nucleus holding a restored copy of the production store — never production
// itself. Mirrors scripts/check-intake-concurrency.mjs's isolation contract
// (SHIP_ISOLATED_CHECK=1 + an explicit NUCLEUS_URL) and scripts/ship-backup.sh
// rehearse's posture (isolated restore, throwaway engine, own rows cleaned up).
//
// What it proves, in order:
//   1. additive-only: every ship_* table that exists before migrate() exists
//      after it with an IDENTICAL row count; the only ledger/table change is
//      the 008 row in ship_migrations.
//   2. the store DDL creates ship_task_requirements on a real engine and its
//      primary-key / conditional-update semantics behave as the unit tests'
//      fake claims (idempotent add, conflict refusal, exactly-once waiver).
//   3. replay idempotency: a second migrate() applies nothing.
//
// It creates only rows under its own proof task root and deletes them before
// exit; the empty table and the ledger row stay (the schema change is the
// point of the rehearsal). Output is a JSON receipt on stdout.
import assert from 'node:assert/strict';
import { NucleusPgwire } from '../dist/nucleus-pgwire.js';
import { migrate } from '../dist/migrations.js';
import { NucleusTaskRequirements } from '../dist/task-requirements.js';

if (process.env.SHIP_ISOLATED_CHECK !== '1' || !process.env.NUCLEUS_URL) {
  throw new Error('Set SHIP_ISOLATED_CHECK=1 and NUCLEUS_URL for an isolated test engine');
}

// Fallback table list in case the engine answers no SHOW TABLES; a live
// Nucleus does (the receipt records which path was taken).
const SHIP_TABLES = [
  'ship_akiroo_cursor', 'ship_akiroo_receipts', 'ship_artifact_expiry', 'ship_artifacts',
  'ship_attributed_spend', 'ship_bulletin_boards', 'ship_bulletin_posts', 'ship_code_chunks',
  'ship_code_files', 'ship_code_rates', 'ship_code_repos', 'ship_connect_requests',
  'ship_delivery', 'ship_docs', 'ship_evidence', 'ship_fleet', 'ship_fleet_capacity',
  'ship_fleet_load', 'ship_governance', 'ship_knowledge_records', 'ship_launch_chunks',
  'ship_launch_commits', 'ship_launch_dispositions', 'ship_launches', 'ship_live',
  'ship_memory', 'ship_migrations', 'ship_model_segments', 'ship_outbox', 'ship_placement',
  'ship_policies', 'ship_projects', 'ship_projects_v2', 'ship_repo_stats', 'ship_run_images',
  'ship_runtime_config', 'ship_spend', 'ship_spend_holds', 'ship_steer',
  'ship_task_requirements', 'ship_tasks', 'ship_tasks_v2', 'ship_unpriced_runs',
  'ship_users', 'ship_workspace_content',
];

const db = new NucleusPgwire(process.env.NUCLEUS_URL, 's03-requirements-rehearsal');
const receipt = {
  pass: false,
  scope: 'migration 008 + task-requirements store on a restored copy; no production path',
  startedAt: new Date().toISOString(),
  url: process.env.NUCLEUS_URL.replace(/:\/\/[^@]*@/, '://'),
  tablesBefore: {},
  tablesAfter: {},
  migrate: {},
  storeProof: {},
};

async function countRows(table) {
  try {
    const rows = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0]?.n ?? 0);
  } catch {
    // Fallback for an engine without aggregate support: page through the
    // table in bounded slices and count client-side.
    let total = 0;
    for (;;) {
      const rows = await db.query(`SELECT 1 FROM ${table} LIMIT 1000 OFFSET ${total}`);
      total += rows.length;
      if (rows.length < 1000) return total;
    }
  }
}

async function tableList() {
  try {
    const rows = await db.query('SHOW TABLES');
    if (Array.isArray(rows) && rows.length > 0) return { tables: rows.map((r) => String(r.table_name)).sort(), source: 'SHOW TABLES' };
  } catch { /* fall through to the static list */ }
  return { tables: SHIP_TABLES, source: 'static list' };
}

async function counts() {
  const out = {};
  for (const table of (await tableList()).tables) {
    try {
      out[table] = await countRows(table);
    } catch {
      out[table] = 'absent';
    }
  }
  return out;
}

try {
  receipt.tablesSource = (await tableList()).source;
  receipt.tablesBefore = await counts();
  const populated = Object.entries(receipt.tablesBefore).filter(([, v]) => typeof v === 'number' && v > 0);
  const proofRoot = `s03-proof-${Date.now().toString(36)}`;

  let t0 = Date.now();
  const applied = await migrate(db, (line) => process.stderr.write(`${line}\n`));
  let t1 = Date.now();
  receipt.migrate.firstPassAppliedIds = applied;
  receipt.migrate.firstPassMs = t1 - t0;
  assert.ok(applied.includes('008-ship-task-requirements') || applied.length === 0,
    '008 must run (stale shape) or be ledger-recorded by the winner/no-op path');

  receipt.tablesAfter = await counts();
  for (const [table, before] of Object.entries(receipt.tablesBefore)) {
    const after = receipt.tablesAfter[table];
    if (table === 'ship_migrations') {
      assert.ok(after === 'absent' || after >= before, `ship_migrations must not lose rows (${before} -> ${after})`);
    } else {
      assert.equal(after, before, `additive-only violated: ${table} ${before} -> ${after}`);
    }
  }
  const ledger = await db.query("SELECT id FROM ship_migrations");
  receipt.migrate.ledgerIds = ledger.map((r) => String(r.id)).sort();
  assert.ok(receipt.migrate.ledgerIds.includes('008-ship-task-requirements'), '008 must be in the ledger');

  t0 = Date.now();
  const appliedAgain = await migrate(db);
  t1 = Date.now();
  receipt.migrate.replayAppliedIds = appliedAgain;
  receipt.migrate.replayMs = t1 - t0;
  assert.deepEqual(appliedAgain, [], 'replay must apply nothing');

  const store = new NucleusTaskRequirements(db);
  t0 = Date.now();
  const base = { taskRootRunId: proofRoot, requirementId: 'req-1', statement: 'The tool must ship a single static binary.', source: 'request', sourceRunId: 'run-proof-1', createdBy: 'rehearsal' };
  const added = await store.add(base);
  assert.equal(added.created, true);
  const again = await store.add(base);
  assert.equal(again.created, false, 'identical re-add must be idempotent');
  assert.equal(again.requirement.statement, added.requirement.statement);
  let conflict;
  try { await store.add({ ...base, statement: 'A different statement under the same id.' }); } catch (e) { conflict = e; }
  assert.equal(conflict?.name, 'RequirementConflictError', 'different content under the same id must be refused');
  const second = await store.add({ taskRootRunId: proofRoot, requirementId: 'req-2', statement: 'The tool must not require a config file.', source: 'request', createdBy: 'rehearsal' });
  assert.equal(second.created, true);
  const waived = await store.waive(proofRoot, 'req-2', 'rehearsal-actor', 'superseded by req-1');
  assert.equal(waived.ok, true);
  const rewaived = await store.waive(proofRoot, 'req-2', 'rehearsal-actor', 'twice');
  assert.equal(rewaived.ok, false, 'a second waiver must be refused');
  assert.equal(rewaived.failure, 'already-waived');
  const listed = await store.list(proofRoot);
  assert.equal(listed.length, 2, 'a waived requirement stays in the list');
  assert.equal(listed.filter((r) => r.state === 'waived').length, 1);
  t1 = Date.now();
  receipt.storeProof = {
    ms: t1 - t0,
    idempotentAdd: true,
    conflictRefused: true,
    waiverExactlyOnce: true,
    waivedStaysListed: true,
    rowsCreated: 2,
  };

  await db.query('DELETE FROM ship_task_requirements WHERE task_root_run_id = $1', [proofRoot]);
  const finalCounts = await counts();
  assert.equal(finalCounts.ship_task_requirements, 0, 'only own proof rows may be removed');
  for (const [table, before] of Object.entries(receipt.tablesAfter)) {
    if (table === 'ship_task_requirements') continue;
    assert.equal(finalCounts[table], before, `cleanup touched more than its own rows: ${table}`);
  }

  receipt.pass = true;
  receipt.finishedAt = new Date().toISOString();
  receipt.tablesPopulatedBefore = populated.length;
  receipt.totalRowsBefore = Object.values(receipt.tablesBefore).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await db.close().catch(() => {});
}
