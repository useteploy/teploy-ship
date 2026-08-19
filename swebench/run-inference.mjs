// SWE-bench inference: run teploy-agent against each instance's real
// environment (an official SWE-bench container on the remote box), extract
// the git diff as the patch, and write a predictions file the official
// swebench evaluator scores.
//
// All Docker operations go through the Engine API over an SSH-forwarded
// socket (docker-client.mjs) — no shell-string assembly anywhere in the
// harness. The only shell scripts below are CONSTANTS (git plumbing),
// passed as single argv elements.
//
// Usage:
//   ANTHROPIC_API_KEY=... node run-inference.mjs <ssh-host> <instances.json> <out-preds.json>
//
// instances.json: [{ instance_id, image, problem_statement }]
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { anthropic, createAnthropic } = await import(join(here, "..", "node_modules", "@neutron-build", "ai", "dist", "anthropic", "index.js"));
// The loop dispatch and the durable arm's driver. Imported unconditionally so
// a typo in it fails at startup rather than twelve minutes into a run — the
// same reason every configuration constant is echoed at startup further down.
// runAgent is NOT imported here any more: driveLoop owns both arms, so the
// choice of loop is made in a module a test can import.
const { DIST_REQUIREMENTS, assertNoExistingLog, driveLoop, durableArmFromEnv, provenance, teeStore } = await import(
  join(here, "durable-run.mjs")
);

// Route model calls through teploy-gateway when AI_GATEWAY_URL + _KEY are set
// (so eval spend is tracked + capped centrally), otherwise call Anthropic
// directly. Same shape as ship's own resolveModel — a gateway baseURL + the
// project key, no gateway-specific adapter needed.
// Prompt caching is an Anthropic feature. Pointing baseURL at an
// Anthropic-COMPATIBLE endpoint (z.ai's /api/anthropic for GLM, or any other
// compat layer) can mean cache_control blocks are rejected or silently
// ignored, so it is togglable: SWEBENCH_NO_CACHE=1 turns it off. Leave it on
// against real Anthropic — it is a large cost saving across a 50-instance run.
const USE_CACHE = process.env.SWEBENCH_NO_CACHE !== "1";

// Extended thinking, off unless a budget is given. SWE-bench instances are
// reasoning-heavy (locate the defect, then decide what the fix should be), so
// a thinking budget is worth spending where the model supports it — GLM 5.2
// does, via the same Anthropic-shaped `thinking` block. Must stay below the
// model's max output tokens.
const THINK_BUDGET = Number(process.env.SWEBENCH_THINKING_TOKENS ?? 0);

// Step cap. OpenHands runs this benchmark at ~100.
//
// Worth less than it first looked. On the 2026-08-12 run 56% (28/50) hit the
// cap; on 2026-08-16 with GLM 5.3 only 24% (12/50) did, and the median run
// stops at 33.5 steps of 40 — most runs no longer die of running out of room,
// they die of not stopping (see FINISH_WHEN_SETTLED below).
//
// The default stays 40 so a raise is measured on its own against the current
// 35/50 baseline:
//   SWEBENCH_MAX_STEPS=100 node swebench/run-inference.mjs ...
const MAX_STEPS = Number(process.env.SWEBENCH_MAX_STEPS ?? 40);

// Deliberate termination. 30% of the 2026-08-16 run (15/50) ended in the
// spinning abort at steps 28-38 of 40, holding a non-empty patch 13 times out
// of 15: the agent had made its fix and kept poking at it.
//
// WHAT A SWEEP WITH THIS ON ACTUALLY MEASURES — do not overstate it:
//   - The stop fires at the SAME step the abort would have. No steps are
//     saved, and the harness reads the patch off the tree after the run
//     whatever the status, so the relabel changes no prediction. The one
//     finish-now nudge is the entire effect on the score.
//   - That nudge reaches any run spinning over a dirty tree, not just the
//     aborts: on the 2026-08-16 data that includes the 23 runs that finished
//     deliberately (20/23 resolved) and the 12 cap-outs. It can talk a
//     would-have-finished run into stopping early, so the score can go DOWN.
//
// Off by default so the next sweep can attribute it by flipping one variable:
//   SHIP_FINISH_WHEN_SETTLED=1 node swebench/run-inference.mjs ...
// `status` in the runlog then reads "settled" on the runs it changed — compare
// that set against the same instances in the 35/50 baseline runlog.
const FINISH_WHEN_SETTLED = process.env.SHIP_FINISH_WHEN_SETTLED === "1";

// The independent critic pass (agent.ts `critic`). The deployed product can run
// it; this harness never did, so every number published from here has been a
// BARER loop than the thing users actually run — "Ship's score" has really been
// "Ship-minus-the-critic's score". Turning it on is what makes a sweep the
// product's number rather than the harness's.
//
// Off by default, like every other knob here, so it is measured on its own:
//   SHIP_CRITIC=1 node swebench/run-inference.mjs ...
// Cost warning: the critic is a second model call on any run that reaches a
// finish with a non-empty diff, so expect a materially larger bill on a paid
// model. It is bounded to one critic-triggered retry per run and never loops.
const CRITIC = process.env.SHIP_CRITIC === "1";

// Hard spend ceiling in USD for the whole sweep. Unset (0) means no cap, which
// is right for the free coding-plan models. Checked after every instance; the
// budget is charged the unpriced CEILING rather than the honest cost, so it
// cannot fail open on a model whose price is unknown.
const BUDGET_USD = Number(process.env.SWEBENCH_BUDGET_USD ?? 0);

// The Nucleus code index (```search). Ship builds and ships this — repo runs
// embed the clone into Nucleus vectors and the agent gets semantic retrieval —
// and nobody has ever measured whether it earns its RAM, because until now the
// harness had no way to hand the agent a search capability at all.
//
// Off by default, like every other knob here. Turning it on needs real operator
// setup on the eval box (a reachable Nucleus and a gateway serving
// /v1/embeddings) — see "Index arm" in README-run.md. It is NOT runnable from a
// cold checkout.
//
//   SHIP_CODE_INDEX=1 NUCLEUS_URL=... SHIP_EMBED_URL=... SHIP_EMBED_KEY=... \
//     node swebench/run-inference.mjs ...
const CODE_INDEX = process.env.SHIP_CODE_INDEX === "1";
// Provider-prefixed form the gateway routes to its ollama accessory
// (teploy-ship/teploy.yml: SHIP_EMBED_MODEL=ollama/nomic-embed-text).
const EMBED_MODEL = process.env.SHIP_EMBED_MODEL ?? "ollama/nomic-embed-text";

// WHICH LOOP RUNS. Off by default, like every other knob here.
//
// Every number published from this harness was measured on `runAgent`
// (src/agent.ts) — the live loop. The PRODUCT is `durableAgent`
// (src/durable.ts): the webhook -> intake -> worker -> PR path that worker.ts
// drives. They are different loops, so the published figure does not describe
// the shipped thing. That is the gap this knob closes, and it is why the
// predictions file carries a DIFFERENT model_name_or_path on this arm — a
// durable result must never be scoreable as the live baseline.
//
// Two values, because the two loops' DEFAULTS differ on three axes and a
// single arm would confound them (see durable-run.mjs for the source lines):
//   SHIP_DURABLE=1        parity arm — recovery and requireEdit forced ON,
//                         which is what the live loop does by default, so the
//                         LOOP is the only variable against the 35/50 baseline.
//   SHIP_DURABLE=product  product arm — exactly what enqueueRun bakes into a
//                         webhook-launched run. Answers "what does a real run
//                         score", and is NOT comparable to 35/50 term by term.
// Whichever is published must be named with its arm. Never average them.
const DURABLE_ARM = durableArmFromEnv(process.env);
const DURABLE = DURABLE_ARM !== null;

function buildModel(id) {
  const opts = { cache: USE_CACHE };
  if (THINK_BUDGET > 0) opts.thinking = { budgetTokens: THINK_BUDGET };

  const url = process.env.AI_GATEWAY_URL;
  const key = process.env.AI_GATEWAY_KEY;
  const notes = [
    USE_CACHE ? "cache on" : "cache off",
    THINK_BUDGET > 0 ? `thinking ${THINK_BUDGET}` : "no thinking",
    FINISH_WHEN_SETTLED ? "settle on" : "settle off",
    CRITIC ? "critic on" : "critic off",
    CODE_INDEX ? "index on" : "index off",
    DURABLE ? `durable loop (${DURABLE_ARM} arm)` : "live loop",
  ].join(", ");
  if (url && key) {
    console.error(`  (routing through ${url} — ${notes})`);
    return createAnthropic({ baseURL: url, apiKey: key })(id, opts);
  }
  console.error(`  (direct anthropic — ${notes})`);
  return anthropic(id, opts);
}
const { containerExecutor } = await import(join(here, "container-executor.mjs"));
const { withDiffSnapshots } = await import(join(here, "executor-snapshot.mjs"));
const { costUSD, isPricedModel } = await import(join(here, "..", "dist", "pricing.js"));
const { FileEventStore } = await import(join(here, "..", "dist", "run-store.js"));
const { connectViaSSH, execCollect, startInstanceContainer } = await import(join(here, "docker-client.mjs"));

const [, , sshHost, instancesPath, outPath] = process.argv;
// Per-instance diagnostics sidecar, next to the predictions file. The
// 2026-08-12 run kept no log, so its 12 empty patches could not be
// attributed after the fact. This file makes that impossible to repeat.
const RUNLOG_PATH = String(outPath ?? "predictions.json").replace(/\.json$/, "") + ".runlog.jsonl";
const instances = JSON.parse(await readFile(instancesPath, "utf8"));
const MODEL = process.env.SWEBENCH_MODEL ?? "claude-sonnet-5";
// The ONE call that decides both the runlog's `loop` field and the predictions'
// model_name_or_path, so those two can never disagree about which loop ran.
const PROVENANCE = provenance(DURABLE, MODEL);
// Whether real per-token pricing exists for this model. Drives whether the
// runlog records a COST or a CEILING — see the diag block below.
const priced = isPricedModel(MODEL);

// The code index, constructed only when the arm is on. Deliberately does NOT
// inherit AI_GATEWAY_URL/_KEY the way ship's own resolveCodeSearch does
// (cli.ts): in THIS harness AI_GATEWAY_URL is the Anthropic-shaped CHAT
// endpoint (z.ai's /api/anthropic in every documented sweep), so inheriting it
// would point embeddings at a messages path and fail on every instance, midway
// through a paid run. Require the embedding endpoint explicitly or refuse to
// start.
// Guard against a STALE dist/. The harness runs code from ../dist, and
// an unknown option is silently dropped by JS — so a sweep launched against a
// build that predates a feature runs for hours with that feature inert and
// reports a number that looks like a real result. Nothing else catches this:
// the env preflight below only proves the operator set variables, not that the
// code honouring them was compiled.
{
  const { readFileSync } = await import("node:fs");
  const read = (file) => readFileSync(join(here, "..", "dist", file), "utf8");
  const built = read("agent.js");
  const required = [
    [FINISH_WHEN_SETTLED, "finishWhenSettled", "SHIP_FINISH_WHEN_SETTLED", "agent.js"],
    [CRITIC && !DURABLE, "critic", "SHIP_CRITIC", "agent.js"],
    [CODE_INDEX && !DURABLE, "codeSearch", "SHIP_CODE_INDEX", "agent.js"],
    // The durable arm reads a DIFFERENT compilation unit, so the rows above
    // cannot see it. Those rows are DIST_REQUIREMENTS, consumed rather than
    // restated, so a symbol added there is enforced here automatically —
    // `workspaceKey` being the one that would fail quietly and expensively:
    // without it the critic and the code index are unreachable on any run with
    // no repo checkout, and a SWE-bench container cannot be a repo run, so a
    // P0-2 sweep would run for hours with NEITHER of the two features it
    // exists to measure and report a number that looks real.
    ...DIST_REQUIREMENTS.map((r) => [r.when({ durable: DURABLE, critic: CRITIC, index: CODE_INDEX }), r.symbol, r.env, r.file]),
  ];
  const sources = new Map([["agent.js", built]]);
  const stale = required.filter(([on, symbol, , file]) => {
    if (!on) return false;
    if (!sources.has(file)) sources.set(file, read(file));
    return !sources.get(file).includes(symbol);
  });
  if (stale.length > 0) {
    for (const [, symbol, env, file] of stale) {
      console.error(`${env} is set but dist/${file} has no "${symbol}" — the build predates it and the flag would be SILENTLY IGNORED.`);
    }
    console.error("Run `pnpm run build` and relaunch.");
    process.exit(2);
  }
}

let index = null;
let db = null;
if (CODE_INDEX) {
  const nucleusURL = process.env.NUCLEUS_URL;
  const embedURL = process.env.SHIP_EMBED_URL;
  const embedKey = process.env.SHIP_EMBED_KEY;
  const missing = [
    nucleusURL ? null : "NUCLEUS_URL",
    embedURL ? null : "SHIP_EMBED_URL",
    embedKey ? null : "SHIP_EMBED_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`SHIP_CODE_INDEX=1 needs ${missing.join(", ")} — see "Index arm" in swebench/README-run.md`);
    process.exit(2);
  }
  const { NucleusPgwire } = await import(join(here, "..", "dist", "nucleus-pgwire.js"));
  const { NucleusCodeIndex } = await import(join(here, "..", "dist", "code-index.js"));
  const { createOpenAI } = await import(join(here, "..", "node_modules", "@neutron-build", "ai", "dist", "openai", "index.js"));
  db = new NucleusPgwire(nucleusURL, "swebench-harness");
  // baseURL is the ROOT with no /v1 — the adapter appends "/v1/embeddings".
  const embedder = createOpenAI({ provider: "embeddings", baseURL: embedURL, apiKey: embedKey }).embedding(EMBED_MODEL);
  index = new NucleusCodeIndex(db, embedder);
  console.error(`  (code index on — nucleus ${nucleusURL.replace(/:[^:@/]*@/, ":***@")}, embeddings ${embedURL} ${EMBED_MODEL})`);
}

/**
 * Drop one instance's index rows. Per-instance keying means 50 instances would
 * otherwise leave 50 repos' worth of vectors behind, which on a shared engine
 * is the memory-pressure write-reject outage waiting to happen.
 *
 * The bulk DELETE uses the `metadata->>'repo'` predicate, which code-index.ts
 * only ever proves in a SELECT — and the house Nucleus gotcha is exactly that
 * reads are lenient where writes are strict. So it is not TRUSTED: a probe
 * (the same predicate, in the shape that IS proven) checks for leftovers, and
 * anything remaining is swept by deterministic chunk id off the file ledger,
 * which uses only statement shapes code-index.ts exercises in production.
 * Failures are logged, never swallowed silently.
 */
async function dropIndexRows(repo) {
  if (db === null) return;
  try {
    await db.query("DELETE FROM ship_code_chunks WHERE metadata->>'repo' = $1", [repo]).catch((e) => {
      console.error(`  [index] bulk chunk delete failed (${e.message}) — falling back to per-id sweep`);
    });
    const leftover = await db.query("SELECT id FROM ship_code_chunks WHERE metadata->>'repo' = $1 LIMIT 1", [repo]);
    let swept = true;
    if (leftover.length > 0) {
      console.error(`  [index] bulk delete left rows behind — sweeping by chunk id`);
      const files = await db.query("SELECT path, chunks FROM ship_code_files WHERE repo = $1", [repo]);
      // Count failures instead of swallowing them. A per-id sweep that fails on
      // EVERY row used to be indistinguishable from a clean one, so an index
      // arm could silently accumulate one instance's chunks into the next
      // instance's retrieval — which would corrupt the very measurement the
      // index arm exists to produce.
      let failed = 0;
      for (const f of files) {
        for (let i = 0; i < Number(f.chunks); i++) {
          try {
            await db.query("DELETE FROM ship_code_chunks WHERE id = $1", [`${repo}::${f.path}#${i}`]);
          } catch {
            failed++;
          }
        }
      }
      if (failed > 0) {
        swept = false;
        console.error(`  [index] per-id sweep failed on ${failed} chunk(s) for ${repo}`);
      }
    }
    // The file ledger is what a retry needs to know WHICH chunks to delete, so
    // it is only safe to drop once the chunks are actually gone. Deleting it
    // after a failed sweep stranded the leftover chunks permanently.
    if (swept) {
      await db.query("DELETE FROM ship_code_files WHERE repo = $1", [repo]);
    } else {
      console.error(`  [index] keeping ship_code_files for ${repo} so the leftover chunks remain identifiable`);
    }
  } catch (err) {
    console.error(`  [index] cleanup FAILED for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const GIT_PRECLEAN =
  "cd /testbed && git config user.email a@b.c; git config user.name a; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null; true";
// The agent's persistent kernel writes its scratch (cells, pids, logs) into
// .teploy-agent/ INSIDE the workspace, so without an exclusion those files land
// in the prediction patch — the canary run produced a patch touching
// kernel.pid and kernel.log alongside the real source fix. Excluded two ways
// because they fail differently: info/exclude keeps the files from ever being
// staged, and the pathspec drops them from the diff even if something staged
// them anyway. info/exclude rather than .gitignore, because editing a tracked
// .gitignore would itself show up in the patch.
const AGENT_SCRATCH = ".teploy-agent";
const GIT_PRECLEAN_EXCLUDE =
  `grep -qxF '${AGENT_SCRATCH}/' /testbed/.git/info/exclude 2>/dev/null || ` +
  `echo '${AGENT_SCRATCH}/' >> /testbed/.git/info/exclude`;
const GIT_DIFF =
  `cd /testbed && git diff HEAD -- . ':(exclude)${AGENT_SCRATCH}' ':(exclude)${AGENT_SCRATCH}/**' 2>/dev/null`;

// Removing each instance image after use keeps a long sweep from filling the
// disk. Off by default so short, repeated runs reuse the cached image.
const PRUNE_IMAGES = process.env.SWEBENCH_PRUNE_IMAGES === "1";

/** Free space on the docker host, in GB. Null when it cannot be read. */
async function diskFreeGB(docker) {
  try {
    const info = await docker.info();
    const total = info?.DriverStatus?.find?.((r) => /data space available/i.test(r?.[0] ?? ""))?.[1];
    return total ?? null;
  } catch {
    return null;
  }
}

// Touch every configuration constant at STARTUP.
//
// Three sweeps died ~12 minutes in, after a full agent run, on a symbol whose
// declaration was never written (costUSD, then BUDGET_USD). `node --check`
// passes — these are runtime references, not syntax — and the test suite does
// not exercise this file. Referencing them here means an undefined one throws
// before a single container starts, which is the difference between a
// two-second failure and a lost sweep.
console.error(
  `  config: model=${MODEL} maxSteps=${MAX_STEPS} thinking=${THINK_BUDGET} ` +
    `settle=${FINISH_WHEN_SETTLED} critic=${CRITIC} index=${CODE_INDEX} ` +
    `loop=${PROVENANCE.loop} arm=${DURABLE_ARM ?? "-"} predictionsAs=${PROVENANCE.modelName} ` +
    `prune=${PRUNE_IMAGES} budgetUSD=${BUDGET_USD} priced=${priced} cache=${USE_CACHE}`,
);
// The durable arm's event logs, one per instance, beside the predictions file.
// The product's own FileEventStore is used rather than an in-memory one for two
// reasons: it is the class fileRuntime() ships (so the benchmark exercises the
// real durability path, fsync and all), and it leaves the post-mortem record
// the 2026-08-12 sweep did not have — with no onEvent hook on this path, the
// log is the ONLY account of what a durable run did. An explicit directory,
// never the operator's ~/.local/state/teploy-ship.
const DURABLE_EVENTS_DIR = String(outPath ?? "predictions.json").replace(/\.json$/, "") + ".durable-events";
if (DURABLE) console.error(`  durable event logs: ${DURABLE_EVENTS_DIR}/`);

const { docker, close } = await connectViaSSH(sshHost);
const predictions = [];
let spentUSD = 0;
const skipped = [];

/**
 * Persist predictions after EVERY instance.
 *
 * This used to be a single writeFile after the loop, and that cost 45
 * completed instances — about six hours of compute — when a transient DNS
 * failure threw out of the loop at instance 46. The runlog sidecar survived
 * (it appends per instance) but it records patchLen, not the patch, so nothing
 * was recoverable. A sweep is expensive and long; its output must be durable
 * at every step, not at the end.
 */
async function persist() {
  await writeFile(outPath, JSON.stringify(predictions, null, 2));
}
let overBudget = null;
try {
  for (const inst of instances) {
    if (overBudget !== null) break;
    const name = `tgw-inf-${inst.instance_id}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    console.error(`\n=== ${inst.instance_id} ===`);

    // Starting the container is OUTSIDE the try below, so a pull failure used
    // to escape the loop and kill the process — taking every completed
    // prediction with it, since they were only written at the end. One
    // instance failing to start is not a reason to discard the sweep: record
    // the skip and carry on. ensureImage already retries with backoff, so
    // reaching here means it failed persistently.
    let container;
    try {
      container = await startInstanceContainer(docker, { image: inst.image, name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  SKIPPED — could not start ${inst.image}: ${message.slice(0, 200)}`);
      skipped.push({ instance_id: inst.instance_id, reason: message.slice(0, 300) });
      appendFileSync(
        RUNLOG_PATH,
        JSON.stringify({ instance_id: inst.instance_id, status: "skipped", reason: message.slice(0, 300) }) + "\n",
      );
      continue;
    }

    try {
      await execCollect(container, ["bash", "-lc", GIT_PRECLEAN]);
      await execCollect(container, ["bash", "-lc", GIT_PRECLEAN_EXCLUDE]);

      const baseExecutor = containerExecutor({ container, workdir: "/testbed" });

      // Patch-preservation safety net: snapshot the working-tree diff after
      // every mutating action, so a fix the agent writes and then reverts is
      // still recoverable. Wrapping lives in executor-snapshot.mjs and is
      // covered by executor-snapshot.test.mjs — including the case that
      // produced 12 empty patches on 2026-08-12, where an `edit` (which goes
      // through putFile, not exec) was reverted before any command ran.
      let lastNonEmptyDiff = "";
      let snapshotCount = 0;
      const executor = withDiffSnapshots(baseExecutor, async () => {
        snapshotCount++;
        const r = await execCollect(container, ["bash", "-lc", GIT_DIFF], { timeoutMs: 30000 });
        if (r.exitCode === 0 && r.stdout.trim() !== "") lastNonEmptyDiff = r.stdout;
      });

      const task = `You are fixing a real bug in the ${inst.instance_id.split("__")[0]} repository, checked out at /testbed.

# Environment (already set up — do not reinstall anything)
- The repo at /testbed is installed in editable mode into an active conda env; \`python\` is the right interpreter and \`pytest\` is on PATH.
- Run tests with e.g. \`python -m pytest <test_file> -x -q -k "<pattern>"\`. Prefer running the few tests relevant to the issue, not the whole suite (some tests need network and will fail regardless of your change — ignore unrelated failures).

# Your deliverable
The DELIVERABLE IS YOUR EDITED WORKING TREE at /testbed — the fix is judged by \`git diff\`, not by what you say.
- NEVER revert or \`git checkout\` your fix once made. If unsure between approaches, leave your best attempt in place.
- Do not edit test files. Do not commit; just leave the edits in the tree.
- If you run low on steps, STOP investigating and ensure your best fix is present in the tree, then finish.

Resolve this GitHub issue by editing the source, then verify with the relevant tests.

--- ISSUE ---
${inst.problem_statement}`;

      // Index this instance's checkout, keyed by instance_id.
      //
      // Keying by instance_id rather than by repo name costs a full re-embed
      // for every instance of the same repo — django alone appears many times
      // in Lite — and that cost buys integrity. Instances of one repo sit at
      // DIFFERENT base commits, and the per-refresh chunk cap can leave a file
      // un-refreshed; a shared index would then let instance B's agent retrieve
      // instance A's post-fix source. That is gold-patch leakage into a
      // published benchmark number. Do not "optimise" this key.
      //
      // baseExecutor, not the snapshot wrapper: index reads are not agent
      // actions and must not inflate snapshotCount in the runlog.
      const repoKey = inst.instance_id;
      let indexStats = null;
      let indexMs = 0;
      let indexError = null;
      // The DURABLE arm does not refresh here. durable.ts refreshes the index
      // itself, as a recorded `repo-index` step, and that step is part of what
      // a product-configuration sweep is supposed to be measuring — running it
      // twice would double the (already minutes-long) index cost and measure
      // the harness's refresh rather than the product's. The scope key is the
      // same `instance_id` either way, so dropIndexRows below cleans up both.
      if (index !== null && !DURABLE) {
        const t0 = Date.now();
        try {
          indexStats = await index.refresh(baseExecutor, repoKey);
          indexMs = Date.now() - t0;
          console.error(
            `  [index] files=${indexStats.files} indexed=${indexStats.indexed} chunks=${indexStats.chunks}` +
              ` capped=${indexStats.capped} in ${indexMs}ms`,
          );
        } catch (err) {
          indexMs = Date.now() - t0;
          indexError = err instanceof Error ? err.message : String(err);
          console.error(`  [index] FAILED after ${indexMs}ms: ${indexError}`);
          // Canary doctrine: if the very first instance cannot index, the
          // setup is wrong (Nucleus unreachable, no model pulled, bad token)
          // and every later instance will fail the same way. Stop before
          // spending hours discovering that. Later failures are recorded and
          // the run continues — but a nonzero indexError count invalidates
          // the arm, which README-run.md says out loud.
          if (predictions.length === 0) {
            throw new Error(`code index failed on the first instance — aborting before spending a sweep: ${indexError}`);
          }
        }
      }

      const started = Date.now();
      // ONE of the two loops runs, and driveLoop decides which. Everything
      // AFTER this call — the final `git diff HEAD`, the lastNonEmptyDiff
      // fallback, the prediction — is shared, deliberately: a durable run that
      // failed or parked can still be holding a real fix in the tree, which is
      // the same lesson durable.ts records when it publishes off a max-steps
      // exit.
      //
      // The dispatch itself lives in durable-run.mjs because this file opens an
      // SSH connection at module scope and so cannot be imported by a test.
      // Anything load-bearing left inline here is verified by nothing but its
      // own text, which is why so little is left inline.
      if (DURABLE) assertNoExistingLog(DURABLE_EVENTS_DIR, inst.instance_id);
      const drive = await driveLoop({
        arm: DURABLE_ARM,
        model: buildModel(MODEL),
        executor,
        task,
        workdir: "/testbed",
        maxSteps: MAX_STEPS,
        actionTimeoutMs: 120000,
        settle: FINISH_WHEN_SETTLED,
        critic: CRITIC,
        index: CODE_INDEX,
        // Live arm: absent unless the index arm is on AND this instance
        // actually indexed, so a per-instance index failure degrades to the
        // baseline loop rather than giving the agent an action that can only
        // refuse. Durable arm: the index object itself, refreshed inside
        // durable's own recorded `repo-index` step.
        ...(DURABLE
          ? index !== null
            ? { codeSearch: index }
            : {}
          : index !== null && indexError === null
            ? { codeSearch: (q) => index.search(repoKey, q) }
            : {}),
        // Same key the harness uses everywhere else, so durable's own
        // `repo-index` step and dropIndexRows() below agree on scope. It is
        // also what makes the critic reachable at all on a run with no repo
        // checkout — see DurableAgentInput.workspaceKey.
        workspaceKey: repoKey,
        runId: inst.instance_id,
        // One log per instance, fsynced, under an explicit directory.
        ...(DURABLE ? { store: teeStore(new FileEventStore(DURABLE_EVENTS_DIR), (line) => console.error(line)) } : {}),
        first: predictions.length === 0,
        onEvent: (e) => {
          if (e.type === "action" || e.type === "finish" || e.type === "error") console.error(`  [${e.type}] ${e.text.slice(0, 100)}`);
        },
      });
      const result = drive.live ?? null;
      const durableRun = drive.durable ?? null;

      const final = await execCollect(container, ["bash", "-lc", GIT_DIFF], { timeoutMs: 30000 });
      const treeDiff = final.exitCode === 0 ? final.stdout : "";
      const finalPatch = treeDiff.trim() !== "" ? treeDiff : lastNonEmptyDiff;
      if (treeDiff.trim() === "" && lastNonEmptyDiff !== "") {
        console.error(`  [recovered] final tree was clean; using last non-empty snapshot (${lastNonEmptyDiff.length} chars)`);
      }

      // Diagnostics. An empty patch has two very different causes and the
      // 2026-08-12 run could not tell them apart, because nothing was
      // persisted: the agent never edited at all (a model/termination
      // problem), or it edited and the tree lost it (a harness problem).
      // everEdited distinguishes them. Written to a JSONL sidecar so the
      // next post-mortem does not depend on someone having kept stderr.
      // The conservative number, always. costUSD prices an unpriced model at the
      // highest known rate on purpose, so a spend cap cannot fail open.
      const usage = drive.usage;
      const ceiling = Number(costUSD(MODEL, usage).toFixed(4));
      const diag = {
        instance_id: inst.instance_id,
        // WHICH LOOP RAN. Recorded first and unconditionally, on every row.
        // A result whose loop cannot be established after the fact is exactly
        // the misattribution this arm exists to end, so this is not optional
        // and is not "durable-only" — a live row says so explicitly too.
        loop: PROVENANCE.loop,
        ...(drive.arm !== null ? { arm: drive.arm } : {}),
        status: drive.status,
        // Model turns, both arms — the same quantity measured two ways
        // (runAgent appends one step per action; durable records one
        // `turn-N-think` per model call). `snapshots` below is NOT comparable
        // across arms: durable's fingerprint, critic-diff and index reads all
        // go through the wrapped executor, while the live arm deliberately
        // indexes off baseExecutor.
        steps: drive.steps,
        durationMs: Date.now() - started,
        patchLen: finalPatch.length,
        everEdited: lastNonEmptyDiff !== "",
        recovered: treeDiff.trim() === "" && lastNonEmptyDiff !== "",
        snapshots: snapshotCount,
        // Index arm measurement. `searches` is the field that decides whether
        // the arm means anything at all: an index arm in which the agent never
        // issued a ```search measures NOTHING, and without this recorded that
        // is invisible after the fact. Same lesson as everEdited.
        ...(CODE_INDEX && !DURABLE
          ? {
              searches: result.steps.filter((s) => s.action.kind === "search").length,
              indexFiles: indexStats?.files ?? 0,
              indexChunks: indexStats?.chunks ?? 0,
              indexCapped: indexStats?.capped ?? false,
              indexMs,
              indexError,
            }
          : {}),
        // The durable arm's own measurements, off its event log — the only
        // account of the run, since durable has no onEvent hook. `execs` and
        // `thinks` are the "did this arm measure anything at all" pair: a
        // durable row with zero execs means the provider never attached, the
        // same trap `searches: 0` is for the index arm. Every field here is a
        // PROCESS metric and a hypothesis about the score — never a proxy for
        // it. The verbatim input is recorded so a row can be reproduced
        // exactly, arm defaults included.
        ...(DURABLE
          ? {
              durableInput: drive.input,
              outcome: durableRun.outcomeStatus,
              turns: durableRun.turns,
              ...(durableRun.error !== undefined ? { error: durableRun.error } : {}),
              ...durableRun.counts,
            }
          : {}),
        // costUSD prices an UNPRICED model at the highest known rate, on
        // purpose, so a spend cap cannot fail open. That is right for a cap
        // and wrong to record as fact: the free z.ai coding-plan models are
        // unpriced, so a 50-instance sweep costing nothing would otherwise
        // write ~$178 of phantom spend into a runlog that gets committed.
        // Record the ceiling, but say plainly that it is one.
        costUSD: priced ? ceiling : 0,
        ...(priced ? {} : { costCeilingUSD: ceiling }),
        priced,
      };
      // Charge the budget the CEILING even when the model is unpriced. Using
      // diag.costUSD here would make SWEBENCH_BUDGET_USD fail open for exactly
      // the models whose price is unknown — the opposite of what a cap is for.
      spentUSD += ceiling;
      console.error(
        `  loop=${diag.loop} status=${diag.status} steps=${diag.steps} durationMs=${diag.durationMs} patchLen=${diag.patchLen}` +
          ` everEdited=${diag.everEdited} snapshots=${diag.snapshots}` +
          (DURABLE ? ` execs=${diag.execs} searches=${diag.searches} criticRuns=${diag.criticRuns} parked=${diag.parked}` : "") +
          (CODE_INDEX && !DURABLE ? ` searches=${diag.searches}` : ""),
      );
      appendFileSync(RUNLOG_PATH, JSON.stringify(diag) + "\n");
      // The predictions file names the loop too, so a durable result can never
      // be scored as the live-loop baseline even if the runlog is lost. Same
      // provenance() call as the runlog's `loop` field — one source, so the two
      // cannot disagree.
      predictions.push({ instance_id: inst.instance_id, model_name_or_path: PROVENANCE.modelName, model_patch: finalPatch });
      await persist();
      // Stop the sweep the moment the running total crosses the ceiling. The
      // check is AFTER the push so the instance just paid for is kept — and
      // outside the try/finally's cleanup so the image prune still runs below.
      if (BUDGET_USD > 0 && spentUSD >= BUDGET_USD) {
        overBudget = `stopped after ${predictions.length} instance(s): spent $${spentUSD.toFixed(2)} of the $${BUDGET_USD.toFixed(2)} SWEBENCH_BUDGET_USD ceiling`;
      }
    } finally {
      // Before the container goes: this instance's vectors are dead weight the
      // moment its run ends, and they are keyed per instance so nothing reuses
      // them.
      if (index !== null) await dropIndexRows(inst.instance_id);
      await container.remove({ force: true }).catch(() => {});
      // Reclaim the instance IMAGE too, not just the container. Official
      // SWE-bench images are 1-2 GB each and every instance uses a different
      // one, so a run of any real size fills the disk and dies partway
      // through — the 3-instance gauge never hit this. Opt-in, because a
      // small repeated run wants the image cached; required for a sweep.
      if (PRUNE_IMAGES) {
        const before = await diskFreeGB(docker);
        await docker.getImage(inst.image).remove({ force: true }).catch(() => {});
        const after = await diskFreeGB(docker);
        console.error(
          `  [prune] removed ${inst.image}` +
            (before !== null && after !== null ? ` (disk free ${before} -> ${after} GB)` : ""),
        );
      }
    }
  }
} finally {
  close();
  // A live pg.Pool keeps the event loop open — without this the harness
  // finishes its work and then simply never exits.
  if (db !== null) await db.close().catch(() => {});
}

await writeFile(outPath, JSON.stringify(predictions, null, 2));
await persist();
console.error(`\nwrote ${predictions.length} predictions to ${outPath}`);
if (skipped.length > 0) {
  // Loud, and non-zero exit: scoring a short predictions file against the full
  // instance list counts every skipped instance as unresolved and silently
  // understates the model. Re-run these before comparing to a full sweep.
  console.error(`\n${skipped.length} instance(s) SKIPPED — the sweep is PARTIAL:`);
  for (const s of skipped) console.error(`  ${s.instance_id}: ${s.reason.slice(0, 120)}`);
  console.error(`Score ${predictions.length}/${predictions.length}, or re-run the skipped ids.`);
  process.exitCode = 4;
}
if (spentUSD > 0) console.error(`total spend: $${spentUSD.toFixed(2)}`);
if (overBudget !== null) {
  // Loud and non-zero: a partial sweep scored as if it were complete would
  // silently understate the model, since unrun instances count as unresolved.
  console.error(`\nBUDGET STOP — ${overBudget}`);
  console.error(`Score this as ${predictions.length}/${predictions.length}, NOT out of ${instances.length}.`);
  process.exitCode = 3;
}
