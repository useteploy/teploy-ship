import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIMENSIONS,
  egressCovered,
  explainRefusal,
  permits,
  resolvePolicy,
  validateLayer,
  type PolicyLayer,
  type PolicyLimits,
} from "./policy-inheritance.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 3_600_000;

const layer = (kind: PolicyLayer["kind"], id: string, limits: PolicyLimits, extra: Partial<PolicyLayer> = {}): PolicyLayer => ({ kind, id, limits, ...extra });

const ORG: PolicyLimits = {
  models: ["claude-sonnet", "claude-haiku"],
  tools: ["read", "edit", "bash"],
  network: "allowlist",
  egressAllow: ["github.com", ".npmjs.org"],
  retentionDays: 90,
  dailyBudgetUSD: 50,
  weeklyBudgetUSD: 200,
  authority: "auto_trivial",
  provisioning: "propose",
  workspace: "write",
  actions: {
    approve: { roles: ["admin", "editor"], users: [] },
    auto: { roles: ["admin"], users: [] },
    steer: { roles: ["admin", "editor"], users: [] },
    policies: { roles: ["admin"], users: [] },
  },
};
const PROJECT: PolicyLimits = { authority: "auto_trivial", verification: { tests: "pnpm test", preview: { app: "web", smoke: "/" }, visual: true } };
const USER: PolicyLimits = {};
const org = (over: PolicyLimits = {}, extra: Partial<PolicyLayer> = {}): PolicyLayer => layer("org", "acme", { ...ORG, ...over }, extra);
const project = (over: PolicyLimits = {}, extra: Partial<PolicyLayer> = {}): PolicyLayer => layer("project", "web", { ...PROJECT, ...over }, extra);
const user = (over: PolicyLimits = {}, extra: Partial<PolicyLayer> = {}, id = "ed"): PolicyLayer => layer("user", id, { ...USER, ...over }, extra);
const editor = { user: "ed", role: "editor" };

test("a well-formed chain resolves to the org limits and explains every dimension", () => {
  const p = resolvePolicy([org(), project(), user()], NOW);
  assert.equal(p.denyAll, null);
  assert.deepEqual(p.models, ["claude-sonnet", "claude-haiku"]);
  assert.equal(p.network, "allowlist");
  assert.equal(p.authority, "auto_trivial");
  assert.equal(p.dailyBudgetUSD, 50);
  for (const d of DIMENSIONS) assert.ok(p.explanations[d] !== undefined && p.explanations[d].decidedBy.length > 0, d);
  assert.deepEqual(p.explanations.dailyBudgetUSD.decidedBy, ["org:acme"]);
  assert.equal(permits(p, { kind: "action", action: "approve", principal: editor }), true);
});

test("tightening: each dimension takes the most restrictive layer and names it", () => {
  const p = resolvePolicy(
    [
      org(),
      project({ dailyBudgetUSD: 20, models: ["claude-haiku"], network: "none", retentionDays: 30, workspace: "read" }),
      user({ weeklyBudgetUSD: 10, tools: ["read"], authority: "send", egressAllow: ["github.com"], provisioning: "none" }),
    ],
    NOW,
  );
  assert.equal(p.dailyBudgetUSD, 20);
  assert.equal(p.weeklyBudgetUSD, 10);
  assert.deepEqual(p.models, ["claude-haiku"]);
  assert.deepEqual(p.tools, ["read"]);
  assert.equal(p.network, "none");
  assert.equal(p.retentionDays, 30);
  assert.equal(p.authority, "send");
  assert.equal(p.provisioning, "none");
  assert.equal(p.workspace, "read");
  assert.deepEqual(p.explanations.dailyBudgetUSD.decidedBy, ["org:acme", "project:web"]);
  assert.deepEqual(p.explanations.tools.decidedBy, ["org:acme", "user:ed"]);
  assert.equal(p.ignored.length, 0, "tightening is not a loosening attempt");
});

test("project tries to loosen an org cap: ignored, reported, org limit kept", () => {
  const p = resolvePolicy(
    [
      org(),
      project({ dailyBudgetUSD: 500, weeklyBudgetUSD: "unlimited", network: "open", retentionDays: 3650, models: ["claude-sonnet", "gpt-x"], workspace: "write", provisioning: "apply" }),
      user(),
    ],
    NOW,
  );
  assert.equal(p.dailyBudgetUSD, 50);
  assert.equal(p.weeklyBudgetUSD, 200);
  assert.equal(p.network, "allowlist");
  assert.equal(p.retentionDays, 90);
  assert.deepEqual(p.models, ["claude-sonnet"]);
  assert.equal(p.provisioning, "propose");
  const dims = p.ignored.filter((i) => i.layer === "project:web").map((i) => i.dimension).sort();
  assert.deepEqual(dims, ["dailyBudgetUSD", "models", "network", "provisioning", "retentionDays", "weeklyBudgetUSD"]);
  assert.deepEqual(p.explanations.network.ignored[0], { layer: "project:web", dimension: "network", asked: "open", kept: "allowlist" });
  const r = explainRefusal(p, { kind: "spend", scope: "daily", spentUSD: 45, costUSD: 10 });
  assert.equal(r?.layer, "org:acme");
  assert.equal(explainRefusal(p, { kind: "model", model: "gpt-x" })?.dimension, "models");
});

test("project authority is capped by its ladder even when it asks for more", () => {
  const p = resolvePolicy([org({ authority: "auto_normal" }), project({ authority: "auto_normal", verification: { tests: "t" } }), user()], NOW);
  assert.equal(p.authority, "send", "no preview/visual -> send, whatever the project record says");
  assert.deepEqual(p.explanations.authority.decidedBy, ["org:acme", "project:web"]);
  const never = resolvePolicy([org(), project({ neverAuto: true }), user()], NOW);
  assert.equal(never.authority, "send");
});

test("user grants themselves a tool/action the org forbids: refused, naming the org layer", () => {
  const sneaky = user({ tools: ["read", "deploy"], actions: { policies: { roles: [], users: ["ed"] } } });
  const p = resolvePolicy([org(), project(), sneaky], NOW);
  assert.deepEqual(p.tools, ["read"]);
  assert.equal(explainRefusal(p, { kind: "tool", tool: "deploy" })?.dimension, "tools");
  assert.ok(p.ignored.some((i) => i.layer === "user:ed" && i.dimension === "tools" && i.asked.includes("deploy")));
  const r = explainRefusal(p, { kind: "action", action: "policies", principal: editor });
  assert.equal(r?.layer, "org:acme", "the org grant is the rule that refused");
  assert.ok(p.ignored.some((i) => i.layer === "user:ed" && i.dimension === "actions.policies"));
  // negative control on the same request shape: an admin the org admits is allowed
  const admin = resolvePolicy([org(), project(), user({}, {}, "root")], NOW);
  assert.equal(permits(admin, { kind: "action", action: "policies", principal: { user: "root", role: "admin" } }), true);
});

test("a user layer can narrow an action but never widen past the org", () => {
  const p = resolvePolicy([org(), project(), user({ actions: { approve: { roles: [], users: ["someone-else"] } } })], NOW);
  const r = explainRefusal(p, { kind: "action", action: "approve", principal: editor });
  assert.equal(r?.layer, "user:ed");
});

test("expired grant contributes nothing; the boundary instant is expired", () => {
  const live = resolvePolicy([org(), project({}, { expiresAt: iso(HOUR) }), user()], NOW);
  assert.equal(live.authority, "auto_trivial");
  const expired = resolvePolicy([org(), project({}, { expiresAt: iso(-HOUR) }), user()], NOW);
  assert.equal(expired.authority, "none", "dropped project layer: authority denied, not defaulted");
  assert.deepEqual(expired.dropped, [{ layer: "project:web", reason: "expired" }]);
  assert.equal(resolvePolicy([org(), project({}, { expiresAt: NOW.toISOString() }), user()], NOW).authority, "none");
  const early = resolvePolicy([org(), project({}, { notBefore: iso(HOUR) }), user()], NOW);
  assert.equal(early.dropped[0]?.reason, "not-yet-valid");
  // other dimensions fall back to the org limit
  assert.equal(expired.dailyBudgetUSD, 50);
  // an unparsable timestamp fails closed
  assert.equal(resolvePolicy([org(), project({}, { expiresAt: "soon" }), user()], NOW).dropped[0]?.reason, "invalid-time");
});

test("recomputed per request: the same layers give a different answer after expiry", () => {
  const layers = [org(), project(), user({}, { expiresAt: iso(HOUR) })];
  assert.equal(permits(resolvePolicy(layers, NOW), { kind: "action", action: "approve", principal: editor }), true);
  const later = new Date(NOW.getTime() + 2 * HOUR);
  const r = explainRefusal(resolvePolicy(layers, later), { kind: "action", action: "approve", principal: editor });
  assert.equal(r?.layer, "user:ed");
  assert.match(r?.rule ?? "", /expired/);
});

test("revoked member: everything denied, naming the user layer; other principals unaffected", () => {
  const revoked = resolvePolicy([org(), project(), user({}, { revokedAt: iso(-1000) })], NOW);
  assert.ok(revoked.denyAll);
  assert.equal(revoked.authority, "none");
  assert.deepEqual(revoked.models, []);
  assert.equal(revoked.network, "none");
  for (const req of [
    { kind: "model", model: "claude-haiku" },
    { kind: "tool", tool: "read" },
    { kind: "action", action: "approve", principal: editor },
  ] as const) {
    const r = explainRefusal(revoked, req);
    assert.equal(r?.layer, "user:ed");
    assert.match(r?.rule ?? "", /revoked/);
  }
  const other = resolvePolicy([org(), project(), user({}, {}, "bo")], NOW);
  assert.equal(permits(other, { kind: "tool", tool: "read" }), true);
  // revoked in the future is still active now
  assert.equal(resolvePolicy([org(), project(), user({}, { revokedAt: iso(HOUR) })], NOW).denyAll, null);
});

test("revoked org layer or no org layer: everything denied", () => {
  assert.ok(resolvePolicy([project(), user()], NOW).denyAll);
  const r = explainRefusal(resolvePolicy([org({}, { revokedAt: iso(-1) }), project(), user()], NOW), { kind: "tool", tool: "read" });
  assert.equal(r?.layer, "org:acme");
});

test("conflicting same-level layers resolve to the stricter, in any input order, and are reported", () => {
  const a = layer("project", "a", { dailyBudgetUSD: 30, tools: ["read", "edit"] });
  const b = layer("project", "b", { dailyBudgetUSD: 10, tools: ["edit", "bash"] });
  const fwd = resolvePolicy([org(), a, b, user()], NOW);
  const rev = resolvePolicy([user(), b, a, org()], NOW);
  for (const p of [fwd, rev]) {
    assert.equal(p.dailyBudgetUSD, 10);
    assert.deepEqual(p.tools, ["edit"]);
    assert.ok(p.conflicts.some((c) => c.dimension === "dailyBudgetUSD" && c.layers.join() === "project:a,project:b" && c.kept === "10"));
    assert.ok(p.conflicts.some((c) => c.dimension === "tools"));
  }
  assert.deepEqual(fwd.explanations.dailyBudgetUSD.decidedBy, ["org:acme", "project:a", "project:b"]);
  assert.equal(JSON.stringify(fwd.explanations), JSON.stringify(rev.explanations), "input order does not change the answer");
  // agreeing layers are not a conflict
  const agree = resolvePolicy([org(), layer("project", "a", { dailyBudgetUSD: 10 }), layer("project", "b", { dailyBudgetUSD: 10 }), user()], NOW);
  assert.equal(agree.conflicts.filter((c) => c.dimension === "dailyBudgetUSD").length, 0);
});

test("empty layers deny: no layers, org only, org + project without a principal", () => {
  const none = resolvePolicy([], NOW);
  assert.ok(none.denyAll);
  assert.equal(explainRefusal(none, { kind: "model", model: "claude-haiku" })?.layer, "default");

  const orgOnly = resolvePolicy([org()], NOW);
  assert.equal(orgOnly.authority, "none", "no project/user layer: authority denied");
  assert.equal(explainRefusal(orgOnly, { kind: "authority", level: "propose" })?.dimension, "authority");
  assert.match(orgOnly.explanations.authority.note ?? "", /no active project or user layer/);
  assert.deepEqual(orgOnly.models, ["claude-sonnet", "claude-haiku"], "non-authority dimensions fall back to the org limit");

  assert.equal(resolvePolicy([org(), project()], NOW).authority, "none");
  assert.equal(resolvePolicy([org(), user()], NOW).authority, "none");
});

test("an org layer that declares nothing is closed, and lower layers cannot open it", () => {
  const bare = layer("org", "acme", {});
  const p = resolvePolicy([bare, project({ models: ["claude-sonnet"], tools: ["bash"], network: "open", dailyBudgetUSD: 1000 }), user()], NOW);
  assert.deepEqual(p.models, []);
  assert.deepEqual(p.tools, []);
  assert.equal(p.network, "none");
  assert.equal(p.dailyBudgetUSD, 0);
  assert.equal(p.authority, "none");
  assert.deepEqual(p.explanations.models.decidedBy, ["default"]);
  for (const a of ["approve", "auto", "steer", "policies"] as const) {
    assert.ok(explainRefusal(p, { kind: "action", action: a, principal: { user: "ed", role: "admin" } }), a);
  }
  assert.equal(p.retentionDays, null, "retention is the one dimension where closed would delete data; it stays unset");
  assert.equal(explainRefusal(p, { kind: "retention", days: 10_000 }), null);
});

test("service accounts do not inherit human authority they were not scoped", () => {
  const sa = (limits: PolicyLimits): PolicyLayer => layer("service_account", "ci-bot", limits);
  const unscoped = resolvePolicy([org(), project(), sa({})], NOW);
  assert.equal(unscoped.authority, "none");
  assert.equal(unscoped.provisioning, "none");
  assert.equal(unscoped.workspace, "none");
  assert.equal(unscoped.principal?.kind, "service_account");
  // Role-based grants never match a service account, whatever role string it presents.
  for (const role of ["admin", "editor"]) {
    const r = explainRefusal(unscoped, { kind: "action", action: "approve", principal: { user: "ci-bot", role } });
    assert.equal(r?.layer, "org:acme", role);
  }
  // Scoped: explicit authority and an explicit id grant in every declaring layer.
  const scoped = resolvePolicy(
    [
      org({ actions: { ...ORG.actions, steer: { roles: ["admin"], users: ["ci-bot"] } } }),
      project(),
      sa({ authority: "send", workspace: "read", provisioning: "none", actions: { steer: { roles: [], users: ["ci-bot"] } } }),
    ],
    NOW,
  );
  assert.equal(scoped.authority, "send");
  assert.equal(scoped.workspace, "read");
  assert.equal(permits(scoped, { kind: "action", action: "steer", principal: { user: "ci-bot", role: "admin" } }), true);
  assert.equal(permits(scoped, { kind: "action", action: "approve", principal: { user: "ci-bot", role: "admin" } }), false);
  assert.equal(permits(scoped, { kind: "workspace", level: "write" }), false);
  // Scoped cannot exceed the org either.
  const greedy = resolvePolicy([org(), project(), sa({ authority: "auto_normal", workspace: "write" })], NOW);
  assert.equal(greedy.authority, "auto_trivial");
  // An expired service account is denied outright.
  const gone = resolvePolicy([org(), project(), layer("service_account", "ci-bot", { authority: "send" }, { expiresAt: iso(-1) })], NOW);
  assert.ok(gone.denyAll);
});

test("a policy resolved for one principal refuses a request carrying another", () => {
  const p = resolvePolicy([org(), project(), user()], NOW);
  const r = explainRefusal(p, { kind: "action", action: "approve", principal: { user: "mallory", role: "admin" } });
  assert.match(r?.rule ?? "", /not the principal/);
});

test("network and egress: most restrictive tier; destinations are the intersection", () => {
  const p = resolvePolicy([org(), project({ egressAllow: ["github.com", "registry.npmjs.org", "evil.test"] }), user()], NOW);
  assert.deepEqual(p.egressAllow, ["github.com", "registry.npmjs.org"], "suffix .npmjs.org covers registry.npmjs.org; evil.test is outside");
  assert.equal(permits(p, { kind: "egress", destination: "registry.npmjs.org" }), true);
  assert.equal(explainRefusal(p, { kind: "egress", destination: "evil.test" })?.layer, "project:web");
  assert.equal(permits(p, { kind: "egress", destination: "github.com:22" }), false, "ports must agree");
  assert.equal(explainRefusal(p, { kind: "network", tier: "open" })?.dimension, "network");
  const sealed = resolvePolicy([org(), project(), user({ network: "none" })], NOW);
  assert.equal(explainRefusal(sealed, { kind: "egress", destination: "github.com" })?.layer, "user:ed");
  assert.equal(egressCovered("a.b.example.com", ".example.com"), true);
  assert.equal(egressCovered("example.com", ".example.com"), false);
  assert.equal(egressCovered("notexample.com", ".example.com"), false);
});

test("spend: cap applies to spent plus cost; unlimited only if every layer says so", () => {
  const p = resolvePolicy([org({ dailyBudgetUSD: "unlimited" }), project(), user()], NOW);
  assert.equal(p.dailyBudgetUSD, "unlimited");
  assert.equal(permits(p, { kind: "spend", scope: "daily", spentUSD: 1e6, costUSD: 1 }), true);
  const q = resolvePolicy([org({ dailyBudgetUSD: "unlimited" }), project({ dailyBudgetUSD: 5 }), user()], NOW);
  assert.equal(q.dailyBudgetUSD, 5);
  assert.equal(permits(q, { kind: "spend", scope: "daily", spentUSD: 4, costUSD: 1 }), true);
  assert.equal(permits(q, { kind: "spend", scope: "daily", spentUSD: 4, costUSD: 1.01 }), false);
  assert.equal(permits(q, { kind: "spend", scope: "daily", spentUSD: NaN, costUSD: 1 }), false);
  // an invalid (negative) value from a lower layer is skipped by resolve and reported by validateLayer
  assert.ok(validateLayer(layer("project", "x", { dailyBudgetUSD: -1, network: "wide" as never })).length === 2);
});

test("retention: shortest wins, request over the limit is refused with the deciding layer", () => {
  const p = resolvePolicy([org(), project({ retentionDays: 14 }), user({ retentionDays: 30 })], NOW);
  assert.equal(p.retentionDays, 14);
  assert.equal(explainRefusal(p, { kind: "retention", days: 30 })?.layer, "project:web");
  assert.equal(explainRefusal(p, { kind: "retention", days: 14 }), null);
});

test("wildcard allow-list at the org is still narrowed by lower layers", () => {
  const p = resolvePolicy([org({ models: "*", tools: "*" }), project({ models: ["claude-haiku"] }), user()], NOW);
  assert.deepEqual(p.models, ["claude-haiku"]);
  assert.equal(p.modelsAny, false);
  assert.equal(p.toolsAny, true);
  assert.equal(permits(p, { kind: "tool", tool: "anything" }), true);
});

// ── negative control: the union merge everyone writes first ──────────────

/** The tempting implementation: combine settings, most generous wins. Kept here only to prove it leaks. */
function unionMerge(layers: PolicyLayer[]): { tools: Set<string>; daily: number; network: string; authority: string } {
  const rank = ["none", "allowlist", "open"];
  const auth = ["propose", "send", "auto_trivial", "auto_normal"];
  const out = { tools: new Set<string>(), daily: 0, network: "none", authority: "propose" };
  for (const l of layers) {
    if (Array.isArray(l.limits.tools)) for (const t of l.limits.tools) out.tools.add(t);
    if (typeof l.limits.dailyBudgetUSD === "number") out.daily = Math.max(out.daily, l.limits.dailyBudgetUSD);
    if (l.limits.network !== undefined && rank.indexOf(l.limits.network) > rank.indexOf(out.network)) out.network = l.limits.network;
    if (l.limits.authority !== undefined && auth.indexOf(l.limits.authority) > auth.indexOf(out.authority)) out.authority = l.limits.authority;
  }
  return out;
}

test("negative control: a union/max merge leaks what resolvePolicy holds", () => {
  const layers = [
    org(),
    project({ tools: ["read", "deploy"], dailyBudgetUSD: 500, network: "open", authority: "auto_normal" }),
    user({ tools: ["read", "shell-root"] }),
  ];
  const leaky = unionMerge(layers);
  assert.ok(leaky.tools.has("deploy") && leaky.tools.has("shell-root"), "union adds tools the org never allowed");
  assert.equal(leaky.daily, 500);
  assert.equal(leaky.network, "open");
  assert.equal(leaky.authority, "auto_normal");

  const p = resolvePolicy(layers, NOW);
  assert.equal(permits(p, { kind: "tool", tool: "deploy" }), false);
  assert.equal(permits(p, { kind: "tool", tool: "shell-root" }), false);
  assert.equal(p.dailyBudgetUSD, 50);
  assert.equal(p.network, "allowlist");
  assert.notEqual(p.authority, "auto_normal");
});

test("explanations are complete and stable for a denied policy too", () => {
  const p = resolvePolicy([], NOW);
  assert.deepEqual(Object.keys(p.explanations).sort(), [...DIMENSIONS].sort());
});
