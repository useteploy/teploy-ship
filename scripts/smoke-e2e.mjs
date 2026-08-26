#!/usr/bin/env node
/**
 * End-to-end smoke run: one real agent run, through the real binary, against a
 * real forge and a real sandbox — and five assertions about what came out.
 *
 * WHY THIS EXISTS. CI runs lint, 530 unit tests, a web build and a secret scan,
 * and never executes a single agent run. In one week of 2026-08 that let four
 * config-vs-behaviour bugs ship green:
 *
 *   1. `SHIP_MODEL` was ignored on some surfaces, so runs used a different
 *      model than the operator asked for.                        (d88f43a)
 *   2. A prefixed `SHIP_MODEL_PRICING` override was silently dropped, so cost
 *      was recorded against the wrong rate.                      (1538d45)
 *   3. Scan mode wrote its findings to a path the executor refuses to write,
 *      git excludes and the publisher never reads: 7 scans, 0 findings.
 *   4. The strict approval policy applied inside a sandbox, so unattended runs
 *      parked forever waiting for an operator who was never coming.
 *                                                          (d3b7029, 67315d1)
 *
 * Every one of those is a seam between configuration and behaviour. A unit
 * test cannot see a seam it mocks, which is why all four passed 520 green
 * tests. So this smoke deliberately shells out to the REAL cli — `evidence
 * set`, `enqueue`, `worker` — instead of driving durableAgent in-process. An
 * in-process harness would have to re-implement model resolution, the approval
 * choice and the pricing lookup, and would therefore agree with itself about
 * exactly the things that were wrong.
 *
 * PRE-DECIDED: the smoke needs a Nucleus (the worker refuses any other store),
 * a sandbox daemon and a forge, so it runs where those exist — nightly and
 * on-demand on the worker host — rather than in GitHub CI, which can reach
 * none of them. Reversal condition: if a Nucleus ever becomes unavailable to
 * CI, add a file-store worker mode; do not weaken the assertions to fit.
 *
 * WHAT IT PROVES, one assertion per line of the plan's done-check:
 *   - a pull request was opened
 *   - the SUITE ran — not "a command ran"; the suite prints a marker and the
 *     recorded outcome must be `passed` with the command that was configured
 *   - cost was recorded for the run
 *   - the model id used matches the model id asked for
 *   - zero unexpected approval parks
 *
 * Usage:
 *   node scripts/smoke-e2e.mjs [--no-worker] [--keep] [--timeout-sec N]
 *
 * Required env:
 *   NUCLEUS_URL           the shared store the worker claims runs from
 *   SHIP_SANDBOX_URL      teploy-sandbox daemon
 *   SHIP_SANDBOX_TOKEN
 *   SHIP_SMOKE_REPO       clone URL of a THROWAWAY repo this script may reset
 *   SHIP_MODEL            the model to assert against (also what runs)
 *   a git token           SHIP_GIT_TOKENS / SHIP_GIT_TOKEN / SHIP_GITHUB_TOKEN
 *   model credentials     AI_GATEWAY_URL + AI_GATEWAY_KEY, or a provider key
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "dist", "cli.js");

/**
 * The suite prints this and nothing else does. `FINISH_NUDGE_NO_EVIDENCE` asks
 * whether a command RAN, not whether the suite passed — `ls` satisfies it
 * (tests.ts:11). Asserting on a marker the suite alone emits is the difference
 * between "a command ran" and "the suite ran".
 */
const SUITE_MARKER = "SHIP_SMOKE_SUITE_OK";
const TEST_COMMAND = "sh test.sh";

/**
 * The fixture. Deliberately shell-only — no python, no node — so it runs under
 * whatever sandbox image the worker is configured with rather than pinning the
 * smoke to one image.
 */
const SEED = {
  "answer.txt": "41\n",
  "test.sh": `#!/bin/sh
# The smoke fixture's suite. Fails on the seed state, passes once the agent has
# done the task. Printing a marker is what lets the smoke tell "the suite ran"
# apart from "a command ran".
actual=$(cat answer.txt 2>/dev/null)
if [ "$actual" != "42" ]; then
  echo "answer.txt is '$actual', expected 42"
  exit 1
fi
echo ${SUITE_MARKER}
`,
  "README.md": `# ship smoke fixture

Throwaway repository. Teploy Ship's end-to-end smoke run resets \`main\` to this
state, files one task against it, and asserts on the pull request that comes
back. Anything you commit here will be overwritten.
`,
};

const TASK =
  "answer.txt contains the wrong number. Change it so that it contains exactly 42 and nothing else. " +
  "Do not modify test.sh. Verify with `sh test.sh` before finishing.";

// --- plumbing ---------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const TIMEOUT_MS = Number(value("timeout-sec", "900")) * 1000;
const KEEP = flag("keep");
const NO_WORKER = flag("no-worker");

const problems = [];
const note = (line) => process.stderr.write(`${line}\n`);

function fail(message) {
  note(`\nsmoke: ${message}`);
  process.exit(2);
}

function run(cliArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...cliArgs], {
      cwd: ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// --- the forge --------------------------------------------------------------

/**
 * Parse a clone URL into the pieces the forge API needs. Mirrors
 * src/git.ts's parseRepoUrl closely enough for a fixture repo; it does not
 * need to handle the fork and credential cases the product does.
 */
function parseRepo(url) {
  const u = new URL(url);
  const parts = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (parts.length < 2) fail(`SHIP_SMOKE_REPO does not look like a repo URL: ${url}`);
  const github = u.host === "github.com";
  return {
    github,
    owner: parts[0],
    repo: parts[1],
    api: github ? "https://api.github.com" : `${u.origin}/api/v1`,
  };
}

function tokenFor(ref) {
  const byOrigin = (() => {
    try {
      return JSON.parse(process.env.SHIP_GIT_TOKENS ?? "{}");
    } catch {
      return {};
    }
  })();
  const origin = ref.github ? "https://github.com" : new URL(process.env.SHIP_SMOKE_REPO).origin;
  return (
    byOrigin[origin] ??
    byOrigin[origin.toLowerCase()] ??
    (ref.github ? process.env.SHIP_GITHUB_TOKEN : undefined) ??
    process.env.SHIP_GIT_TOKEN ??
    ""
  );
}

async function forge(ref, token, path, init = {}) {
  const response = await fetch(`${ref.api}${path}`, {
    ...init,
    headers: {
      authorization: ref.github ? `Bearer ${token}` : `token ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * Put the fixture on `main`, whatever was there before.
 *
 * Over the contents API rather than a local clone: the smoke must not need git
 * on the box it runs from, and a create-or-update per file is the smallest
 * thing that reaches a known state on both forges.
 */
async function seedRepo(ref, token) {
  const exists = await forge(ref, token, `/repos/${ref.owner}/${ref.repo}`);
  if (!exists.ok) {
    note(`seeding: ${ref.owner}/${ref.repo} does not exist — creating it`);
    const created = await forge(ref, token, ref.github ? "/user/repos" : "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name: ref.repo, private: true, auto_init: true, description: "Teploy Ship smoke fixture" }),
    });
    if (!created.ok) fail(`could not create ${ref.owner}/${ref.repo}: ${created.status} ${JSON.stringify(created.body)}`);
  }

  for (const [path, content] of Object.entries(SEED)) {
    const current = await forge(ref, token, `/repos/${ref.owner}/${ref.repo}/contents/${path}`);
    const sha = current.ok && current.body !== null && typeof current.body === "object" ? current.body.sha : undefined;
    const encoded = Buffer.from(content, "utf8").toString("base64");
    if (sha !== undefined && current.body.content !== undefined) {
      const existing = Buffer.from(String(current.body.content).replace(/\s/g, ""), "base64").toString("utf8");
      if (existing === content) continue; // already right — do not churn history
    }
    // Forgejo/Gitea split create and update across POST and PUT and reject a
    // PUT with no sha ("[SHA]: Required"); GitHub takes PUT for both.
    const method = sha !== undefined ? "PUT" : ref.github ? "PUT" : "POST";
    const put = await forge(ref, token, `/repos/${ref.owner}/${ref.repo}/contents/${path}`, {
      method,
      body: JSON.stringify({
        message: `smoke fixture: ${path}`,
        content: encoded,
        ...(sha !== undefined ? { sha } : {}),
      }),
    });
    if (!put.ok) fail(`could not write ${path}: ${put.status} ${JSON.stringify(put.body)}`);
  }
  note(`seeding: ${ref.owner}/${ref.repo} is at the fixture state`);
}

// --- preflight --------------------------------------------------------------

const REQUIRED = ["NUCLEUS_URL", "SHIP_SANDBOX_URL", "SHIP_SANDBOX_TOKEN", "SHIP_SMOKE_REPO", "SHIP_MODEL"];

/**
 * Only drive a live run when this file IS the program. Importing it — which
 * scripts/smoke-e2e.test.mjs does, to replay the four bugs against
 * evaluateSmoke — must not read env, enqueue anything, or touch a forge.
 */
const RUN_DIRECTLY = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

let repoUrl;
let ref;
let token;
let askedModel;

function preflight() {
  const missing = REQUIRED.filter((k) => (process.env[k] ?? "") === "");
  if (missing.length > 0) {
    note(`smoke: missing required env: ${missing.join(", ")}`);
    note("smoke: this runs where a Nucleus, a sandbox daemon and a forge all exist — see the header.");
    process.exit(2);
  }
  repoUrl = process.env.SHIP_SMOKE_REPO;
  ref = parseRepo(repoUrl);
  token = tokenFor(ref);
  if (token === "") fail("no git token for the smoke repo's origin (SHIP_GIT_TOKENS / SHIP_GIT_TOKEN / SHIP_GITHUB_TOKEN)");
  askedModel = process.env.SHIP_MODEL;
}

// --- the run ----------------------------------------------------------------

const started = Date.now();
let worker = null;
let workerOutput = "";

async function main() {
  preflight();
  await seedRepo(ref, token);

  // The repo must be allowlisted for an enqueue to be accepted, and its
  // evidence entry is what turns the suite leg on — both through the real
  // commands an operator would use, so a break in either is a smoke failure
  // rather than something the script papers over.
  const project = await run([
    "project",
    "set",
    repoUrl,
    "--url",
    repoUrl,
    "--test-command",
    TEST_COMMAND,
    "--store",
    "nucleus",
  ]);
  if (project.code !== 0) fail(`project set failed: ${project.stderr.trim()}`);

  const queued = await run(["enqueue", TASK, "--repo", repoUrl, "--json", "--store", "nucleus"]);
  if (queued.code !== 0) fail(`enqueue failed: ${queued.stderr.trim()}`);
  const runId = JSON.parse(queued.stdout.trim()).runId;
  note(`queued ${runId} (model asked: ${askedModel})`);

  // A worker of our own by default: the smoke must be able to run on a box
  // where nothing is deployed yet, and a dedicated worker with one slot makes
  // the run's timing its own rather than a queue's. `--no-worker` hands the
  // run to whatever worker is already resident — which is what you want when
  // the point is to smoke-test the DEPLOYED worker rather than this checkout.
  if (!NO_WORKER) {
    worker = spawn(process.execPath, [CLI, "worker", "--store", "nucleus", "--interval", "2", "--max-concurrent", "1"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (d) => (workerOutput += d));
    worker.stderr.on("data", (d) => (workerOutput += d));
  } else {
    note("waiting for a resident worker to claim it (--no-worker)");
  }

  const runtimeModule = await import(join(ROOT, "dist", "runtime.js"));
  const runtime = await runtimeModule.nucleusRuntime(process.env.NUCLEUS_URL, "smoke", { log: () => {} });

  try {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    let meta = null;
    for (;;) {
      if (Date.now() - started > TIMEOUT_MS) {
        fail(`the run did not reach a terminal state within ${Math.round(TIMEOUT_MS / 1000)}s (last status: ${meta?.status ?? "none"})`);
      }
      meta = await runtime.loadMeta(runId);
      if (meta !== null && terminal.has(meta.status)) break;
      if (meta !== null && meta.status === "waiting") {
        // Not a timeout to wait out: an unattended run that parks is exactly
        // failure #4, and there is no operator coming to approve it.
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    const events = await runtime.store.load(runId);
    const ledger = await readLedger(runtime);
    reportChecks(evaluateSmoke({ meta, events, ledger, askedModel, testCommand: TEST_COMMAND }), events);
  } finally {
    await runtime.close().catch(() => {});
  }
}

// --- the assertions ---------------------------------------------------------

export function stepResult(events, predicate) {
  const hit = [...events].reverse().find((e) => e.type === "step-completed" && predicate(e.name ?? ""));
  return hit === undefined ? undefined : hit.data?.result;
}

/**
 * The whole verdict, as data.
 *
 * Exported and pure so the four bugs this smoke exists to catch can be
 * REPLAYED as a unit test (`scripts/smoke-e2e.test.mjs`) rather than
 * reintroduced by hand into a live deployment once and then never again. An
 * assertion nobody has watched fail is a comment, not a check.
 */
export function evaluateSmoke({ meta, events, ledger, askedModel, testCommand }) {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail });

  // 1. A pull request was opened.
  const pr = stepResult(events, (n) => n === "repo-pr");
  const prUrl = typeof pr === "string" ? pr : (pr?.url ?? pr?.pr ?? undefined);
  check(
    "a pull request was opened",
    prUrl !== undefined && String(prUrl) !== "",
    prUrl === undefined ? `run ended ${meta?.status}` : String(prUrl),
  );

  // 2. The SUITE ran — not "a command ran". FINISH_NUDGE_NO_EVIDENCE asks
  //    whether a command RAN, not whether the suite passed (tests.ts:11), and
  //    `ls` satisfies it. So both the outcome and the command are asserted:
  //    a `disabled`/`errored` outcome, or a different command, is a red.
  const tests = stepResult(events, (n) => n === "tests" || n.endsWith("-critic-tests"));
  check(
    "the suite ran and passed",
    tests?.kind === "passed",
    tests === undefined ? "no `tests` step in the log at all" : `kind=${tests.kind}${tests.reason !== undefined ? ` (${tests.reason})` : ""}`,
  );
  check(
    "it was the configured command, not something else",
    tests?.command === testCommand,
    `recorded command: ${JSON.stringify(tests?.command ?? null)}`,
  );

  // 3. Cost was recorded. An unpriced model is COUNTED, never reported as $0
  //    (P5-3), so the pass condition is "the run's consumption reached a
  //    ledger", by whichever of the two routes applies. A run whose cost
  //    vanishes silently is the pricing-override failure's shape exactly.
  const completed = [...events].reverse().find((e) => e.type === "run-completed");
  const output = completed?.data?.output ?? completed?.data ?? undefined;
  const usage = output?.usage ?? undefined;
  const tokens = Number(usage?.totalTokens ?? 0) || Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0);
  check("the run recorded model usage", tokens > 0, `usage=${JSON.stringify(usage ?? null)}`);
  check(
    "that usage reached a spend ledger",
    (ledger?.priced ?? 0) > 0 || (ledger?.unpriced ?? 0) > 0,
    `priced today: ${ledger?.priced ?? 0}, unpriced runs today: ${ledger?.unpriced ?? 0}` +
      (ledger?.error !== undefined ? ` (ledger read failed: ${ledger.error})` : ""),
  );

  // 4. The model id used matches the model id asked for.
  check(
    "the model used is the model asked for",
    meta?.model === askedModel,
    `asked ${JSON.stringify(askedModel)}, ran ${JSON.stringify(meta?.model ?? null)}`,
  );

  // 5. Zero unexpected approval parks. An unattended run has no operator to
  //    answer a park, so one is a hang, not a pause.
  const parks = events.filter((e) => e.type === "event-waiting");
  check(
    "no approval park",
    parks.length === 0 && meta?.status !== "waiting",
    parks.length > 0 ? `parked on: ${parks.map((p) => p.name ?? "?").join(", ")}` : `status=${meta?.status}`,
  );

  return checks;
}

function reportChecks(checks, events) {
  note("\nassertions:");
  for (const c of checks) {
    note(`${c.ok ? "  ok  " : " FAIL "} ${c.label}${c.detail !== undefined ? ` — ${c.detail}` : ""}`);
    if (!c.ok) problems.push(`${c.label}${c.detail !== undefined ? `: ${c.detail}` : ""}`);
  }
  // Not an assertion, but the first thing anyone reading a failure wants.
  const failed = events.filter((e) => e.type === "step-failed");
  if (failed.length > 0) {
    note(`\nfailed steps: ${failed.map((e) => `${e.name}: ${JSON.stringify(e.data?.error ?? "")}`).join("\n              ")}`);
  }
}

/**
 * What the spend ledgers hold for today.
 *
 * Both are read because a free or unrecognised model is deliberately NOT
 * priced at $0 — it is counted in the unpriced-run ledger instead (P5-3) — and
 * the smoke must pass on either kind of model without being told which it has.
 */
async function readLedger(runtime) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const priced = await runtime.spend.get("manual", day).catch(() => 0);
    const unpriced = await runtime.unpricedRuns.count("manual", day).catch(() => 0);
    return { priced: Number(priced) || 0, unpriced: Number(unpriced) || 0 };
  } catch (error) {
    return { priced: 0, unpriced: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- teardown ---------------------------------------------------------------

async function shutdown() {
  if (worker !== null) {
    worker.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
}

if (RUN_DIRECTLY) {
main()
  .then(async () => {
    await shutdown();
    const seconds = Math.round((Date.now() - started) / 1000);
    if (problems.length > 0) {
      note(`\nsmoke FAILED in ${seconds}s — ${problems.length} assertion${problems.length === 1 ? "" : "s"}:`);
      for (const p of problems) note(`  - ${p}`);
      if (!KEEP) note("\nworker output:\n" + workerOutput.split("\n").slice(-40).join("\n"));
      process.exit(1);
    }
    note(`\nsmoke PASSED in ${seconds}s — a real run, a real sandbox, a real pull request.`);
    process.exit(0);
  })
  .catch(async (error) => {
    await shutdown();
    note(`\nsmoke ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    note("\nworker output:\n" + workerOutput.split("\n").slice(-40).join("\n"));
    process.exit(1);
  });
}
