import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import {
  FINDING_CONTINUITY_FLAG,
  compareWithPrior,
  findingContinuityEnabled,
  loadPriorReview,
  revisionDiff,
} from "./finding-continuity-wiring.js";
import type { ContinuityRecord } from "./finding-continuity-wiring.js";
import { FINDINGS_MARKER, parseFindings } from "./findings.js";
import type { ParsedFindings } from "./findings.js";
import { scanPrompt } from "./prompt.js";
import { readForgeState } from "./forge-state.js";
import { parseRepoUrl } from "./git.js";

/**
 * S09 wiring, advisory. The e2e cases drive the REAL durable scan path (a
 * scripted model, a real git remote with real commits on a PR branch, a fake
 * forge answering the PR lookup) across three revisions, so the diff the
 * continuity pass reads is a real `git diff` between real commits.
 */

function scripted(text: string): ModelAdapter {
  let used = false;
  return {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(): Promise<AdapterGenerateResult> {
      const out = used ? "```finish\nout of script\n```" : text;
      used = true;
      return { content: [{ type: "text", text: out }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

async function sh(root: string, command: string): Promise<string> {
  const r = await new LocalExecutor({ root }).exec(command);
  assert.equal(r.exitCode, 0, `${command}\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/** A bare remote with a PR branch `feat` that tests advance one real commit at a time. */
async function prRemote() {
  const bare = await mkdtemp(join(tmpdir(), "fc-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "fc-seed-"));
  await sh(seed, `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'readme\\n' > README.md && git add -A && git commit -qm seed && git clone -q --bare . ${bare}/owner/repo.git && git remote add origin ${bare}/owner/repo.git && git checkout -q -b feat`);
  const state = { head: "" };
  return {
    repo: `file://${bare}/owner/repo.git`,
    state,
    /** Write files, commit, push the PR branch; returns the new head sha. */
    async commit(files: Record<string, string>): Promise<string> {
      for (const [path, body] of Object.entries(files)) {
        const dir = path.includes("/") ? `mkdir -p ${path.slice(0, path.lastIndexOf("/"))} && ` : "";
        await sh(seed, `${dir}cat > ${path} <<'EOT'\n${body}\nEOT`);
      }
      await sh(seed, `git add -A && git commit -qm rev && git push -q origin feat`);
      state.head = await sh(seed, "git rev-parse HEAD");
      return state.head;
    },
  };
}

const AUTH_V1 = `export function login(user) {
  return db.query("select * from u where n='" + user + "'");
}
export function render(x) {
  return eval(x);
}`;
// Revision 2: two comment lines inserted ABOVE the SQL finding (pure drift) and
// the eval replaced (a real fix).
const AUTH_V2 = `// auth helpers
// reviewed in v2
export function login(user) {
  return db.query("select * from u where n='" + user + "'");
}
export function render(x) {
  return JSON.parse(x);
}`;

const SQLI = { title: "SQL built by string concatenation", severity: "high", file: "src/auth.js", symbol: "login", snippet: `return db.query("select * from u where n='" + user + "'");`, confidence: "high", evidence: "user is spliced into the query text", detail: "injectable", fix: "use a parameter" };
const EVAL = { title: "eval of caller input", severity: "high", file: "src/auth.js", symbol: "render", snippet: "return eval(x);", detail: "runs arbitrary code" };
const TOKEN = { title: "hardcoded token", severity: "med", file: "src/new.js", line: 1, snippet: `export const token = "hardcoded";`, detail: "committed secret" };

const finish = (findings: unknown[]): string => `\`\`\`finish\nReview done.\n\n${FINDINGS_MARKER}\n${JSON.stringify(findings)}\n\`\`\``;

interface Harness {
  remote: Awaited<ReturnType<typeof prRemote>>;
  store: MemoryEventStore;
  ids: string[];
  review(runId: string, findings: unknown[]): Promise<{ step: ParsedFindings; steps: (string | undefined)[]; output: unknown }>;
}

async function harness(): Promise<Harness> {
  const remote = await prRemote();
  const store = new MemoryEventStore();
  const ids: string[] = [];
  const provider: ExecutorProvider = {
    async create() {
      return { handle: await mkdtemp(join(tmpdir(), "fc-work-")) };
    },
    attach: (handle: string) => new LocalExecutor({ root: handle }),
  };
  const lineage = {
    loadEvents: (id: string) => store.load(id),
    recentRunIds: async () => [...ids].reverse(),
    marked: async () => undefined,
    mark: async () => {},
  };
  return {
    remote,
    store,
    ids,
    async review(runId, findings) {
      // Distinct run-started timestamps: "earlier" is decided by recorded time.
      await new Promise((r) => setTimeout(r, 8));
      ids.push(runId);
      const orig = globalThis.fetch;
      (globalThis as unknown as { fetch: unknown }).fetch = () =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ state: "open", head: { ref: "feat", sha: remote.state.head }, base: { ref: "main" } }) });
      try {
        const wf = durableAgent({ model: scripted(finish(findings)), executor: provider, previewLineage: lineage });
        const outcome = await executeRun({ workflow: wf, runId, store, input: { task: "review PR 7", repo: remote.repo, pr: 7, mode: "scan" } });
        assert.equal(outcome.status, "completed");
        const events = await store.load(runId);
        const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
        return {
          step: (step?.data as { result: ParsedFindings }).result,
          steps: events.filter((e) => e.type === "step-completed").map((e) => e.name),
          output: outcome.output,
        };
      } finally {
        globalThis.fetch = orig;
      }
    },
  };
}

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[FINDING_CONTINUITY_FLAG];
  if (value === undefined) delete process.env[FINDING_CONTINUITY_FLAG];
  else process.env[FINDING_CONTINUITY_FLAG] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[FINDING_CONTINUITY_FLAG];
    else process.env[FINDING_CONTINUITY_FLAG] = before;
  }
}

const statusOf = (c: ContinuityRecord | undefined, title: string): string | undefined => c?.entries.find((e) => e.title === title)?.status;

// ── the real review path, three revisions ─────────────────────────────────

test("flag on: three real revisions through the durable scan path carry findings forward", async () => {
  await withFlag("on", async () => {
    const h = await harness();

    await h.remote.commit({ "src/auth.js": AUTH_V1 });
    const r1 = await h.review("run-1", [{ ...SQLI, line: 2 }, { ...EVAL, line: 5 }]);
    // A first review has nothing to be continuous with: no section, not an "all new" one.
    assert.equal(r1.step.continuity, undefined);
    // ... but the revision-aware fields were recorded, additively.
    assert.equal(r1.step.findings[0]?.snippet, SQLI.snippet);
    assert.equal(r1.step.findings[0]?.confidence, "high");

    const rev1 = h.remote.state.head;
    await h.remote.commit({ "src/auth.js": AUTH_V2, "src/new.js": `export const token = "hardcoded";` });
    const r2 = await h.review("run-2", [{ ...SQLI, line: 4 }, TOKEN]);
    const c2 = r2.step.continuity;
    assert.ok(c2, "second review carries a continuity record");
    assert.equal(c2.priorRunId, "run-1");
    assert.equal(c2.priorRevision, rev1);
    assert.equal(c2.diff, "available");
    // Two lines were inserted above it: still the SAME finding, not "fixed + new".
    assert.equal(statusOf(c2, SQLI.title), "still-open");
    // Code changed and the reviewer stopped reporting it: resolved WITH evidence.
    assert.equal(statusOf(c2, EVAL.title), "resolved");
    assert.equal(statusOf(c2, TOKEN.title), "new");
    assert.ok(c2.advisory.some((l) => /Advisory only/.test(l)));
    // The later findings carry stable ids for the next pass.
    assert.ok(r2.step.findings.every((f) => typeof f.id === "string"));

    await h.remote.commit({ "src/other.js": "export const other = 1;" });
    const r3 = await h.review("run-3", [TOKEN]);
    const c3 = r3.step.continuity;
    assert.ok(c3);
    assert.equal(c3.priorRunId, "run-2", "compares with the NEWEST earlier review, not the first");
    assert.equal(statusOf(c3, TOKEN.title), "still-open");
    // Untouched code the reviewer simply stopped mentioning is NOT "fixed".
    assert.equal(statusOf(c3, SQLI.title), "unconfirmed-disappearance");
    assert.notEqual(statusOf(c3, SQLI.title), "resolved");
    assert.ok(c3.advisory.some((l) => /unconfirmed/.test(l)));
    // The review's outcome and the findings it reports are unaffected by the advice.
    assert.deepEqual(
      (r3.output as { findings: { title: string }[] }).findings.map((f) => f.title),
      [TOKEN.title],
    );
  });
});

test("flag on adds no step: the step sequence equals the flag-off sequence", async () => {
  const run = async (flag: string | undefined) =>
    withFlag(flag, async () => {
      const h = await harness();
      await h.remote.commit({ "src/auth.js": AUTH_V1 });
      await h.review("a-1", [{ ...SQLI, line: 2 }]);
      await h.remote.commit({ "src/auth.js": AUTH_V2 });
      return (await h.review("a-2", [{ ...SQLI, line: 4 }])).steps;
    });
  assert.deepEqual(await run("on"), await run(undefined));
});

test("flag off: recorded output is byte-identical to the pre-S09 shape, even when the model sends the new fields", async () => {
  await withFlag(undefined, async () => {
    const h = await harness();
    await h.remote.commit({ "src/auth.js": AUTH_V1 });
    const summary = finish([{ ...SQLI, line: 2 }, { ...EVAL, line: 5 }]);
    await h.review("off-1", [{ ...SQLI, line: 2 }, { ...EVAL, line: 5 }]);
    await h.remote.commit({ "src/auth.js": AUTH_V2 });
    const r2 = await h.review("off-2", [{ ...SQLI, line: 4 }]);
    assert.equal(r2.step.continuity, undefined);
    for (const f of r2.step.findings) {
      for (const k of ["snippet", "symbol", "confidence", "evidence", "id"] as const) assert.equal(k in f, false, `${k} must not be recorded with the flag off`);
    }
    const expected = JSON.stringify(parseFindings(finish([{ ...SQLI, line: 4 }])));
    assert.equal(JSON.stringify(r2.step), expected);
    assert.equal(JSON.stringify(parseFindings(summary)), JSON.stringify(parseFindings(summary, {})));
  });
});

// ── parts ─────────────────────────────────────────────────────────────────

test("parseFindings: new fields only with the option; evidence consumed as detail is not duplicated", () => {
  const text = finish([{ ...SQLI, line: 2 }, { title: "t", file: "a.ts", evidence: "only evidence", confidence: "Medium" }]);
  const off = parseFindings(text);
  assert.equal("snippet" in off.findings[0]!, false);
  const on = parseFindings(text, { revisionFields: true });
  assert.equal(on.findings[0]?.symbol, "login");
  assert.equal(on.findings[0]?.evidence, "user is spliced into the query text");
  assert.equal(on.findings[1]?.detail, "only evidence");
  assert.equal(on.findings[1]?.evidence, undefined, "evidence used as the detail is not also a separate field");
  assert.equal(on.findings[1]?.confidence, "med");
  assert.equal(parseFindings(finish([{ title: "t", file: "a", confidence: "banana" }]), { revisionFields: true }).findings[0]?.confidence, undefined);
});

test("scanPrompt: byte-identical without the flag, asks for the fields with it", () => {
  const base = { task: "audit", branch: "feat" };
  assert.equal(scanPrompt(base), scanPrompt({ ...base, revisionFields: false }));
  assert.doesNotMatch(scanPrompt(base), /snippet/);
  assert.match(scanPrompt({ ...base, revisionFields: true }), /`snippet`/);
});

test("findingContinuityEnabled is on only for an explicit on", () => {
  assert.equal(findingContinuityEnabled({}), false);
  assert.equal(findingContinuityEnabled({ [FINDING_CONTINUITY_FLAG]: "off" }), false);
  assert.equal(findingContinuityEnabled({ [FINDING_CONTINUITY_FLAG]: "" }), false);
  assert.equal(findingContinuityEnabled({ [FINDING_CONTINUITY_FLAG]: "on" }), true);
});

test("compareWithPrior with no diff proves nothing fixed (negative control for 'resolved needs evidence')", () => {
  const f = (title: string) => ({ title, severity: "high" as const, file: "a.ts", detail: "d", snippet: `code ${title}` });
  const out = compareWithPrior({
    parsed: { found: true, findings: [f("kept")], errors: [] },
    prior: { runId: "p", snapshot: { revision: "abc1234", findings: [f("kept"), f("gone")] } },
  });
  assert.equal(statusOf(out.continuity, "gone"), "unconfirmed-disappearance");
  assert.equal(out.continuity.diff, "unavailable");
  assert.ok(out.continuity.advisory.some((l) => /No revision diff/.test(l)));
});

const log = (at: string, input: Record<string, unknown>, opts: { done?: boolean; findings?: unknown[]; head?: string } = {}) => [
  { type: "run-started", at, data: { input } },
  { type: "step-completed", name: "repo-setup", data: { result: { headSha: opts.head ?? "aaaaaaa" } } },
  ...(opts.findings !== undefined ? [{ type: "step-completed", name: "scan-findings", data: { result: { found: true, findings: opts.findings, errors: [] } } }] : []),
  ...(opts.done === false ? [] : [{ type: "run-completed", at }]),
];

test("loadPriorReview picks the newest EARLIER completed scan of the same repo+PR, and nothing else", async () => {
  const F = [{ title: "x", severity: "low", file: "a", detail: "d" }];
  const scan = { mode: "scan", repo: "r", pr: 7, task: "t" };
  const runs: Record<string, ReturnType<typeof log>> = {
    old: log("2026-01-01T00:00:00Z", scan, { findings: F, head: "1111111" }),
    mid: log("2026-01-02T00:00:00Z", scan, { findings: F, head: "2222222" }),
    otherPr: log("2026-01-02T12:00:00Z", { ...scan, pr: 8 }, { findings: F, head: "3333333" }),
    otherRepo: log("2026-01-02T13:00:00Z", { ...scan, repo: "z" }, { findings: F, head: "4444444" }),
    notScan: log("2026-01-02T14:00:00Z", { ...scan, mode: undefined }, { findings: F, head: "5555555" }),
    unfinished: log("2026-01-02T15:00:00Z", scan, { findings: F, done: false, head: "6666666" }),
    noFindings: log("2026-01-02T16:00:00Z", scan, { head: "7777777" }),
    later: log("2026-01-04T00:00:00Z", scan, { findings: F, head: "8888888" }),
    me: log("2026-01-03T00:00:00Z", scan),
  };
  const history = { loadEvents: async (id: string) => runs[id] ?? [], recentRunIds: async () => Object.keys(runs) };
  const prior = await loadPriorReview(history, { runId: "me", repo: "r", pr: 7, task: "t" });
  assert.equal(prior?.runId, "mid");
  assert.equal(prior?.snapshot.revision, "2222222");
  // No pull request: same task text is the key.
  assert.equal(await loadPriorReview(history, { runId: "me", repo: "r", task: "t" }), null);
  // Unreadable history or an unknown own start never throws and never guesses.
  assert.equal(await loadPriorReview({ loadEvents: async () => { throw new Error("x"); }, recentRunIds: async () => ["a"] }, { runId: "me", repo: "r", pr: 7, task: "t" }), null);
  assert.equal(await loadPriorReview(history, { runId: "ghost", repo: "r", pr: 7, task: "t" }), null);
});

test("revisionDiff validates both ids before they reach a shell, and equal revisions are an empty diff", async () => {
  const calls: string[] = [];
  const exec = async (c: string) => {
    calls.push(c);
    return { stdout: "diff --git a/x b/x\n", exitCode: 0 };
  };
  assert.equal(await revisionDiff(exec, "abc1234; touch /tmp/pwn", "def5678"), undefined);
  assert.equal(await revisionDiff(exec, "abc1234", "def5678 && id"), undefined);
  assert.equal(await revisionDiff(exec, "abc1234", undefined), undefined);
  assert.deepEqual(calls, []);
  assert.equal(await revisionDiff(exec, "abc1234", "ABC1234"), "");
  assert.equal(await revisionDiff(exec, "abc1234", "def5678"), "diff --git a/x b/x\n");
  assert.equal(await revisionDiff(async () => ({ stdout: "", exitCode: 128 }), "abc1234", "def5678"), undefined);
  assert.equal(await revisionDiff(async () => { throw new Error("gone"); }, "abc1234", "def5678"), undefined);
});

// ── forge-state: additive inline comments ─────────────────────────────────

function forge(github: boolean) {
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    const pull = { state: "open", head: { sha: "abc1234567" }, base: { ref: "main" }, title: "t" };
    if (/\/pulls\/3$/.test(u)) return Response.json(pull);
    if (/\/status$/.test(u)) return Response.json({ statuses: [] });
    if (/check-runs/.test(u)) return Response.json({ check_runs: [], total_count: 0 });
    if (/\/pulls\/3\/reviews\?/.test(u)) return Response.json([{ id: 11, user: { login: "bob" }, state: "COMMENTED", body: "see inline" }]);
    if (/\/pulls\/3\/comments/.test(u)) return Response.json([
      { user: { login: "bob" }, path: "src/a.ts", line: 4, position: 4, body: "bad" },
      { user: { login: "bob" }, path: "src/b.ts", original_line: 9, position: null, line: null, body: "old anchor" },
    ]);
    if (/\/reviews\/11\/comments/.test(u)) return Response.json([
      { user: { login: "bob" }, path: "src/a.ts", line: 4, body: "open", resolver: null },
      { user: { login: "bob" }, path: "src/a.ts", line: 8, body: "done", resolver: { login: "amy" } },
    ]);
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  const ref = parseRepoUrl(github ? "https://github.com/o/r" : "http://forge.example:3000/o/r");
  return { urls, fetchImpl, ref };
}

test("forge state: without the option nothing extra is requested or returned (byte-identical)", async () => {
  for (const github of [true, false]) {
    const a = forge(github);
    const plain = await readForgeState(a.ref, "tok", 3, a.fetchImpl);
    const b = forge(github);
    const explicitOff = await readForgeState(b.ref, "tok", 3, b.fetchImpl, { inlineComments: false });
    assert.equal("reviewComments" in plain, false);
    assert.deepEqual(a.urls, b.urls);
    assert.ok(!a.urls.some((u) => /\/comments/.test(u)));
    assert.equal(JSON.stringify({ ...plain, checkedAt: 0 }), JSON.stringify({ ...explicitOff, checkedAt: 0 }));
  }
});

test("forge state: inline comments are additive; GitHub leaves resolved unknown, Forgejo reports the resolver", async () => {
  const g = forge(true);
  const gh = await readForgeState(g.ref, "tok", 3, g.fetchImpl, { inlineComments: true });
  assert.deepEqual(gh.reviews, [{ author: "bob", state: "COMMENTED", body: "see inline" }], "old shape intact");
  assert.equal(gh.reviewComments?.length, 2);
  assert.equal(gh.reviewComments?.[0]?.resolved, undefined, "GitHub REST cannot say: unknown, not unresolved");
  assert.equal(gh.reviewComments?.[1]?.outdated, true);
  assert.equal(gh.reviewComments?.[1]?.line, 9);

  const f = forge(false);
  const fj = await readForgeState(f.ref, "tok", 3, f.fetchImpl, { inlineComments: true });
  assert.deepEqual(fj.reviewComments?.map((c) => c.resolved), [false, true]);
});

test("forge state: a failing comments read becomes a warning and costs nothing else", async () => {
  const g = forge(true);
  const failing = (async (url: unknown, init?: unknown) => (/\/pulls\/3\/comments/.test(String(url)) ? new Response("x", { status: 500 }) : g.fetchImpl(url as string, init as RequestInit))) as typeof fetch;
  const r = await readForgeState(g.ref, "tok", 3, failing, { inlineComments: true });
  assert.equal(r.reviewComments, undefined);
  assert.ok(r.warnings.includes("Inline review comments unavailable"));
  assert.equal(r.reviews.length, 1);
});
