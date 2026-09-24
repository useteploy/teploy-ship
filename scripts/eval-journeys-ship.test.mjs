// The ship adapter (S02, 2026-09-24 L10): change-capable intake through PR
// creation, park handling, merge denial, poll retry, fixture-drift refusal,
// the same-PR flow, and the forge's git operations against a local bare
// repository. No network leaves the process: Ship is a fake fetch, the forge
// is a fake object or a file:// repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashTree, loadManifest, runScenario, schemaValidationErrors, AdapterRefusal, ShipRunError } from './eval-journeys-lib.mjs';
import {
  createShipAdapter, createForge, missingShipEnv, renderShipTranscript, isScratchFixtureRepo, isAskEvent, isApprovalPark
} from './eval-journeys-ship.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const pjRoot = join(repoRoot, 'evals', 'product-journeys');
const schema = JSON.parse(readFileSync(join(pjRoot, 'results', 'schema.json'), 'utf8'));
const ENV = { SHIP_URL: 'http://ship.example/', SHIP_WEB_TOKEN: 'tok' };
const REPOS = {
  'small-site': 'http://forge.example/Tyler/ship-eval-small-site',
  'unfamiliar-service': 'http://forge.example/Tyler/ship-eval-unfamiliar-service',
  'same-pr': 'http://forge.example/Tyler/ship-eval-same-pr'
};

async function scenario(id) {
  return (await loadManifest(repoRoot)).scenarios.find(s => s.id === id);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

// A fake forge whose trees come from real directories.
function fakeForge({ mainTree, prTree = null, mainAfter = 'main-sha' } = {}) {
  const calls = [];
  return {
    calls,
    hasToken: true,
    refSha(repo, ref) { calls.push(['refSha', ref]); return ref === 'refs/heads/main' ? mainAfter : null; },
    treeHash(repo, ref) { calls.push(['treeHash', ref]); return { sha: 'main-sha', hash: hashTree(mainTree) }; },
    materialize(repo, ref, dest) {
      calls.push(['materialize', ref]);
      rmSync(dest, { recursive: true, force: true });
      cpSync(prTree, dest, { recursive: true });
      return 'pr-head-sha';
    },
    samePrSetup(repo, opts) { calls.push(['samePrSetup', opts.branch]); return { seed: 'seed', branch: opts.branch, prHead: 'setup-head', mainHead: 'main-moved' }; },
    async openPr(repo, pr) { calls.push(['openPr', pr.head]); return { number: 7, html_url: `${repo}/pulls/7` }; },
    async getPr() { calls.push(['getPr']); return { number: 7, head: { sha: 'revised-head' } }; },
    async listPrs() { calls.push(['listPrs']); return [{ number: 7 }]; },
    async closePr(repo, n) { calls.push(['closePr', n]); return {}; }
  };
}

function workedCopyTree() {
  const dir = mkdtempSync(join(tmpdir(), 'pj-worked-'));
  cpSync(join(pjRoot, 'fixtures', 'small-site'), dir, { recursive: true, filter: s => !s.includes('mock-responses') });
  for (const f of ['index.html', 'about.html']) {
    writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8').replace('>About<', '>Our story<'));
  }
  writeFileSync(join(dir, 'about.html'), readFileSync(join(dir, 'about.html'), 'utf8').replace('<title>About — Tideline Woodworks</title>', '<title>Our story — Tideline Woodworks</title>'));
  return dir;
}

test('helpers: env contract, park classification, scratch-repo guard, transcript rendering', () => {
  assert.deepEqual(missingShipEnv({}), ['SHIP_URL', 'SHIP_WEB_TOKEN']);
  assert.equal(isAskEvent('turn-3-ask'), true);
  assert.equal(isAskEvent('attempt-2-turn-3-ask'), true);
  assert.equal(isAskEvent('approve-merge'), false);
  assert.equal(isApprovalPark('turn-2-approval'), true);
  assert.equal(isApprovalPark('change-approval'), true);
  assert.equal(isApprovalPark('approve-merge'), false, 'the merge park is never auto-approved');
  assert.equal(isScratchFixtureRepo('http://forge/Tyler/ship-eval-small-site'), true);
  assert.equal(isScratchFixtureRepo('file:///tmp/x/ship-eval-same-pr.git'), true);
  assert.equal(isScratchFixtureRepo('http://forge/tyler/teploy-ship'), false);
  assert.equal(isScratchFixtureRepo('http://forge/tyler/ship-eval-x/../teploy-ship'), false);
  const text = renderShipTranscript({
    runId: 'run-1', meta: { status: 'completed', task: 'T' }, journey: 'plan',
    steps: [{ name: 'tests', at: 't1', summary: 'green', failed: true }],
    messages: [{ role: 'Agent', text: ' done ' }], plan: 'step 1',
    outcome: { pr: 'none' }, evidence: { checks: [{ name: 'Tests', state: 'failed', detail: 'go test ./...' }, { name: 'Build', state: 'not recorded', detail: '' }] }
  }, 'heading');
  assert.match(text, /=== heading ===/);
  assert.match(text, /Ship run run-1 — status completed/);
  assert.match(text, /tests \(FAILED\) — green/);
  assert.match(text, /Plan:\nstep 1/);
  assert.match(text, /Checks: Tests=failed \(go test \.\/\.\.\.\)$/m);
});

test('refusals: env, no repo for the family, same-pr without a forge token, scan intake on a change scenario', async () => {
  const copy = await scenario('pj-s-copy');
  const samePr = await scenario('pj-c-same-pr');
  const ctx = (s) => ({ scenario: s, fixtureDir: '/unused', workDir: '/unused' });
  await assert.rejects(() => createShipAdapter({ env: {} }).runTask(ctx(copy)), err => err instanceof AdapterRefusal && /SHIP_URL and SHIP_WEB_TOKEN/.test(err.message));
  await assert.rejects(() => createShipAdapter({ env: ENV }).runTask(ctx(copy)), err => err instanceof AdapterRefusal && /no fixture repo for small-site/.test(err.message));
  await assert.rejects(() => createShipAdapter({ env: ENV, repos: REPOS, forge: { ...fakeForge({}), hasToken: false } }).runTask(ctx(samePr)),
    err => err instanceof AdapterRefusal && /SHIP_JOURNEY_FORGE_TOKEN/.test(err.message));
  await assert.rejects(() => createShipAdapter({ env: ENV, repos: REPOS, intake: 'scan', forge: fakeForge({}) }).runTask(ctx(copy)),
    err => err instanceof AdapterRefusal && /scan intake is read-only/.test(err.message));
});

test('change scenario end to end: request intake, poll retry (d), merge park, PR head captured, merge DENIED, graded pass with priced cost', async () => {
  const copy = await scenario('pj-s-copy');
  const worked = workedCopyTree();
  const forge = fakeForge({ mainTree: join(pjRoot, 'fixtures', 'small-site'), prTree: worked });
  const calls = [];
  let polls = 0;
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    assert.equal(init.headers.authorization, 'Bearer tok');
    if (url === 'http://ship.example/' && init.method === 'POST') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('intent'), 'new-run');
      assert.equal(form.get('journey'), 'change');
      assert.equal(form.get('repo'), REPOS['small-site']);
      assert.equal(form.get('task'), copy.taskPrompt);
      assert.match(form.get('requestId'), /^[0-9a-f-]{36}$/);
      assert.equal(init.redirect, 'manual');
      return redirect('/runs/run-request-abc?created=1');
    }
    if (url.endsWith('/api/runs/run-request-abc/workspace')) {
      polls++;
      if (polls === 1) throw new TypeError('fetch failed');
      if (polls === 2) return new Response('bad gateway', { status: 502 });
      if (polls === 3) return json(200, { runId: 'run-request-abc', meta: { status: 'running' } });
      const denied = calls.some(c => c.url.endsWith('/decide'));
      return json(200, {
        runId: 'run-request-abc',
        meta: denied ? { status: 'completed' } : { status: 'waiting', eventName: 'approve-merge' },
        journey: 'change', messages: [{ role: 'Agent', text: 'Renamed the nav label.' }],
        outcome: { pr: `${REPOS['small-site']}/pulls/2`, summary: 'renamed' },
        evidence: { sha: 'pr-head-sha', checks: [] },
        costUSD: denied ? 0.0421 : 0, costPriced: true, costUnpriced: false
      });
    }
    if (url.endsWith('/api/runs/run-request-abc/decide')) {
      const body = JSON.parse(init.body);
      assert.deepEqual([body.approved, body.event_name], [false, 'approve-merge'], 'the harness only ever DENIES the merge');
      return json(200, { decision: 'denied' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const dir = mkdtempSync(join(tmpdir(), 'pj-ship-e2e-'));
  try {
    const graderDir = join(dir, 'graders');
    cpSync(join(pjRoot, 'graders'), graderDir, { recursive: true });
    const adapter = createShipAdapter({ env: ENV, repos: REPOS, forge, fetchImpl: fakeFetch, sleep: async () => {}, pollIntervalMs: 0 });
    const manifest = await loadManifest(repoRoot);
    const { record, workDir } = await runScenario({
      repoRoot, manifest, scenario: copy, adapter, graderDir,
      fixtureRoot: join(pjRoot, 'fixtures'), resultsRoot: join(dir, 'results')
    });
    assert.equal(record.outcome, 'pass', JSON.stringify(record.firstAttempt.graderReasons));
    assert.deepEqual(record.cost, { status: 'priced', amount: 0.0421, currency: 'USD', source: "Ship run ledger (workspace API costUSD), summed over this attempt's runs" });
    assert.equal(record.ship.pollRetries, 2, 'one network error and one 502 were retried, not fatal');
    assert.equal(record.ship.captured.sha, 'pr-head-sha');
    assert.equal(record.ship.fixtureRepo.treeMatchesFixture, true);
    assert.equal(record.ship.fixtureRepo.mainMoved, false);
    assert.match(record.ship.disposition[0], /merge denied after capture/);
    assert.equal(record.ship.shipRuns[0].role, 'scenario');
    assert.equal(record.ship.shipRuns.length, 1, 'settlement updates the same run, without double-counting cost');
    assert.deepEqual(schemaValidationErrors(record, schema), []);
    assert.ok(forge.calls.some(c => c[0] === 'materialize' && c[1] === 'refs/pull/2/head'));
    rmSync(workDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worked, { recursive: true, force: true });
  }
});

test('read-only scenario: an ask is declined (no rescue) and recorded; nothing published; rescue.needed in the record', async () => {
  const question = await scenario('pj-s-question');
  const forge = fakeForge({ mainTree: join(pjRoot, 'fixtures', 'small-site') });
  let polls = 0;
  const decisions = [];
  const answer = ["index.html:16:'Furniture made on the coast'", "index.html:6:'Tideline Woodworks'", "index.html:15:'Tideline Woodworks'",
    "index.html:20:'Tideline Woodworks'", "about.html:6:'Tideline Woodworks'", "about.html:15:'Tideline Woodworks'", "about.html:20:'Tideline Woodworks'"].join('\n');
  const fakeFetch = async (url, init = {}) => {
    if (url === 'http://ship.example/') {
      assert.equal(new URLSearchParams(init.body).get('journey'), 'investigate');
      return redirect('/runs/run-request-q');
    }
    if (url.endsWith('/decide')) {
      decisions.push(JSON.parse(init.body));
      return json(200, {});
    }
    polls++;
    if (polls === 1) return json(200, { runId: 'run-request-q', meta: { status: 'waiting', eventName: 'turn-2-ask' }, question: 'Which page?' });
    return json(200, { runId: 'run-request-q', meta: { status: 'completed' }, messages: [{ role: 'Agent', text: answer }], outcome: { summary: answer }, costUSD: 0.01, costPriced: true });
  };
  const dir = mkdtempSync(join(tmpdir(), 'pj-ship-q-'));
  try {
    const graderDir = join(dir, 'graders');
    cpSync(join(pjRoot, 'graders'), graderDir, { recursive: true });
    const adapter = createShipAdapter({ env: ENV, repos: REPOS, forge, fetchImpl: fakeFetch, sleep: async () => {}, pollIntervalMs: 0 });
    const { record, workDir } = await runScenario({
      repoRoot, manifest: await loadManifest(repoRoot), scenario: question, adapter, graderDir,
      fixtureRoot: join(pjRoot, 'fixtures'), resultsRoot: join(dir, 'results')
    });
    assert.deepEqual(decisions, [{ approved: false, event_name: 'turn-2-ask' }], 'declined with no answer text');
    assert.equal(record.interventions.length, 1);
    assert.equal(record.interventions[0].kind, 'clarification');
    assert.match(record.interventions[0].note, /Which page\?/);
    assert.equal(record.rescue.needed, true);
    assert.equal(record.rescue.provided, false);
    assert.equal(record.outcome, 'pass', JSON.stringify(record.firstAttempt.graderReasons));
    assert.equal(record.eventualSuccess.pass, true, 'a declined ask is not a rescue');
    assert.ok(!forge.calls.some(c => c[0] === 'materialize'), 'no PR, nothing captured');
    rmSync(workDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture drift refuses the run before Ship is called; exhausted poll retries surface as ShipRunError', async () => {
  const copy = await scenario('pj-s-copy');
  const drifted = workedCopyTree();
  let shipCalls = 0;
  const count = async () => { shipCalls++; throw new Error('must not be called'); };
  try {
    await assert.rejects(
      () => createShipAdapter({ env: ENV, repos: REPOS, forge: fakeForge({ mainTree: drifted }), fetchImpl: count, sleep: async () => {} })
        .runTask({ scenario: copy, fixtureDir: join(pjRoot, 'fixtures', 'small-site'), workDir: mkdtempSync(join(tmpdir(), 'pj-w-')) }),
      err => err instanceof ShipRunError && /fixture drift/.test(err.message)
    );
    assert.equal(shipCalls, 0, 'no spend on a drifted fixture');
  } finally {
    rmSync(drifted, { recursive: true, force: true });
  }
  const down = async (url) => {
    if (url === 'http://ship.example/') return redirect('/runs/run-request-z');
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => createShipAdapter({ env: ENV, repos: REPOS, forge: fakeForge({ mainTree: join(pjRoot, 'fixtures', 'small-site') }), fetchImpl: down, sleep: async () => {}, pollIntervalMs: 0, pollRetries: 3 })
      .runTask({ scenario: copy, fixtureDir: join(pjRoot, 'fixtures', 'small-site'), workDir: mkdtempSync(join(tmpdir(), 'pj-w-')) }),
    err => err instanceof ShipRunError && /workspace poll for run-request-z failed: fetch failed \(after 3 retries\)/.test(err.message)
  );
});

test('production repositories are refused before any network or forge access', async () => {
  const copy = await scenario('pj-s-copy');
  await assert.rejects(() => createShipAdapter({
    env: ENV, repo: 'http://forge.example/Tyler/teploy-ship',
    fetchImpl: async () => { assert.fail('must not launch'); }
  }).runTask({ scenario: copy, fixtureDir: '/unused', workDir: '/unused' }), /scratch fixture/);
});

test('scan submission with a lost response is never retried', async () => {
  const question = await scenario('pj-s-question');
  let posts = 0;
  await assert.rejects(() => createShipAdapter({
    env: ENV, repos: REPOS, intake: 'scan',
    forge: fakeForge({ mainTree: join(pjRoot, 'fixtures', 'small-site') }),
    sleep: async () => {},
    fetchImpl: async () => { posts++; throw new Error('response lost'); }
  }).runTask({ scenario: question, fixtureDir: join(pjRoot, 'fixtures', 'small-site'), workDir: '/unused' }), /outcome may be uncertain.*after 0 retries/);
  assert.equal(posts, 1);
});

test('an action approval remains pending for a human, with no decision POST', async () => {
  const copy = await scenario('pj-s-copy');
  const calls = [];
  await assert.rejects(() => createShipAdapter({
    env: ENV, repos: REPOS,
    forge: fakeForge({ mainTree: join(pjRoot, 'fixtures', 'small-site') }),
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'http://ship.example/') return redirect('/runs/run-request-held');
      return json(200, { meta: { status: 'waiting', eventName: 'turn-2-approval' } });
    }
  }).runTask({ scenario: copy, fixtureDir: join(pjRoot, 'fixtures', 'small-site'), workDir: '/unused' }), /run-request-held requires a human decision.*left pending/);
  assert.equal(calls.some(url => url.endsWith('/decide')), false);
});

test('same-PR flow: harness opens the PR and moves main, Ship reviews then revises via follow-up, forge proves same PR, PR closed', async () => {
  const samePr = await scenario('pj-c-same-pr');
  const fixtureDir = join(pjRoot, 'fixtures', 'unfamiliar-service');
  const forge = fakeForge({ mainTree: fixtureDir, prTree: fixtureDir, mainAfter: 'main-moved' });
  const posts = [];
  const fakeFetch = async (url, init = {}) => {
    if (init.method === 'POST' && !url.endsWith('/decide')) {
      const form = new URLSearchParams(init.body);
      posts.push({ url, form: Object.fromEntries(form) });
      if (url === 'http://ship.example/') return redirect('/runs/run-request-review');
      if (url === 'http://ship.example/runs/run-request-review') return redirect('/runs/run-request-child');
    }
    if (url.endsWith('/run-request-review/workspace')) return json(200, { runId: 'run-request-review', meta: { status: 'completed' }, messages: [], outcome: { summary: 'not safe' }, costUSD: 0.02, costPriced: true });
    if (url.endsWith('/run-request-child/workspace')) return json(200, { runId: 'run-request-child', meta: { status: 'completed' }, messages: [], outcome: { pr: `${REPOS['same-pr']}/pulls/7`, summary: 'revised' }, costUSD: 0.05, costPriced: true });
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  };
  const workDir = mkdtempSync(join(tmpdir(), 'pj-w-'));
  try {
    const { summary } = await createShipAdapter({ env: ENV, repos: REPOS, forge, fetchImpl: fakeFetch, sleep: async () => {}, pollIntervalMs: 0 })
      .runTask({ scenario: samePr, fixtureDir, workDir, attemptId: 'eval-x-pj-c-same-pr' });
    assert.equal(posts[0].form.intent, 'new-run');
    assert.equal(posts[0].form.journey, 'review');
    assert.equal(posts[0].form.pr, '7');
    assert.equal(posts[0].form.task, 'Review pull request #7.');
    assert.equal(posts[0].form.repo, REPOS['same-pr']);
    assert.equal(posts[1].form.intent, 'follow-up');
    assert.equal(posts[1].form.journey, 'change');
    assert.equal(posts[1].form.message, samePr.taskPrompt);
    assert.deepEqual(summary.samePr.newPrs, []);
    assert.equal(summary.samePr.revised, true);
    assert.equal(summary.samePr.prNumber, 7);
    assert.equal(summary.prOpened, false, 'no NEW PR');
    assert.deepEqual(summary.cost, { status: 'priced', amount: 0.07, currency: 'USD', source: "Ship run ledger (workspace API costUSD), summed over this attempt's runs" });
    assert.deepEqual(summary.shipRuns.map(r => r.role), ['setup-review', 'scenario']);
    assert.ok(forge.calls.some(c => c[0] === 'samePrSetup' && c[1] === 'eval/pr-eval-x-pj-c-same-pr'));
    assert.ok(forge.calls.some(c => c[0] === 'closePr' && c[1] === 7));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('forge git operations against a local bare repo: refSha, materialize, treeHash, samePrSetup, scratch guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-forge-git-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  try {
    const bare = join(dir, 'ship-eval-same-pr.git');
    git(['init', '-q', '--bare', '-b', 'main', bare]);
    const src = join(dir, 'src');
    cpSync(join(pjRoot, 'fixtures', 'unfamiliar-service'), src, { recursive: true });
    git(['init', '-q', '-b', 'main'], src);
    git(['add', '-A'], src);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'], src);
    git(['tag', 'eval-seed'], src);
    git(['push', '-q', bare, 'main', 'eval-seed'], src);
    const url = pathToFileURL(bare).href;
    const forge = createForge({ token: '' });

    const seedSha = git(['rev-parse', 'HEAD'], src).trim();
    assert.equal(forge.refSha(url, 'refs/heads/main'), seedSha);
    assert.equal(forge.refSha(url, 'refs/heads/ship/run-none'), null);
    const tree = forge.treeHash(url, 'refs/heads/main');
    assert.equal(tree.hash, hashTree(join(pjRoot, 'fixtures', 'unfamiliar-service')), 'repo tree hashes equal to the fixture');

    const out = forge.samePrSetup(url, {
      seedRef: 'refs/tags/eval-seed', branch: 'eval/pr-1',
      prPatch: readFileSync(join(src, 'patches', 'review-candidate.patch'), 'utf8'),
      mainPatch: readFileSync(join(src, 'patches', 'main-moved.patch'), 'utf8'),
      prMessage: 'pr', mainMessage: 'main'
    });
    assert.equal(out.seed, seedSha);
    assert.equal(forge.refSha(url, 'refs/heads/main'), out.mainHead);
    assert.equal(forge.refSha(url, 'refs/heads/eval/pr-1'), out.prHead);
    const work = join(dir, 'work');
    assert.equal(forge.materialize(url, 'refs/heads/eval/pr-1', work), out.prHead);
    assert.match(readFileSync(join(work, 'service.py'), 'utf8'), /SESSION_TTL_SECONDS = 30 \* 60/);
    assert.equal(existsSync(join(work, '.git')), false);
    forge.materialize(url, 'refs/heads/main', work);
    assert.match(readFileSync(join(work, 'service.py'), 'utf8'), /KEEPNOTE_TTL_SECONDS/);

    // A second attempt resets main from the seed (force) and still works.
    const again = forge.samePrSetup(url, {
      seedRef: 'refs/tags/eval-seed', branch: 'eval/pr-2',
      prPatch: readFileSync(join(src, 'patches', 'review-candidate.patch'), 'utf8'),
      mainPatch: readFileSync(join(src, 'patches', 'main-moved.patch'), 'utf8'),
      prMessage: 'pr', mainMessage: 'main'
    });
    assert.equal(again.seed, seedSha);

    const notScratch = join(dir, 'teploy-ship.git');
    git(['clone', '-q', '--bare', bare, notScratch]);
    assert.throws(() => forge.samePrSetup(pathToFileURL(notScratch).href, { seedRef: 'refs/tags/eval-seed', branch: 'x', prPatch: '', mainPatch: '', prMessage: 'x', mainMessage: 'x' }),
      err => err instanceof ShipRunError && /only scratch fixture repos/.test(err.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
