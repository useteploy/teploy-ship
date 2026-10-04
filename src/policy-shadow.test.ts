import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { normalizeEgressAllow, resolveNetworkTier } from "./egress.js";
import { DEFAULT_AUTHORITY, mayDo } from "./governance.js";
import type { Governance } from "./governance.js";
import { effectiveAuthority } from "./ladder.js";
import { resolvePolicy } from "./policy-inheritance.js";
import type { EffectivePolicy, PolicyLayer, PolicyLimits } from "./policy-inheritance.js";
import {
  flushShadow,
  installPolicyShadow,
  installPolicyShadowFromEnv,
  parseShadowRecords,
  readDeclaredLayers,
  readShadowSummary,
  renderShadowReport,
  summariseShadow,
} from "./policy-shadow.js";
import type { ShadowRecord, ShadowSink } from "./policy-shadow.js";
import { assertRepoAllowed, RepoNotAllowedError } from "./repo-policy.js";
import { assertDailyBudget, DailyBudgetExceededError } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { setShadowObserver } from "./shadow-hook.js";
import type { SpendStore } from "./spend.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const governance: Governance = { authority: DEFAULT_AUTHORITY, windows: {}, reviewers: [] };

function memorySink(): { sink: ShadowSink; records: ShadowRecord[] } {
  const records: ShadowRecord[] = [];
  return { records, sink: { append: async (r) => void records.push(r) } };
}

const layer = (kind: PolicyLayer["kind"], id: string, limits: PolicyLimits): PolicyLayer => ({ kind, id, limits });
const declare = (...layers: PolicyLayer[]) => async () => ({ layers });

function install(layers: PolicyLayer[] = [], resolve?: (l: readonly PolicyLayer[], n: Date) => EffectivePolicy) {
  const m = memorySink();
  installPolicyShadow({ sink: m.sink, now: () => NOW, declaredLayers: declare(...layers), env: {}, ...(resolve !== undefined ? { resolve } : {}) });
  return m;
}

afterEach(() => {
  installPolicyShadow(null);
  setShadowObserver(null);
});

// ── flag off: nothing changes ─────────────────────────────────────────────

test("flag off installs no observer: decisions are identical and nothing is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shadow-off-"));
  const file = join(dir, "policy-shadow.jsonl");
  const env = { SHIP_POLICY_SHADOW_FILE: file } as NodeJS.ProcessEnv;
  assert.equal(installPolicyShadowFromEnv(env), false);
  assert.equal(installPolicyShadowFromEnv({ ...env, SHIP_POLICY_SHADOW: "off" }), false);

  const run = () =>
    JSON.stringify({
      a: mayDo(governance, "approve", { user: "e", role: "editor" }),
      b: mayDo(governance, "auto", { user: "e", role: "editor" }),
      c: mayDo(governance, "auto", null),
      d: effectiveAuthority({ authority: "auto_normal", neverAuto: false }),
      e: resolveNetworkTier("open", undefined, undefined),
      f: normalizeEgressAllow([" GitHub.com ", ".npmjs.org"]),
      g: assertRepoAllowed("https://github.com/o/r", { trust: "operator", config: {} }).cloneUrl,
    });
  const off = run();
  await flushShadow();
  await assert.rejects(stat(file), "no record file is created while the flag is off");

  // The same calls with the shadow ON return byte-identical results.
  install();
  assert.equal(run(), off);
  await flushShadow();
});

test("flag on: only the exact value 'on' enables it", () => {
  const env = { SHIP_POLICY_SHADOW_FILE: join(tmpdir(), "never-written.jsonl") } as NodeJS.ProcessEnv;
  for (const v of ["", "1", "true", "ON-ish", "no"]) assert.equal(installPolicyShadowFromEnv({ ...env, SHIP_POLICY_SHADOW: v }), false, v);
  assert.equal(installPolicyShadowFromEnv({ ...env, SHIP_POLICY_SHADOW: "on" }), true);
});

// ── real decision paths ───────────────────────────────────────────────────

test("mayDo: a declared organisation grant narrower than governance is a disagreement, and the outcome does not change", async () => {
  const m = install([layer("org", "acme", { actions: { approve: { roles: ["admin"], users: [] } } })]);
  const allowed = mayDo(governance, "approve", { user: "ed", role: "editor" });
  await flushShadow();
  assert.equal(allowed, true, "shadow never changes the outcome");
  assert.equal(m.records.length, 1);
  const r = m.records[0]!;
  assert.equal(r.type, "disagreement");
  assert.equal(r.kind, "existing-allows-policy-denies");
  assert.equal(r.point, "mayDo");
  assert.equal(r.dimension, "actions.approve");
  assert.equal(r.subject, "ed");
  assert.ok(r.layers.includes("org:acme"), "names the layer that refused");
});

test("mayDo: with no declared layers the derived layers mirror governance, so nothing is recorded", async () => {
  const m = install();
  for (const action of ["approve", "auto", "steer", "policies"] as const) {
    for (const role of ["admin", "editor", "viewer", "wizard"]) mayDo(governance, action, { user: `u-${role}`, role });
  }
  mayDo(governance, "approve", null);
  await flushShadow();
  assert.deepEqual(m.records, []);
});

test("mayDo: a revoked user layer is a disagreement (existing allows, policy denies)", async () => {
  const m = install([{ kind: "user", id: "ed", revokedAt: "2026-10-01T00:00:00Z", limits: {} }]);
  assert.equal(mayDo(governance, "steer", { user: "ed", role: "editor" }), true);
  await flushShadow();
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.kind, "existing-allows-policy-denies");
  assert.match(m.records[0]!.rule ?? "", /revoked/);
});

test("service account: id-only match, role is not consulted, and the record is tagged", async () => {
  const bot = layer("service_account", "ci-bot", {});
  const byRole = install([bot]);
  assert.equal(mayDo(governance, "approve", { user: "ci-bot", role: "admin" }), true, "existing code matches by role");
  await flushShadow();
  assert.equal(byRole.records.length, 1);
  assert.equal(byRole.records[0]!.serviceAccount, true);
  assert.equal(byRole.records[0]!.kind, "existing-allows-policy-denies");

  // Named by id in the grant: both agree, nothing recorded.
  const named: Governance = { ...governance, authority: { ...DEFAULT_AUTHORITY, approve: { roles: [], users: ["ci-bot"] } } };
  const byId = install([bot]);
  assert.equal(mayDo(named, "approve", { user: "ci-bot", role: "viewer" }), true);
  await flushShadow();
  assert.deepEqual(byId.records, []);
});

test("effectiveAuthority: a declared project layer that is stricter than the record is recorded; the result is unchanged", async () => {
  const project = { repo: "o/r", authority: "auto_normal" as const, verification: { tests: "t", preview: { app: "a", smoke: "/" }, visual: true as const, observeWindowMin: 5 } };
  const quiet = install();
  assert.equal(effectiveAuthority(project), "auto_normal");
  await flushShadow();
  assert.deepEqual(quiet.records, [], "derived layer mirrors the record");

  const m = install([layer("project", "o/r", { authority: "send" })]);
  assert.equal(effectiveAuthority(project), "auto_normal");
  await flushShadow();
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.dimension, "authority");
  assert.equal(m.records[0]!.existing, "auto_normal");
  assert.equal(m.records[0]!.policy, "send");
  assert.equal(m.records[0]!.kind, "existing-allows-policy-denies");
});

test("resolveNetworkTier: a tier above a declared organisation ceiling is recorded; the chosen tier is unchanged", async () => {
  const m = install([layer("org", "acme", { network: "allowlist" })]);
  assert.equal(resolveNetworkTier("open", undefined, undefined), "open");
  assert.equal(resolveNetworkTier("none", undefined, undefined), "none", "a tighter choice is not a disagreement");
  await flushShadow();
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.dimension, "network");
  assert.equal(m.records[0]!.existing, "open");
  assert.equal(m.records[0]!.policy, "allowlist");
});

test("normalizeEgressAllow: entries outside a declared organisation allowlist are recorded; the list is unchanged", async () => {
  const m = install([layer("org", "acme", { egressAllow: ["github.com", ".npmjs.org"], network: "allowlist" })]);
  const out = normalizeEgressAllow(["github.com", "registry.npmjs.org", "evil.example"]);
  await flushShadow();
  assert.deepEqual(out, ["github.com", "registry.npmjs.org", "evil.example"]);
  assert.deepEqual(m.records.map((r) => r.existing), ["allow evil.example"]);
  assert.equal(m.records[0]!.kind, "existing-allows-policy-denies");
});

test("assertRepoAllowed: a refusal the policy would have allowed is recorded, and it still throws", async () => {
  const m = install();
  assert.throws(() => assertRepoAllowed("https://github.com/o/r", { trust: "external", config: {} }), RepoNotAllowedError);
  await flushShadow();
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.kind, "policy-allows-existing-denies");
  assert.equal(m.records[0]!.point, "repo");
  assert.match(m.records[0]!.note ?? "", /proxy/);
});

test("assertRepoAllowed: an allowed clone whose host a declared network ceiling closes is recorded", async () => {
  const m = install([layer("org", "acme", { network: "none" })]);
  const ref = assertRepoAllowed("https://github.com/o/r", { trust: "operator", config: {} });
  await flushShadow();
  assert.equal(ref.owner, "o");
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.kind, "existing-allows-policy-denies");
});

function spendStore(initial = 0): SpendStore {
  const holds = new Map<string, number>();
  return {
    async add() {},
    async get() {
      return initial + [...holds.values()].reduce((a, b) => a + b, 0);
    },
    async list() {
      return [];
    },
    async reserve(id: string, _s: string, _d: string, amount: number) {
      holds.set(id, amount);
    },
    async release(id: string) {
      holds.delete(id);
    },
  } as unknown as SpendStore;
}

const budgetRuntime = (spend: SpendStore, project: unknown = null): Pick<ShipRuntime, "spend" | "policies" | "projects"> =>
  ({ spend, policies: { list: async () => [{ source: "web", policy: "propose", dailyBudgetUSD: 5 }] }, projects: { forRepo: async () => project } }) as never;

test("assertDailyBudget: a weekly cap that today's spend plus this run exceeds is recorded; the run is still admitted", async () => {
  const m = install();
  const project = { repo: "o/r", weeklyBudgetUSD: 1 };
  await assertDailyBudget(budgetRuntime(spendStore(1), project), { runId: "r1", source: "web", repo: "o/r", now: NOW });
  await flushShadow();
  const weekly = m.records.filter((r) => r.dimension === "weeklyBudgetUSD");
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0]!.kind, "existing-allows-policy-denies");
  assert.match(weekly[0]!.note ?? "", /lower-bounded/);
  assert.equal(m.records.filter((r) => r.dimension === "dailyBudgetUSD").length, 0, "daily cap mirrors the existing one");
});

test("assertDailyBudget: the daily refusal still throws, and an agreeing policy records nothing", async () => {
  const m = install();
  await assert.rejects(
    assertDailyBudget(budgetRuntime(spendStore(10)), { runId: "r2", source: "web", now: NOW }),
    DailyBudgetExceededError,
  );
  await flushShadow();
  assert.deepEqual(m.records, []);
});

test("assertDailyBudget: a declared organisation budget below the repo's own cap is a daily disagreement", async () => {
  const m = install([layer("org", "acme", { dailyBudgetUSD: 3 })]);
  const project = { repo: "o/r", dailyBudgetUSD: 20 };
  await assertDailyBudget(budgetRuntime(spendStore(4), project), { runId: "r3", source: "web", repo: "o/r", now: NOW });
  await flushShadow();
  const daily = m.records.filter((r) => r.dimension === "dailyBudgetUSD");
  assert.equal(daily.length, 1);
  assert.equal(daily[0]!.kind, "existing-allows-policy-denies");
});

// ── the shadow is isolated ────────────────────────────────────────────────

test("a broken sink and a malformed layers file never fail or alter a decision", async () => {
  installPolicyShadow({
    sink: { append: async () => Promise.reject(new Error("disk full")) },
    now: () => NOW,
    declaredLayers: async () => ({ layers: [], problem: "garbage" }),
    env: {},
  });
  assert.equal(mayDo(governance, "approve", { user: "e", role: "editor" }), true);
  assert.equal(resolveNetworkTier("open", undefined, undefined), "open");
  await flushShadow();
});

test("a malformed declared-layers file is recorded as an error, not as agreement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shadow-layers-"));
  const path = join(dir, "policy-layers.json");
  await writeFile(path, "{not json");
  const m = memorySink();
  installPolicyShadow({ sink: m.sink, now: () => NOW, declaredLayers: () => readDeclaredLayers(path), env: {} });
  mayDo(governance, "approve", { user: "e", role: "editor" });
  await flushShadow();
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0]!.type, "error");
  assert.match(m.records[0]!.note ?? "", /declared layers ignored/);
  assert.equal(summariseShadow(m.records).errors, 1);
  assert.equal((await readDeclaredLayers(join(dir, "absent.json"))).problem, undefined, "an absent file is simply no layers");
});

// ── negative control: a union-merge resolver must be visible ──────────────

/** The bug S25 exists to prevent: combine layers by union / max instead of intersection / min. */
function unionResolve(layers: readonly PolicyLayer[], now: Date): EffectivePolicy {
  const p = resolvePolicy(layers, now);
  const auths = layers.map((l) => l.limits.authority).filter((a): a is NonNullable<typeof a> => a !== undefined);
  const order = ["propose", "send", "auto_trivial", "auto_normal"] as const;
  const loosest = auths.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  const budgets = layers.map((l) => l.limits.dailyBudgetUSD).filter((b) => b !== undefined);
  const daily = budgets.includes("unlimited") ? "unlimited" : Math.max(...(budgets as number[]));
  return { ...p, authority: loosest ?? p.authority, dailyBudgetUSD: daily };
}

test("negative control: the correct resolver agrees on these paths, a union-merge resolver produces visible disagreements", async () => {
  const project = { repo: "o/r", authority: "send" as const };
  const drive = async () => {
    effectiveAuthority(project);
    await assert.rejects(
      assertDailyBudget(budgetRuntime(spendStore(6), { repo: "o/r", dailyBudgetUSD: 5 }), { runId: "nc", source: "web", repo: "o/r", now: NOW }),
      DailyBudgetExceededError,
    );
    await flushShadow();
  };

  const correct = install();
  await drive();
  assert.deepEqual(correct.records, [], "intersection merge agrees with the existing decisions");

  const buggy = install([], unionResolve);
  await drive();
  const dims = buggy.records.map((r) => `${r.dimension}:${r.kind}`).sort();
  assert.deepEqual(dims, ["authority:policy-allows-existing-denies", "dailyBudgetUSD:policy-allows-existing-denies"]);
});

// ── report ────────────────────────────────────────────────────────────────

test("report: groups repeats, separates errors, tags service accounts, and states what it cannot know", async () => {
  const m = install([layer("org", "acme", { actions: { approve: { roles: ["admin"], users: [] } } }), layer("service_account", "bot", {})]);
  for (let i = 0; i < 3; i++) mayDo(governance, "approve", { user: "ed", role: "editor" });
  mayDo(governance, "approve", { user: "bot", role: "admin" });
  await flushShadow();
  const text = [...m.records.map((r) => JSON.stringify(r)), "not json", JSON.stringify({ v: 2 })].join("\n");
  const parsed = parseShadowRecords(text);
  assert.equal(parsed.malformed, 2);
  const s = summariseShadow(parsed.records, parsed.malformed);
  assert.equal(s.disagreements, 4);
  assert.equal(s.groups.find((g) => g.subject === "ed")?.count, 3);
  assert.equal(s.serviceAccountDisagreements, 1);
  const out = renderShadowReport(s, "x.jsonl");
  assert.match(out, /3x existing-allows-policy-denies/);
  assert.match(out, /\[service-account\]/);
  assert.match(out, /service-account role is NOT decided/i);
  assert.match(out, /cannot give a disagreement rate/);
  assert.match(out, /2 unreadable line/);
  assert.equal(summariseShadow([]).disagreements, 0);
});

test("report: a missing record file reads as unknown, not as zero disagreements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shadow-missing-"));
  const s = await readShadowSummary(join(dir, "absent.jsonl"));
  assert.equal(s.fileFound, false);
  assert.match(renderShadowReport(s, "absent.jsonl"), /unknown, not zero/);
});

test("the file sink writes JSON lines the report command reads back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shadow-file-"));
  const file = join(dir, "nested", "policy-shadow.jsonl");
  const layers = join(dir, "layers.json");
  await writeFile(layers, JSON.stringify({ layers: [layer("org", "acme", { actions: { approve: { roles: ["admin"], users: [] } } })] }));
  const env = { SHIP_POLICY_SHADOW: "on", SHIP_POLICY_SHADOW_FILE: file, SHIP_POLICY_LAYERS_FILE: layers } as NodeJS.ProcessEnv;
  assert.equal(installPolicyShadowFromEnv(env), true);
  assert.equal(mayDo(governance, "approve", { user: "ed", role: "editor" }), true);
  await flushShadow();
  const { records, malformed } = parseShadowRecords(await readFile(file, "utf8"));
  assert.equal(malformed, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.point, "mayDo");
});
