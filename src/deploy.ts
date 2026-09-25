/**
 * Put a machine-authored fix on a URL a human can open.
 *
 * Ship uses its deployer (`teploy`), so a run can
 * end at "here is the change, and here it is running" instead.
 *
 * WHERE THIS RUNS, AND WHY IT MATTERS. The `teploy` CLI holds the credentials
 * that reach the target server. Those must never be inside the agent's
 * sandbox — the agent executes model-authored commands on repo content that
 * may itself be attacker-controlled, which is exactly the threat the
 * default-deny egress policy and the approval gate exist for. So every command
 * here runs on the WORKER host, in an operator-configured directory, and the
 * only thing the run contributes is a branch name Ship generated itself.
 *
 * Nothing here uses a shell. Commands are argv arrays through `execFile`, and
 * the branch is checked with the same `assertGitSafe` that guards git refs, so
 * a branch cannot smuggle a flag or a second command.
 *
 * A preview is ADVISORY. It happens after the pull request exists, and a
 * failure is recorded and reported — never allowed to fail the run. A fix that
 * is correct but could not be previewed is still a fix.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertGitSafe } from "./git.js";
import { MAX_EGRESS_ALLOW_ENTRIES, normalizeEgressAllow } from "./egress.js";

/** A preview attempt's leftovers: the UUID that named its ref and worktree. */
export interface PreviewLeftover {
  id: string;
  kind: "worktree" | "ref";
  /** Worktree path (kind=worktree) or ref name (kind=ref). */
  at: string;
}

/** What a sweep of crash-left preview checkouts did. */
export interface PreviewSweep {
  removed: PreviewLeftover[];
  /** Left in place — too young, or not verifiably ours. */
  kept: PreviewLeftover[];
}

const PREVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREVIEW_TREE = /\.teploy-ship-preview-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PREVIEW_REF = /^refs\/ship-previews\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Reclaim preview leftovers a crash left behind (A.6).
 *
 * deployPreview cleans its worktree and ref in a `finally`, but a SIGKILL, a
 * power cut or a host restart skips it, and those UUID-named worktrees and
 * refs then sit in the operator's clone forever. This sweep removes ONLY what
 * is verifiably ours and verifiably dead:
 *
 *   - a path registered as a git worktree of THIS clone whose basename is
 *     exactly `.teploy-ship-preview-<uuid>`, older than `olderThanMs`;
 *   - a ref under `refs/ship-previews/<uuid>` whose matching worktree no
 *     longer exists at all (nothing on disk can still be building from it).
 *
 * Everything else — any other worktree, any younger path, any directory that
 * is not a registered worktree, any other ref — is `kept` and never touched.
 * The default threshold (6h) is far past the longest legal attempt (the
 * per-command ceiling is minutes), so an in-flight preview cannot be reclaimed
 * out from under its run.
 */
export async function sweepStalePreviewCheckouts(
  target: Pick<PreviewTarget, "dir" | "timeoutMs">,
  options: { olderThanMs?: number; now?: () => number } = {},
): Promise<PreviewSweep> {
  const run = hostRunner();
  const cwd = target.dir;
  const olderThanMs = options.olderThanMs ?? 6 * 60 * 60 * 1000;
  const nowMs = options.now?.() ?? Date.now();
  const removed: PreviewLeftover[] = [];
  const kept: PreviewLeftover[] = [];

  const listed = await run(["git", "-C", cwd, "worktree", "list", "--porcelain"], { cwd, timeoutMs: 60_000 });
  if (listed.code !== 0) return { removed, kept };
  const trees = new Map<string, string>();
  for (const block of listed.stdout.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    if (line === undefined) continue;
    const at = line.slice("worktree ".length).trim();
    const id = at.match(PREVIEW_TREE)?.[1];
    if (id !== undefined) trees.set(id, at);
  }

  const refs = await run(["git", "-C", cwd, "for-each-ref", "--format=%(refname)", "refs/ship-previews/"], { cwd, timeoutMs: 60_000 });
  const refIds = new Set<string>();
  if (refs.code === 0) {
    for (const line of refs.stdout.split("\n")) {
      const id = line.trim().match(PREVIEW_REF)?.[1];
      if (id !== undefined) refIds.add(id);
    }
  }

  for (const [id, at] of trees) {
    let ageMs = -1;
    try {
      ageMs = nowMs - statSync(at).mtimeMs;
    } catch {
      ageMs = Infinity; // registered but the path is gone: prune-able metadata
    }
    const ref = `refs/ship-previews/${id}`;
    if (ageMs >= olderThanMs) {
      const gone = await run(["git", "-C", cwd, "worktree", "remove", "--force", at], { cwd, timeoutMs: 60_000 });
      if (gone.code === 0) {
        removed.push({ id, kind: "worktree", at });
        // The ref went with the attempt; reclaim it in the same sweep.
        if (refIds.delete(id)) await run(["git", "-C", cwd, "update-ref", "-d", ref], { cwd, timeoutMs: 60_000 }).catch(() => undefined);
      } else {
        kept.push({ id, kind: "worktree", at });
        refIds.delete(id); // an unremovable worktree keeps its ref too
      }
    } else {
      kept.push({ id, kind: "worktree", at });
      refIds.delete(id); // a live attempt owns both
    }
  }

  // Refs whose worktree no longer exists anywhere: the only owner a preview
  // ref ever had was the attempt that created it, named by the same UUID.
  for (const id of refIds) {
    const ref = `refs/ship-previews/${id}`;
    // Belt and braces: if a directory with that UUID still sits in the preview
    // dir unregistered, leave it — an operator may be inspecting it.
    const tree = join(cwd, `.teploy-ship-preview-${id}`);
    if (existsSync(tree)) {
      kept.push({ id, kind: "ref", at: ref });
      continue;
    }
    const gone = await run(["git", "-C", cwd, "update-ref", "-d", ref], { cwd, timeoutMs: 60_000 });
    if (gone.code === 0) removed.push({ id, kind: "ref", at: ref });
    else kept.push({ id, kind: "ref", at: ref });
  }
  return { removed, kept };
}

/** One command's result. Non-zero exit is data here, not an exception. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one argv on the worker host. Injectable so tests need no `teploy`. */
export type CommandRunner = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

/** What a preview attempt produced. */
export type PreviewOutcome =
  | {
      kind: "deployed";
      url: string;
      image: string;
      expiresAt?: string;
      deployedAt?: string;
      revision?: string;
      branch?: string;
      /**
       * The base domain the preview was deployed under when the worker
       * overrode it (tailnet mode). Recorded so the visual rung knows the
       * preview host no longer shares a parent domain with main.
       */
      previewBase?: string;
      /** Main's URL from explicit config (SHIP_PREVIEW_MAIN_URL), when set. */
      mainUrl?: string;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** Where and how this worker may deploy previews. Absent = feature off. */
export interface PreviewTarget {
  /**
   * Working copy containing the app's `teploy.yml`, on the worker host. The
   * operator points this at a checkout they control; Ship never creates it,
   * and never writes to it.
   */
  dir: string;
  /** The `teploy` binary. */
  bin?: string;
  /** Lifetime before the CLI's own pruner reclaims it. */
  ttl?: string;
  /** Destination overlay (`-d staging`). */
  destination?: string;
  /** Per-command ceiling. A server-side image build is the slow step. */
  timeoutMs?: number;
  /**
   * Route options for `teploy preview deploy`. Absent = the CLI's defaults
   * (the app's own domain, automatic HTTPS, no gate), argv unchanged.
   * previewTargetFromEnv sets all three together from SHIP_PREVIEW_TAILNET_IP.
   */
  baseDomain?: string;
  httpOnly?: boolean;
  allowIps?: string[];
  /** Main's URL for the visual rung, when explicitly configured. */
  mainUrl?: string;
  /** Per-app overrides of `mainUrl`, applied by resolvePreviewTarget. */
  mainUrlByApp?: Record<string, string>;
  /**
   * Why this target's preview configuration is unusable. Set instead of
   * falling back: a tailnet setting that failed to parse must not silently
   * become a public HTTPS preview with no gate.
   */
  invalid?: string;
  /** Override the runner (tests). */
  run?: CommandRunner;
}

/** The default runner: argv through execFile, never a shell. */
export function hostRunner(): CommandRunner {
  return (argv, opts) =>
    new Promise<CommandResult>((resolve) => {
      const [bin, ...args] = argv;
      execFile(
        bin!,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** Last few lines of output, for a failure a human has to read in a PR. */
function tail(text: string, lines = 6): string {
  const kept = text.trimEnd().split("\n").slice(-lines).join("\n").trim();
  return kept.length > 800 ? `${kept.slice(0, 800)}…` : kept;
}

interface PreviewRow {
  branch?: string;
  domain?: string;
  /** The URL with its real scheme (newer CLIs). Absent on older ones. */
  url?: string;
  expires_at?: string;
}

/** The row's URL: its own `url` when it carries an http(s) one, else https://domain (CLIs before `url`). */
function rowUrl(row: PreviewRow): string | undefined {
  if (typeof row.url === "string" && row.url !== "") {
    try {
      const u = new URL(row.url);
      if (u.protocol === "http:" || u.protocol === "https:") return row.url;
    } catch {
      // Fall through to the domain.
    }
  }
  return typeof row.domain === "string" && row.domain !== "" ? `https://${row.domain}` : undefined;
}

/**
 * Deploy a preview of `branch`, and return the URL a reviewer can open.
 *
 * FIRST, the branch is checked out. `teploy build` builds whatever is in its
 * working directory, and `teploy preview deploy` only uses the branch name to
 * pick a subdomain — so building in the operator's directory would deploy
 * WHATEVER COMMIT THAT DIRECTORY HAPPENS TO BE ON and label it as the fix. The
 * pull request would carry a URL serving code the reviewer never wrote. Caught
 * 2026-08-19 by reading this function against the CLI's own help text, after
 * tests that asserted the argv and never the commit had passed.
 *
 * A detached `git worktree` off the operator's clone, not a checkout in it:
 * this must not move the branch a human has open, and it must clean up even
 * when the build fails.
 *
 * Then three CLI calls, in order, because each is the input to the next:
 *   1. `teploy build --json`     — an image of THIS branch, without touching
 *                                  production. `teploy deploy` would build one
 *                                  too, and also replace the running app.
 *   2. `teploy preview deploy`   — runs that exact image on a temporary
 *                                  subdomain, with `--image` so the tag is
 *                                  passed rather than re-derived.
 *   3. `teploy preview list --json` — asks the CLI what the URL is instead of
 *                                  re-deriving the subdomain here. The naming
 *                                  rule lives in Go (`SanitizeBranch`); a copy
 *                                  of it in TypeScript would drift and start
 *                                  reporting URLs that do not exist.
 */
export async function deployPreview(target: PreviewTarget, branch: string, revision?: string): Promise<PreviewOutcome> {
  const run = target.run ?? hostRunner();
  const bin = target.bin ?? "teploy";
  const timeoutMs = target.timeoutMs ?? 900_000;
  const cwd = target.dir;
  const dest = target.destination !== undefined ? ["-d", target.destination] : [];

  if (target.invalid !== undefined) return { kind: "failed", reason: target.invalid };
  try {
    assertGitSafe("branch", branch);
    if (revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error("Preview requires a full commit identity");
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }

  // Each attempt owns its ref and worktree. FETCH_HEAD and a fixed worktree
  // race across workers and can build or delete another run's checkout.
  const id = randomUUID();
  const ref = `refs/ship-previews/${id}`;
  const tree = `${cwd.replace(/\/+$/, "")}/.teploy-ship-preview-${id}`;
  let added = false;
  try {
    const fetched = await run(["git", "-C", cwd, "fetch", "--no-write-fetch-head", "origin", `${revision ?? `refs/heads/${branch}`}:${ref}`], { cwd, timeoutMs: 120_000 });
    if (fetched.code !== 0) return { kind: "failed", reason: `could not fetch ${revision ?? branch} into the preview checkout: ${tail(fetched.stderr || fetched.stdout)}. SHIP_PREVIEW_DIR must be a clone of the repository being fixed.` };
    const checkout = await run(["git", "-C", cwd, "worktree", "add", "--detach", tree, revision ?? ref], { cwd, timeoutMs: 120_000 });
    if (checkout.code !== 0) return { kind: "failed", reason: `could not create a preview worktree: ${tail(checkout.stderr || checkout.stdout)}` };
    added = true;
    // Different revisions never share a preview slot: recovering an earlier
    // run must not tear down a later revision's preview.
    const previewBranch = revision ? `ship-${createHash("sha256").update(branch + "\0" + revision).digest("hex").slice(0,40)}` : branch;
    const outcome = await buildAndDeploy({ run, bin, dest, timeoutMs, tree, branch: previewBranch, target });
    return outcome.kind === "deployed" ? { ...outcome, branch: previewBranch, ...(revision ? { revision } : {}) } : outcome;
  } finally {
    if (added) await run(["git", "-C", cwd, "worktree", "remove", "--force", tree], { cwd, timeoutMs: 60_000 });
    await run(["git", "-C", cwd, "update-ref", "-d", ref], { cwd, timeoutMs: 60_000 });
  }
}

/** The three CLI calls, once the branch is checked out at `tree`. */
async function buildAndDeploy(opts: {
  run: CommandRunner;
  bin: string;
  dest: string[];
  timeoutMs: number;
  tree: string;
  branch: string;
  target: PreviewTarget;
}): Promise<PreviewOutcome> {
  const { run, bin, dest, timeoutMs, branch, target } = opts;
  // Every teploy call runs in the WORKTREE, not the operator's directory:
  // build takes its source and its version from here, and preview deploy reads
  // the same teploy.yml.
  const cwd = opts.tree;

  // Route options only when configured: the default argv is exactly what it
  // was before tailnet mode existed, so a CLI without these flags keeps working.
  const route = [
    ...(target.baseDomain !== undefined ? ["--base-domain", target.baseDomain] : []),
    ...(target.httpOnly === true ? ["--http-only"] : []),
    ...(target.allowIps ?? []).flatMap((cidr) => ["--allow-ip", cidr]),
  ];
  // A CLI that predates the route flags must be refused BEFORE the slow build,
  // by what it advertises rather than by an "unknown flag" after the fact.
  if (route.length > 0) {
    const refusal = await exposureRefusal(run, bin, cwd);
    if (refusal !== undefined) return { kind: "failed", reason: refusal };
  }

  const built = await run([bin, "build", "--json", ...dest], { cwd, timeoutMs });
  if (built.code !== 0) {
    return { kind: "failed", reason: `teploy build failed (exit ${built.code}): ${tail(built.stderr || built.stdout)}` };
  }
  let image = "";
  try {
    const parsed = JSON.parse(built.stdout.trim()) as { image?: unknown };
    if (typeof parsed.image === "string") image = parsed.image;
  } catch {
    // Fall through: an unparseable payload is reported as such rather than
    // guessed at, because the wrong tag deploys the wrong code.
  }
  if (image === "") {
    return { kind: "failed", reason: `teploy build printed no image tag: ${tail(built.stdout)}` };
  }

  const deployed = await run(
    [bin, "preview", "deploy", branch, "--ttl", target.ttl ?? "24h", "--image", image, ...route, ...dest],
    { cwd, timeoutMs },
  );
  // Stamped once the CLI returned: the observe window (ladder-steps.ts) is
  // anchored here, not at the run's start.
  const deployedAt = new Date().toISOString();
  if (deployed.code !== 0) {
    return { kind: "failed", reason: `teploy preview deploy failed (exit ${deployed.code}): ${tail(deployed.stderr || deployed.stdout)}` };
  }

  // What the visual rung needs to know about main, recorded with the outcome
  // so a replay reads the same answer (ladder-steps.ts resolveMainUrl).
  const about = {
    ...(target.baseDomain !== undefined ? { previewBase: target.baseDomain } : {}),
    ...(target.mainUrl !== undefined ? { mainUrl: target.mainUrl } : {}),
  };
  const listed = await run([bin, "preview", "list", "--json", ...dest], { cwd, timeoutMs: 60_000 });
  if (listed.code === 0) {
    try {
      const rows = JSON.parse(listed.stdout.trim()) as PreviewRow[];
      const row = Array.isArray(rows) ? rows.find((r) => r.branch === branch) : undefined;
      const url = row !== undefined ? rowUrl(row) : undefined;
      if (row !== undefined && url !== undefined) {
        return {
          kind: "deployed",
          url,
          image,
          ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}),
          deployedAt,
          ...about,
        };
      }
    } catch {
      // Fall through to the printed URL.
    }
  }

  // Fallback: the deploy command prints the URL it just created. Used when
  // `preview list` is unavailable or does not carry this branch — the preview
  // itself succeeded, so reporting no URL would be worse than reporting this.
  const printed = /Preview deployed:\s*(https?:\/\/\S+)/.exec(deployed.stdout);
  if (printed !== null) return { kind: "deployed", url: printed[1]!, image, deployedAt, ...about };
  return { kind: "failed", reason: `preview deployed but no URL could be established: ${tail(deployed.stdout)}` };
}

/** The `teploy version --json` capability token for the preview route flags. */
export const PREVIEW_EXPOSURE_CAPABILITY = "preview-exposure";

/** Why this CLI cannot take the route flags, or undefined when it advertises them. */
async function exposureRefusal(run: CommandRunner, bin: string, cwd: string): Promise<string | undefined> {
  const version = await run([bin, "version", "--json"], { cwd, timeoutMs: 60_000 });
  let capabilities: unknown;
  try {
    capabilities = (JSON.parse(version.stdout.trim()) as { capabilities?: unknown }).capabilities;
  } catch {
    capabilities = undefined;
  }
  if (version.code === 0 && Array.isArray(capabilities) && capabilities.includes(PREVIEW_EXPOSURE_CAPABILITY)) return undefined;
  return (
    `the teploy CLI (${bin}) does not advertise the ${PREVIEW_EXPOSURE_CAPABILITY} capability in \`teploy version --json\`, ` +
    `so it cannot deploy a tailnet preview (--base-domain/--http-only/--allow-ip); upgrade the CLI on this worker. ` +
    `Nothing was built or deployed` +
    (version.code !== 0 ? ` (version exited ${version.code}: ${tail(version.stderr || version.stdout, 2)})` : "")
  );
}

/**
 * The preview target for one project's declared preview app (C4).
 *
 * `SHIP_PREVIEW_DIR` was one clone per worker. With the ladder a worker serves
 * many projects, so the directory may instead be a ROOT holding one clone per
 * app: `<dir>/<app>/teploy.yml`. When the project names an app and that
 * subdirectory exists, it is the working copy; otherwise the directory itself
 * is, exactly as before. The app name is used only as a path segment and is
 * refused when it is not a plain name.
 */
export function resolvePreviewTarget(target: PreviewTarget, app: string | undefined): PreviewTarget {
  if (app === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(app)) return target;
  // Main's URL is keyed by app name, independent of the directory layout: a
  // per-app entry wins over the worker-wide default.
  const mainUrl = target.mainUrlByApp?.[app];
  const withMain = mainUrl !== undefined ? { ...target, mainUrl } : target;
  const dir = join(target.dir, app);
  return existsSync(dir) && statSync(dir).isDirectory() ? { ...withMain, dir } : withMain;
}

/** What a rollback attempt produced. Non-zero exit is data, like everywhere else here. */
export type RollbackOutcome =
  | { kind: "rolled-back"; output: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** Restore an explicitly named retained release. Never infer "previous": a
 * repeated recovery could otherwise toggle between two releases. This helper
 * does not grant authority; preview workflows must only destroy their preview.
 * Older CLIs that do not support --to fail without a wider fallback.
 */
export async function rollbackDeploy(target: PreviewTarget, version?: string): Promise<RollbackOutcome> {
  const run = target.run ?? hostRunner();
  const bin = target.bin ?? "teploy";
  const dest = target.destination !== undefined ? ["-d", target.destination] : [];
  if (!version || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(version)) return { kind: "skipped", reason: "Rollback requires an explicit retained version; previous is not a stable recovery target" };
  const result = await run([bin, "rollback", "--to", version, ...dest], {
    cwd: target.dir,
    timeoutMs: target.timeoutMs ?? 900_000,
  });
  return result.code === 0
    ? { kind: "rolled-back", output: tail(result.stdout || result.stderr) }
    : { kind: "failed", reason: `teploy rollback failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}` };
}

/** Tear a preview down. Used when a PR closes; the CLI's TTL is the backstop. */
export async function destroyPreview(target: PreviewTarget, branch: string): Promise<PreviewOutcome> {
  const run = target.run ?? hostRunner();
  const bin = target.bin ?? "teploy";
  const dest = target.destination !== undefined ? ["-d", target.destination] : [];
  try {
    assertGitSafe("branch", branch);
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
  const result = await run([bin, "preview", "destroy", branch, ...dest], {
    cwd: target.dir,
    timeoutMs: target.timeoutMs ?? 300_000,
  });
  return result.code === 0
    ? { kind: "skipped", reason: `preview for ${branch} destroyed` }
    : { kind: "failed", reason: `teploy preview destroy failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}` };
}

/** The line a reviewer reads on the pull request. */
export function previewComment(outcome: PreviewOutcome, runId: string): string {
  switch (outcome.kind) {
    case "deployed":
      return (
        `Preview: ${outcome.url}\n\nRunning \`${outcome.image}\`` +
        (outcome.revision ? ` from revision \`${outcome.revision}\`` : "") +
        (outcome.expiresAt !== undefined ? `, expires ${outcome.expiresAt}` : "") +
        `.\nDeployed by Teploy Ship (run ${runId}).`
      );
    case "failed":
      // Said out loud, on the PR. A preview that silently did not happen
      // teaches a reviewer to assume the URL is just slow.
      return `Preview deploy FAILED for this branch (run ${runId}).\n\n${outcome.reason}\n\nThe change itself is unaffected — review the diff.`;
    case "skipped":
      return `Preview skipped (run ${runId}): ${outcome.reason}`;
  }
}

/**
 * Read this worker's preview target from the environment.
 *
 * `SHIP_PREVIEW_DIR` is the switch: a worker with no directory to run the CLI
 * in cannot deploy a preview, and returning undefined makes that explicit
 * rather than half-configured. The directory is the operator's own checkout of
 * the app being previewed — Ship never creates it and never writes to it, and
 * it is the reason deploy credentials stay on the worker host instead of
 * reaching the agent's sandbox.
 */
export function previewTargetFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewTarget | undefined {
  const dir = (env.SHIP_PREVIEW_DIR ?? "").trim();
  if (dir === "") return undefined;
  const bin = (env.SHIP_PREVIEW_BIN ?? "").trim();
  const ttl = (env.SHIP_PREVIEW_TTL ?? "").trim();
  const destination = (env.SHIP_PREVIEW_DESTINATION ?? "").trim();
  const timeout = Number(env.SHIP_PREVIEW_TIMEOUT_MS);
  const tailnet = tailnetRoute((env.SHIP_PREVIEW_TAILNET_IP ?? "").trim());
  const main = mainUrls((env.SHIP_PREVIEW_MAIN_URL ?? "").trim());
  const invalid = [tailnet.invalid, main.invalid].filter((r): r is string => r !== undefined);
  return {
    dir,
    ...(bin !== "" ? { bin } : {}),
    ...(ttl !== "" ? { ttl } : {}),
    ...(destination !== "" ? { destination } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...tailnet.route,
    ...main.urls,
    ...(invalid.length > 0 ? { invalid: invalid.join("; ") } : {}),
  };
}

/** Tailscale's address range (CGNAT). Preview routes admit only this. */
export const TAILNET_CIDR = "100.64.0.0/10";

/**
 * Tailnet mode (DELEGATED_DECISIONS_2026-09-23 §10): one setting, the deploy
 * target's tailnet IPv4, implies all three route options together — base
 * domain `<ip>.sslip.io` (resolves publicly to a 100.x address, so no DNS
 * records and no certificates), plain HTTP (the dashboard is HTTP, so the
 * frame is not mixed content), and the tailnet allowlist (so the Host header
 * sent to the target's PUBLIC address is refused). One knob rather than
 * three, because the three are only safe together: an sslip.io host without
 * the allowlist is a public, unauthenticated HTTP preview.
 */
function tailnetRoute(ip: string): { route: Pick<PreviewTarget, "baseDomain" | "httpOnly" | "allowIps">; invalid?: string } {
  if (ip === "") return { route: {} };
  const baseDomain = tailnetBaseDomain(ip);
  if (baseDomain === undefined) {
    return {
      route: {},
      invalid: `SHIP_PREVIEW_TAILNET_IP=${JSON.stringify(ip)} is not a tailnet IPv4 address (${TAILNET_CIDR}); refusing to deploy a preview rather than fall back to a public route`,
    };
  }
  return { route: { baseDomain, httpOnly: true, allowIps: [TAILNET_CIDR] } };
}

/**
 * `<ip>.sslip.io` for a tailnet IPv4 (inside 100.64.0.0/10), else undefined.
 * The one derivation of the preview base: the worker deploys under it and the
 * dashboard's CSP frames only it (web/src/lib/preview-frame.server.ts).
 */
export function tailnetBaseDomain(ip: string): string | undefined {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())?.slice(1).map(Number);
  const ok = octets !== undefined && octets.every((o) => o <= 255) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  return ok ? `${octets!.join(".")}.sslip.io` : undefined;
}

/**
 * The sandbox egress entries a project with a declared preview needs, derived
 * from this deployment's preview config (wave 10, L13).
 *
 * The preview rungs (smoke, visual, flow) run IN the sandbox, behind its
 * allowlist proxy, so a tailnet preview was refused until an operator added
 * the target's sslip suffix to each project by hand (first live preview,
 * 2026-09-24). With SHIP_PREVIEW_TAILNET_IP set, the preview host is known:
 *
 *   - `.<ip>.sslip.io` — every preview on this target. A leading-dot suffix
 *     is the narrowest form the daemon's grammar has (no wildcards, exact host
 *     or suffix), and a preview's hostname is minted per revision, after the
 *     run's sandbox exists. Portless, so 80 and 443 only.
 *   - main's host, when the project declares the visual rung and main's URL
 *     is configured for its app (SHIP_PREVIEW_MAIN_URL): the rung screenshots
 *     main through the same proxy.
 *
 * Empty when the tailnet setting is unset or invalid, or the project declares
 * no preview. Resolved at enqueue and copied into the run input with the
 * project's own entries, like every other sandbox setting.
 */
export function previewEgressAllow(
  verification: { preview?: { app?: string }; visual?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (verification?.preview === undefined) return [];
  const base = tailnetBaseDomain((env.SHIP_PREVIEW_TAILNET_IP ?? "").trim());
  if (base === undefined) return [];
  const out = [`.${base}`];
  if (verification.visual === true) {
    const main = mainUrls((env.SHIP_PREVIEW_MAIN_URL ?? "").trim());
    const app = verification.preview.app;
    const url = main.invalid === undefined ? ((app !== undefined ? main.urls.mainUrlByApp?.[app] : undefined) ?? main.urls.mainUrl) : undefined;
    if (url !== undefined) {
      const u = new URL(url);
      out.push(u.port !== "" ? `${u.hostname}:${u.port}` : u.hostname);
    }
  }
  return out;
}

/**
 * A project's explicit allowlist with the derived preview entries appended.
 * Explicit entries always survive: when both together would pass the daemon's
 * bound, the derived ones are dropped rather than refusing the enqueue.
 */
export function withPreviewEgress(
  explicit: string[] | undefined,
  verification: { preview?: { app?: string }; visual?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const derived = previewEgressAllow(verification, env);
  if (derived.length === 0) return explicit;
  let merged: string[] | undefined;
  try {
    merged = normalizeEgressAllow([...(explicit ?? []), ...derived]);
  } catch {
    return explicit;
  }
  return merged !== undefined && merged.length <= MAX_EGRESS_ALLOW_ENTRIES ? merged : explicit;
}

/**
 * SHIP_PREVIEW_MAIN_URL: main's URL for the visual rung. Either one URL (a
 * worker that previews one app) or comma-separated `app=url` entries (a
 * preview root with one clone per app); a bare URL among entries is the
 * default for apps not named.
 */
function mainUrls(raw: string): { urls: Pick<PreviewTarget, "mainUrl" | "mainUrlByApp">; invalid?: string } {
  if (raw === "") return { urls: {} };
  const byApp: Record<string, string> = {};
  let fallback: string | undefined;
  for (const part of raw.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const eq = /^([A-Za-z0-9][A-Za-z0-9._-]*)=(.+)$/.exec(part);
    const url = eq !== null ? eq[2]!.trim() : part;
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
      return { urls: {}, invalid: `SHIP_PREVIEW_MAIN_URL entry ${JSON.stringify(part)} is not an http(s) URL` };
    }
    if (eq !== null) byApp[eq[1]!] = parsed.href;
    else fallback = parsed.href;
  }
  return {
    urls: {
      ...(fallback !== undefined ? { mainUrl: fallback } : {}),
      ...(Object.keys(byApp).length > 0 ? { mainUrlByApp: byApp } : {}),
    },
  };
}
