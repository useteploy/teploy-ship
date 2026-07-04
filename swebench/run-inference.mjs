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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { runAgent } = await import(join(here, "..", "dist", "index.js"));
const { anthropic } = await import(join(here, "..", "node_modules", "@neutron-build", "ai", "dist", "anthropic", "index.js"));
const { containerExecutor } = await import(join(here, "container-executor.mjs"));
const { connectViaSSH, execCollect, startInstanceContainer } = await import(join(here, "docker-client.mjs"));

const [, , sshHost, instancesPath, outPath] = process.argv;
const instances = JSON.parse(await readFile(instancesPath, "utf8"));
const MODEL = process.env.SWEBENCH_MODEL ?? "claude-sonnet-5";

const GIT_PRECLEAN =
  "cd /testbed && git config user.email a@b.c; git config user.name a; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null; true";
const GIT_DIFF = "cd /testbed && git diff HEAD -- . 2>/dev/null";

const { docker, close } = await connectViaSSH(sshHost);
const predictions = [];
try {
  for (const inst of instances) {
    const name = `tgw-inf-${inst.instance_id}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    console.error(`\n=== ${inst.instance_id} ===`);
    const container = await startInstanceContainer(docker, { image: inst.image, name });
    try {
      await execCollect(container, ["bash", "-lc", GIT_PRECLEAN]);

      const baseExecutor = containerExecutor({ container, workdir: "/testbed" });

      // Patch-preservation safety net: after every action, snapshot the
      // working-tree diff; if the agent reverts its own fix while
      // thrashing, the last non-empty diff is still recoverable.
      let lastNonEmptyDiff = "";
      const snapshotDiff = async () => {
        const r = await execCollect(container, ["bash", "-lc", GIT_DIFF], { timeoutMs: 30000 });
        if (r.exitCode === 0 && r.stdout.trim() !== "") lastNonEmptyDiff = r.stdout;
      };
      const executor = {
        async exec(cmd, opts) {
          const result = await baseExecutor.exec(cmd, opts);
          await snapshotDiff();
          return result;
        },
        putFile: (p, d) => baseExecutor.putFile(p, d),
        getFile: (p) => baseExecutor.getFile(p),
        destroy: () => baseExecutor.destroy(),
      };

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
        model: anthropic(MODEL, { cache: true }),
        executor,
        task,
        workdir: "/testbed",
        maxSteps: 40,
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

      console.error(`  status=${result.status} steps=${result.steps.length} durationMs=${Date.now() - started} patchLen=${finalPatch.length}`);
      predictions.push({ instance_id: inst.instance_id, model_name_or_path: `teploy-agent+${MODEL}`, model_patch: finalPatch });
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }
} finally {
  close();
}

await writeFile(outPath, JSON.stringify(predictions, null, 2));
console.error(`\nwrote ${predictions.length} predictions to ${outPath}`);
