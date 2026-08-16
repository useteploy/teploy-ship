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
const { runAgent } = await import(join(here, "..", "dist", "index.js"));
const { anthropic, createAnthropic } = await import(join(here, "..", "node_modules", "@neutron-build", "ai", "dist", "anthropic", "index.js"));

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

// Step cap. 56% of the 2026-08-12 run (28/50) hit this and were cut off
// mid-work, so it is a config choice presenting as a capability gap —
// OpenHands runs this benchmark at ~100.
//
// The default deliberately stays 40. The next sweep must measure the
// empty-patch fix ALONE against the 22/50 baseline; raising the cap in the
// same run would make the delta unattributable. Raise it in a SECOND run:
//   SWEBENCH_MAX_STEPS=100 node swebench/run-inference.mjs ...
const MAX_STEPS = Number(process.env.SWEBENCH_MAX_STEPS ?? 40);

function buildModel(id) {
  const opts = { cache: USE_CACHE };
  if (THINK_BUDGET > 0) opts.thinking = { budgetTokens: THINK_BUDGET };

  const url = process.env.AI_GATEWAY_URL;
  const key = process.env.AI_GATEWAY_KEY;
  const notes = [
    USE_CACHE ? "cache on" : "cache off",
    THINK_BUDGET > 0 ? `thinking ${THINK_BUDGET}` : "no thinking",
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
const { connectViaSSH, execCollect, startInstanceContainer } = await import(join(here, "docker-client.mjs"));

const [, , sshHost, instancesPath, outPath] = process.argv;
// Per-instance diagnostics sidecar, next to the predictions file. The
// 2026-08-12 run kept no log, so its 12 empty patches could not be
// attributed after the fact. This file makes that impossible to repeat.
const RUNLOG_PATH = String(outPath ?? "predictions.json").replace(/\.json$/, "") + ".runlog.jsonl";
const instances = JSON.parse(await readFile(instancesPath, "utf8"));
const MODEL = process.env.SWEBENCH_MODEL ?? "claude-sonnet-5";

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

const { docker, close } = await connectViaSSH(sshHost);
const predictions = [];
try {
  for (const inst of instances) {
    const name = `tgw-inf-${inst.instance_id}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    console.error(`\n=== ${inst.instance_id} ===`);
    const container = await startInstanceContainer(docker, { image: inst.image, name });
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

      const started = Date.now();
      const result = await runAgent({
        model: buildModel(MODEL),
        executor,
        task,
        workdir: "/testbed",
        maxSteps: MAX_STEPS,
        actionTimeoutMs: 120000,
        onEvent: (e) => {
          if (e.type === "action" || e.type === "finish" || e.type === "error") console.error(`  [${e.type}] ${e.text.slice(0, 100)}`);
        },
      });

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
      const diag = {
        instance_id: inst.instance_id,
        status: result.status,
        steps: result.steps.length,
        durationMs: Date.now() - started,
        patchLen: finalPatch.length,
        everEdited: lastNonEmptyDiff !== "",
        recovered: treeDiff.trim() === "" && lastNonEmptyDiff !== "",
        snapshots: snapshotCount,
      };
      console.error(
        `  status=${diag.status} steps=${diag.steps} durationMs=${diag.durationMs} patchLen=${diag.patchLen}` +
          ` everEdited=${diag.everEdited} snapshots=${diag.snapshots}`,
      );
      appendFileSync(RUNLOG_PATH, JSON.stringify(diag) + "\n");
      predictions.push({ instance_id: inst.instance_id, model_name_or_path: `teploy-agent+${MODEL}`, model_patch: finalPatch });
    } finally {
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
}

await writeFile(outPath, JSON.stringify(predictions, null, 2));
console.error(`\nwrote ${predictions.length} predictions to ${outPath}`);
