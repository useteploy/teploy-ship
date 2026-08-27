import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AKIROO_REF_MARKER,
  FileAkirooCursor,
  akirooTargetFromEnv,
  createLabelledIssue,
  handleAkirooRow,
  issueBodyFor,
  makeAkirooState,
  resolveLabelIds,
  sweepAkiroo,
} from "./akiroo.js";
import type { AkirooRow, AkirooSweepDeps, DecisionOutcome } from "./akiroo.js";
import { parseRepoUrl } from "./git.js";
import type { DeliveryLog } from "./deliveries.js";
import type { IntakeTask, ProposeInput } from "./intake.js";
import type { RepoPolicyConfig } from "./repo-policy.js";

/** A DeliveryLog that remembers, so the at-most-once claim is really exercised. */
function memoryDeliveries(): DeliveryLog & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    claim: async (source, id) => {
      const key = `${source}:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

function memoryIntake(): { propose: (input: ProposeInput) => Promise<{ created: boolean; task: IntakeTask }>; calls: ProposeInput[] } {
  const calls: ProposeInput[] = [];
  const byKey = new Map<string, IntakeTask>();
  return {
    calls,
    propose: async (input) => {
      calls.push(input);
      const existing = byKey.get(input.dedupeKey);
      if (existing !== undefined) return { created: false, task: existing };
      const now = new Date().toISOString();
      const task: IntakeTask = {
        taskId: `task-${byKey.size + 1}`,
        source: input.source,
        kind: input.kind,
        title: input.title,
        dedupeKey: input.dedupeKey,
        state: "proposed",
        createdAt: now,
        updatedAt: now,
      };
      byKey.set(input.dedupeKey, task);
      return { created: true, task };
    },
  };
}

const REPO = "http://forge.test/tyler/ship-demo.git";
const POLICY: RepoPolicyConfig = { allowlist: "http://forge.test", gitToken: "tok-abc" };

function baseDeps(overrides: Partial<AkirooSweepDeps> = {}): AkirooSweepDeps {
  return {
    target: { url: "http://akiroo.test", token: "ship_pull_xyz" },
    cursor: { get: async () => 0, set: async () => {} },
    deliveries: memoryDeliveries(),
    intake: memoryIntake(),
    decide: async () => "delivered",
    repoPolicy: POLICY,
    log: () => {},
    ...overrides,
  };
}

test("akirooTargetFromEnv is both or nothing", () => {
  assert.equal(akirooTargetFromEnv({} as NodeJS.ProcessEnv), undefined);
  assert.equal(akirooTargetFromEnv({ AKIROO_URL: "http://a" } as NodeJS.ProcessEnv), undefined);
  assert.equal(akirooTargetFromEnv({ AKIROO_PULL_TOKEN: "t" } as NodeJS.ProcessEnv), undefined);
  assert.deepEqual(akirooTargetFromEnv({ AKIROO_URL: "http://a/", AKIROO_PULL_TOKEN: " t " } as NodeJS.ProcessEnv), {
    url: "http://a",
    token: "t",
  });
});

test("the issue body carries the ref where Akiroo reads it back", () => {
  const body = issueBodyFor("Fix the send path.", "work-item:7");
  assert.ok(body.includes("Fix the send path."));
  // Akiroo scans the run's task text line by line for this exact prefix
  // (webhook_ingest.go shipWorkItemRefOf). A ref folded into a sentence would
  // never be found.
  assert.ok(body.split("\n").some((line) => line.trim() === `${AKIROO_REF_MARKER}work-item:7`));
  // An empty description must still carry the ref, or an item filed with just
  // a title loses its way home.
  assert.equal(issueBodyFor("", "work-item:7"), `${AKIROO_REF_MARKER}work-item:7`);
});

test("a decision row resumes the run through the claim path", async () => {
  const seen: Array<{ runId: string; eventName: string; approved: boolean; reason?: string }> = [];
  const deps = baseDeps({
    decide: async (row) => {
      seen.push(row);
      return "delivered";
    },
  });
  await handleAkirooRow(
    {
      id: 1,
      kind: "decision",
      payload: { run_id: "run-7", event_name: "plan-approval", approved: true, reason: "looks right" },
    },
    deps,
  );
  assert.deepEqual(seen, [{ runId: "run-7", eventName: "plan-approval", approved: true, reason: "looks right" }]);
});

test("a decision row missing its event is refused rather than guessed", async () => {
  let called = false;
  const deps = baseDeps({
    decide: async () => {
      called = true;
      return "delivered";
    },
  });
  await assert.rejects(() => handleAkirooRow({ id: 1, kind: "decision", payload: { run_id: "run-7" } }, deps));
  // Delivering to a park nobody named is exactly the misapplication event_name
  // exists to prevent.
  assert.equal(called, false);
});

test("a task row opens a labelled issue and proposes it under the forge's own dedupe key", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    requests.push({ url: href, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (href.includes("/labels?")) {
      return new Response(JSON.stringify([{ id: 11, name: "ship" }]), { status: 200 });
    }
    if (href.endsWith("/labels")) {
      return new Response(JSON.stringify({ id: 12 }), { status: 201 });
    }
    if (href.endsWith("/issues")) {
      return new Response(JSON.stringify({ number: 42, html_url: "http://forge.test/tyler/ship-demo/issues/42" }), {
        status: 201,
      });
    }
    throw new Error(`unexpected request: ${href}`);
  }) as unknown as typeof fetch;

  const intake = memoryIntake();
  const deps = baseDeps({ intake, fetchImpl });
  await handleAkirooRow(
    {
      id: 5,
      kind: "task",
      payload: {
        repo: REPO,
        title: "Fix the send path",
        body: "It 500s on an empty recipient list.",
        labels: ["ship", "bug"],
        work_item_id: 7,
        work_item_ref: "work-item:7",
      },
    },
    deps,
  );

  const issue = requests.find((r) => r.url.endsWith("/issues"));
  assert.ok(issue, "no issue was opened");
  const payload = issue.body as { title: string; body: string; labels: number[] };
  assert.equal(payload.title, "Fix the send path");
  // Forgejo takes label IDS, not names. Sending names produces a 422 and an
  // unlabelled issue the forge webhook then ignores.
  // "ship" already existed (id 11); "bug" did not and was created (id 12).
  assert.deepEqual(payload.labels, [11, 12]);
  assert.ok(payload.body.includes(`${AKIROO_REF_MARKER}work-item:7`));

  // The dedupe key must be byte-identical to the one the forge webhook builds
  // (web/src/routes/hooks/forgejo.tsx), or the two paths make two tasks.
  assert.equal(intake.calls.length, 1);
  assert.equal(intake.calls[0]!.dedupeKey, "forgejo:tyler/ship-demo#42");
  assert.equal(intake.calls[0]!.source, "forgejo");
  assert.equal(intake.calls[0]!.repo, parseRepoUrl(REPO).cloneUrl);
});

test("a missing ship label is created rather than dropped", async () => {
  const created: unknown[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/labels?")) return new Response("[]", { status: 200 });
    if (href.endsWith("/labels")) {
      created.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    }
    throw new Error(`unexpected: ${href}`);
  }) as unknown as typeof fetch;

  const ids = await resolveLabelIds({ ref: parseRepoUrl(REPO), token: "t", names: ["ship"], fetchImpl });
  assert.deepEqual(ids, [99]);
  assert.equal((created[0] as { name: string }).name, "ship");
});

test("a label the forge refuses does not lose the issue", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/labels?")) return new Response("[]", { status: 200 });
    if (href.endsWith("/labels")) return new Response("forbidden", { status: 403 });
    throw new Error(`unexpected: ${href}`);
  }) as unknown as typeof fetch;
  assert.deepEqual(await resolveLabelIds({ ref: parseRepoUrl(REPO), token: "t", names: ["ship"], fetchImpl }), []);
});

test("GitHub takes label names, not ids", async () => {
  let sent: { labels: unknown } | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    assert.ok(href.startsWith("https://api.github.com/"), href);
    sent = JSON.parse(String(init?.body)) as { labels: unknown };
    return new Response(JSON.stringify({ number: 3, html_url: "u" }), { status: 201 });
  }) as unknown as typeof fetch;
  await createLabelledIssue({
    ref: parseRepoUrl("https://github.com/o/r.git"),
    token: "t",
    title: "t",
    body: "b",
    labels: ["ship"],
    fetchImpl,
  });
  assert.deepEqual(sent?.labels, ["ship"]);
});

test("a repo outside the allowlist never sees a credential", async () => {
  const deps = baseDeps({
    fetchImpl: (async () => {
      throw new Error("the forge must not be called for a disallowed repo");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      handleAkirooRow(
        { id: 1, kind: "task", payload: { repo: "http://evil.test/o/r.git", title: "t", work_item_ref: "work-item:1" } },
        deps,
      ),
    /not an origin this deployment allows/,
  );
});

/** A poll/ack pair over a scripted Akiroo. */
function scriptedAkiroo(rows: AkirooRow[]): {
  fetchImpl: typeof fetch;
  polls: string[];
  acked: number[][];
  failAck?: boolean;
} {
  const state = { failAck: false };
  const polls: string[] = [];
  const acked: number[][] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/outbox?")) {
      polls.push(href);
      return new Response(JSON.stringify({ items: rows }), { status: 200 });
    }
    if (href.endsWith("/outbox/ack")) {
      acked.push((JSON.parse(String(init?.body)) as { ids: number[] }).ids);
      if (state.failAck) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ acked: acked[acked.length - 1]!.length }), { status: 200 });
    }
    throw new Error(`unexpected: ${href}`);
  }) as unknown as typeof fetch;
  return Object.assign({ fetchImpl, polls, acked }, state);
}

test("a sweep pulls from the cursor, handles, acks, then advances", async () => {
  let stored = 3;
  const script = scriptedAkiroo([
    { id: 4, kind: "decision", payload: { run_id: "r", event_name: "e", approved: false } },
    { id: 9, kind: "decision", payload: { run_id: "r2", event_name: "e", approved: true } },
  ]);
  const result = await sweepAkiroo(
    baseDeps({
      fetchImpl: script.fetchImpl,
      cursor: {
        get: async () => stored,
        set: async (n) => {
          stored = n;
        },
      },
    }),
  );
  assert.equal(result.pulled, 2);
  assert.equal(result.handled, 2);
  assert.ok(script.polls[0]!.includes("after=3"));
  assert.deepEqual(script.acked, [[4, 9]]);
  // Highest id in the batch, not the count and not the first — a cursor that
  // lags re-reads rows the claim then throws away, forever.
  assert.equal(stored, 9);
});

test("an unknown kind is acked rather than left to block the queue", async () => {
  const script = scriptedAkiroo([{ id: 1, kind: "something-newer", payload: {} }]);
  const result = await sweepAkiroo(baseDeps({ fetchImpl: script.fetchImpl }));
  assert.deepEqual(script.acked, [[1]]);
  assert.equal(result.handled, 1);
});

test("a row whose handler throws is still acked", async () => {
  const script = scriptedAkiroo([
    { id: 1, kind: "decision", payload: {} }, // no run id: the handler throws
    { id: 2, kind: "decision", payload: { run_id: "r", event_name: "e", approved: true } },
  ]);
  const result = await sweepAkiroo(baseDeps({ fetchImpl: script.fetchImpl }));
  // One bad row must not wedge everything behind it, and must not come back
  // every five seconds for the life of the deployment.
  assert.deepEqual(script.acked, [[1, 2]]);
  assert.equal(result.handled, 1);
});

test("a re-delivered batch does not handle a row twice", async () => {
  const rows: AkirooRow[] = [{ id: 1, kind: "decision", payload: { run_id: "r", event_name: "e", approved: true } }];
  const deliveries = memoryDeliveries();
  let decides = 0;
  const decide = async (): Promise<DecisionOutcome> => {
    decides += 1;
    return "delivered";
  };

  const failing = scriptedAkiroo(rows);
  failing.failAck = true;
  // Rebuild with the flag honoured: scriptedAkiroo copies it at construction.
  const fetchFailingAck = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/outbox?")) return new Response(JSON.stringify({ items: rows }), { status: 200 });
    if (href.endsWith("/outbox/ack")) return new Response("nope", { status: 500 });
    throw new Error(`unexpected: ${href}`);
  }) as unknown as typeof fetch;

  let stored = 0;
  const cursor = {
    get: async () => stored,
    set: async (n: number) => {
      stored = n;
    },
  };
  await assert.rejects(() => sweepAkiroo(baseDeps({ fetchImpl: fetchFailingAck, deliveries, decide, cursor })));
  assert.equal(decides, 1);
  // The cursor did NOT advance, so the same batch comes back...
  assert.equal(stored, 0);

  const script = scriptedAkiroo(rows);
  const result = await sweepAkiroo(baseDeps({ fetchImpl: script.fetchImpl, deliveries, decide, cursor }));
  // ...and the claim short-circuits the handler rather than deciding twice.
  assert.equal(decides, 1);
  assert.equal(result.handled, 0);
  assert.deepEqual(script.acked, [[1]]);
  assert.equal(stored, 1);
});

test("an empty poll neither acks nor moves the cursor", async () => {
  let stored = 12;
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("/outbox?")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    throw new Error("acked an empty batch");
  }) as unknown as typeof fetch;
  const result = await sweepAkiroo(
    baseDeps({
      fetchImpl,
      cursor: {
        get: async () => stored,
        set: async (n) => {
          stored = n;
        },
      },
    }),
  );
  assert.deepEqual(result, { pulled: 0, handled: 0, acked: 0 });
  assert.equal(stored, 12);
});

test("a rejected pull token says so", async () => {
  const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(() => sweepAkiroo(baseDeps({ fetchImpl })), /AKIROO_PULL_TOKEN was rejected/);
});

test("the file cursor persists and never moves backwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-akiroo-"));
  const cursor = new FileAkirooCursor(dir);
  assert.equal(await cursor.get(), 0);
  await cursor.set(10);
  assert.equal(await new FileAkirooCursor(dir).get(), 10);
  // Out-of-order writes happen when two sweeps overlap; the older one must not
  // rewind the queue.
  await cursor.set(4);
  assert.equal(await cursor.get(), 10);
});

test("connector state reports the last pull and the last error", () => {
  const off = makeAkirooState(undefined);
  assert.equal(off.read().configured, false);

  const on = makeAkirooState({ url: "http://akiroo.test", token: "t" });
  on.recordError(new Error("unreachable"));
  assert.equal(on.read().lastError, "unreachable");
  on.recordPull({ pulled: 2, handled: 2, acked: 2 });
  // A successful pull clears the error, or the Settings page shows a fault that
  // fixed itself hours ago.
  assert.equal(on.read().lastError, undefined);
  assert.equal(on.read().lastPulled, 2);
  assert.ok(on.read().lastPullAt !== undefined);
});
