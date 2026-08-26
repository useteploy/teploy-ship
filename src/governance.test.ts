import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_AUTHORITY,
  FileGovernanceStore,
  autoAllowedNow,
  insideWindow,
  mayDo,
  normalizeGovernance,
  parseDays,
  reviewersFor,
  validateWindow,
} from "./governance.js";
import type { AutoWindow, Governance } from "./governance.js";
import { parseRepoUrl, requestReviewers } from "./git.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { sweepIntake } from "./worker.js";
import type { IntakeSweepDeps } from "./worker.js";
import type { IntakeTask } from "./intake.js";
import { LocalAdmission } from "./admission.js";

async function store(): Promise<FileGovernanceStore> {
  return new FileGovernanceStore(await mkdtemp(join(tmpdir(), "governance-")));
}

const defaults: Governance = { authority: DEFAULT_AUTHORITY, windows: {}, reviewers: [] };

// ── authority ─────────────────────────────────────────────────────────────

test("mayDo: defaults reproduce today's roles, and an unknown role is denied everywhere", () => {
  assert.equal(mayDo(defaults, "approve", { user: "e", role: "editor" }), true);
  assert.equal(mayDo(defaults, "steer", { user: "e", role: "editor" }), true);
  assert.equal(mayDo(defaults, "auto", { user: "e", role: "editor" }), false, "editor may not set auto");
  assert.equal(mayDo(defaults, "policies", { user: "e", role: "editor" }), false);
  assert.equal(mayDo(defaults, "approve", { user: "v", role: "viewer" }), false);
  for (const action of ["approve", "auto", "steer", "policies"] as const) {
    assert.equal(mayDo(defaults, action, { user: "x", role: "superuser" }), false, `unknown role denied for ${action}`);
    assert.equal(mayDo(defaults, action, null), false, "no principal is denied");
    assert.equal(mayDo(defaults, action, { user: "a", role: "admin" }), true, "admin holds every default grant");
  }
});

test("mayDo: a named user is allowed regardless of role; a narrowed role grant is honoured", async () => {
  const s = await store();
  await s.setAuthority("approve", { roles: ["admin"], users: ["release-bot"] });
  const g = await s.get();
  assert.equal(mayDo(g, "approve", { user: "e", role: "editor" }), false, "editor lost approve when the grant narrowed");
  assert.equal(mayDo(g, "approve", { user: "release-bot", role: "viewer" }), true, "named user allowed even as viewer");
  assert.equal(mayDo(g, "approve", { user: "release-bot-2", role: "viewer" }), false, "exact id match only");
  // Untouched actions keep their defaults.
  assert.equal(mayDo(g, "steer", { user: "e", role: "editor" }), true);
});

test("normalizeGovernance drops junk roles and ignores unknown actions", () => {
  const g = normalizeGovernance({ authority: { approve: { roles: ["editor", "root", 3], users: [" a ", ""] }, bogus: { roles: ["admin"] } } });
  assert.deepEqual(g.authority.approve, { roles: ["editor"], users: ["a"] });
  assert.equal((g.authority as Record<string, unknown>).bogus, undefined);
  assert.deepEqual(g.authority.auto, DEFAULT_AUTHORITY.auto);
});

// ── windows ───────────────────────────────────────────────────────────────

const office: AutoWindow = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", tz: "Europe/Berlin" };

test("insideWindow is evaluated on the zone's wall clock, across a DST change", () => {
  // Berlin is UTC+1 in winter and UTC+2 in summer. 08:30 UTC is 09:30 Berlin
  // in January (inside) and 10:30 in July (inside); 07:30 UTC is 08:30 in
  // January (outside) but 09:30 in July (inside) — the same UTC instant lands
  // on opposite sides of the boundary depending on the season.
  assert.equal(insideWindow(office, new Date("2026-01-14T08:30:00Z")), true);
  assert.equal(insideWindow(office, new Date("2026-01-14T07:30:00Z")), false, "08:30 CET is before 09:00");
  assert.equal(insideWindow(office, new Date("2026-07-15T07:30:00Z")), true, "09:30 CEST is inside");
  assert.equal(insideWindow(office, new Date("2026-07-15T16:30:00Z")), false, "18:30 CEST is after end");
  // The weekday is the zone's, too: 23:30 UTC Friday is 01:30 Saturday in Berlin.
  assert.equal(insideWindow({ ...office, start: "00:00", end: "23:59" }, new Date("2026-01-16T23:30:00Z")), false, "Saturday in Berlin");
  // And the other way: 23:30 UTC Sunday is 15:30 Sunday in Los Angeles but 08:30 Monday in Tokyo.
  const tokyo = { ...office, tz: "Asia/Tokyo" };
  assert.equal(insideWindow(tokyo, new Date("2026-01-11T23:30:00Z")), false, "08:30 Monday Tokyo, before 09:00");
  assert.equal(insideWindow(tokyo, new Date("2026-01-12T00:30:00Z")), true, "09:30 Monday Tokyo");
});

test("an overnight window belongs to the day it starts on", () => {
  const night: AutoWindow = { days: [5], start: "22:00", end: "06:00", tz: "UTC" }; // Friday night
  assert.equal(insideWindow(night, new Date("2026-01-16T23:00:00Z")), true, "Friday 23:00");
  assert.equal(insideWindow(night, new Date("2026-01-17T02:00:00Z")), true, "Saturday 02:00 is Friday's night");
  assert.equal(insideWindow(night, new Date("2026-01-17T07:00:00Z")), false, "Saturday 07:00 is past end");
  assert.equal(insideWindow(night, new Date("2026-01-17T23:00:00Z")), false, "Saturday night is not in the rule");
});

test("autoAllowedNow: no window means always; a source window overrides the global one", () => {
  const monday10 = new Date("2026-01-12T09:00:00Z"); // 10:00 Berlin
  const sunday10 = new Date("2026-01-11T09:00:00Z");
  assert.equal(autoAllowedNow({}, "forgejo", sunday10), true);
  assert.equal(autoAllowedNow({ "*": office }, "forgejo", sunday10), false);
  assert.equal(autoAllowedNow({ "*": office }, "forgejo", monday10), true);
  const always: AutoWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", tz: "UTC" };
  assert.equal(autoAllowedNow({ "*": office, forgejo: always }, "forgejo", sunday10), true, "per-source wins");
  assert.equal(autoAllowedNow({ "*": office, forgejo: always }, "github", sunday10), false, "others keep the global");
});

test("validateWindow refuses what an operator could mistype", () => {
  assert.throws(() => validateWindow({ days: [], start: "09:00", end: "18:00", tz: "UTC" }), /at least one day/);
  assert.throws(() => validateWindow({ days: [7], start: "09:00", end: "18:00", tz: "UTC" }), /0 \(Sun\) to 6/);
  assert.throws(() => validateWindow({ days: [1], start: "9am", end: "18:00", tz: "UTC" }), /HH:MM/);
  assert.throws(() => validateWindow({ days: [1], start: "09:00", end: "09:00", tz: "UTC" }), /differ/);
  assert.throws(() => validateWindow({ days: [1], start: "09:00", end: "18:00", tz: "Mars/Olympus" }), /unknown time zone/);
  assert.deepEqual(validateWindow({ days: [5, 1, 1], start: "09:00", end: "18:00", tz: "UTC" }).days, [1, 5]);
});

test("parseDays: names, ranges, wrap-around and numbers", () => {
  assert.deepEqual(parseDays("mon-fri"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays("sat,sun"), [0, 6]);
  assert.deepEqual(parseDays("fri-mon"), [0, 1, 5, 6], "a range may wrap the week");
  assert.deepEqual(parseDays("1-3,6"), [1, 2, 3, 6]);
  assert.throws(() => parseDays("mon,someday"), /unknown day/);
});

test("worker sweep: an auto source outside its window parks as propose and claims nothing", async () => {
  const task: IntakeTask = {
    taskId: "t1",
    source: "forgejo",
    kind: "issue",
    title: "x",
    dedupeKey: "k",
    state: "proposed",
    createdAt: "2026-01-11T09:00:00Z",
    updatedAt: "2026-01-11T09:00:00Z",
  };
  const tasks = [task];
  const launched: string[] = [];
  const claims: string[] = [];
  const logs: string[] = [];
  const mk = (now: Date): IntakeSweepDeps => ({
    intake: {
      list: async () => tasks.filter((t) => t.state === "proposed"),
      setState: async (id, state) => {
        const t = tasks.find((x) => x.taskId === id)!;
        t.state = state;
      },
      claim: async (id) => {
        claims.push(id);
        const t = tasks.find((x) => x.taskId === id)!;
        if (t.state !== "proposed") return false;
        t.state = "launched";
        return true;
      },
    },
    spend: { reserve: async () => {}, release: async () => {}, get: async () => 0, list: async () => [], add: async () => {} } as never,
    admission: new LocalAdmission(),
    policies: { forgejo: "auto" },
    windows: { "*": office },
    dailyAutoLimit: 10,
    maxConcurrentRuns: 10,
    budgetFor: () => 0,
    estimatedRunCostUSD: 0.1,
    inFlight: new Map(),
    outcomeOf: async () => ({ terminal: false }),
    newRunId: () => "run-1",
    launch: async (_t, runId) => {
      launched.push(runId);
    },
    now: () => now,
    log: (l) => logs.push(l),
  });

  await sweepIntake(mk(new Date("2026-01-11T09:00:00Z"))); // Sunday 10:00 Berlin
  assert.deepEqual(launched, [], "outside the window nothing launches");
  assert.deepEqual(claims, [], "and nothing is claimed — the task is still proposable by a human");
  assert.equal(tasks[0]!.state, "proposed");
  assert.match(logs.join("\n"), /outside its auto window/);

  await sweepIntake(mk(new Date("2026-01-12T09:00:00Z"))); // Monday 10:00 Berlin
  assert.deepEqual(launched, ["run-1"], "the next in-window sweep launches it");
});

// ── reviewers ─────────────────────────────────────────────────────────────

test("reviewer rules are keyed by repo slug and an emptied rule is removed", async () => {
  const s = await store();
  await s.setReviewers({ repo: "https://git.example.com/Tyler/App.git", users: ["alice", " alice ", "bob"], teams: ["core"] });
  let g = await s.get();
  assert.deepEqual(g.reviewers, [{ repo: "tyler/app", users: ["alice", "bob"], teams: ["core"] }]);
  assert.deepEqual(reviewersFor(g.reviewers, "git@git.example.com:tyler/app"), g.reviewers[0]);
  assert.equal(reviewersFor(g.reviewers, "tyler/other"), null);

  await s.setReviewers({ repo: "tyler/app", users: [], teams: [] });
  g = await s.get();
  assert.deepEqual(g.reviewers, []);
});

test("enqueueRun materialises the repo's reviewers into the run input, and nothing when there is no rule", async () => {
  const s = await store();
  await s.setReviewers({ repo: "tyler/app", users: ["alice"], teams: [] });
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { forRepo: async () => null },
    governance: s,
    store: {
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") inputs.push(event.data!.input!);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;

  await enqueueRun(runtime, { runId: "r1", task: "t", model: "m", repo: "https://git.example.com/tyler/app" });
  assert.deepEqual(inputs[0]!.reviewers, { users: ["alice"], teams: [] });

  await enqueueRun(runtime, { runId: "r2", task: "t", model: "m", repo: "https://git.example.com/tyler/other" });
  assert.equal(inputs[1]!.reviewers, undefined, "no rule, no field, no extra recorded step");

  await enqueueRun(runtime, { runId: "r3", task: "t", model: "m" });
  assert.equal(inputs[2]!.reviewers, undefined, "a workspace run has no repo to look up");
});

test("requestReviewers posts the same payload shape to both forges and throws on refusal", async () => {
  const calls: Array<{ url: string; body: unknown; auth: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization });
    return new Response("{}", { status: 201 });
  }) as typeof fetch;

  await requestReviewers({ ref: parseRepoUrl("http://forge.example:3000/Tyler/app"), token: "tok", pr: 7, users: ["alice"], teams: ["core"], fetchImpl });
  assert.equal(calls[0]?.url, "http://forge.example:3000/api/v1/repos/Tyler/app/pulls/7/requested_reviewers");
  assert.deepEqual(calls[0]?.body, { reviewers: ["alice"], team_reviewers: ["core"] });
  assert.equal(calls[0]?.auth, "token tok");

  await requestReviewers({ ref: parseRepoUrl("https://github.com/o/r"), token: "tok", pr: 9, users: ["alice"], teams: [], fetchImpl });
  assert.equal(calls[1]?.url, "https://api.github.com/repos/o/r/pulls/9/requested_reviewers");
  assert.deepEqual(calls[1]?.body, { reviewers: ["alice"] });
  assert.equal(calls[1]?.auth, "Bearer tok");

  const failImpl = (async () => new Response("not a collaborator", { status: 422 })) as typeof fetch;
  await assert.rejects(
    requestReviewers({ ref: parseRepoUrl("https://github.com/o/r"), token: "tok", pr: 9, users: ["nobody"], teams: [], fetchImpl: failImpl }),
    /reviewer request failed \(422\): not a collaborator/,
  );
});

test("file store: corrupt governance throws rather than reading as defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "governance-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "governance.json"), "{ not json");
  await assert.rejects(new FileGovernanceStore(dir).get());
});
