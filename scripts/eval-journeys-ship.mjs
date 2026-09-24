// The ship adapter for the S02 product-journey harness: drives a REAL Ship
// instance over HTTP through the same surfaces a person uses, against
// scratch fixture repositories on a forge, and hands the resulting tree back
// to the runner for out-of-tree grading.
//
// Surfaces (all bearer-authenticated; a bearer caller passes Ship's CSRF gate
// because it sends no Origin):
//   POST $SHIP_URL/                         intent=new-run  (the composer's form)
//   POST $SHIP_URL/runs/<id>                intent=follow-up (same-PR revision)
//   GET  $SHIP_URL/api/runs/<id>/workspace  status, transcript, PR, cost
//   POST $SHIP_URL/api/runs/<id>/decide     park decisions
//   POST $SHIP_URL/api/runs/scan            legacy read-only intake (--ship-intake scan)
//
// Safety rules enforced here, not by convention:
//   - Every forge WRITE (push, PR create/close) refuses unless the repository
//     name is a scratch fixture (`ship-eval-*`).
//   - A run parked at the merge boundary is DENIED after its tree is captured.
//     The harness never approves a merge; Ship closes the PR on denial.
//   - Before a run, the fixture repo's main must be byte-identical to the
//     pristine fixture (drift refuses the run before any spend); after it,
//     main must not have moved (recorded loudly if it did).
//   - Asks are declined (no answer given): the baseline measures success
//     without rescue. Other approval parks remain pending for a person; the
//     harness never grants authority on their behalf.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRefusal, ShipRunError, hashTree } from './eval-journeys-lib.mjs';

export const SHIP_ENV_CONTRACT = ['SHIP_URL', 'SHIP_WEB_TOKEN'];
export const JOURNEYS = ['change', 'investigate', 'plan', 'review'];
export const MERGE_EVENT = 'approve-merge';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function missingShipEnv(env) {
  return SHIP_ENV_CONTRACT.filter(k => !String(env?.[k] ?? '').trim());
}

export function isAskEvent(name) {
  return typeof name === 'string' && /^(attempt-\d+-)?turn-\d+-ask$/.test(name);
}

// Mid-run approval parks a person would decide in the product. Approving
// them is not rescue (no information is given to the agent), but it is an
// intervention and is recorded as one.
export function isApprovalPark(name) {
  return typeof name === 'string'
    && (/^(attempt-\d+-)?turn-\d+-approval$/.test(name) || name === 'change-approval' || name === 'plan-approval');
}

export function isScratchFixtureRepo(url) {
  return /\/ship-eval-[a-z0-9-]+(\.git)?\/?$/.test(String(url));
}

function defaultSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// A network failure or a gateway-class status is transient: the run lives on
// in Ship whatever the poll saw. Found live 2026-09-24 (eval-20260924-10):
// one "fetch failed" under load turned a completed Ship run into a
// harness-error with no transcript.
export function isTransientStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function renderShipTranscript(data, heading = null) {
  const lines = [];
  if (heading) lines.push(`=== ${heading} ===`);
  lines.push(`Ship run ${data?.runId ?? '?'} — status ${data?.meta?.status ?? 'unknown'}`);
  if (data?.meta?.task) lines.push(`Task: ${data.meta.task}`);
  if (data?.journey) lines.push(`Journey: ${data.journey}`);
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  if (steps.length > 0) {
    lines.push('Steps:');
    for (const s of steps) lines.push(`  ${s.at ?? ''} ${s.name ?? '?'}${s.failed ? ' (FAILED)' : ''} — ${s.summary ?? ''}`.replace(/\s+$/, ''));
  }
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  if (messages.length > 0) {
    lines.push('Messages:');
    for (const m of messages) lines.push(`  ${m.role ?? '?'}: ${String(m.text ?? '').trim()}`);
  }
  if (typeof data?.plan === 'string' && data.plan.trim() !== '') lines.push(`Plan:\n${data.plan.trim()}`);
  if (data?.outcome && Object.keys(data.outcome).length > 0) lines.push(`Outcome: ${JSON.stringify(data.outcome)}`);
  for (const item of Array.isArray(data?.items) ? data.items : []) {
    if (item.kind === 'error') lines.push(`Error: ${item.title ?? ''} — ${item.body ?? ''}`);
  }
  const checks = Array.isArray(data?.evidence?.checks) ? data.evidence.checks.filter(c => c.state !== 'not recorded') : [];
  if (checks.length > 0) lines.push(`Checks: ${checks.map(c => `${c.name}=${c.state}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`);
  return lines.join('\n') + '\n';
}

// ── forge: git + Forgejo API, token never on argv ───────────────────────

function defaultRunGit(args, { cwd, env } = {}) {
  return execFileSync('git', args, {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
  }).toString();
}

export function parseRepoUrl(url) {
  const u = new URL(String(url).replace(/\.git$/, '').replace(/\/+$/, ''));
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`not an owner/name repository URL: ${url}`);
  return { origin: u.origin, owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

function clearDir(dir) {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

export function createForge({ token = '', runGit = defaultRunGit, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const gitEnv = token
    ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: token ${token}` }
    : {};
  const git = (args, cwd) => runGit(args, { cwd, env: gitEnv });
  const ident = ['-c', 'user.name=S02 eval harness', '-c', 'user.email=eval-harness@localhost', '-c', 'commit.gpgsign=false'];

  function assertScratch(repo, what) {
    if (!isScratchFixtureRepo(repo)) throw new ShipRunError(`refusing to ${what} on ${repo}: only scratch fixture repos (ship-eval-*) may be written by the harness`);
  }

  function scratchGit() {
    const dir = mkdtempSync(join(tmpdir(), 'pj-forge-'));
    git(['init', '-q'], dir);
    return dir;
  }

  const forge = {
    hasToken: token !== '',

    /** sha of a ref on the remote, or null when it does not exist. */
    refSha(repo, ref) {
      const out = git(['ls-remote', repo, ref]).trim();
      const line = out.split('\n').find(l => l.endsWith(`\t${ref}`));
      return line ? line.split('\t')[0] : null;
    },

    /** Replace `dest`'s contents with the tree at `ref` (no .git). Returns the fetched sha. */
    materialize(repo, ref, dest) {
      const dir = scratchGit();
      try {
        git(['fetch', '-q', '--depth', '1', repo, ref], dir);
        const sha = git(['rev-parse', 'FETCH_HEAD'], dir).trim();
        const tar = join(dir, 'tree.tar');
        git(['archive', '--format=tar', '-o', tar, 'FETCH_HEAD'], dir);
        mkdirSync(dest, { recursive: true });
        clearDir(dest);
        execFileSync('tar', ['-xf', tar, '-C', dest]);
        return sha;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /** Hash of the remote tree at ref, comparable with the runner's fixtureRevision. */
    treeHash(repo, ref) {
      const dest = mkdtempSync(join(tmpdir(), 'pj-tree-'));
      try {
        const sha = forge.materialize(repo, ref, dest);
        return { sha, hash: hashTree(dest) };
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    },

    /**
     * Same-PR setup on a scratch repo: reset main to the seed tag, push a PR
     * branch carrying `prPatch`, then move main by committing `mainPatch`.
     * Returns { seed, branch, prHead, mainHead }.
     */
    samePrSetup(repo, { seedRef, branch, prPatch, mainPatch, prMessage, mainMessage }) {
      assertScratch(repo, 'reset main and push a setup branch');
      const dir = scratchGit();
      try {
        git(['fetch', '-q', repo, `${seedRef}:refs/eval/seed`], dir);
        const seed = git(['rev-parse', 'refs/eval/seed^{commit}'], dir).trim();
        git(['checkout', '-q', '--detach', seed], dir);
        writeFileSync(join(dir, '.pr.patch'), prPatch);
        git(['apply', '.pr.patch'], dir);
        rmSync(join(dir, '.pr.patch'));
        git([...ident, 'commit', '-q', '-am', prMessage], dir);
        const prHead = git(['rev-parse', 'HEAD'], dir).trim();
        git(['checkout', '-q', '--detach', seed], dir);
        writeFileSync(join(dir, '.main.patch'), mainPatch);
        git(['apply', '.main.patch'], dir);
        rmSync(join(dir, '.main.patch'));
        git([...ident, 'commit', '-q', '-am', mainMessage], dir);
        const mainHead = git(['rev-parse', 'HEAD'], dir).trim();
        // The seed first (force: the previous attempt moved main), then the
        // branch, then main fast-forwards over the seed.
        git(['push', '-q', '--force', repo, `${seed}:refs/heads/main`], dir);
        git(['push', '-q', '--force', repo, `${prHead}:refs/heads/${branch}`], dir);
        git(['push', '-q', repo, `${mainHead}:refs/heads/main`], dir);
        return { seed, branch, prHead, mainHead };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async api(method, repo, path, body) {
      if (!token) throw new ShipRunError('forge API calls need SHIP_JOURNEY_FORGE_TOKEN');
      if (method !== 'GET') assertScratch(repo, `${method} ${path}`);
      const { origin, owner, name } = parseRepoUrl(repo);
      const res = await fetchImpl(`${origin}/api/v1/repos/${owner}/${name}${path}`, {
        method,
        headers: { authorization: `token ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      const text = await res.text();
      if (res.status >= 300) throw new ShipRunError(`forge ${method} ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },

    openPr(repo, { head, base, title, body }) {
      return forge.api('POST', repo, '/pulls', { head, base, title, body });
    },
    getPr(repo, number) {
      return forge.api('GET', repo, `/pulls/${number}`);
    },
    listPrs(repo) {
      return forge.api('GET', repo, '/pulls?state=all&limit=50&sort=newest');
    },
    closePr(repo, number) {
      return forge.api('PATCH', repo, `/pulls/${number}`, { state: 'closed' });
    }
  };
  return forge;
}

// ── the adapter ──────────────────────────────────────────────────────────

function resolveRepos(env, repos, repo) {
  const map = { ...(repos ?? {}) };
  const fromEnv = String(env?.SHIP_JOURNEY_REPOS ?? '').trim();
  if (fromEnv) {
    try {
      Object.assign(map, JSON.parse(fromEnv));
    } catch (err) {
      throw new AdapterRefusal(`SHIP_JOURNEY_REPOS is not JSON: ${err.message}`);
    }
  }
  const single = repo ?? String(env?.SHIP_JOURNEY_REPO ?? '').trim();
  return { map, single: single || null };
}

export function createShipAdapter({
  env = process.env, fetchImpl = globalThis.fetch.bind(globalThis), sleep = defaultSleep,
  repo = null, repos = null, intake = 'request', forge = null,
  pollIntervalMs = 10000, timeoutMs = 120 * 60 * 1000, pollRetries = 8, settleTimeoutMs = 10 * 60 * 1000
} = {}) {
  return {
    name: 'ship',
    async runTask({ scenario, fixtureDir, workDir, transcriptDir, attemptId = randomUUID().slice(0, 8) }) {
      const missing = missingShipEnv(env);
      if (missing.length > 0) {
        throw new AdapterRefusal('SHIP_URL and SHIP_WEB_TOKEN must both be set (and the run must pass --i-authorize-spend, which the runner enforces before this point)');
      }
      const { map, single } = resolveRepos(env, repos, repo);
      const repoKey = scenario.ship?.repoKey ?? scenario.family;
      const repoUrl = map[repoKey] ?? single;
      if (!repoUrl) {
        throw new AdapterRefusal(`no fixture repo for ${repoKey}: set SHIP_JOURNEY_REPOS (JSON family->url) or pass --ship-repos <file> / --ship-repo <url>`);
      }
      if (!isScratchFixtureRepo(repoUrl)) throw new AdapterRefusal('evaluation runs require a scratch fixture repository named ship-eval-*');
      const journey = scenario.ship?.journey;
      if (!JOURNEYS.includes(journey)) throw new AdapterRefusal(`${scenario.id} declares no ship.journey (one of ${JOURNEYS.join(', ')})`);
      const setup = scenario.ship?.setup ?? null;
      const f = forge ?? createForge({ token: String(env.SHIP_JOURNEY_FORGE_TOKEN ?? '').trim(), fetchImpl });
      if (setup?.kind === 'same-pr' && !f.hasToken) throw new AdapterRefusal('the same-pr setup opens a PR through the forge API: set SHIP_JOURNEY_FORGE_TOKEN');
      if (intake === 'scan' && journey === 'change') throw new AdapterRefusal(`${scenario.id} changes code; the scan intake is read-only — use --ship-intake request`);

      const base = String(env.SHIP_URL).trim().replace(/\/+$/, '');
      const auth = { authorization: `Bearer ${String(env.SHIP_WEB_TOKEN).trim()}` };
      const interventions = [];
      const shipRuns = [];
      let pollRetriesUsed = 0;

      // One HTTP call with bounded retry on transient failure. `idempotent`
      // gates retrying a POST: only requests whose replay is harmless retry.
      async function call(path, init = {}, { idempotent = true, what = path } = {}) {
        let lastErr = null;
        let retries = 0;
        for (let attempt = 0; attempt <= pollRetries; attempt++) {
          if (attempt > 0) {
            pollRetriesUsed++;
            retries++;
            await sleep(Math.min(60000, 2000 * 2 ** (attempt - 1)));
          }
          let res;
          try {
            res = await fetchImpl(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...init, headers: { ...auth, ...(init.headers ?? {}) } });
          } catch (err) {
            lastErr = new ShipRunError(`${what} failed: ${err.message}`);
            if (!idempotent) break;
            continue;
          }
          if (isTransientStatus(res.status) && idempotent) {
            lastErr = new ShipRunError(`${what} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            continue;
          }
          return res;
        }
        throw new ShipRunError(`${lastErr.message} (after ${retries} retries)`);
      }

      async function form(path, fields, what) {
        // requestId makes a replay land on the same run (Ship derives the run
        // id from it), so retrying the POST is safe.
        const res = await call(path, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString()
        }, { what });
        const location = res.headers.get('location') ?? '';
        const m = location.match(/^\/runs\/(run-[A-Za-z0-9-]+)(?:\?|$)/);
        if ((res.status === 302 || res.status === 303) && m) return m[1];
        const err = new URL(location || '/', 'http://x').searchParams;
        const reason = err.get('error') ?? err.get('messageError') ?? (err.get('denied') ? `denied: ${err.get('denied')}` : null);
        throw new ShipRunError(`${what} rejected: HTTP ${res.status}${reason ? ` — ${reason}` : ''}${location ? ` (location ${location})` : ` ${(await res.text()).slice(0, 300)}`}`);
      }

      async function launch({ task, journey: j, pr }) {
        if (intake === 'scan') {
          const res = await call('/api/runs/scan', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ repo: repoUrl, task, source: 'product-journey' })
          }, { what: 'scan intake (outcome may be uncertain; inspect Ship before submitting again)', idempotent: false });
          const text = await res.text();
          if (res.status !== 202) throw new ShipRunError(`intake rejected: HTTP ${res.status} ${text.slice(0, 500)}`);
          const id = JSON.parse(text).run;
          if (!id) throw new ShipRunError(`intake returned 202 without a run id: ${text.slice(0, 500)}`);
          return id;
        }
        return form('/', {
          intent: 'new-run', task, repo: repoUrl, journey: j, requestId: randomUUID(),
          ...(pr !== undefined ? { pr: String(pr) } : {})
        }, 'request intake');
      }

      async function workspace(runId) {
        const res = await call(`/api/runs/${runId}/workspace`, {}, { what: `workspace poll for ${runId}` });
        if (res.status !== 200) throw new ShipRunError(`workspace poll for ${runId} returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        return res.json();
      }

      async function decide(runId, eventName, approved, reason) {
        const res = await call(`/api/runs/${runId}/decide`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved, event_name: eventName, ...(reason ? { reason } : {}) })
        }, { what: `decide ${eventName} on ${runId}` });
        const text = await res.text();
        // 409 = someone (or a replay of this call) already decided: fine.
        if (res.status !== 200 && res.status !== 409) throw new ShipRunError(`decide ${eventName} on ${runId} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      // Poll to a terminal status, or to the merge park when stopAtMerge.
      async function awaitRun(runId, { stopAtMerge, limitMs = timeoutMs }) {
        const deadline = Date.now() + limitMs;
        const decided = new Set();
        for (;;) {
          await sleep(pollIntervalMs);
          const data = await workspace(runId);
          const status = data?.meta?.status;
          const event = data?.meta?.eventName;
          if (TERMINAL.has(status)) return { data, parkedAtMerge: false };
          if (status === 'waiting' && event === MERGE_EVENT && stopAtMerge) return { data, parkedAtMerge: true };
          if (status === 'waiting' && event && !decided.has(event)) {
            if (isAskEvent(event)) {
              decided.add(event);
              await decide(runId, event, false);
              interventions.push({ kind: 'clarification', at: new Date().toISOString(), by: 'harness', note: `${runId} asked; declined without an answer (no-rescue baseline): ${String(data.question ?? '').slice(0, 500)}` });
            } else if (isApprovalPark(event)) {
              throw new ShipRunError(`${runId} requires a human decision on ${event}; left pending without approval`);
            }
          }
          if (Date.now() >= deadline) throw new ShipRunError(`${runId} did not settle within ${limitMs}ms (last status: ${status}${event ? `, waiting on ${event}` : ''})`);
        }
      }

      function record(role, runId, data, t0) {
        const result = {
          role, runId, journey: data?.journey ?? null, status: data?.meta?.status ?? 'unknown',
          latencyMs: Date.now() - t0,
          costUSD: typeof data?.costUSD === 'number' ? data.costUSD : null,
          costPriced: TERMINAL.has(data?.meta?.status) && data?.costPriced === true && data?.costUnpriced !== true,
          pr: data?.outcome?.pr ?? null
        };
        const index = shipRuns.findIndex(r => r.runId === runId);
        if (index < 0) shipRuns.push(result);
        else shipRuns[index] = result;
      }

      const transcripts = [];
      let fixtureRepo = { url: repoUrl };
      let samePr = null;
      let captured = { sha: null, source: 'none' };
      let disposition = [];
      let finalRunId = null;
      let finalData = null;
      let prOpened = false;

      // 1. The fixture repo must be exactly the fixture before anything spends.
      const fixtureHash = hashTree(fixtureDir);
      if (setup?.kind === 'same-pr') {
        const seedRef = setup.seedRef ?? 'refs/tags/eval-seed';
        const seed = f.treeHash(repoUrl, seedRef);
        if (seed.hash !== fixtureHash) throw new ShipRunError(`fixture drift: ${repoUrl} ${seedRef} (${seed.sha}) is ${seed.hash}, fixture is ${fixtureHash}`);
        const branch = `eval/pr-${attemptId}`;
        const prepared = f.samePrSetup(repoUrl, {
          seedRef, branch,
          prPatch: readFileSync(join(fixtureDir, setup.prPatch), 'utf8'),
          mainPatch: readFileSync(join(fixtureDir, setup.mainPatch), 'utf8'),
          prMessage: setup.prTitle, mainMessage: setup.mainTitle
        });
        const pr = await f.openPr(repoUrl, { head: branch, base: 'main', title: setup.prTitle, body: setup.prBody ?? setup.prTitle });
        samePr = { prNumber: pr.number, prUrl: pr.html_url ?? pr.url, branch, setupHead: prepared.prHead, mainHead: prepared.mainHead, seed: prepared.seed };
        fixtureRepo = { url: repoUrl, head: prepared.seed, ref: seedRef, treeMatchesFixture: true, movedMainTo: prepared.mainHead };
      } else {
        const main = f.treeHash(repoUrl, 'refs/heads/main');
        if (main.hash !== fixtureHash) throw new ShipRunError(`fixture drift: ${repoUrl} main (${main.sha}) is ${main.hash}, fixture is ${fixtureHash}`);
        fixtureRepo = { url: repoUrl, head: main.sha, ref: 'refs/heads/main', treeMatchesFixture: true };
      }

      // 2. Run the scenario through the product.
      if (setup?.kind === 'same-pr') {
        const tr = Date.now();
        const reviewId = await launch({ task: setup.reviewTask.replaceAll('{pr}', String(samePr.prNumber)), journey: 'review', pr: samePr.prNumber });
        const review = await awaitRun(reviewId, { stopAtMerge: false });
        record('setup-review', reviewId, review.data, tr);
        transcripts.push(renderShipTranscript(review.data, `setup: review of PR #${samePr.prNumber} (${reviewId})`));
        const before = new Set((await f.listPrs(repoUrl)).map(p => p.number));
        const tc = Date.now();
        finalRunId = await form(`/runs/${reviewId}`, {
          intent: 'follow-up', message: scenario.taskPrompt, journey: 'change', requestId: randomUUID()
        }, 'follow-up intake');
        const child = await awaitRun(finalRunId, { stopAtMerge: true });
        finalData = child.data;
        record('scenario', finalRunId, child.data, tc);
        transcripts.push(renderShipTranscript(child.data, `scenario: same-PR revision (${finalRunId})`));
        const after = await f.getPr(repoUrl, samePr.prNumber);
        const created = (await f.listPrs(repoUrl)).filter(p => !before.has(p.number));
        samePr = {
          ...samePr,
          headAfter: after?.head?.sha ?? null,
          revised: (after?.head?.sha ?? samePr.setupHead) !== samePr.setupHead,
          runPr: child.data?.outcome?.pr ?? null,
          newPrs: created.map(p => ({ number: p.number, head: p.head?.ref ?? null, url: p.html_url ?? null }))
        };
        captured = { sha: f.materialize(repoUrl, `refs/heads/${samePr.branch}`, workDir), source: `PR #${samePr.prNumber} head` };
        fixtureRepo.mainAfter = f.refSha(repoUrl, 'refs/heads/main');
        fixtureRepo.mainMoved = fixtureRepo.mainAfter !== samePr.mainHead;
        if (child.parkedAtMerge) {
          await decide(finalRunId, MERGE_EVENT, false, 'S02 eval harness: graded; scratch fixtures are never merged');
          disposition.push(`${finalRunId}: merge denied after capture`);
          try {
            const settled = await awaitRun(finalRunId, { stopAtMerge: false, limitMs: settleTimeoutMs });
            finalData = settled.data;
            record('scenario', finalRunId, settled.data, tc);
          } catch (err) {
            disposition.push(`denial did not settle: ${err.message}`);
          }
        }
        try {
          await f.closePr(repoUrl, samePr.prNumber);
          disposition.push(`PR #${samePr.prNumber} closed after capture`);
        } catch (err) {
          disposition.push(`close PR #${samePr.prNumber} failed: ${err.message}`);
        }
        prOpened = samePr.newPrs.length > 0;
      } else {
        const t0 = Date.now();
        finalRunId = await launch({ task: scenario.taskPrompt, journey });
        const run = await awaitRun(finalRunId, { stopAtMerge: true });
        finalData = run.data;
        record('scenario', finalRunId, run.data, t0);
        transcripts.push(renderShipTranscript(run.data));
        const prUrl = run.data?.outcome?.pr ?? run.data?.evidence?.pr ?? null;
        const prNumber = typeof prUrl === 'string' ? Number(prUrl.match(/\/pulls?\/(\d+)/)?.[1]) : NaN;
        prOpened = Number.isInteger(prNumber);
        if (Number.isInteger(prNumber)) {
          const sha = f.materialize(repoUrl, `refs/pull/${prNumber}/head`, workDir);
          captured = { sha, source: `PR #${prNumber} head`, expected: run.data?.evidence?.sha ?? null };
        }
        if (run.parkedAtMerge) {
          await decide(finalRunId, MERGE_EVENT, false, 'S02 eval harness: graded; scratch fixtures are never merged');
          disposition.push(`${finalRunId}: merge denied after capture (Ship closes the PR)`);
          try {
            const settled = await awaitRun(finalRunId, { stopAtMerge: false, limitMs: settleTimeoutMs });
            finalData = settled.data;
            record('scenario', finalRunId, settled.data, t0);
          } catch (err) {
            disposition.push(`denial did not settle: ${err.message}`);
          }
        }
        const mainAfter = f.refSha(repoUrl, 'refs/heads/main');
        fixtureRepo.mainAfter = mainAfter;
        fixtureRepo.mainMoved = mainAfter !== fixtureRepo.head;
      }

      const branchPushed = f.refSha(repoUrl, `refs/heads/ship/${finalRunId}`) !== null;

      const dir = transcriptDir ?? mkdtempSync(join(tmpdir(), 'pj-ship-'));
      mkdirSync(dir, { recursive: true });
      const transcriptPath = join(dir, 'transcript.txt');
      writeFileSync(transcriptPath, transcripts.join('\n'));

      const allPriced = shipRuns.length > 0 && shipRuns.every(r => r.costPriced && r.costUSD !== null);
      const total = shipRuns.reduce((sum, r) => sum + (r.costUSD ?? 0), 0);
      const summary = {
        runId: finalRunId,
        status: finalData?.meta?.status ?? 'unknown',
        journey,
        intake,
        prOpened,
        pushed: branchPushed || captured.sha !== null,
        answer: typeof finalData?.outcome?.summary === 'string' ? finalData.outcome.summary : '',
        claims: typeof finalData?.outcome?.summary === 'string' && finalData.outcome.summary !== '' ? [finalData.outcome.summary] : [],
        captured,
        fixtureRepo,
        shipRuns,
        pollRetries: pollRetriesUsed,
        interventions,
        disposition,
        ...(samePr ? { samePr } : {}),
        cost: allPriced
          ? { status: 'priced', amount: Number(total.toFixed(6)), currency: 'USD', source: 'Ship run ledger (workspace API costUSD), summed over this attempt\'s runs' }
          : { status: 'unknown', reason: shipRuns.length === 0 ? 'no Ship run recorded' : 'at least one Ship run reported no priced cost (costPriced false or costUnpriced true)' }
      };
      return { transcriptPath, summary };
    }
  };
}
