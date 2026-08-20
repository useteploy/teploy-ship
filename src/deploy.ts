/**
 * Put a machine-authored fix on a URL a human can open.
 *
 * This is the half of Ship that closes the loop: Devin, Vorflux and OpenHands
 * all stop at the pull request. Ship owns a deployer (`teploy`), so a run can
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
import { execFile } from "node:child_process";
import { assertGitSafe } from "./git.js";

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
  | { kind: "deployed"; url: string; image: string; expiresAt?: string }
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
  expires_at?: string;
}

/**
 * Deploy a preview of `branch`, and return the URL a reviewer can open.
 *
 * Three CLI calls, in order, because each is the input to the next:
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
export async function deployPreview(target: PreviewTarget, branch: string): Promise<PreviewOutcome> {
  const run = target.run ?? hostRunner();
  const bin = target.bin ?? "teploy";
  const timeoutMs = target.timeoutMs ?? 900_000;
  const cwd = target.dir;
  const dest = target.destination !== undefined ? ["-d", target.destination] : [];

  try {
    assertGitSafe("branch", branch);
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
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
    [bin, "preview", "deploy", branch, "--ttl", target.ttl ?? "24h", "--image", image, ...dest],
    { cwd, timeoutMs },
  );
  if (deployed.code !== 0) {
    return { kind: "failed", reason: `teploy preview deploy failed (exit ${deployed.code}): ${tail(deployed.stderr || deployed.stdout)}` };
  }

  const listed = await run([bin, "preview", "list", "--json", ...dest], { cwd, timeoutMs: 60_000 });
  if (listed.code === 0) {
    try {
      const rows = JSON.parse(listed.stdout.trim()) as PreviewRow[];
      const row = Array.isArray(rows) ? rows.find((r) => r.branch === branch) : undefined;
      if (row?.domain !== undefined && row.domain !== "") {
        return {
          kind: "deployed",
          url: `https://${row.domain}`,
          image,
          ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}),
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
  if (printed !== null) return { kind: "deployed", url: printed[1]!, image };
  return { kind: "failed", reason: `preview deployed but no URL could be established: ${tail(deployed.stdout)}` };
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
  return {
    dir,
    ...(bin !== "" ? { bin } : {}),
    ...(ttl !== "" ? { ttl } : {}),
    ...(destination !== "" ? { destination } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}
