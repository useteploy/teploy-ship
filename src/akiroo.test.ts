import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AKIROO_REF_MARKER,
  FileAkirooCursor,
  akirooRefFrom,
  akirooTargetFromEnv,
  akirooWorkspaceKey,
  createLabelledIssue,
  handleAkirooRow,
  issueBodyFor,
  makeAkirooState,
  resolveLabelIds,
  sweepAkiroo,
} from "./akiroo.js";
import type { AkirooResolution, AkirooRow, AkirooSweepDeps, DecisionOutcome } from "./akiroo.js";
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
    cursor: { get: async () => 0, set: async () => {}, reset: async () => {} },
    deliveries: memoryDeliveries(),
    intake: memoryIntake(),
    enqueueScan: async () => ({ runId: "run-scan" }),
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

test("a scan row enqueues a read-only scan run with the ref on its origin and opens no issue", async () => {
  const enqueued: Array<Parameters<AkirooSweepDeps["enqueueScan"]>[0]> = [];
  const intake = memoryIntake();
  const lines: string[] = [];
  const deps = baseDeps({
    intake,
    enqueueScan: async (input) => {
      enqueued.push(input);
      return { runId: "run-s1" };
    },
    fetchImpl: (async () => {
      throw new Error("the forge must not be called for a scan");
    }) as unknown as typeof fetch,
    log: (line) => lines.push(line),
  });
  await handleAkirooRow(
    { id: 9, kind: "scan", payload: { repo: REPO, question: "Where is the send path retried?", ref: "room-scan:31", model: "glm-5.3" } },
    deps,
  );
  assert.equal(intake.calls.length, 0, "a scan is a question, not a work record");
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    repo: parseRepoUrl(REPO).cloneUrl,
    task: "Where is the send path retried?",
    model: "glm-5.3",
    origin: { source: "akiroo", dedupeKey: "akiroo:room-scan:31", workItemRef: "room-scan:31" },
  });
  assert.ok(lines.some((l) => l.includes("room-scan:31") && l.includes("run-s1")));
});

test("a scan row is validated before anything is enqueued", async () => {
  const deps = baseDeps({
    enqueueScan: async () => {
      throw new Error("must not enqueue");
    },
  });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ question: "q", ref: "room-scan:1" }, /no repo or no question/],
    [{ repo: REPO, ref: "room-scan:1" }, /no repo or no question/],
    [{ repo: REPO, question: "x".repeat(4001), ref: "room-scan:1" }, /exceeds 4000/],
    [{ repo: REPO, question: "q", ref: "work-item:1" }, /must start with room-scan:/],
    [{ repo: REPO, question: "q", ref: "room-scan:" }, /must start with room-scan:/],
    [{ repo: REPO, question: "q" }, /must start with room-scan:/],
    [{ repo: "http://evil.test/o/r.git", question: "q", ref: "room-scan:1" }, /not an origin this deployment allows/],
  ];
  for (const [payload, expected] of cases) {
    await assert.rejects(() => handleAkirooRow({ id: 1, kind: "scan", payload }, deps), expected, JSON.stringify(payload));
  }
});

test("a refused scan is logged and its row is still acked", async () => {
  const lines: string[] = [];
  const akiroo = scriptedAkiroo([
    { id: 4, kind: "scan", payload: { repo: REPO, question: "q", ref: "room-scan:2" } },
  ]);
  const deps = baseDeps({
    fetchImpl: akiroo.fetchImpl,
    enqueueScan: async () => {
      throw new Error("daily budget for source akiroo is spent");
    },
    log: (line) => lines.push(line),
  });
  const result = await sweepAkiroo(deps);
  assert.equal(result.handled, 0);
  assert.deepEqual(akiroo.acked, [[4]]);
  assert.ok(lines.some((l) => l.includes("row 4 (scan)") && l.includes("daily budget")));
});

test("akirooRefFrom recovers the footer ref from the text that carries it", () => {
  assert.equal(akirooRefFrom(issueBodyFor("It 500s.", "work-item:7")), "work-item:7");
  assert.equal(akirooRefFrom(`Fix it\n\n${issueBodyFor("", "work-item:8")}\n\nhttp://forge/i/1`), "work-item:8");
  assert.equal(akirooRefFrom("no footer here"), undefined);
  assert.equal(akirooRefFrom(undefined), undefined);
  // The marker mid-line is prose, not a footer.
  assert.equal(akirooRefFrom("see Akiroo: work-item:9 for context"), undefined);
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
        set: async (_source, n) => {
          stored = n;
        },
        reset: async () => {},
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
    set: async (_source: string, n: number) => {
      stored = n;
    },
    reset: async () => {},
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
        set: async (_source, n) => {
          stored = n;
        },
        reset: async () => {},
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

test("the file cursor persists, never moves backwards, and is per workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-akiroo-"));
  const one = akirooWorkspaceKey("https://a.akiroo.test");
  const two = akirooWorkspaceKey("https://b.akiroo.test");
  const cursor = new FileAkirooCursor(dir);
  assert.equal(await cursor.get(one), 0);
  await cursor.set(one, 10);
  assert.equal(await new FileAkirooCursor(dir).get(one), 10);
  // Out-of-order writes happen when two sweeps overlap; the older one must not
  // rewind the queue.
  await cursor.set(one, 4);
  assert.equal(await cursor.get(one), 10);

  // The bug this keying exists for: reconnecting to a DIFFERENT workspace used
  // to inherit the previous one's high-water mark, so Ship polled past the top
  // of a queue it had never read and reported itself connected and healthy.
  assert.equal(await cursor.get(two), 0);
  await cursor.set(two, 2);
  assert.equal(await cursor.get(one), 10, "one workspace's position is not the other's");

  // Completing a connect resets the position for that workspace only.
  await cursor.reset(one);
  assert.equal(await cursor.get(one), 0);
  assert.equal(await cursor.get(two), 2);
});

test("a workspace key is its full identity, so a trailing slash is one workspace and a prefix is not", () => {
  // Origin plus path prefix — the same representation the approve link, the
  // exchange and the poll use. It was the bare origin, which gave two
  // path-prefixed installs on one host a shared cursor and a shared set of
  // delivery claims: the exact confusion this key exists to prevent.
  assert.equal(akirooWorkspaceKey("https://a.akiroo.test"), akirooWorkspaceKey("https://a.akiroo.test/"));
  assert.equal(akirooWorkspaceKey("https://a.akiroo.test/tenant/x"), akirooWorkspaceKey("https://a.akiroo.test/tenant/x/"));
  assert.notEqual(akirooWorkspaceKey("https://a.akiroo.test"), akirooWorkspaceKey("https://a.akiroo.test/tenant/x"));
  assert.notEqual(akirooWorkspaceKey("https://a.akiroo.test/tenant/x"), akirooWorkspaceKey("https://a.akiroo.test/tenant/y"));
  assert.notEqual(akirooWorkspaceKey("https://a.akiroo.test"), akirooWorkspaceKey("https://b.akiroo.test"));
  assert.notEqual(akirooWorkspaceKey("https://a.akiroo.test"), akirooWorkspaceKey("http://a.akiroo.test"));
  assert.equal(akirooWorkspaceKey("javascript:alert(1)"), "akiroo:invalid");
});

test("a sweep namespaces its cursor and its delivery claims by workspace", async () => {
  // Both, not just the cursor. Keying the cursor alone would reset the position
  // on a reconnect and then have every row read as already handled, because the
  // claim namespace still carried the previous workspace's row ids.
  const rows = [{ id: 7, kind: "decision", payload: { run_id: "r", event_name: "e", approved: true } }];
  const deliveries = memoryDeliveries();
  const claimed: string[] = [];
  const spy = {
    claim: async (source: string, id: string) => {
      claimed.push(`${source}/${id}`);
      return deliveries.claim(source, id);
    },
  } as unknown as AkirooSweepDeps["deliveries"];

  // One store shared by every sweep below, exactly as the worker holds one for
  // the life of the process. The bug was that this store was written under a
  // constant, so the position followed the connector rather than the workspace.
  const positions = new Map<string, number>();
  const cursor: AkirooSweepDeps["cursor"] = {
    get: async (source) => positions.get(source) ?? 0,
    set: async (source, after) => {
      positions.set(source, Math.max(positions.get(source) ?? 0, after));
    },
    reset: async (source) => {
      positions.delete(source);
    },
  };
  const keyA = akirooWorkspaceKey("https://a.akiroo.test");
  const keyB = akirooWorkspaceKey("https://b.akiroo.test");

  const first = scriptedAkiroo(rows);
  await sweepAkiroo(
    baseDeps({ fetchImpl: first.fetchImpl, cursor, deliveries: spy, target: { url: "https://a.akiroo.test", token: "t" } }),
  );
  assert.ok(first.polls[0]!.includes("after=0"), "the first workspace starts at the top of its queue");
  assert.equal(positions.get(keyA), 7);

  // Still workspace A: the position it just wrote is the one it polls from.
  const again = scriptedAkiroo([]);
  await sweepAkiroo(
    baseDeps({ fetchImpl: again.fetchImpl, cursor, deliveries: spy, target: { url: "https://a.akiroo.test", token: "t" } }),
  );
  assert.ok(again.polls[0]!.includes("after=7"), again.polls[0]!);

  // Reconnected to a DIFFERENT workspace. This is the whole finding: under the
  // old constant key the poll went out as ?after=7 against a queue whose row 7
  // belongs to somebody else, so Ship received nothing forever and reported
  // itself connected.
  const second = scriptedAkiroo(rows);
  const result = await sweepAkiroo(
    baseDeps({ fetchImpl: second.fetchImpl, cursor, deliveries: spy, target: { url: "https://b.akiroo.test", token: "t" } }),
  );
  assert.ok(second.polls[0]!.includes("after=0"), `the new workspace starts from the beginning: ${second.polls[0]}`);
  assert.equal(result.pulled, 1);
  assert.equal(result.handled, 1, "the second workspace's row 7 is a different row and must be handled");
  assert.deepEqual(claimed, [`${keyA}/7`, `${keyB}/7`]);
  assert.equal(positions.get(keyA), 7, "the first workspace's position is kept, not reused and not clobbered");
  assert.equal(positions.get(keyB), 7);
});

/**
 * A resolution of the shape resolveAkirooTarget hands the worker sweep.
 * The per-value provenance rows are decoration for this test — what retarget
 * judges is the (url, status, token) triple.
 */
function resolution(url: string, token: string, status: "runtime" | "env" = "env"): AkirooResolution {
  return {
    target: { url, token },
    status,
    url: { value: url, source: status },
    token: { value: "set", source: status },
  };
}

/**
 * FIX-5. The connector can change under a RUNNING worker — the connect
 * handshake writes the runtime config while this process is mid-poll — so the
 * sweep re-resolves it every pass and calls retarget with the answer.
 *
 * The early return in retarget exists so that steady state (the overwhelmingly
 * common case: the same connector, resolved again, five seconds later) does not
 * wipe the last-pull line off Settings. The bug it hid was a rotation that
 * keeps the same URL and the same source: a genuinely different credential that
 * compared equal, so the PREVIOUS token's successful pull went on being
 * displayed as this one's — which an operator reads as "the new token works"
 * before it has been used once.
 */
test("a token rotation is a new connector, so the old token's last pull is not shown as its own", () => {
  const state = makeAkirooState({ url: "https://lite.akiroo.test", token: "ship_pull_old" });
  state.recordPull({ pulled: 3, handled: 3, acked: 3 });
  assert.ok(state.read().lastPullAt !== undefined, "the old connector did pull");

  // Same URL, same source, different credential.
  state.retarget(resolution("https://lite.akiroo.test", "ship_pull_new"));
  assert.equal(state.read().lastPullAt, undefined, "the new token has not pulled anything yet");
  assert.equal(state.read().lastPulled, undefined);
  assert.equal(state.read().url, "https://lite.akiroo.test", "and it is still the same workspace");
  assert.equal(state.read().configured, true);
});

test("re-resolving the SAME connector keeps its last pull, or the Settings line would never survive a sweep", () => {
  const state = makeAkirooState({ url: "https://lite.akiroo.test", token: "ship_pull_old" });
  state.recordPull({ pulled: 3, handled: 3, acked: 3 });
  const pulledAt = state.read().lastPullAt;

  state.retarget(resolution("https://lite.akiroo.test", "ship_pull_old"));
  assert.equal(state.read().lastPullAt, pulledAt, "nothing changed, so nothing is forgotten");
  assert.equal(state.read().lastPulled, 3);
});

test("a workspace change, a source change and a half-set pair each retarget the connector", () => {
  // The URL moved: a reconnect to a different workspace.
  const moved = makeAkirooState({ url: "https://a.akiroo.test", token: "t" });
  moved.recordPull({ pulled: 1, handled: 1, acked: 1 });
  moved.retarget(resolution("https://b.akiroo.test", "t"));
  assert.equal(moved.read().lastPullAt, undefined);
  assert.equal(moved.read().url, "https://b.akiroo.test");

  // The SOURCE moved: the same pair, now supplied by the runtime store rather
  // than by the manifest. A connect that has just completed lands here, and the
  // Settings page has to say which side won.
  const promoted = makeAkirooState({ url: "https://a.akiroo.test", token: "t" });
  promoted.recordPull({ pulled: 1, handled: 1, acked: 1 });
  promoted.retarget(resolution("https://a.akiroo.test", "t", "runtime"));
  assert.equal(promoted.read().status, "runtime");
  assert.equal(promoted.read().lastPullAt, undefined);

  // A half-set pair polls nothing, and says so rather than showing "disabled".
  const broken = makeAkirooState({ url: "https://a.akiroo.test", token: "t" });
  broken.recordPull({ pulled: 1, handled: 1, acked: 1 });
  broken.retarget({
    status: "misconfigured",
    url: { value: "https://a.akiroo.test", source: "runtime" },
    token: { value: "", source: "unset" },
    reason: "AKIROO_URL is set but AKIROO_PULL_TOKEN is not",
  });
  assert.equal(broken.read().configured, false);
  assert.equal(broken.read().url, "");
  assert.equal(broken.read().lastPullAt, undefined, "a connector that cannot poll has no last pull");
  assert.match(broken.read().lastError ?? "", /AKIROO_PULL_TOKEN/);
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
