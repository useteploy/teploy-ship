import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRunner, deployPreview, destroyPreview, previewComment, previewTargetFromEnv, resolvePreviewTarget, rollbackDeploy, sweepStalePreviewCheckouts, type CommandResult, type CommandRunner, type PreviewOutcome } from "./deploy.js";

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
    branch: "fix/login",
    expiresAt: "2026-08-20T12:00:00Z",
  });

  // The branch is fetched and checked out BEFORE anything is built. Without
  // this the image is of whatever commit the operator's directory sits on, and
  // the PR carries a URL serving code the reviewer never wrote.
  assert.deepEqual(calls[0]!.slice(0,6), ["git", "-C", "/srv/app", "fetch", "--no-write-fetch-head", "origin"]);
  assert.match(calls[0]![6]!, /^refs\/heads\/fix\/login:refs\/ship-previews\//);
  assert.ok(
    calls.some((c) => c[3] === "worktree" && c[4] === "add" && c.some(a => a.startsWith("refs/ship-previews/"))),
    `the fetched branch must be checked out: ${JSON.stringify(calls)}`,
  );

  const buildIdx = calls.findIndex((c) => c[0] === "teploy" && c[1] === "build");
  assert.ok(buildIdx !== -1, "nothing was built");
  assert.deepEqual(calls[buildIdx], ["teploy", "build", "--json"]);
  // ...and it ran in the WORKTREE, not the operator's checkout.
  assert.notEqual(cwds[buildIdx], "/srv/app", "building in the operator's directory builds the wrong commit");
  assert.match(cwds[buildIdx]!, /\.teploy-ship-preview-[a-f0-9-]+$/);

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
  const outcome = await rollbackDeploy({ dir: "/srv/app", destination: "staging", run }, "abc1234");
  assert.deepEqual(outcome, { kind: "rolled-back", output: "Rolled back to abc1234" });
  assert.deepEqual(calls, [["teploy", "rollback", "--to", "abc1234", "-d", "staging"]]);
  assert.deepEqual(cwds, ["/srv/app"]);
});

test("P1-4: a failed rollback is reported, not thrown — the run still ends with its pull request", async () => {
  const { run } = scriptedRunner({ rollback: { code: 1, stdout: "", stderr: "no previous version to roll back to\n" } });
  const outcome = await rollbackDeploy({ dir: "/srv/app", run }, "abc1234");
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


test("rollback cannot toggle a mutable previous release on retry", async () => {
  const {run,calls}=scriptedRunner({});
  for (const version of [undefined, "", "--to=other", "a;touch bad"]) {
    assert.equal((await rollbackDeploy({dir:"/srv/app",run},version)).kind,"skipped");
  }
  assert.equal(calls.length,0);
});

test("parallel previews build their own exact commits and leave the operator checkout intact", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ship-preview-race-"));
  const git=hostRunner();
  const exec=async (...args:string[])=> {
    const r=await git(["git",...args],{cwd:dir,timeoutMs:10000});
    assert.equal(r.code,0,r.stderr); return r.stdout.trim();
  };
  try {
    await exec("init"); await exec("config","user.email","test@example.invalid"); await exec("config","user.name","Test");
    await writeFile(join(dir,"file"),"one"); await exec("add","file"); await exec("commit","-m","one");
    const one=await exec("rev-parse","HEAD");
    await writeFile(join(dir,"file"),"two"); await exec("commit","-am","two");
    const two=await exec("rev-parse","HEAD"); await exec("remote","add","origin",dir);
    let entered=0; let release!:()=>void; const barrier=new Promise<void>(resolve=>release=resolve);
    const heads:string[]=[]; const paths=new Set<string>();
    const runner:CommandRunner=async (argv,opts)=> {
      if(argv[0]==="git") return git(argv,opts);
      if(argv[1]==="build") {
        paths.add(opts.cwd); entered++; if(entered===2)release(); await barrier;
        const head=await git(["git","rev-parse","HEAD"],opts); assert.equal(head.code,0); heads.push(head.stdout.trim());
        return {code:0,stdout:JSON.stringify({image:"app-"+head.stdout.trim()}),stderr:""};
      }
      if(argv[2]==="deploy")return {code:0,stdout:"Preview deployed: https://preview.example.invalid",stderr:""};
      return {code:0,stdout:"[]",stderr:""};
    };
    const results=await Promise.all([deployPreview({dir,run:runner},"same/branch",one),deployPreview({dir,run:runner},"same/branch",two)]);
    assert.ok(results.every(r=>r.kind==="deployed")); assert.equal(paths.size,2);
    assert.deepEqual(heads.sort(),[one,two].sort()); assert.equal(await exec("rev-parse","HEAD"),two);
    assert.equal(await exec("for-each-ref","--format=%(refname)","refs/ship-previews/"),"");
    assert.equal((await exec("worktree","list","--porcelain")).split("worktree ").length,2);
    assert.notEqual((results[0] as any).branch,(results[1] as any).branch);
    assert.equal((results[0] as any).revision,one);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

// --- A.6: crash-left preview checkout sweep -----------------------------------

test("A.6: the sweep removes only verifiably-ours, verifiably-dead preview leftovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-preview-sweep-"));
  const git = hostRunner();
  const exec = async (...args: string[]) => {
    const r = await git(["git", ...args], { cwd: dir, timeoutMs: 20_000 });
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    await exec("init"); await exec("config", "user.email", "t@t"); await exec("config", "user.name", "t");
    await writeFile(join(dir, "f"), "one"); await exec("add", "f"); await exec("commit", "-m", "one");

    const uuid = (): string => randomUUID();
    // A STALE crash-left worktree + its ref: old enough to reclaim.
    const oldId = uuid();
    const oldTree = join(dir, `.teploy-ship-preview-${oldId}`);
    await exec("worktree", "add", "--detach", oldTree, "HEAD");
    await exec("update-ref", `refs/ship-previews/${oldId}`, "HEAD");
    const old = new Date(Date.now() - 8 * 60 * 60 * 1000);
    await utimes(oldTree, old, old);

    // A FRESH attempt (young mtime): an in-flight build must never be reclaimed.
    const newId = uuid();
    const newTree = join(dir, `.teploy-ship-preview-${newId}`);
    await exec("worktree", "add", "--detach", newTree, "HEAD");
    await exec("update-ref", `refs/ship-previews/${newId}`, "HEAD");

    // An OPERATOR worktree: any name outside our exact UUID convention — old,
    // registered, whatever — is not ours and must survive.
    const opTree = join(dir, "operator-checkout");
    await exec("worktree", "add", "--detach", opTree, "HEAD");
    await utimes(opTree, old, old);

    // A dangling ref whose worktree is entirely gone: reclaimable.
    const goneId = uuid();
    await exec("update-ref", `refs/ship-previews/${goneId}`, "HEAD");

    // A dangling ref with an unregistered directory still on disk: an operator
    // may be inspecting it; the ref stays.
    const heldId = uuid();
    await exec("update-ref", `refs/ship-previews/${heldId}`, "HEAD");
    await mkdir(join(dir, `.teploy-ship-preview-${heldId}`));

    const sweep = await sweepStalePreviewCheckouts({ dir }, { olderThanMs: 6 * 60 * 60 * 1000 });

    assert.deepEqual(
      sweep.removed.map((r) => `${r.kind}:${r.id}`).sort(),
      [`worktree:${oldId}`, `ref:${goneId}`].sort(),
      "exactly the stale worktree (with its ref) and the worktree-less ref",
    );
    const keptIds = sweep.kept.map((r) => r.id);
    assert.ok(keptIds.includes(newId), "the fresh attempt is kept");
    assert.ok(keptIds.includes(heldId), "a ref with a live directory on disk is kept");

    const refs = await exec("for-each-ref", "--format=%(refname)", "refs/ship-previews/");
    assert.ok(!refs.includes(oldId), "the stale attempt's ref went with its worktree");
    assert.ok(!refs.includes(goneId), "the dangling ref was reclaimed");
    assert.ok(refs.includes(newId) && refs.includes(heldId), "the kept refs remain");
    assert.equal(await exec("rev-parse", "--verify", "--quiet", `refs/ship-previews/${heldId}`) !== "", true);
    // The operator worktree still registered and on disk.
    assert.ok((await exec("worktree", "list", "--porcelain")).includes(opTree));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A.6: the sweep leaves a clone with no leftovers alone and reports nothing removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-preview-clean-"));
  const git = hostRunner();
  const exec = async (...args: string[]) => {
    const r = await git(["git", ...args], { cwd: dir, timeoutMs: 20_000 });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    await exec("init"); await exec("config", "user.email", "t@t"); await exec("config", "user.name", "t");
    await writeFile(join(dir, "f"), "one"); await exec("add", "f"); await exec("commit", "-m", "one");
    const sweep = await sweepStalePreviewCheckouts({ dir });
    assert.equal(sweep.removed.length, 0);
    assert.equal(sweep.kept.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Tailnet previews (DELEGATED_DECISIONS_2026-09-23 §10) -------------------

const TAILNET_DEPLOY: CommandResult = {
  code: 0,
  stdout: `  Preview deployed: http://preview-fix-login-1a2b3c4d.100.101.102.103.sslip.io\n`,
  stderr: "",
};
const TAILNET_LIST: CommandResult = {
  code: 0,
  stdout: JSON.stringify([
    {
      branch: "fix/login",
      domain: "preview-fix-login-1a2b3c4d.100.101.102.103.sslip.io",
      url: "http://preview-fix-login-1a2b3c4d.100.101.102.103.sslip.io",
      expires_at: "2026-09-25T12:00:00Z",
    },
  ]),
  stderr: "",
};

const EXPOSURE_VERSION: CommandResult = {
  code: 0,
  stdout: JSON.stringify({ capabilities: ["preview-blue-green", "preview-canonical-id", "preview-exposure"], machine_interface: 2, version: "v0.2.0" }),
  stderr: "",
};

test("tailnet mode: one IP implies sslip.io base, plain HTTP and the tailnet allowlist — all three or none", () => {
  const target = previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: " 100.101.102.103 " });
  assert.deepEqual(target, {
    dir: "/srv/app",
    baseDomain: "100.101.102.103.sslip.io",
    httpOnly: true,
    allowIps: ["100.64.0.0/10"],
  });
  // Unset: the target is byte-identical to before tailnet mode existed.
  assert.deepEqual(previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: "" }), { dir: "/srv/app" });
});

test("tailnet mode: an address outside 100.64.0.0/10 refuses the preview instead of falling back to a public route", async () => {
  for (const bad of ["192.168.1.5", "100.128.0.1", "100.63.255.255", "100.101.102.300", "tailnet", "100.101.102"]) {
    const target = previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: bad });
    assert.ok(target !== undefined, "a bad setting is not the feature switched off");
    assert.equal(target.baseDomain, undefined);
    assert.match(target.invalid ?? "", /not a tailnet IPv4 address/, `${bad} must be refused`);
    const { run, calls } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
    const outcome = await deployPreview({ ...target, run }, "fix/login");
    assert.equal(outcome.kind, "failed");
    assert.match((outcome as { reason: string }).reason, /SHIP_PREVIEW_TAILNET_IP/);
    assert.equal(calls.length, 0, "nothing is fetched, built or deployed under a refused route");
  }
  for (const edge of ["100.64.0.0", "100.127.255.255"]) {
    assert.equal(previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: edge })?.invalid, undefined, `${edge} is inside the range`);
  }
});

test("tailnet mode: the route flags reach `teploy preview deploy` and the list row's own http URL is reported", async () => {
  const target = previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: "100.101.102.103", SHIP_PREVIEW_DESTINATION: "staging" })!;
  const { run, calls } = scriptedRunner({ version: EXPOSURE_VERSION, build: OK_BUILD, "preview deploy": TAILNET_DEPLOY, "preview list": TAILNET_LIST });
  const outcome = await deployPreview({ ...target, run }, "fix/login");
  const teploy = calls.filter((c) => c[0] === "teploy").map((c) => c.slice(1, 3).join(" "));
  assert.deepEqual(teploy.slice(0, 2), ["version --json", "build --json"], "the capability is checked before the slow build");
  assert.deepEqual(calls.find((c) => c[1] === "preview" && c[2] === "deploy"), [
    "teploy", "preview", "deploy", "fix/login",
    "--ttl", "24h",
    "--image", "api-build-abc1234",
    "--base-domain", "100.101.102.103.sslip.io",
    "--http-only",
    "--allow-ip", "100.64.0.0/10",
    "-d", "staging",
  ]);
  assert.equal(outcome.kind, "deployed");
  const deployed = outcome as Extract<PreviewOutcome, { kind: "deployed" }>;
  assert.equal(deployed.url, "http://preview-fix-login-1a2b3c4d.100.101.102.103.sslip.io", "the scheme comes from the CLI, not assumed https");
  assert.equal(deployed.previewBase, "100.101.102.103.sslip.io", "recorded so the visual rung does not derive main from it");
  assert.equal(deployed.expiresAt, "2026-09-25T12:00:00Z");
});

test("list rows: `url` wins when it is http(s); otherwise https://domain, so older CLIs keep working", async () => {
  const rows = (row: Record<string, string>): CommandResult => ({ code: 0, stdout: JSON.stringify([{ branch: "fix/login", ...row }]), stderr: "" });
  const cases: Array<[Record<string, string>, string]> = [
    [{ domain: "preview-fix-login.example.com" }, "https://preview-fix-login.example.com"],
    [{ domain: "preview-fix-login.example.com", url: "http://preview-fix-login.example.com" }, "http://preview-fix-login.example.com"],
    [{ domain: "preview-fix-login.example.com", url: "javascript:alert(1)" }, "https://preview-fix-login.example.com"],
    [{ domain: "preview-fix-login.example.com", url: "" }, "https://preview-fix-login.example.com"],
    [{ url: "http://preview-fix-login.example.com" }, "http://preview-fix-login.example.com"],
  ];
  for (const [row, want] of cases) {
    const { run } = scriptedRunner({ build: OK_BUILD, "preview deploy": { code: 0, stdout: "", stderr: "" }, "preview list": rows(row) });
    const outcome = await deployPreview({ dir: "/srv/app", run }, "fix/login");
    assert.equal((outcome as { url?: string }).url, want, JSON.stringify(row));
    assert.equal((outcome as { previewBase?: string }).previewBase, undefined, "default mode records no base override");
  }
});

test("SHIP_PREVIEW_MAIN_URL: one URL, or app=url entries resolved per app; a bad entry refuses rather than guesses", async () => {
  assert.deepEqual(previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_MAIN_URL: "https://site.example.com" }), {
    dir: "/srv/app",
    mainUrl: "https://site.example.com/",
  });
  const root = await mkdtemp(join(tmpdir(), "ship-preview-main-"));
  await mkdir(join(root, "site"), { recursive: true });
  const target = previewTargetFromEnv({ SHIP_PREVIEW_DIR: root, SHIP_PREVIEW_MAIN_URL: "site=https://site.example.com, docs=https://docs.example.com/, https://fallback.example.com" })!;
  assert.equal(resolvePreviewTarget(target, "site").mainUrl, "https://site.example.com/");
  assert.equal(resolvePreviewTarget(target, "docs").mainUrl, "https://docs.example.com/", "keyed by app name even without a per-app clone");
  assert.equal(resolvePreviewTarget(target, "other").mainUrl, "https://fallback.example.com/");
  const bad = previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_MAIN_URL: "site=ftp://x" })!;
  assert.match(bad.invalid ?? "", /SHIP_PREVIEW_MAIN_URL/);

  const { run } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
  const outcome = await deployPreview({ ...resolvePreviewTarget(target, "site"), run }, "fix/login");
  assert.equal((outcome as { mainUrl?: string }).mainUrl, "https://site.example.com/", "recorded with the outcome for the visual rung");
});

test("tailnet mode: a CLI that does not advertise preview-exposure is refused before anything is built", async () => {
  const target = previewTargetFromEnv({ SHIP_PREVIEW_DIR: "/srv/app", SHIP_PREVIEW_TAILNET_IP: "100.101.102.103" })!;
  const older: CommandResult[] = [
    { code: 0, stdout: JSON.stringify({ capabilities: ["preview-blue-green", "preview-canonical-id"], machine_interface: 2 }), stderr: "" },
    { code: 1, stdout: "", stderr: "Error: unknown flag: --json" },
    { code: 0, stdout: "teploy v0.1.27\n", stderr: "" },
  ];
  for (const version of older) {
    const { run, calls } = scriptedRunner({ version, build: OK_BUILD, "preview deploy": TAILNET_DEPLOY, "preview list": TAILNET_LIST });
    const outcome = await deployPreview({ ...target, run }, "fix/login");
    assert.equal(outcome.kind, "failed");
    assert.match((outcome as { reason: string }).reason, /does not advertise the preview-exposure capability/);
    assert.ok(!calls.some((c) => c[1] === "build" || c[1] === "preview"), `nothing built or deployed: ${JSON.stringify(calls)}`);
  }
});

test("default mode never asks the CLI for its version: the argv sequence is unchanged", async () => {
  const { run, calls } = scriptedRunner({ build: OK_BUILD, "preview deploy": OK_DEPLOY, "preview list": OK_LIST });
  await deployPreview({ dir: "/srv/app", run }, "fix/login");
  assert.deepEqual(calls.filter((c) => c[0] === "teploy").map((c) => c[1]), ["build", "preview", "preview"]);
});

test("previewEgressAllow: the tailnet suffix for a declared preview, main's host only for the visual rung, nothing without a valid tailnet IP", async () => {
  const { previewEgressAllow, withPreviewEgress } = await import("./deploy.js");
  const env = { SHIP_PREVIEW_TAILNET_IP: "100.107.192.39", SHIP_PREVIEW_MAIN_URL: "ship-preview-proof=http://100.107.192.39/,http://main.example.com:8080/" };
  assert.deepEqual(previewEgressAllow({ preview: { app: "ship-preview-proof" } }, env), [".100.107.192.39.sslip.io"]);
  assert.deepEqual(previewEgressAllow({ preview: { app: "ship-preview-proof" }, visual: true }, env), [".100.107.192.39.sslip.io", "100.107.192.39"]);
  assert.deepEqual(previewEgressAllow({ preview: { app: "unnamed" }, visual: true }, env), [".100.107.192.39.sslip.io", "main.example.com:8080"], "the default main URL, with its port");
  assert.deepEqual(previewEgressAllow({ visual: true }, env), [], "no declared preview, nothing derived");
  assert.deepEqual(previewEgressAllow({ preview: {} }, { SHIP_PREVIEW_TAILNET_IP: "192.168.1.5" }), [], "not a tailnet address");
  assert.deepEqual(previewEgressAllow({ preview: {} }, {}), []);
  // Every derived entry is one the daemon's grammar accepts.
  const { egressEntryError } = await import("./egress.js");
  for (const e of previewEgressAllow({ preview: { app: "unnamed" }, visual: true }, env)) assert.equal(egressEntryError(e), null, e);
  // Explicit entries survive; a full explicit list is never refused for the derived ones.
  assert.deepEqual(withPreviewEgress(["a.example"], { preview: {} }, env), ["a.example", ".100.107.192.39.sslip.io"]);
  const full = Array.from({ length: 64 }, (_v, i) => `h${i}.example`);
  assert.deepEqual(withPreviewEgress(full, { preview: {} }, env), full);
  assert.equal(withPreviewEgress(undefined, undefined, env), undefined);
});
