import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { FileIntakeStore } from "./intake.js";
import {
  PR_WATCH_CURSOR_KEY,
  PR_WATCH_DISCOVERY_LIMIT,
  PR_WATCH_KEY_PREFIX,
  contextMatches,
  openedPr,
  prWatchEnabled,
  prWatchKey,
  sweepPrWatch,
  type PrWatchDeps,
} from "./pr-watch.js";
import type { RunMeta } from "./run-store.js";
import { MemoryRuntimeConfig, type RuntimeConfigStore } from "./runtime-config.js";

/**
 * B1 real-path sweep: real HTTP to a loopback fake Forgejo, the real
 * readForgeState, the real file intake store with its dedupe. Only the run
 * history (metas + event logs) is an in-memory double.
 */

interface FakePr {
  state: "open" | "closed";
  merged: boolean;
  head: string;
  ref: string;
  mergeable: boolean | null;
  statuses: { context: string; state: string }[];
}

const prs = new Map<number, FakePr>();
let protection: Record<string, unknown> | null = null;
let requests: string[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const pull = /^\/api\/v1\/repos\/acme\/app\/pulls\/(\d+)$/.exec(url);
    if (pull) {
      const p = prs.get(Number(pull[1]));
      if (!p) return send(404, {});
      return send(200, {
        state: p.state,
        merged: p.merged,
        title: "Ship change",
        head: { sha: p.head, ref: p.ref },
        base: { ref: "main" },
        mergeable: p.mergeable,
      });
    }
    const status = /^\/api\/v1\/repos\/acme\/app\/commits\/([a-f0-9]+)\/status$/.exec(url);
    if (status) {
      const p = [...prs.values()].find((x) => x.head === status[1]);
      return send(200, { statuses: p?.statuses ?? [] });
    }
    if (/\/pulls\/\d+\/reviews/.test(url)) return send(200, []);
    if (url === "/api/v1/repos/acme/app/branch_protections/main") return protection ? send(200, protection) : send(404, {});
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const sha = (c: string) => c.repeat(40);

function runEvents(repo: string, opts: { openedPr?: number; inputPr?: number }): WorkflowEvent[] {
  const events: WorkflowEvent[] = [
    { type: "run-started", data: { input: { repo, ...(opts.inputPr !== undefined ? { pr: opts.inputPr } : {}) } } } as unknown as WorkflowEvent,
  ];
  if (opts.openedPr !== undefined) {
    events.push({ type: "step-completed", name: "repo-pr", data: { result: { url: `${repo}/pulls/${opts.openedPr}`, number: opts.openedPr } } } as unknown as WorkflowEvent);
  }
  return events;
}

async function harness(runs: { runId: string; events: WorkflowEvent[]; updatedAt?: string }[]) {
  const dir = await mkdtemp(join(tmpdir(), "pr-watch-"));
  const intake = new FileIntakeStore(join(dir, "tasks"));
  const config = new MemoryRuntimeConfig();
  const repo = `${base}/acme/app.git`;
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const metas: RunMeta[] = runs.map((r, i) => ({
    runId: r.runId,
    task: "t",
    status: "completed",
    model: "m",
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: r.updatedAt ?? `2026-10-16T0${i}:00:00Z`,
  }));
  const deps: PrWatchDeps = {
    config,
    // Honors limit/offset like the real stores (newest first) so paging is
    // exercised. (Explicitly typed so this also compiles against a listMeta
    // without `offset` — where the paging tests must FAIL.)
    listMeta: async (o?: { limit?: number; offset?: number }) => {
      const all = [...metas].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const offset = Math.max(0, Math.trunc(o?.offset ?? 0));
      return o?.limit !== undefined ? all.slice(offset, offset + Math.max(1, Math.trunc(o.limit))) : all.slice(offset);
    },
    store: { load: async (id) => runs.find((r) => r.runId === id)?.events ?? [] },
    intake,
    policy: { gitToken: "tok", allowlist: `${base}/acme` },
    fetchImpl: globalThis.fetch,
    env: { SHIP_PR_WATCH: "on", SHIP_PR_WATCH_INTERVAL_SEC: "60" },
    now: () => new Date(clock),
  };
  return {
    deps,
    intake,
    config,
    repo,
    advance: (sec: number) => {
      clock += sec * 1000;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function reset(): void {
  prs.clear();
  protection = null;
  requests = [];
}

test("flag parser: only `on` enables", () => {
  assert.equal(prWatchEnabled({}), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "1" }), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "true" }), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "on" }), true);
});

test("flag off: no store reads, no forge calls, nothing proposed", async () => {
  reset();
  prs.set(7, { state: "open", merged: false, head: sha("a"), ref: "ship/r1", mergeable: false, statuses: [] });
  const h = await harness([{ runId: "r1", events: runEvents(`${base}/acme/app.git`, { openedPr: 7 }) }]);
  let reads = 0;
  const counting: PrWatchDeps = {
    ...h.deps,
    env: {},
    listMeta: async () => {
      reads++;
      return [];
    },
    store: {
      load: async () => {
        reads++;
        return [];
      },
    },
  };
  const r = await sweepPrWatch(counting);
  assert.equal(r.enabled, false);
  assert.equal(reads, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(await h.config.list(), []);
  assert.deepEqual(await h.intake.list(), []);
  await h.cleanup();
});

test("conflict on a Ship PR -> exactly one revision task on the same PR; same sha -> no duplicate; new sha -> new eligibility", async () => {
  reset();
  prs.set(7, { state: "open", merged: false, head: sha("a"), ref: "ship/r1", mergeable: false, statuses: [] });
  const h = await harness([{ runId: "r1", events: runEvents(`${base}/acme/app.git`, { openedPr: 7 }) }]);

  const first = await sweepPrWatch(h.deps);
  assert.equal(first.discovered, 1);
  assert.equal(first.checked, 1);
  assert.equal(first.proposed.length, 1);
  assert.equal(first.proposed[0]!.reason, "conflict");
  let tasks = await h.intake.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.pr, 7);
  assert.equal(tasks[0]!.repo, h.repo);
  assert.equal(tasks[0]!.source, "pr-watch");
  assert.equal(tasks[0]!.dedupeKey, `pr-watch:acme/app#7:${sha("a")}:conflict`);

  // Not due yet: no forge call at all.
  requests = [];
  const early = await sweepPrWatch(h.deps);
  assert.equal(early.checked, 0);
  assert.deepEqual(requests, []);

  // Due again, same head: read, but nothing proposed.
  h.advance(61);
  const repeat = await sweepPrWatch(h.deps);
  assert.equal(repeat.checked, 1);
  assert.equal(repeat.proposed.length, 0);
  assert.equal((await h.intake.list()).length, 1);

  // Dismissing the task does not make the same head eligible again.
  await h.intake.setState(tasks[0]!.taskId, "dismissed");
  h.advance(61);
  assert.equal((await sweepPrWatch(h.deps)).proposed.length, 0);

  // A new head that is still conflicted is a new revision.
  prs.get(7)!.head = sha("b");
  h.advance(61);
  const fresh = await sweepPrWatch(h.deps);
  assert.equal(fresh.proposed.length, 1);
  tasks = await h.intake.list("proposed");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.dedupeKey, `pr-watch:acme/app#7:${sha("b")}:conflict`);
  await h.cleanup();
});

test("failing check -> one CI task keyed like the webhook's; idle green PR proposes nothing", async () => {
  reset();
  prs.set(8, { state: "open", merged: false, head: sha("c"), ref: "ship/r2", mergeable: true, statuses: [{ context: "ci/test", state: "success" }] });
  const h = await harness([{ runId: "r2", events: runEvents(`${base}/acme/app.git`, { openedPr: 8 }) }]);
  const idle = await sweepPrWatch(h.deps);
  assert.equal(idle.checked, 1);
  assert.equal(idle.proposed.length, 0);

  prs.get(8)!.statuses = [{ context: "ci/test", state: "failure" }];
  h.advance(61);
  const red = await sweepPrWatch(h.deps);
  assert.equal(red.proposed.length, 1);
  assert.equal(red.proposed[0]!.reason, "check");
  const tasks = await h.intake.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.source, "ci");
  assert.equal(tasks[0]!.pr, 8);
  // Same key ciFixTaskFromWorkflowRun writes, so a webhook delivery for this head collapses into this task.
  assert.equal(tasks[0]!.dedupeKey, `ci:acme/app#8:${sha("c")}`);
  const viaWebhook = await h.intake.propose({ source: "ci", kind: "ci", repo: h.repo, pr: 8, title: "x", dedupeKey: `ci:Acme/App#8:${sha("c")}` });
  assert.equal(viaWebhook.created, false);

  h.advance(61);
  assert.equal((await sweepPrWatch(h.deps)).proposed.length, 0);
  assert.equal((await h.intake.list()).length, 1);
  await h.cleanup();
});

test("required contexts: a failing non-required check is ignored when protection names the required ones", async () => {
  reset();
  protection = { enable_status_check: true, status_check_contexts: ["ci/required*"] };
  prs.set(9, { state: "open", merged: false, head: sha("d"), ref: "ship/r3", mergeable: true, statuses: [{ context: "lint/optional", state: "failure" }] });
  const h = await harness([{ runId: "r3", events: runEvents(`${base}/acme/app.git`, { openedPr: 9 }) }]);
  assert.equal((await sweepPrWatch(h.deps)).proposed.length, 0);
  prs.get(9)!.statuses.push({ context: "ci/required-test", state: "error" });
  h.advance(61);
  assert.equal((await sweepPrWatch(h.deps)).proposed.length, 1);
  await h.cleanup();
});

test("merged or closed -> unwatched, and no further forge calls", async () => {
  reset();
  prs.set(10, { state: "closed", merged: true, head: sha("e"), ref: "ship/r4", mergeable: null, statuses: [] });
  prs.set(11, { state: "closed", merged: false, head: sha("f"), ref: "ship/r5", mergeable: null, statuses: [] });
  const h = await harness([
    { runId: "r4", events: runEvents(`${base}/acme/app.git`, { openedPr: 10 }) },
    { runId: "r5", events: runEvents(`${base}/acme/app.git`, { openedPr: 11 }) },
  ]);
  const r = await sweepPrWatch(h.deps);
  assert.deepEqual(r.unwatched.map((u) => u.why).sort(), ["closed", "merged"]);
  assert.equal((await h.config.list()).filter((k) => k.key.startsWith(PR_WATCH_KEY_PREFIX)).length, 0);
  requests = [];
  h.advance(3600);
  const later = await sweepPrWatch(h.deps);
  assert.equal(later.checked, 0);
  assert.deepEqual(requests, []);
  // The cursor stops rediscovery of the same runs.
  assert.ok((await h.config.get(PR_WATCH_CURSOR_KEY)) !== undefined);
  await h.cleanup();
});

test("negative control: a run that reviewed someone else's PR is never watched; a non-ship head branch is dropped", async () => {
  reset();
  prs.set(12, { state: "open", merged: false, head: sha("1"), ref: "feature/human", mergeable: false, statuses: [{ context: "ci", state: "failure" }] });
  prs.set(13, { state: "open", merged: false, head: sha("2"), ref: "feature/other", mergeable: false, statuses: [] });
  const repo = `${base}/acme/app.git`;
  const h = await harness([
    // A review/revision run on PR 12: input.pr, but no repo-pr step — it opened nothing.
    { runId: "review", events: runEvents(repo, { inputPr: 12 }) },
    // A recorded repo-pr whose forge head is not a Ship branch.
    { runId: "odd", events: runEvents(repo, { openedPr: 13 }) },
  ]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.discovered, 1);
  assert.equal(r.proposed.length, 0);
  assert.equal(r.unwatched.length, 1);
  assert.match(r.unwatched[0]!.why, /not a Ship branch/);
  assert.equal(requests.some((u) => u.includes("/pulls/12")), false);
  assert.deepEqual(await h.intake.list(), []);
  await h.cleanup();
});

test("forge errors back off exponentially and cap per sweep holds", async () => {
  reset();
  const repo = `${base}/acme/app.git`;
  // PR 20 does not exist on the fake forge: every read 404s.
  const h = await harness([{ runId: "gone", events: runEvents(repo, { openedPr: 20 }) }]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /retry in 120s/);
  requests = [];
  h.advance(61);
  assert.equal((await sweepPrWatch(h.deps)).checked, 0);
  assert.deepEqual(requests, []);
  h.advance(60);
  const again = await sweepPrWatch(h.deps);
  assert.match(again.errors[0]!, /retry in 240s/);
  await h.cleanup();

  reset();
  const many = Array.from({ length: 5 }, (_, i) => {
    prs.set(30 + i, { state: "open", merged: false, head: sha(String(i)), ref: `ship/m${i}`, mergeable: true, statuses: [] });
    return { runId: `m${i}`, events: runEvents(repo, { openedPr: 30 + i }) };
  });
  const c = await harness(many);
  const capped = await sweepPrWatch({ ...c.deps, env: { ...c.deps.env, SHIP_PR_WATCH_MAX_PER_SWEEP: "2" } });
  assert.equal(capped.discovered, 5);
  assert.equal(capped.checked, 2);
  await c.cleanup();
});

test("openedPr / prWatchKey / contextMatches", () => {
  assert.equal(openedPr(runEvents("https://x/a/b.git", { inputPr: 3 })), null);
  assert.deepEqual(openedPr(runEvents("https://x/a/b.git", { openedPr: 4 })), { repo: "https://x/a/b.git", pr: 4 });
  assert.equal(prWatchKey("https://X/a/b.git", 1), prWatchKey("https://x/a/b", 1));
  assert.ok(contextMatches("ci/*", "ci/test"));
  assert.ok(!contextMatches("ci/*", "lint"));
  assert.ok(contextMatches("a.b", "a.b"));
  assert.ok(!contextMatches("a.b", "axb"));
});

test("a transient config read error keeps the watch and its handled history; a corrupt row is still dropped", async () => {
  reset();
  prs.set(40, { state: "open", merged: false, head: sha("7"), ref: "ship/r40", mergeable: false, statuses: [] });
  const h = await harness([{ runId: "r40", events: runEvents(`${base}/acme/app.git`, { openedPr: 40 }) }]);
  assert.equal((await sweepPrWatch(h.deps)).proposed.length, 1);
  const task = (await h.intake.list())[0]!;
  await h.intake.setState(task.taskId, "dismissed");
  const key = prWatchKey(h.repo, 40);
  assert.ok((await h.config.get(key)) !== undefined);

  // One sweep where every watch-row read rejects (store hiccup), not corrupt data.
  let flaky = true;
  const flakyConfig: RuntimeConfigStore = {
    get: (k) => (flaky && k.startsWith(PR_WATCH_KEY_PREFIX) ? Promise.reject(new Error("store: connection reset")) : h.config.get(k)),
    set: (k, v, by) => h.config.set(k, v, by),
    remove: (k) => h.config.remove(k),
    list: () => h.config.list(),
  };
  h.advance(61);
  const during = await sweepPrWatch({ ...h.deps, config: flakyConfig });
  assert.equal(during.checked, 0);
  assert.deepEqual(during.unwatched, []);
  assert.deepEqual(during.errors, []);
  assert.ok((await h.config.get(key)) !== undefined, "a transient read error must not delete the watch");

  // The dismissed head is not re-proposed: `handled` survived the failed read.
  flaky = false;
  h.advance(61);
  const after = await sweepPrWatch(h.deps);
  assert.equal(after.checked, 1);
  assert.equal(after.proposed.length, 0);
  assert.equal((await h.intake.list()).length, 1);

  // A value that IS present but unparseable is still garbage-collected.
  await h.config.set(key, "{corrupt", "test");
  h.advance(61);
  await sweepPrWatch(h.deps);
  assert.equal((await h.config.list()).some((k) => k.key === key), false, "a corrupt row is dropped");
  await h.cleanup();
});

/** Runs for the paging tests: n runs in one interval, each having opened a PR, newest first. */
function burstRuns(count: number, firstPr: number): { runId: string; events: WorkflowEvent[]; updatedAt: string }[] {
  const repo = `${base}/acme/app.git`;
  return Array.from({ length: count }, (_, i) => {
    const pr = firstPr + i;
    prs.set(pr, { state: "open", merged: false, head: sha(String(pr).padStart(2, "0")), ref: `ship/p${pr}`, mergeable: true, statuses: [] });
    return {
      runId: `p${i}`,
      events: runEvents(repo, { openedPr: pr }),
      updatedAt: new Date(Date.parse("2026-10-16T12:00:00Z") - i * 1000).toISOString(),
    };
  });
}

test("discovery pages past the newest 50 runs instead of skipping the rest forever", async () => {
  reset();
  // 60 runs updated since the cursor — more than one discovery window.
  const runs = burstRuns(60, 100);
  const h = await harness(runs);
  const first = await sweepPrWatch({ ...h.deps, env: { ...h.deps.env, SHIP_PR_WATCH_MAX_PER_SWEEP: "2" } });
  assert.equal(first.discovered, 60, "every run past the cursor is examined, not just the newest 50");
  assert.equal((await h.config.list()).filter((k) => k.key.startsWith(PR_WATCH_KEY_PREFIX)).length, 60);
  // The cursor advanced to the newest meta only after examining all of them.
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), runs[0]!.updatedAt);
  assert.equal((await sweepPrWatch(h.deps)).discovered, 0);
  await h.cleanup();
});

test("a backlog deeper than the page bound is resumed next sweep, never marked seen", async () => {
  reset();
  // Five more than the page bound (10 windows of 50): the first sweep examines
  // 500 and runs out of pages. Those five below the bound must not be counted
  // as seen — the cursor stays put and a resume marker parks the depth reached.
  const bound = PR_WATCH_DISCOVERY_LIMIT * 10;
  const runs = burstRuns(bound + 5, 500);
  const h = await harness(runs);
  const env = { ...h.deps.env, SHIP_PR_WATCH_MAX_PER_SWEEP: "1" };
  const first = await sweepPrWatch({ ...h.deps, env });
  assert.equal(first.discovered, bound);
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), undefined, "the cursor did not advance past unexamined metas");
  assert.equal((await h.config.list()).some((k) => k.key === "SHIP_PR_WATCH_DISCOVERY_RESUME"), true, "the sweep parked a resume marker instead");

  // The next sweep continues at that depth and examines the remaining five;
  // only once the whole backlog is seen may the cursor advance.
  const second = await sweepPrWatch({ ...h.deps, env });
  assert.equal(second.discovered, 5, "the remainder is examined on the next sweep");
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), runs[0]!.updatedAt);
  assert.equal((await h.config.list()).some((k) => k.key === "SHIP_PR_WATCH_DISCOVERY_RESUME"), false, "the resume marker is spent");
  assert.equal((await h.config.list()).filter((k) => k.key.startsWith(PR_WATCH_KEY_PREFIX)).length, bound + 5);
  assert.equal((await sweepPrWatch(h.deps)).discovered, 0);
  await h.cleanup();
});
