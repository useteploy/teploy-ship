// SWE-bench inference: run teploy-agent against each instance's real
// environment (an official SWE-bench container on the remote box), extract
// the git diff as the patch, and write a predictions file the official
// swebench evaluator scores.
//
// Usage:
//   ANTHROPIC_API_KEY=... node run-inference.mjs <ssh-host> <instances.json> <out-preds.json>
//
// instances.json: [{ instance_id, image, problem_statement }]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, "..", "dist", "index.js");
const { runAgent } = await import(AGENT);
const { anthropic } = await import(join(here, "..", "node_modules", "@neutron-build", "ai", "dist", "anthropic", "index.js"));
const { containerExecutor } = await import(join(here, "container-executor.mjs"));

const [, , sshHost, instancesPath, outPath] = process.argv;
const instances = JSON.parse(await readFile(instancesPath, "utf8"));
const MODEL = process.env.SWEBENCH_MODEL ?? "claude-sonnet-5";

const ssh = async (cmd) => {
  const { stdout } = await run("ssh", [sshHost, cmd], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const predictions = [];
for (const inst of instances) {
  const container = `tgw-inf-${inst.instance_id}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
  console.error(`\n=== ${inst.instance_id} ===`);
  // fresh container from the instance image; repo is at /testbed at base_commit
  await ssh(`docker rm -f ${container} 2>/dev/null; docker run -d --name ${container} ${inst.image} sleep infinity`);
  try {
    // clean any prior state and snapshot the git HEAD so the diff is only the agent's work
    await ssh(`docker exec ${container} bash -lc 'cd /testbed && git config user.email a@b.c; git config user.name a; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null; true'`);

    const executor = containerExecutor({ ssh: sshHost, container, workdir: "/testbed" });
    const task = `You are fixing a real bug in the ${inst.instance_id.split("__")[0]} repository, checked out at /testbed. Resolve this GitHub issue by editing the source. Run the project's tests to verify your fix. Do not edit test files.\n\n--- ISSUE ---\n${inst.problem_statement}`;

    const started = Date.now();
    const result = await runAgent({
      model: anthropic(MODEL),
      executor,
      task,
      workdir: "/testbed",
      maxSteps: 40,
      actionTimeoutMs: 120000,
      onEvent: (e) => { if (e.type === "action" || e.type === "finish" || e.type === "error") console.error(`  [${e.type}] ${e.text.slice(0, 100)}`); },
    });

    // extract the patch: tracked-file edits only (scratch files are untracked → excluded)
    const patch = await ssh(`docker exec ${container} bash -lc 'cd /testbed && git add -A -- ":!*.teploy-agent*" 2>/dev/null; git diff --cached -- . ":!/testbed/.teploy-agent"'`).catch(() => "");
    const cleanPatch = await ssh(`docker exec ${container} bash -lc 'cd /testbed && git diff HEAD -- . 2>/dev/null'`).catch(() => "");
    const finalPatch = (cleanPatch && cleanPatch.trim()) ? cleanPatch : patch;

    console.error(`  status=${result.status} steps=${result.steps.length} durationMs=${Date.now() - started} patchLen=${finalPatch.length}`);
    predictions.push({ instance_id: inst.instance_id, model_name_or_path: `teploy-agent+${MODEL}`, model_patch: finalPatch });
  } finally {
    await ssh(`docker rm -f ${container} 2>/dev/null`).catch(() => {});
  }
}

await writeFile(outPath, JSON.stringify(predictions, null, 2));
console.error(`\nwrote ${predictions.length} predictions to ${outPath}`);
