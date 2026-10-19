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
  prWatchMaxAgeDays,
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
  /** The PR's base branch (DS1 stacked tests); default "main". */
  base?: string;
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
        base: { ref: p.base ?? "main" },
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

function runEvents(repo: string, opts: { openedPr?: number; inputPr?: number; openedAt?: string; stack?: { runId: string; pr: number; branch: string; sha: string } }): WorkflowEvent[] {
  const events: WorkflowEvent[] = [
    { type: "run-started", data: { input: { repo, ...(opts.inputPr !== undefined ? { pr: opts.inputPr } : {}), ...(opts.stack !== undefined ? { stack: opts.stack } : {}) } } } as unknown as WorkflowEvent,
  ];
  if (opts.openedPr !== undefined) {
    events.push({
      type: "step-completed",
      name: "repo-pr",
      ...(opts.openedAt !== undefined ? { at: opts.openedAt } : {}),
      data: { result: { url: `${repo}/pulls/${opts.openedPr}`, number: opts.openedPr } },
    } as unknown as WorkflowEvent);
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

test("flag parser: on unless explicitly off (unset means on)", () => {
  assert.equal(prWatchEnabled({}), true);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "1" }), true);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "true" }), true);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "on" }), true);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "off" }), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "0" }), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "false" }), false);
  assert.equal(prWatchEnabled({ SHIP_PR_WATCH: "no" }), false);
});

test("max-age parser: default 14, clamped to [1, 90]", () => {
  assert.equal(prWatchMaxAgeDays({}), 14);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "14" }), 14);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "1" }), 1);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "90" }), 90);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "365" }), 90, "above the cap clamps down to 90");
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "2.9" }), 2);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "0" }), 14, "below the minimum falls back to the default");
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "-5" }), 14);
  assert.equal(prWatchMaxAgeDays({ SHIP_PR_WATCH_MAX_AGE_DAYS: "abc" }), 14);
});

test("flag off: no store reads, no forge calls, nothing proposed", async () => {
  reset();
  prs.set(7, { state: "open", merged: false, head: sha("a"), ref: "ship/r1", mergeable: false, statuses: [] });
  const h = await harness([{ runId: "r1", events: runEvents(`${base}/acme/app.git`, { openedPr: 7 }) }]);
  let reads = 0;
  const counting: PrWatchDeps = {
    ...h.deps,
    env: { SHIP_PR_WATCH: "off" },
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

/** The harness clock, so tests can date runs relative to it. */
const CLOCK = "2026-10-16T12:00:00Z";
const daysAgo = (n: number): string => new Date(Date.parse(CLOCK) - n * 24 * 60 * 60 * 1000).toISOString();

test("discovery is bounded by PR age: a PR opened 60 days ago is not adopted, one 3 days ago is", async () => {
  reset();
  prs.set(50, { state: "open", merged: false, head: sha("9"), ref: "ship/age60", mergeable: true, statuses: [] });
  prs.set(51, { state: "open", merged: false, head: sha("8"), ref: "ship/age3", mergeable: true, statuses: [] });
  const h = await harness([
    { runId: "age60", events: runEvents(`${base}/acme/app.git`, { openedPr: 50, openedAt: daysAgo(60) }), updatedAt: daysAgo(60) },
    { runId: "age3", events: runEvents(`${base}/acme/app.git`, { openedPr: 51, openedAt: daysAgo(3) }), updatedAt: daysAgo(3) },
  ]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.discovered, 1, "only the PR inside the age window is adopted");
  assert.ok((await h.config.get(prWatchKey(h.repo, 51))) !== undefined);
  assert.equal(await h.config.get(prWatchKey(h.repo, 50)), undefined, "a 60-day-old PR is never watched");
  assert.equal(requests.some((u) => u.includes("/pulls/50")), false, "the stale PR is not even read from the forge");
  await h.cleanup();
});

test("the age bound uses the repo-pr step's own time, not the run meta's updatedAt", async () => {
  reset();
  // A long-lived run touched NOW but whose repo-pr step recorded 60 days ago:
  // updatedAt alone would adopt it; the step's append time must not.
  prs.set(52, { state: "open", merged: false, head: sha("6"), ref: "ship/touched", mergeable: true, statuses: [] });
  const h = await harness([
    { runId: "touched", events: runEvents(`${base}/acme/app.git`, { openedPr: 52, openedAt: daysAgo(60) }), updatedAt: daysAgo(0) },
  ]);
  const lines: string[] = [];
  const r = await sweepPrWatch({ ...h.deps, log: (l) => lines.push(l) });
  assert.equal(r.discovered, 0);
  assert.equal(await h.config.get(prWatchKey(h.repo, 52)), undefined);
  assert.equal(requests.some((u) => u.includes("/pulls/52")), false);
  assert.equal(lines.some((l) => l.includes("first enable")), true);
  assert.equal(lines.some((l) => l.includes("1 historical PR skipped as too old")), true, "the first-enable log counts it as skipped");
  await h.cleanup();
});

test("first enable with no cursor does not adopt beyond the window; the cursor starts at the age floor; existing proposals stay", async () => {
  reset();
  const h = await harness([
    { runId: "d20", events: runEvents(`${base}/acme/app.git`, { openedPr: 61, openedAt: daysAgo(20) }), updatedAt: daysAgo(20) },
    { runId: "d40", events: runEvents(`${base}/acme/app.git`, { openedPr: 62, openedAt: daysAgo(40) }), updatedAt: daysAgo(40) },
    { runId: "d60", events: runEvents(`${base}/acme/app.git`, { openedPr: 63, openedAt: daysAgo(60) }), updatedAt: daysAgo(60) },
  ]);
  // A proposal that already sits in the Inbox (from the flood) is NOT auto-dismissed.
  await h.intake.propose({ source: "pr-watch", kind: "conflict", repo: h.repo, pr: 63, title: "stale flood task", dedupeKey: "pr-watch:acme/app#63:deadbeef:conflict" });
  const lines: string[] = [];
  const r = await sweepPrWatch({ ...h.deps, log: (l) => lines.push(l) });
  assert.equal(r.discovered, 0);
  assert.equal((await h.config.list()).filter((k) => k.key.startsWith(PR_WATCH_KEY_PREFIX)).length, 0);
  assert.deepEqual(requests, [], "history beyond the window is not scanned or read");
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), daysAgo(14), "the cursor is initialised at now minus the max age, not walked through history");
  assert.equal((await h.config.list()).some((k) => k.key === "SHIP_PR_WATCH_DISCOVERY_RESUME"), false);
  assert.equal((await h.intake.list()).length, 1);
  assert.equal((await h.intake.list())[0]!.state, "proposed", "the existing proposal was not touched");
  assert.equal(lines.filter((l) => l.includes("first enable")).length, 1, "one first-enable summary line");
  // Not the first enable any more: no repeat line, still nothing adopted.
  lines.length = 0;
  const again = await sweepPrWatch({ ...h.deps, log: (l) => lines.push(l) });
  assert.equal(again.discovered, 0);
  assert.equal(lines.filter((l) => l.includes("first enable")).length, 0);
  await h.cleanup();
});

test("first enable still adopts history inside the window and advances the cursor to it", async () => {
  reset();
  prs.set(64, { state: "open", merged: false, head: sha("5"), ref: "ship/infresh", mergeable: true, statuses: [] });
  const h = await harness([
    { runId: "infresh", events: runEvents(`${base}/acme/app.git`, { openedPr: 64, openedAt: daysAgo(3) }), updatedAt: daysAgo(3) },
    { runId: "inold", events: runEvents(`${base}/acme/app.git`, { openedPr: 65, openedAt: daysAgo(40) }), updatedAt: daysAgo(40) },
  ]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.discovered, 1);
  assert.equal(r.checked, 1);
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), daysAgo(3), "the cursor advances to the newest examined meta, not the floor");
  await h.cleanup();
});

test("SHIP_PR_WATCH_MAX_AGE_DAYS widens to 90 and narrows to 1 (clamped)", async () => {
  reset();
  prs.set(66, { state: "open", merged: false, head: sha("4"), ref: "ship/w60", mergeable: true, statuses: [] });
  prs.set(67, { state: "open", merged: false, head: sha("3"), ref: "ship/w3", mergeable: true, statuses: [] });
  const runs = [
    { runId: "w60", events: runEvents(`${base}/acme/app.git`, { openedPr: 66, openedAt: daysAgo(60) }), updatedAt: daysAgo(60) },
    { runId: "w3", events: runEvents(`${base}/acme/app.git`, { openedPr: 67, openedAt: daysAgo(3) }), updatedAt: daysAgo(3) },
  ];
  const wide = await harness(runs.map((r) => ({ ...r })));
  const r90 = await sweepPrWatch({ ...wide.deps, env: { ...wide.deps.env, SHIP_PR_WATCH_MAX_AGE_DAYS: "90" } });
  assert.equal(r90.discovered, 2, "a 60-day-old PR is inside a 90-day window");
  await wide.cleanup();

  reset();
  const narrow = await harness(runs.map((r) => ({ ...r })));
  const r1 = await sweepPrWatch({ ...narrow.deps, env: { ...narrow.deps.env, SHIP_PR_WATCH_MAX_AGE_DAYS: "1" } });
  assert.equal(r1.discovered, 0, "a 3-day-old PR is beyond a 1-day window");
  await narrow.cleanup();
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
  assert.deepEqual(openedPr(runEvents("https://x/a/b.git", { openedPr: 4, openedAt: "2026-10-01T00:00:00Z" })), { repo: "https://x/a/b.git", pr: 4, at: "2026-10-01T00:00:00Z" });
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
  // The first sweep is also a FIRST ENABLE, so the cursor exists — written at
  // the age floor by the cutover. What it must NOT be is anywhere above the
  // unexamined tail: the floor sits below every meta in this history.
  assert.equal(await h.config.get(PR_WATCH_CURSOR_KEY), new Date(Date.parse("2026-10-16T12:00:00Z") - 14 * 24 * 60 * 60 * 1000).toISOString(), "the cursor did not advance past unexamined metas");
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

// ------------------------------------------------------------- DS1 stack ----

const STACK = { runId: "r-base", pr: 3, branch: "ship/r-base", sha: sha("e") };

/** The stacked PR #7 fixture: open, based on ship/r-base; base PR #3 beside it. */
function stackedFixture(base: FakePr): void {
  reset();
  prs.set(7, { state: "open", merged: false, head: sha("c"), ref: "ship/r-stack", mergeable: true, statuses: [], base: STACK.branch });
  prs.set(3, base);
}

test("DS1: discovery adopts a stacked run's watch with its stack record", async () => {
  stackedFixture({ state: "open", merged: false, head: sha("b"), ref: "ship/r-base", mergeable: true, statuses: [] });
  const h = await harness([{ runId: "r-stack", events: runEvents(`${base}/acme/app.git`, { openedPr: 7, stack: STACK }) }]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.discovered, 1);
  const row = await h.config.get(prWatchKey(`${base}/acme/app.git`, 7));
  assert.deepEqual((JSON.parse(row!) as { stack?: unknown }).stack, STACK);
  assert.equal(r.checked, 1);
  assert.equal(r.proposed.length, 0, "an open base proposes nothing");
  await h.cleanup();
});

test("DS1: base merged -> ONE stack-rebase task with the recorded facts; a duplicate sweep proposes nothing more", async () => {
  // Base PR #3 squash-merged into main (its base ref is the target).
  stackedFixture({ state: "closed", merged: true, head: sha("b"), ref: "ship/r-base", mergeable: true, statuses: [] });
  const h = await harness([{ runId: "r-stack", events: runEvents(`${base}/acme/app.git`, { openedPr: 7, stack: STACK }) }]);

  const first = await sweepPrWatch(h.deps);
  assert.equal(first.proposed.length, 1);
  assert.equal(first.proposed[0]!.reason, "stack-rebase");
  assert.equal(first.proposed[0]!.created, true);
  assert.ok(requests.includes(`/api/v1/repos/acme/app/pulls/${3}`), "the base PR was read");

  const tasks = await h.intake.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.kind, "stack-rebase");
  assert.equal(tasks[0]!.pr, 7);
  assert.equal(tasks[0]!.repo, h.repo);
  assert.deepEqual(tasks[0]!.stack, { oldBaseHeadSha: STACK.sha, defaultBranch: "main" }, "the recorded old base head and the default branch");
  assert.match(tasks[0]!.title ?? "", /base PR #3 merged/);
  assert.match(tasks[0]!.detail ?? "", /rebase --onto/);

  // The ordinary conflict rule stays quiet for this head (the retarget and the
  // rebase are the woken task's, and a second sweep must not double-propose).
  prs.get(7)!.mergeable = false;
  h.advance(61);
  const second = await sweepPrWatch(h.deps);
  assert.equal(second.proposed.length, 0, "duplicate sweep: the key is handled");
  assert.equal((await h.intake.list()).length, 1, "still exactly one task");
  await h.cleanup();
});

test("DS1 negative: base closed unmerged -> nothing proposed, the stack is abandoned", async () => {
  stackedFixture({ state: "closed", merged: false, head: sha("b"), ref: "ship/r-base", mergeable: true, statuses: [] });
  const h = await harness([{ runId: "r-stack", events: runEvents(`${base}/acme/app.git`, { openedPr: 7, stack: STACK }) }]);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.proposed.length, 0);
  assert.deepEqual(r.unwatched, [{ repo: h.repo, pr: 7, why: "stack base abandoned: base PR #3 was closed unmerged" }]);
  assert.equal((await h.intake.list()).length, 0);
  assert.equal(await h.config.get(prWatchKey(h.repo, 7)), undefined, "the watch is gone");
  await h.cleanup();
});

test("DS1: once the PR is retargeted off the stack branch, the rule stays quiet for good", async () => {
  // Base merged AND the woken revision already retargeted PR #7 to main.
  stackedFixture({ state: "closed", merged: true, head: sha("b"), ref: "ship/r-base", mergeable: true, statuses: [] });
  const h = await harness([{ runId: "r-stack", events: runEvents(`${base}/acme/app.git`, { openedPr: 7, stack: STACK }) }]);
  await sweepPrWatch(h.deps);
  prs.get(7)!.base = "main";
  h.advance(61);
  const second = await sweepPrWatch(h.deps);
  assert.equal(second.proposed.length, 0, "no second task after the retarget");
  assert.equal((await h.intake.list()).length, 1);
  assert.equal(second.unwatched.length, 0, "the stacked PR itself is still watched");
  await h.cleanup();
});

test("DS1: a base read failure backs off and proposes nothing", async () => {
  stackedFixture({ state: "open", merged: false, head: sha("b"), ref: "ship/r-base", mergeable: true, statuses: [] });
  const h = await harness([{ runId: "r-stack", events: runEvents(`${base}/acme/app.git`, { openedPr: 7, stack: STACK }) }]);
  // First sweep adopts the watch; then break the base PR's answer.
  await sweepPrWatch(h.deps);
  prs.delete(3);
  h.advance(61);
  const r = await sweepPrWatch(h.deps);
  assert.equal(r.proposed.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /stack base read failed/);
  const row = JSON.parse((await h.config.get(prWatchKey(h.repo, 7)))!) as { failures: number; stack?: unknown };
  assert.equal(row.failures, 1, "the failure backs the watch off");
  assert.deepEqual(row.stack, STACK, "and keeps the stack record");
  await h.cleanup();
});
