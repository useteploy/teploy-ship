import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversation,
  diffSnapshots,
  evidence,
  safeLink,
  splitDiff,
} from "./workspace.js";
import { checkConnections } from "./connections.server.js";
const at = "2026-09-19T10:00:00Z";
test("conversation retains steering and answers without mixing command output into messages", () => {
  const items = conversation([
    { type: "run-started", at, data: { input: { task: "Fix login" } } },
    {
      type: "step-completed",
      name: "turn-1-think",
      at,
      data: {
        result: { text: "I found the route.\n```bash\ncat app.ts\n```" },
      },
    },
    {
      type: "step-completed",
      name: "turn-2-steer",
      at,
      data: { result: ["Keep the API stable"] },
    },
    {
      type: "event-received",
      name: "turn-3-ask",
      at,
      data: { payload: { answer: "Use the existing provider" } },
    },
  ]);
  assert.deepEqual(
    items.map((m) => m.role),
    ["You", "Agent", "You", "Decision"],
  );
  assert.equal(items[1].text, "I found the route.");
  assert.equal(items[2].text, "Keep the API stable");
  assert.equal(items[3].text, "Use the existing provider");
});
test("absence is not success and arbitrary URLs are not rendered", () => {
  const data = evidence({
    tests: { kind: "failed", output: "red" },
    preview: { kind: "deployed", url: "javascript:alert(1)" },
    flow: {
      kind: "passed",
      shots: [
        { name: "bad", asset: "data:text/html,hello" },
        { name: "good", asset: "https://forge.test/shot.png" },
      ],
    },
  });
  assert.equal(
    data.checks.find((c) => c.name === "Build")?.state,
    "not recorded",
  );
  assert.equal(data.checks.find((c) => c.name === "Tests")?.state, "failed");
  assert.equal(data.preview, undefined);
  assert.equal(data.images.length, 1);
  assert.equal(safeLink("https://secret:token@example.com"), undefined);
});
test("published and intermediate diffs retain provenance and partial markers", () => {
  const diff =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
  const snapshots = diffSnapshots([
    {
      type: "step-completed",
      name: "turn-1-critic-diff",
      at,
      data: { result: diff },
    },
    {
      type: "step-completed",
      name: "repo-push",
      at,
      data: {
        result: {
          kind: "pushed",
          sha: "abc",
          diff: diff + "\n[500 chars omitted from the middle of this diff]",
        },
      },
    },
  ]);
  assert.equal(snapshots[0].name, "repo-push");
  assert.equal(snapshots[0].truncated, true);
  assert.equal(splitDiff(diff)[0].file, "a.ts");
  assert.deepEqual(
    diffSnapshots([{ type: "step-completed", name: "oops", at, data: null }]),
    [],
  );
});
test("connection diagnostics use configured endpoints only and do not forward credentials or follow redirects", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.test" },
    });
  };
  const checks = await checkConnections(
    {
      AI_GATEWAY_URL: "http://gateway.test",
      SHIP_SANDBOX_URL: "https://user:secret@sandbox.test",
    },
    fetcher,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test/health");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[0].init?.headers, undefined);
  assert.equal(checks[0].state, "HTTP 302");
  assert.equal(checks[1].state, "Invalid address");
  assert.ok(!JSON.stringify(checks).includes("secret"));
});

test("conversation follows the executor transcript and discards imagined post-action output", () => {
  const messages = conversation([
    { type: "step-completed", name: "turn-0-think", at, data: { result: { text: "I will inspect the form.\n```bash\ncat index.html\n```\nThe output was: customer data is in local storage.\n```bash\ncat imaginary.js\n```" } } },
    { type: "step-completed", name: "turn-1-think", at, data: { result: { text: "```finish\nThe observed implementation uses SQLite.\n```\nInvented extra conclusion." } } },
  ]);
  assert.equal(messages[0].text, "I will inspect the form.");
  assert.match(messages[1].text, /observed implementation uses SQLite/);
  assert.doesNotMatch(messages.map(m => m.text).join("\n"), /local storage|imaginary|Invented/);
});

test("planning prose after a command example is retained because planning does not execute actions", () => {
  const messages = conversation([{ type: "step-completed", name: "attempt-1-plan-think", at, data: { result: { text: "First inspect the repository.\n```bash\nls\n```\nThen agree on acceptance criteria before editing." } } }]);
  assert.match(messages[0].text, /Then agree on acceptance criteria/);
});

test("read-only evidence identifies the checked-out revision without pretending it was pushed", () => {
  const reviewed = "a".repeat(40), pushed = "b".repeat(40);
  const scan = evidence({}, reviewed);
  assert.equal(scan.sha, reviewed);
  assert.equal(scan.pr, undefined);
  assert.equal(evidence({}, "not-a-revision").sha, undefined);
  assert.equal(evidence({ push: { kind: "pushed", sha: pushed } }, reviewed).sha, pushed);
});
