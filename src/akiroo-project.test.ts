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

test("parseProjectRow refuses a slug that disagrees with the repo url", () => {
  assert.throws(() => parseProjectRow(row({ slug: "someone/else" })), /does not match its repo url/);
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
