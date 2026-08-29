import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployPreview, destroyPreview, previewComment, previewTargetFromEnv, resolvePreviewTarget, rollbackDeploy, type CommandResult, type CommandRunner, type PreviewOutcome } from "./deploy.js";

/** A runner that plays scripted results and records every argv it saw. */
function scriptedRunner(results: Record<string, CommandResult>): {
  run: CommandRunner;
  calls: string[][];
  cwds: string[];
} {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const run: CommandRunner = async (argv, opts) => {
    calls.push(argv);
    cwds.push(opts.cwd);
    if (argv[0] === "git") return { code: 0, stdout: "", stderr: "" };
    // Key on the command words only: the verb, plus its subcommand when the
    // next token is not a flag. ["teploy","build","--json","-d","staging"]
    // -> "build"; ["teploy","preview","deploy",...] -> "preview deploy".
    const key = [argv[1], argv[2]?.startsWith("-") === false ? argv[2] : undefined]
      .filter((a): a is string => a !== undefined)
      .join(" ");
    return results[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, cwds };
}

const OK_BUILD: CommandResult = { code: 0, stdout: `{"image":"api-build-abc1234","version":"abc1234","built":true}\n`, stderr: "" };
const OK_DEPLOY: CommandResult = {
  code: 0,
  stdout: `Deploying preview for branch "fix/login"...\n  Domain: preview-fix-login.example.com\n  Preview deployed: https://preview-fix-login.example.com\n`,
  stderr: "",
};
const OK_LIST: CommandResult = {
  code: 0,
  stdout: JSON.stringify([
    { branch: "other", domain: "preview-other.example.com" },
    { branch: "fix/login", domain: "preview-fix-login.example.com", expires_at: "2026-08-20T12:00:00Z" },
  ]),
  stderr: "",
};

test("a preview is built, deployed and reported — and the tag is passed, never re-derived", async () => {
  const { run, calls, cwds } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
  const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");
  assert.equal(outcome?.kind, "deployed");
  const { deployedAt, ...rest } = outcome as Extract<PreviewOutcome, { kind: "deployed" }>;
  assert.ok(typeof deployedAt === "string" && !Number.isNaN(Date.parse(deployedAt)), "the outcome stamps when the deploy returned, for the observe window to anchor on");
  assert.deepEqual({ ...rest, kind: "deployed" }, {
    kind: "deployed",
    url: "https://preview-fix-login.example.com",
    image: "api-build-abc1234",
    expiresAt: "2026-08-20T12:00:00Z",
  });

  // The branch is fetched and checked out BEFORE anything is built. Without
  // this the image is of whatever commit the operator's directory sits on, and
  // the PR carries a URL serving code the reviewer never wrote.
  assert.deepEqual(calls[0], ["git", "-C", "/srv/app", "fetch", "origin", "fix/login"]);
  assert.ok(
    calls.some((c) => c[3] === "worktree" && c[4] === "add" && c.includes("FETCH_HEAD")),
    `the fetched branch must be checked out: ${JSON.stringify(calls)}`,
  );

  const buildIdx = calls.findIndex((c) => c[0] === "teploy" && c[1] === "build");
  assert.ok(buildIdx !== -1, "nothing was built");
  assert.deepEqual(calls[buildIdx], ["teploy", "build", "--json"]);
  // ...and it ran in the WORKTREE, not the operator's checkout.
  assert.notEqual(cwds[buildIdx], "/srv/app", "building in the operator's directory builds the wrong commit");
  assert.match(cwds[buildIdx]!, /\.teploy-ship-preview$/);

  // The worktree is removed afterwards, or the next run cannot create one.
  assert.ok(
    calls.filter((c) => c[3] === "worktree" && c[4] === "remove").length >= 1,
    "the worktree must be cleaned up inside the operator's clone",
  );
  // The tag from step 1 reaches step 2. Without --image the two agree only by
  // both re-deriving <app>-build-<git hash>, which breaks across checkouts.
  assert.deepEqual(calls.find((c) => c[1] === "preview" && c[2] === "deploy"), [
    "teploy",
    "preview",
    "deploy",
    "fix/login",
    "--ttl",
    "24h",
    "--image",
    "api-build-abc1234",
  ]);
  // The URL comes from the CLI, not from a TypeScript copy of Go's
  // SanitizeBranch — that copy would drift and report URLs that do not exist.
  assert.deepEqual(calls.find((c) => c[1] === "preview" && c[2] === "list"), ["teploy", "preview", "list", "--json"]);
});

test("`teploy deploy` is never invoked — a preview must not reach production", async () => {
  const { run, calls } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
  await deployPreview({ dir: "/srv/app", run }, "fix/login");
  for (const argv of calls) {
    assert.notEqual(argv[1], "deploy", `deploy would replace the running app: ${argv.join(" ")}`);
  }
});

test("a failed build stops there — nothing is deployed off a broken image", async () => {
  const { run, calls } = scriptedRunner({
    build: { code: 1, stdout: "", stderr: "Step 7/9 : RUN npm ci\nnpm ERR! missing script\n" },
  });
  const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");

  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /teploy build failed \(exit 1\)/);
  assert.match((outcome as { reason: string }).reason, /npm ERR/, "the reviewer needs the actual build error");
  assert.ok(!calls.some((c) => c[1] === "preview" && c[2] === "deploy"), "a preview deploy after a failed build would run stale code");
});

test("a build that prints no tag is a failure, not a guess", async () => {
  const { run, calls } = scriptedRunner({ build: { code: 0, stdout: "Built image: ???\n", stderr: "" } });
  const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /no image tag/);
  assert.ok(!calls.some((c) => c[1] === "preview"), "guessing a tag deploys the wrong code");
});

test("a preview that deployed but cannot be listed still reports its URL", async () => {
  const { run } = scriptedRunner({
    build: OK_BUILD,
    "preview deploy": OK_DEPLOY,
    "preview list": { code: 1, stdout: "", stderr: "connection refused" },
  });
  const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");
  assert.equal(outcome.kind, "deployed");
  assert.equal((outcome as { url: string }).url, "https://preview-fix-login.example.com");
});

test("a branch that could carry a flag or a second command is refused before any CLI call", async () => {
  for (const branch of ["--image=evil", "fix/login; rm -rf /", "../../etc/passwd", ""]) {
    const { run, calls } = scriptedRunner({ build: OK_BUILD });
    const outcome = await deployPreview({ dir: "/srv/app", run }, branch);
    assert.equal(outcome.kind, "skipped", `branch ${JSON.stringify(branch)} must not reach the CLI`);
    assert.equal(calls.length, 0);
  }
});

test("the destination overlay reaches every command, or the preview lands on the wrong server", async () => {
  const { run, calls } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
  await deployPreview({ dir: "/srv/app", destination: "staging", ttl: "6h", bin: "/usr/local/bin/teploy", run }, "fix/login");
  const teployCalls = calls.filter((c) => c[0] !== "git");
  assert.ok(teployCalls.length >= 3, "build, preview deploy and preview list all run");
  for (const argv of teployCalls) {
    assert.equal(argv[0], "/usr/local/bin/teploy");
    assert.ok(argv.includes("-d") && argv.includes("staging"), `missing overlay: ${argv.join(" ")}`);
  }
  assert.ok(teployCalls.find((c) => c[1] === "preview" && c[2] === "deploy")!.includes("6h"));
});

test("destroy is scoped to the one branch and never falls back to a wider teardown", async () => {
  const { run, calls } = scriptedRunner({ "preview destroy": { code: 0, stdout: "Destroyed", stderr: "" } });
  const outcome = await destroyPreview({ dir: "/srv/app", run }, "fix/login");
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(calls, [["teploy", "preview", "destroy", "fix/login"]]);
  assert.ok(!calls.some((c) => c.includes("prune")), "prune would remove other branches' previews");
});

test("the PR comment tells a reviewer the truth in all three cases", () => {
  const deployed = previewComment(
    { kind: "deployed", url: "https://preview-fix-login.example.com", image: "api-build-abc1234", expiresAt: "2026-08-20T12:00:00Z" },
    "run-1",
  );
  assert.match(deployed, /https:\/\/preview-fix-login\.example\.com/);
  assert.match(deployed, /api-build-abc1234/, "which image is running is half the value of a preview");

  // A silent failure teaches a reviewer that a missing URL just means "slow".
  const failed = previewComment({ kind: "failed", reason: "teploy build failed (exit 1): npm ERR!" }, "run-1");
  assert.match(failed, /FAILED/);
  assert.match(failed, /npm ERR!/);
  assert.match(failed, /change itself is unaffected/, "a failed preview must not read as a failed fix");

  assert.match(previewComment({ kind: "skipped", reason: "no preview target" }, "run-1"), /skipped/i);
});

test("a worker is preview-capable only when it has a directory to run the CLI in", () => {
  assert.equal(previewTargetFromEnv({}), undefined, "no directory means the feature is off, not half-configured");
  assert.equal(previewTargetFromEnv({ SHIP_PREVIEW_BIN: "/usr/local/bin/teploy" }), undefined, "a binary alone cannot deploy anything");

  assert.deepEqual(previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app" }), { dir: "/srv/app" });
  assert.deepEqual(
    previewTargetFromEnv({
      SHIP_PREVIEW_DIR: "/srv/app",
      SHIP_PREVIEW_BIN: "/usr/local/bin/teploy",
      SHIP_PREVIEW_TTL: "6h",
      SHIP_PREVIEW_DESTINATION: "staging",
      SHIP_PREVIEW_TIMEOUT_MS: "60000",
    }),
    { dir: "/srv/app", bin: "/usr/local/bin/teploy", ttl: "6h", destination: "staging", timeoutMs: 60000 },
  );
  // A junk timeout falls back to the default rather than becoming NaN, which
  // execFile would treat as no timeout at all — a hung build would pin a worker.
  assert.deepEqual(previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TIMEOUT_MS: "soon" }), { dir: "/srv/app" });
});

test("a preview directory that is not a clone of the repo fails with a usable reason", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv[3] === "fetch") {
      return { code: 128, stdout: "", stderr: "fatal: not a git repository\n" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");

  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /must be a clone of the repository being fixed/);
  assert.ok(!calls.some((c) => c[0] === "teploy"), "nothing may be built from an unknown commit");
});

// --- P1-4 / L4: rolling a bad deploy back ----------------------------------

test("P1-4: rollback is `teploy rollback` in the worker's working copy, with the destination overlay", async () => {
  // No `--app`: that variant reads state off a server and needs `--host`
  // (teploy-cli internal/cli/rollback.go:40), which Ship has no wiring for.
  // The working copy's own teploy.yml names the app, exactly as for a preview.
  const { run, calls, cwds } = scriptedRunner({ rollback: { code: 0, stdout: "Rolled back to abc1234\n", stderr: "" } });
  const outcome = await rollbackDeploy({ dir: "/srv/app", destination: "staging", run });
  assert.deepEqual(outcome, { kind: "rolled-back", output: "Rolled back to abc1234" });
  assert.deepEqual(calls, [["teploy", "rollback", "-d", "staging"]]);
  assert.deepEqual(cwds, ["/srv/app"]);
});

test("P1-4: a failed rollback is reported, not thrown — the run still ends with its pull request", async () => {
  const { run } = scriptedRunner({ rollback: { code: 1, stdout: "", stderr: "no previous version to roll back to\n" } });
  const outcome = await rollbackDeploy({ dir: "/srv/app", run });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.reason : "", /exit 1.*no previous version/s);
});

// --- C4: the per-app preview target ------------------------------------------

test("C4: a declared preview app resolves to its own clone under the preview root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-preview-root-"));
  const app = join(root, "site");
  await mkdir(app, { recursive: true });
  const base = { dir: root, bin: "/usr/local/bin/teploy", ttl: "24h" };
  assert.deepEqual(resolvePreviewTarget(base, "site"), { ...base, dir: app });
  // No app named, or the subdirectory does not exist: the directory itself,
  // exactly as a single-app worker always worked.
  assert.deepEqual(resolvePreviewTarget(base, undefined), base);
  assert.deepEqual(resolvePreviewTarget(base, "not-there"), base);
  // The app name is only ever a path segment: a traversal or a flag carrier
  // is refused before it can become one.
  for (const bad of ["../evil", "..", ".", "-x", "a/b", ""]) {
    assert.deepEqual(resolvePreviewTarget(base, bad), base, `app ${JSON.stringify(bad)} must not become a path`);
  }
});
