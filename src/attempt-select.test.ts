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
import type { HarnessAdapter } from "./harness.js";

/**
 * A repo whose suite is `sh check.sh`, failing while `answer.txt` is not 42.
 * The attempts are driven by fake adapters, so the suite verdict is the only
 * thing that differs between them — which is exactly what the ranking is
 * supposed to read.
 */
async function suiteRepo(name: string, answer: string): Promise<{ repo: string; provider: ExecutorProvider }> {
  const bare = await mkdtemp(join(tmpdir(), `${name}-bare-`));
  const seedDir = await mkdtemp(join(tmpdir(), `${name}-seed-`));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && ` +
      `printf '42\\n' > answer.txt && ` +
      `printf '#!/bin/sh\\n[ "$(cat answer.txt)" = "42" ] || { echo "answer.txt is not 42"; exit 1; }\\necho SUITE_OK\\n' > check.sh && ` +
      `git add -A && git commit -qm seed && git clone -q --bare . ${bare}/owner/repo.git`,
  );
  void answer;
  return {
    repo: `file://${bare}/owner/repo.git`,
    provider: {
      async create() {
        return { handle: await mkdtemp(join(tmpdir(), `${name}-work-`)) };
      },
      attach: (h: string) => new LocalExecutor({ root: h }),
    },
  };
}

/**
 * A harness adapter that runs a SCRIPT of writes, one per invocation — so the
 * same adapter can be launched K times and produce a different tree each time,
 * which is what "K independent attempts of one harness" means.
 */
function scriptedAdapter(id: string, script: Array<{ file: string; content: string }>): HarnessAdapter & { runs: number } {
  const a = {
    id,
    version: "1",
    isolated: true,
    runs: 0,
    async run(_task: unknown, ws: { executor: LocalExecutor; ctx: { step: <T>(name: string, fn: () => Promise<T>) => Promise<T> }; stepPrefix: string }) {
      const turn = a.runs;
      a.runs += 1;
      const line = script[turn] ?? script[script.length - 1]!;
      await ws.ctx.step(`${ws.stepPrefix}${id}-edit`, async () => {
        await ws.executor.putFile(line.file, line.content);
        return true;
      });
      return {
        status: "finished" as const,
        summary: `${id} attempt ${turn + 1} wrote ${line.file}`,
        turns: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        incomplete: false,
      };
    },
  };
  return a as unknown as HarnessAdapter & { runs: number };
}

/** A model that answers nothing the ranking can use — the worst-case tie-break. */
function opinionModel(answer: string): { model: ModelAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      provider: "scripted",
      modelId: "opinion",
      async doGenerate(): Promise<AdapterGenerateResult> {
        calls += 1;
        return { content: [{ type: "text", text: answer }], finishReason: "stop", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

function stubForge(): { restore: () => void; bodies: string[] } {
  const real = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("file:///api/v1/")) return real(url, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/pulls") && method === "POST") {
      bodies.push((JSON.parse(String(init?.body)) as { body: string }).body);
      return json({ number: 5, html_url: "file:///owner/repo/pulls/5" }, 201);
    }
    return json({ number: 5, body: "" });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = real), bodies };
}

test("P6-1: an attempt that failed the suite is never published over one that passed it", async () => {
  const { repo, provider } = await suiteRepo("attempt-select", "42");
  // Attempt 1 breaks the suite; attempt 2 keeps it green. Both produce a diff,
  // both are the same size, so the suite verdict is the ONLY thing separating
  // them — the case the ranking exists to decide.
  const harness = scriptedAdapter("scripted", [
    { file: "answer.txt", content: "41\n" },
    { file: "note.txt", content: "ok\n" },
  ]);
  // The critic loudly prefers the failing attempt. It must not get it.
  const critic = opinionModel("Attempt 1 is the more complete change.\nATTEMPT 1");
  const forge = stubForge();
  try {
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: durableAgent({ model: critic.model, executor: provider, workdir: ".", harnesses: [harness] }),
      runId: "run-attempt-select",
      store,
      input: {
        task: "change the repo",
        repo,
        trust: "operator",
        harness: { id: "scripted", version: "1" },
        tests: true,
        testCommand: "sh check.sh",
        attempts: 2,
      },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(harness.runs, 2, "K attempts of the same harness run");
    // The critic is not asked at all: the suite separated the attempts, so
    // there is no tie for an opinion to break.
    assert.equal(critic.calls(), 0, "the critic must not be consulted when the suite decided");

    const events = await store.load("run-attempt-select");
    const pick = events.find((e) => e.type === "step-completed" && e.name === "harness-pick")?.data as {
      result: { winner: number; reason: string };
    };
    assert.equal(pick.result.winner, 1, "the green attempt (index 1) must win");
    assert.match(pick.result.reason, /selected attempt 2 of 2: suite passed/);
    assert.match(pick.result.reason, /attempt 1 suite failed \(exit 1\)/);

    // The winner's tree is the one pushed: the bare repo holds note.txt, and
    // the answer.txt that would fail the suite is not on any branch.
    const bare = repo.slice("file://".length);
    const files = await new LocalExecutor({ root: tmpdir() }).exec(
      `for ref in $(git --git-dir=${bare} for-each-ref --format='%(refname)' refs/heads); do git --git-dir=${bare} ls-tree --name-only -r "$ref"; done`,
    );
    assert.match(files.stdout, /note\.txt/, "the passing attempt's file is pushed");
    assert.doesNotMatch(files.stdout, /answer\.txt is not/, "nothing else leaked");
    const answer = await new LocalExecutor({ root: tmpdir() }).exec(`git --git-dir=${bare} show refs/heads/main:answer.txt 2>/dev/null || true`);
    assert.doesNotMatch(answer.stdout, /^41/, "the failing attempt's edit must not be published");

    // The PR's Verification section can say which attempt was selected and why.
    assert.match(forge.bodies[0]!, /selected attempt 2 of 2: suite passed/, JSON.stringify(forge.bodies));
  } finally {
    forge.restore();
  }
});
