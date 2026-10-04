import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { extractRefs, groundPlan, groundPlanFromExecutor, planGroundingEnabled, readGroundingFacts, renderGrounding } from "./plan-grounding.js";
import type { GroundingReport } from "./plan-grounding.js";

/**
 * Real temp git repositories read through a real LocalExecutor, the same path
 * a run's checkout takes. There is no mock of git.
 */

const GIT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" }).trim();
}

async function repo(tree: Record<string, string>): Promise<{ root: string; sha: string; executor: LocalExecutor; done: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "plan-grounding-"));
  git(root, "init", "-q", "-b", "main");
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, sha: git(root, "rev-parse", "HEAD"), executor: new LocalExecutor({ root }), done: () => rm(root, { recursive: true, force: true }) };
}

const TREE = {
  "package.json": JSON.stringify({ name: "x", scripts: { build: "tsc", test: "node --test", lint: "eslint ." } }),
  "Makefile": "all: build\nbuild:\n\techo hi\n",
  "src/billing/invoice.ts": "export function computeProration(a: number) { return a; }\nexport class InvoiceStore { save() {} }\n",
  "src/index.ts": "export const x = 1;\n",
  "docs/notes.md": "hello\n",
};

function byName(r: GroundingReport, name: string) {
  const x = r.refs.find((y) => y.name === name);
  assert.ok(x, `no ref ${name}; have ${r.refs.map((y) => y.name).join(", ")}`);
  return x;
}

test("flag: off by default, on only for explicit values", () => {
  assert.equal(planGroundingEnabled({}), false);
  assert.equal(planGroundingEnabled({ SHIP_PLAN_GROUNDING: "off" }), false);
  assert.equal(planGroundingEnabled({ SHIP_PLAN_GROUNDING: "" }), false);
  assert.equal(planGroundingEnabled({ SHIP_PLAN_GROUNDING: "on" }), true);
  assert.equal(planGroundingEnabled({ SHIP_PLAN_GROUNDING: "1" }), true);
});

test("real repo: existing files, symbols and scripts are grounded; invented ones are ungrounded", async () => {
  const r = await repo(TREE);
  try {
    const plan = [
      "1. Edit `src/billing/invoice.ts:1` so `computeProration()` rounds.",
      "2. Update `InvoiceStore.save` and `src/billing/ledger.ts`.",
      "3. Call `reconcileLedgerEntries()` from `src/index.ts`.",
      "4. Run `pnpm run build` then `pnpm run migrate` and `make build`, `make deploy`.",
    ].join("\n");
    const rep = await groundPlanFromExecutor(r.executor, plan, { expectedRevision: r.sha.slice(0, 10) });
    assert.equal(rep.revision, r.sha);
    assert.equal(rep.revisionMismatch, undefined);
    assert.equal(byName(rep, "src/billing/invoice.ts").status, "grounded");
    assert.equal(byName(rep, "src/billing/invoice.ts").line, 1);
    assert.equal(byName(rep, "computeProration").status, "grounded");
    assert.equal(byName(rep, "InvoiceStore.save").status, "grounded");
    assert.equal(byName(rep, "src/index.ts").status, "grounded");
    assert.equal(byName(rep, "src/billing/ledger.ts").status, "ungrounded");
    assert.equal(byName(rep, "reconcileLedgerEntries").status, "ungrounded");
    assert.equal(byName(rep, "pnpm run build").status, "grounded");
    assert.equal(byName(rep, "pnpm run migrate").status, "ungrounded");
    assert.equal(byName(rep, "make build").status, "grounded");
    assert.equal(byName(rep, "make deploy").status, "ungrounded");
    assert.equal(rep.allCheckedGrounded, false);
    const text = renderGrounding(rep);
    assert.ok(text.indexOf("[ungrounded]") < text.indexOf("[grounded]"), "ungrounded listed first");
    assert.match(text, /advisory/);
  } finally { await r.done(); }
});

test("a fully grounded plan reports allCheckedGrounded; an empty plan does not claim grounding", async () => {
  const r = await repo(TREE);
  try {
    const ok = await groundPlanFromExecutor(r.executor, "Edit `src/index.ts` and run `pnpm test`.");
    assert.equal(ok.allCheckedGrounded, true);
    const none = await groundPlanFromExecutor(r.executor, "Make it better and faster, somehow.");
    assert.equal(none.refs.length, 0);
    assert.equal(none.allCheckedGrounded, false);
    assert.match(renderGrounding(none), /nothing to ground/);
  } finally { await r.done(); }
});

test("negative control: an untracked or uncommitted file does not ground a claim (revision-bound, not working-tree)", async () => {
  const r = await repo(TREE);
  try {
    await writeFile(join(r.root, "src/untracked.ts"), "export function onlyOnDisk() {}\n");
    await writeFile(join(r.root, "src/index.ts"), "export const x = 1;\nexport function editedUncommitted() {}\n");
    const rep = await groundPlanFromExecutor(r.executor, "Touch `src/untracked.ts` and `onlyOnDisk()` and `editedUncommitted()`.");
    assert.equal(byName(rep, "src/untracked.ts").status, "ungrounded");
    assert.equal(byName(rep, "onlyOnDisk").status, "ungrounded");
    assert.equal(byName(rep, "editedUncommitted").status, "ungrounded");
  } finally { await r.done(); }
});

test("a later commit is not visible when grounding an earlier revision", async () => {
  const r = await repo(TREE);
  try {
    await writeFile(join(r.root, "src/later.ts"), "export function laterFn() {}\n");
    git(r.root, "add", "-A"); git(r.root, "commit", "-q", "-m", "later");
    const old = await groundPlanFromExecutor(r.executor, "Use `src/later.ts` and `laterFn()`.", { rev: r.sha });
    assert.equal(old.revision, r.sha);
    assert.equal(byName(old, "src/later.ts").status, "ungrounded");
    assert.equal(byName(old, "laterFn").status, "ungrounded");
    const head = await groundPlanFromExecutor(r.executor, "Use `src/later.ts` and `laterFn()`.");
    assert.equal(byName(head, "src/later.ts").status, "grounded");
    assert.equal(byName(head, "laterFn").status, "grounded");
  } finally { await r.done(); }
});

test("revision mismatch asserts nothing: every ref is unchecked, none grounded or ungrounded", async () => {
  const r = await repo(TREE);
  try {
    const rep = await groundPlanFromExecutor(r.executor, "Edit `src/index.ts` and `src/nope.ts`.", { expectedRevision: "deadbeef" });
    assert.ok(rep.revisionMismatch);
    assert.deepEqual(rep.counts, { grounded: 0, ungrounded: 0, proposed: 0, unchecked: 2 });
    assert.equal(rep.allCheckedGrounded, false);
    assert.match(renderGrounding(rep), /REVISION MISMATCH/);
  } finally { await r.done(); }
});

test("a file the plan says it creates is proposed, not ungrounded; creating something that exists is called out", async () => {
  const r = await repo(TREE);
  try {
    const rep = await groundPlanFromExecutor(r.executor, ["Create `src/billing/ledger.ts` with the new store.", "Add `src/index.ts` as the entry."].join("\n"));
    const fresh = byName(rep, "src/billing/ledger.ts");
    assert.equal(fresh.status, "proposed");
    assert.match(fresh.detail, /not present/);
    const dup = byName(rep, "src/index.ts");
    assert.equal(dup.status, "proposed");
    assert.match(dup.detail, /already exists/);
    assert.equal(rep.counts.ungrounded, 0);
  } finally { await r.done(); }
});

test("unknown is not pass: unparsed commands, out-of-repo paths and a missing package.json are unchecked", async () => {
  const r = await repo({ "src/a.ts": "export const a = 1;\n" });
  try {
    const plan = "Run `cargo test`, `pnpm --filter web build`, `pnpm run build`; read `../secrets/x.ts` and `/etc/passwd.txt`.";
    const rep = await groundPlanFromExecutor(r.executor, plan);
    assert.equal(byName(rep, "cargo test").status, "unchecked");
    assert.equal(byName(rep, "pnpm --filter web build").status, "unchecked");
    const nopkg = byName(rep, "pnpm run build");
    assert.equal(nopkg.status, "unchecked");
    assert.match(nopkg.detail, /no package\.json/);
    assert.equal(byName(rep, "../secrets/x.ts").status, "unchecked");
    assert.equal(byName(rep, "/etc/passwd.txt").status, "unchecked");
    assert.equal(rep.counts.grounded, 0);
    assert.equal(rep.counts.ungrounded, 0);
  } finally { await r.done(); }
});

test("prose is not a claim: plain words and URLs in backticks are not extracted; fenced commands are", () => {
  const refs = extractRefs([
    "Set `true` for `config` and see `https://example.com/a/b.ts` and fractions like `1/2`.",
    "```sh",
    "$ pnpm run lint",
    "echo not a command we know",
    "```",
    "Use `parseThing()` and `snake_case_name`.",
  ].join("\n"));
  const names = refs.map((x) => `${x.kind}:${x.name}`);
  assert.deepEqual(names, ["command:pnpm run lint", "symbol:parseThing", "symbol:snake_case_name"]);
  assert.equal(refs[0]!.line, 3);
});

test("hostile plan text never reaches a shell: a symbol with metacharacters is not extracted or searched", async () => {
  const r = await repo(TREE);
  try {
    const marker = join(r.root, "pwned");
    const plan = `Look at \`foo();touch ${marker}\` and \`$(touch ${marker})\` and \`x\`; also \`computeProration()\`.`;
    const rep = await groundPlanFromExecutor(r.executor, plan);
    await assert.rejects(() => r.executor.getFile("pwned"));
    assert.equal(byName(rep, "computeProration").status, "grounded");
    assert.ok(rep.refs.every((x) => !x.name.includes(";") && !x.name.includes("$(")));
  } finally { await r.done(); }
});

test("adapter guard: a hand-built symbol ref with shell metacharacters is never interpolated", async () => {
  const r = await repo(TREE);
  try {
    const facts = await readGroundingFacts(r.executor, [{ kind: "symbol", name: "a;touch pwned", line: 1, creates: false }]);
    await assert.rejects(() => r.executor.getFile("pwned"));
    assert.equal(facts.symbols["a;touch pwned"], undefined);
    assert.match(facts.symbolNotes["a;touch pwned"] ?? "", /not a plain identifier/);
  } finally { await r.done(); }
});

test("not a git repository throws rather than reporting everything ungrounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-grounding-nogit-"));
  try {
    await writeFile(join(root, "a.ts"), "export {};\n");
    await assert.rejects(() => groundPlanFromExecutor(new LocalExecutor({ root }), "Edit `a.ts`."), /not a git repository|unknown revision/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe revision strings are refused before any command runs", async () => {
  const r = await repo(TREE);
  try {
    await assert.rejects(() => groundPlanFromExecutor(r.executor, "Edit `src/index.ts`.", { rev: "HEAD; touch pwned" }), /unsafe revision/);
    await assert.rejects(() => r.executor.getFile("pwned"));
  } finally { await r.done(); }
});

test("pure half: a truncated listing makes absence unassertable (unchecked), never ungrounded", () => {
  const rep = groundPlan("Edit `src/gone.ts`.", { revision: "a".repeat(40), filesNote: "file listing truncated", symbols: {}, symbolNotes: {} });
  assert.equal(byName(rep, "src/gone.ts").status, "unchecked");
  assert.equal(rep.counts.ungrounded, 0);
});

test("pure half: a symbol that could not be searched is unchecked", () => {
  const rep = groundPlan("Call `doTheThing()`.", { revision: "a".repeat(40), symbols: {}, symbolNotes: { doTheThing: "git grep failed (exit 128)" } });
  assert.equal(byName(rep, "doTheThing").status, "unchecked");
});
