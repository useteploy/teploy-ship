import test from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_WEBHOOK_EVENTS,
  ensureProjectWebhook,
  parseProjectRow,
  projectHookUrl,
  registerProject,
} from "./akiroo-project.js";
import type { RegisterProjectDeps } from "./akiroo-project.js";
import type { ProjectAckPayload, ProjectNotifier } from "./notify.js";
import type { Project, ProjectStore } from "./projects.js";
import { managedDrift } from "./projects.js";
import { repoSlug } from "./observe.js";
import { parseRepoUrl } from "./git.js";
import type { RepoPolicyConfig } from "./repo-policy.js";

const POLICY: RepoPolicyConfig = { allowlist: "http://forge.test", gitToken: "tok-abc" };
const REPO = "http://forge.test/tyler/site.git";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_ref: "project:12",
    repo: REPO,
    slug: "tyler/site",
    label: "Site",
    verification: { build: "pnpm build", tests: "pnpm test", observe_window_min: 10 },
    authority: "auto_trivial",
    never_auto: false,
    weekly_budget_usd: 20,
    sandbox_image: null,
    settings_hash: "abc123def456",
    ...overrides,
  };
}

/** In-memory ProjectStore — registerProject only reads forRepo and set. */
function memoryProjects(): ProjectStore {
  const records = new Map<string, Project>();
  return {
    forRepo: async (repo) => records.get(repoSlug(repo) ?? repo) ?? null,
    set: async (p) => {
      records.set(p.repo, p);
    },
    list: async () => [...records.values()],
    remove: async (repo) => {
      records.delete(repoSlug(repo) ?? repo);
    },
  };
}

/** A fetch that answers the forge's hook list and hook create endpoints. */
function fakeForge(options: { existing?: string; failCreate?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: href, body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (href.includes("/hooks") && method === "GET") {
      return new Response(JSON.stringify(options.existing !== undefined ? [{ config: { url: options.existing } }] : []), { status: 200 });
    }
    if (href.includes("/hooks") && method === "POST") {
      if (options.failCreate === true) return new Response("no", { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }
    throw new Error(`unexpected fetch: ${method} ${href}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * registerProject deps over an in-memory store, a capturing notifier and a
 * fake forge. `deps()` re-reads the same stores, so a test can act between
 * registrations through deps().projects.
 */
function sink(overrides: Partial<RegisterProjectDeps> = {}): {
  acks: ProjectAckPayload[];
  forge: ReturnType<typeof fakeForge>;
  deps: (more?: Partial<RegisterProjectDeps>) => RegisterProjectDeps;
} {
  const acks: ProjectAckPayload[] = [];
  const projects = memoryProjects();
  const forge = fakeForge();
  const notifier: ProjectNotifier = {
    enabled: true,
    project: async (ack) => {
      acks.push(ack);
      return true;
    },
    revert: async () => true,
  };
  const deps = (more: Partial<RegisterProjectDeps> = {}): RegisterProjectDeps => ({
    projects,
    repoPolicy: POLICY,
    hookBase: "http://ship.test",
    hookSecret: "whsec",
    notify: notifier,
    fetchImpl: forge.fetchImpl,
    log: () => {},
    ...overrides,
    ...more,
  });
  return { acks, forge, deps };
}

test("parseProjectRow accepts the contract-1 shape and camelCases the ladder", () => {
  const parsed = parseProjectRow(row());
  assert.equal(parsed.project_ref, "project:12");
  assert.equal(parsed.authority, "auto_trivial");
  assert.deepEqual(parsed.verification, { build: "pnpm build", tests: "pnpm test", observeWindowMin: 10 });
});

test("first ownership sync cannot silently erase manual verification or safety settings", async () => {
  const s = sink();
  const original: Project = { repo: "tyler/site", url: REPO, autoMerge: false, autoDeploy: false,
    testCommand: "go test ./...", weeklyBudgetUSD: 5, verification: { build: "go build ./...", tests: "go test ./..." } };
  await s.deps().projects.set(original);
  const result = await registerProject(s.deps(),row({ verification: {}, weekly_budget_usd: null }));
  assert.equal(result.status,"failed");
  assert.match(result.error ?? "",/reconcile/);
  assert.deepEqual(await s.deps().projects.forRepo(REPO),original);
  assert.equal(s.forge.calls.length,0);
});

test("parseProjectRow reads the environment pair: snake_case in, validated, absent distinct from null", () => {
  const parsed = parseProjectRow(row({ preparation: { command: " pnpm install ", timeout_ms: 120_000 }, sandbox_network: "open" }));
  assert.deepEqual(parsed.preparation, { command: "pnpm install", timeoutMs: 120_000 });
  assert.equal(parsed.sandbox_network, "open");
  // timeout_ms omitted takes normalizePreparation's default.
  assert.deepEqual(parseProjectRow(row({ preparation: { command: "make deps" } })).preparation, { command: "make deps", timeoutMs: 300_000 });
  // The legacy spelling folds like everywhere else.
  assert.equal(parseProjectRow(row({ sandbox_network: "egress" })).sandbox_network, "allowlist");
  // Absent: the keys are not on the parsed row at all. Null: "none".
  const old = parseProjectRow(row());
  assert.equal("preparation" in old, false);
  assert.equal("sandbox_network" in old, false);
  const none = parseProjectRow(row({ preparation: null, sandbox_network: null }));
  assert.equal(none.preparation, null);
  assert.equal(none.sandbox_network, null);
  assert.equal(parseProjectRow(row({ preparation: { command: "  " } })).preparation, null);
});

test("parseProjectRow refuses a malformed environment", () => {
  assert.throws(() => parseProjectRow(row({ preparation: "pnpm install" })), /preparation must be an object or null/);
  assert.throws(() => parseProjectRow(row({ preparation: { command: 7 } })), /preparation.command must be a string/);
  assert.throws(() => parseProjectRow(row({ preparation: { command: "x", timeout_ms: 10 } })), /project project:12 preparation: Environment timeout/);
  assert.throws(() => parseProjectRow(row({ preparation: { command: "x", timeout_ms: "60000" } })), /Environment timeout/);
  assert.throws(() => parseProjectRow(row({ sandbox_network: "bridge" })), /sandbox_network must be/);
  assert.throws(() => parseProjectRow(row({ sandbox_network: 1 })), /sandbox_network must be/);
});

test("a row carrying the environment applies it, snapshots it, and an operator edit shows as drift", async () => {
  const s = sink();
  await registerProject(s.deps(), row({ preparation: { command: "pnpm install", timeout_ms: 60_000 }, sandbox_network: "open" }));
  const store = s.deps().projects;
  const saved = (await store.forRepo(REPO))!;
  assert.deepEqual(saved.preparation, { command: "pnpm install", timeoutMs: 60_000 });
  assert.equal(saved.sandboxNetwork, "open");
  assert.deepEqual(saved.managedBy?.fields.preparation, { command: "pnpm install", timeoutMs: 60_000 });
  assert.equal(saved.managedBy?.fields.sandboxNetwork, "open");
  assert.equal(managedDrift(saved).length, 0);
  await store.set({ ...saved, sandboxNetwork: "none", preparation: { command: "npm ci", timeoutMs: 60_000 } });
  const drift = managedDrift((await store.forRepo(REPO))!);
  assert.deepEqual(drift.map((d) => d.field).sort(), ["preparation", "sandboxNetwork"]);
  assert.deepEqual(drift.find((d) => d.field === "sandboxNetwork"), { field: "sandboxNetwork", local: "none", managed: "open" });
  // Null clears as an owned field, and the record and snapshot agree.
  await registerProject(s.deps(), row({ preparation: null, sandbox_network: null, settings_hash: "h2" }));
  const cleared = (await store.forRepo(REPO))!;
  assert.equal(cleared.preparation, undefined);
  assert.equal(cleared.sandboxNetwork, undefined);
  assert.equal(managedDrift(cleared).length, 0);
  // A hand-set value under a null snapshot IS drift (Akiroo said none).
  await store.set({ ...cleared, sandboxNetwork: "open" });
  assert.deepEqual(managedDrift((await store.forRepo(REPO))!), [{ field: "sandboxNetwork", local: "open", managed: "unset" }]);
});

test("a row from an older Akiroo that omits the environment keeps the hand-set one, unmanaged and without drift", async () => {
  const s = sink();
  await registerProject(s.deps(), row());
  const store = s.deps().projects;
  await store.set({ ...(await store.forRepo(REPO))!, preparation: { command: "go mod download", timeoutMs: 90_000 }, sandboxNetwork: "allowlist" });
  await registerProject(s.deps(), row({ settings_hash: "h2" }));
  const after = (await store.forRepo(REPO))!;
  assert.deepEqual(after.preparation, { command: "go mod download", timeoutMs: 90_000 });
  assert.equal(after.sandboxNetwork, "allowlist");
  assert.equal("preparation" in after.managedBy!.fields, false);
  assert.equal("sandboxNetwork" in after.managedBy!.fields, false);
  assert.equal(managedDrift(after).length, 0);
});

test("first sync: a hand-set environment refuses a row that clears it, but not one that carries it or omits it", async () => {
  const original: Project = { repo: "tyler/site", url: REPO, autoMerge: false, autoDeploy: false,
    preparation: { command: "pnpm install", timeoutMs: 300_000 }, sandboxNetwork: "open" };
  for (const clearing of [{ preparation: null }, { sandbox_network: null }]) {
    const s = sink();
    await s.deps().projects.set(original);
    const result = await registerProject(s.deps(), row({ verification: undefined, weekly_budget_usd: null, ...clearing }));
    assert.equal(result.status, "failed", JSON.stringify(clearing));
    assert.match(result.error ?? "", /environment/);
    assert.deepEqual(await s.deps().projects.forRepo(REPO), original);
  }
  for (const keeping of [
    { preparation: { command: "pnpm install", timeout_ms: 300_000 }, sandbox_network: "open" },
    { preparation: { command: "pnpm install --frozen-lockfile", timeout_ms: 600_000 }, sandbox_network: "allowlist" },
    {},
  ]) {
    const s = sink();
    await s.deps().projects.set(original);
    const result = await registerProject(s.deps(), row({ verification: undefined, weekly_budget_usd: null, ...keeping }));
    assert.equal(result.status, "registered", JSON.stringify(keeping));
    assert.notEqual((await s.deps().projects.forRepo(REPO))?.preparation, undefined);
  }
});

test("parseProjectRow reads sandbox_user: root, default/null as the non-root default, absent distinct", () => {
  assert.equal(parseProjectRow(row({ sandbox_user: "root" })).sandbox_user, "root");
  assert.equal(parseProjectRow(row({ sandbox_user: "default" })).sandbox_user, null);
  assert.equal(parseProjectRow(row({ sandbox_user: null })).sandbox_user, null);
  assert.equal("sandbox_user" in parseProjectRow(row()), false);
  assert.throws(() => parseProjectRow(row({ sandbox_user: "ship" })), /sandbox_user must be/);
  assert.throws(() => parseProjectRow(row({ sandbox_user: true })), /sandbox_user must be/);
});

test("sandbox_user: applied and snapshotted when carried, cleared by null, left alone when absent", async () => {
  const s = sink();
  const store = s.deps().projects;
  await registerProject(s.deps(), row({ sandbox_user: "root" }));
  const saved = (await store.forRepo(REPO))!;
  assert.equal(saved.sandboxUser, "root");
  assert.equal(saved.managedBy?.fields.sandboxUser, "root");
  assert.equal(managedDrift(saved).length, 0);
  // An operator flips it back by hand: drift.
  const { sandboxUser: _u, ...handEdited } = saved;
  await store.set(handEdited);
  assert.deepEqual(managedDrift((await store.forRepo(REPO))!), [{ field: "sandboxUser", local: "unset", managed: "root" }]);
  // A row saying `default` clears it as an owned field.
  await registerProject(s.deps(), row({ sandbox_user: "default", settings_hash: "h2" }));
  const cleared = (await store.forRepo(REPO))!;
  assert.equal(cleared.sandboxUser, undefined);
  assert.equal(cleared.managedBy?.fields.sandboxUser, null);
  assert.equal(managedDrift(cleared).length, 0);

  const t = sink();
  const other = t.deps().projects;
  await registerProject(t.deps(), row());
  await other.set({ ...(await other.forRepo(REPO))!, sandboxUser: "root" });
  await registerProject(t.deps(), row({ settings_hash: "h2" }));
  const kept = (await other.forRepo(REPO))!;
  assert.equal(kept.sandboxUser, "root", "a row without the key keeps the hand-set root");
  assert.equal("sandboxUser" in kept.managedBy!.fields, false);
  assert.equal(managedDrift(kept).length, 0);
});

test("first sync: a hand-set root refuses a row that clears it", async () => {
  const original: Project = { repo: "tyler/site", url: REPO, autoMerge: false, autoDeploy: false, sandboxUser: "root" };
  for (const [extra, status] of [[{ sandbox_user: null }, "failed"], [{ sandbox_user: "default" }, "failed"], [{ sandbox_user: "root" }, "registered"], [{}, "registered"]] as const) {
    const s = sink();
    await s.deps().projects.set(original);
    const result = await registerProject(s.deps(), row({ verification: undefined, weekly_budget_usd: null, ...extra }));
    assert.equal(result.status, status, JSON.stringify(extra));
    assert.equal((await s.deps().projects.forRepo(REPO))?.sandboxUser, "root");
  }
});

test("a refused repo cannot be persisted before the allowlist check", async () => {
  const s = sink();
  const result = await registerProject(s.deps({ repoPolicy: { allowlist: "https://elsewhere.example.com" } }),row());
  assert.equal(result.status,"failed");
  assert.equal(await s.deps().projects.forRepo(REPO),null);
});

test("managed tests replace and clear the legacy command alias too", async () => {
  const s = sink();
  await registerProject(s.deps(),row());
  await registerProject(s.deps(),row({ verification: { tests: "pnpm test:new" }, settings_hash: "new" }));
  assert.equal((await s.deps().projects.forRepo(REPO))?.testCommand,"pnpm test:new");
  await registerProject(s.deps(),row({ verification: {}, settings_hash: "cleared" }));
  assert.equal((await s.deps().projects.forRepo(REPO))?.testCommand,undefined);
});

test("parseProjectRow refuses a slug that disagrees with the repo url", () => {
  assert.throws(() => parseProjectRow(row({ slug: "someone/else" })), /does not match its repo url/);
});

test("parseProjectRow takes a slug that differs from the repo url only in case", () => {
  assert.doesNotThrow(() => parseProjectRow(row({
    repo: "http://forge.example.internal:49152/Tyler/ship-credential-proof.git",
    slug: "Tyler/ship-credential-proof",
  })));
});

test("parseProjectRow refuses a half-declared preview, through S-C's validator", () => {
  assert.throws(() => parseProjectRow(row({ verification: { preview: { app: "x", smoke: "" } } })), /needs both app and smoke/);
});

test("parseProjectRow refuses an unknown authority and a bad window", () => {
  assert.throws(() => parseProjectRow(row({ authority: "auto_everything" })), /authority/);
  assert.throws(() => parseProjectRow(row({ verification: { observe_window_min: 2.5 } })), /whole number/);
});

test("registerProject upserts by slug, snapshots managedBy, and acks registered with the webhook", async () => {
  const s = sink();
  const result = await registerProject(s.deps(), row());
  assert.deepEqual(result, { status: "registered", webhook: true });
  const saved = await s.deps().projects.forRepo(REPO);
  assert.notEqual(saved, null);
  assert.equal(saved!.authority, "auto_trivial");
  assert.equal(saved!.weeklyBudgetUSD, 20);
  assert.equal(saved!.managedBy?.ref, "project:12");
  assert.equal(saved!.managedBy?.hash, "abc123def456");
  assert.equal(managedDrift(saved!).length, 0);
  assert.deepEqual(s.acks, [
    { kind: "project", status: "registered", project_ref: "project:12", settings_hash: "abc123def456", webhook: true },
  ]);
  // The hook was created on the forge, pointed at this Ship's receiver.
  const created = s.forge.calls.find((c) => c.method === "POST");
  assert.equal((created?.body?.config as { url?: string } | undefined)?.url, "http://ship.test/hooks/forgejo");
  // The registration gotcha from the forgejo receiver's header comment.
  assert.ok(PROJECT_WEBHOOK_EVENTS.includes("pull_request_comment"));
});

test("registerProject finds an existing webhook and does not create a second one", async () => {
  const s = sink();
  const withExisting = fakeForge({ existing: "http://ship.test/hooks/forgejo" });
  const result = await registerProject(s.deps({ fetchImpl: withExisting.fetchImpl }), row());
  assert.equal(result.webhook, true);
  assert.equal(withExisting.calls.filter((c) => c.method === "POST").length, 0);
});

test("registerProject registers without a webhook when the forge refuses, and says so in the ack", async () => {
  const s = sink();
  const refused = fakeForge({ failCreate: true });
  const result = await registerProject(s.deps({ fetchImpl: refused.fetchImpl }), row());
  assert.deepEqual(result, { status: "registered", webhook: false });
  assert.equal(s.acks[0]?.webhook, false);
});

test("registerProject acks failed with the error when the row cannot even be parsed", async () => {
  const s = sink();
  const result = await registerProject(s.deps(), row({ repo: "" }));
  assert.equal(result.status, "failed");
  assert.match(s.acks[0]?.error ?? "", /names no repo/);
  assert.equal(await s.deps().projects.forRepo(REPO), null);
});

test("a second row overwrites the managed fields; an operator edit between rows shows as drift", async () => {
  const s = sink();
  await registerProject(s.deps(), row());
  const store = s.deps().projects;
  // An operator overrides the authority between rows.
  const saved = (await store.forRepo(REPO))!;
  await store.set({ ...saved, authority: "propose" });
  assert.equal(managedDrift((await store.forRepo(REPO))!).length, 1);
  // The next row overwrites the override — drift displayed, never kept silently.
  await registerProject(s.deps(), row({ authority: "send", settings_hash: "newhash" }));
  const after = (await store.forRepo(REPO))!;
  assert.equal(after.authority, "send");
  assert.equal(after.managedBy?.hash, "newhash");
  assert.equal(managedDrift(after).length, 0);
});

test("an absent field in the row clears the record's, rather than inheriting the old value", async () => {
  const s = sink();
  await registerProject(s.deps(), row());
  await registerProject(s.deps(), row({ label: undefined, weekly_budget_usd: null, settings_hash: "h2" }));
  const after = (await s.deps().projects.forRepo(REPO))!;
  assert.equal(after.label, undefined);
  assert.equal(after.weeklyBudgetUSD, undefined);
  // No phantom drift: the snapshot agrees with the record.
  assert.equal(managedDrift(after).length, 0);
});

test("a repo the policy refuses is acked failed, and no record is written", async () => {
  const s = sink();
  const result = await registerProject(s.deps({ repoPolicy: { allowlist: "http://elsewhere.test", gitToken: "t" } }), row());
  assert.equal(result.status, "failed");
  assert.match(s.acks[0]?.error ?? "", /is not an origin this deployment allows/);
});

test("the github dialect of the same repo points its hook at the github receiver", () => {
  const ref = parseRepoUrl("https://github.com/tyler/site.git")!;
  assert.equal(projectHookUrl("http://ship.test/", ref), "http://ship.test/hooks/github");
});

test("ensureProjectWebhook sends the shared inbound secret to the forge, once, on create only", async () => {
  const fresh = fakeForge();
  const created = await ensureProjectWebhook({
    ref: parseRepoUrl(REPO)!,
    token: "tok-abc",
    hookBase: "http://ship.test",
    secret: "whsec",
    fetchImpl: fresh.fetchImpl,
  });
  assert.equal(created, true);
  const post = fresh.calls.find((c) => c.method === "POST")!;
  assert.equal((post.body?.config as { secret?: string } | undefined)?.secret, "whsec");
});
