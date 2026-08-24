import type { AgentExecutor } from "@neutron-build/agents";

/**
 * Harness-owned checks between "the agent edited the tree" and "Ship pushes it".
 *
 * The publisher used to ask one question — is `git status --porcelain` non-empty
 * — and then `git add -A` everything. A sandbox protects the HOST from the
 * agent; nothing protected the destination repository from the diff. An agent
 * that vendored a dependency tree, committed a build directory, wrote a private
 * key into a fixture, or deleted a directory it misread would have all of that
 * pushed to a real branch under Ship's credential.
 *
 * Two different verdicts, because two different questions:
 *
 *   BLOCKING — credentials, forbidden paths, symlinks, submodule pointers,
 *              and a diff over the HARD file cap. Refused. None of these can
 *              be un-published once pushed, and none of them has a legitimate
 *              version that Ship should guess at.
 *   WARNING  — the diff is unusually large or contains binaries. Published as a
 *              DRAFT that says why. A 400-file change is either a real refactor
 *              or a runaway agent, and only a human knows which; a product that
 *              refuses both just teaches its operator to raise the limit until
 *              it never fires again, which is worse than not having it.
 *
 * The hard cap (SHIP_PUBLISH_HARD_MAX_FILES) is the blast-radius bound from the
 * policy work: the soft limit above it stays a question for a human, but an
 * operator running unattended against real repositories gets to say "past this
 * many files, do not push at all" — the refusal is recorded as a step and the
 * work stays in the run's log. Unset by default so existing deployments behave
 * exactly as before until the operator opts in.
 */

export interface PublishLimits {
  /** Above this many files the PR is raised as a draft, not refused. */
  maxFiles: number;
  /**
   * Above this many files the push is REFUSED outright. Undefined = no hard
   * cap; the draft-level maxFiles above still applies.
   */
  hardMaxFiles?: number;
  /** Above this many added lines the PR is raised as a draft. */
  maxAddedLines: number;
  /** Above this size for one file the PR is raised as a draft, in bytes. */
  maxFileBytes: number;
  /** Paths that must never be committed, matched against the repo-relative path. */
  forbidden: RegExp[];
}

export const defaultPublishLimits: PublishLimits = {
  maxFiles: 200,
  maxAddedLines: 20_000,
  maxFileBytes: 2 * 1024 * 1024,
  forbidden: [
    /(^|\/)\.git\/(?!info\/exclude)/, // git internals (the harness's own exclude is fine)
    /(^|\/)\.ssh\//,
    /(^|\/)\.env(\.|$)/,
    /(^|\/)\.aws\//,
    /(^|\/)\.npmrc$/,
    /(^|\/)\.netrc$/,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
    /\.(pem|pfx|p12|keystore|jks)$/,
    /(^|\/)\.teploy-agent\//, // harness scratch
  ],
};

/** Content that must not be pushed regardless of which file it is in. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; describe: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, describe: "a private key block" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, describe: "an AWS access key id" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, describe: "a GitHub token" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, describe: "a Slack token" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, describe: "an API secret key" },
];

export interface PublishScreen {
  /** No concerns at all. */
  ok: boolean;
  /**
   * Content that must never be pushed: credentials, forbidden paths, symlinks,
   * submodule pointers. Present means REFUSE.
   */
  blocking: string[];
  /**
   * The diff is unusual — very large, very many files, binaries. Present means
   * publish, but as a draft that says why. A 400-file change can be a
   * legitimate refactor or a runaway agent, and a product that refuses both
   * teaches its users to raise the limit until it never fires. A draft asks a
   * human the question instead of answering it for them.
   */
  warnings: string[];
  /** Everything, blocking first — for logs and summaries. */
  reasons: string[];
  files: number;
  addedLines: number;
}

/** One `git` call that returns "" rather than throwing — screening is advisory-first. */
async function git(executor: AgentExecutor, command: string): Promise<string> {
  const result = await executor.exec(command, { timeoutMs: 60_000 });
  return result.exitCode === 0 ? result.stdout : "";
}

/**
 * Screen the STAGED tree (call after `git add -A`). Returns the verdict plus
 * the numbers, so a refusal can say "412 files, 88k added lines" instead of
 * "policy violation".
 */
export async function screenPublication(
  executor: AgentExecutor,
  limits: PublishLimits = defaultPublishLimits,
): Promise<PublishScreen> {
  const blocking: string[] = [];
  const warnings: string[] = [];

  // --raw gives us modes, which is the only way to see symlinks (120000) and
  // submodule pointers (160000) — both of which can redirect what a reviewer
  // thinks they are approving.
  const raw = await git(executor, "git diff --cached --raw");
  const numstat = await git(executor, "git diff --cached --numstat");

  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
    const match = /^:(\d{6})\s+(\d{6})\s+\S+\s+\S+\s+(\S+)\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, srcMode, dstMode, , path] = match;
    paths.push(path!);
    if (dstMode === "120000" && srcMode !== "120000") {
      // A link changes what a reviewer is actually approving — it can point
      // anywhere, including outside the tree they are reading.
      blocking.push(`adds a symlink (${path}) — a link can point outside anything a reviewer reads`);
    }
    if (dstMode === "160000" || srcMode === "160000") {
      blocking.push(`changes a submodule pointer (${path}) — that moves code a reviewer cannot see in the diff`);
    }
    if (dstMode === "100755" && srcMode === "100644") {
      warnings.push(`makes ${path} executable`);
    }
  }

  let addedLines = 0;
  let binaryFiles = 0;
  for (const line of numstat.split("\n")) {
    if (line.trim() === "") continue;
    const [added, removed] = line.split("\t");
    // git reports "-\t-" for binary files.
    if (added === "-" && removed === "-") {
      binaryFiles += 1;
      continue;
    }
    const n = Number(added);
    if (Number.isFinite(n)) addedLines += n;
  }

  const files = paths.length;
  // Size is a smell, not a verdict: a big diff can be a real refactor.
  if (files > limits.maxFiles) {
    warnings.push(`touches ${files} files (usual limit ${limits.maxFiles})`);
  }
  // ...unless the operator drew a hard line. Past the hard cap this is a
  // runaway agent or a misunderstanding of the task, and pushing it creates a
  // branch the repository then owns; the refusal keeps the work in the run's
  // log, where a human can still look at it.
  if (limits.hardMaxFiles !== undefined && files > limits.hardMaxFiles) {
    blocking.push(`touches ${files} files (hard cap ${limits.hardMaxFiles}) — refused rather than pushed`);
  }
  if (addedLines > limits.maxAddedLines) {
    warnings.push(`adds ${addedLines} lines (usual limit ${limits.maxAddedLines})`);
  }
  if (binaryFiles > 0) {
    warnings.push(`adds or changes ${binaryFiles} binary file(s)`);
  }

  for (const path of paths) {
    if (limits.forbidden.some((p) => p.test(path))) {
      blocking.push(`touches a path that must never be committed (${path})`);
    }
  }

  // Oversized single files: ls-files -s gives blob shas, cat-file -s the size.
  for (const path of paths) {
    const size = Number(await git(executor, `git cat-file -s :"${path.replace(/"/g, '\\"')}" 2>/dev/null`));
    if (Number.isFinite(size) && size > limits.maxFileBytes) {
      warnings.push(`${path} is ${Math.round(size / 1024)}KB (usual limit ${Math.round(limits.maxFileBytes / 1024)}KB)`);
    }
  }

  // Secret scan over ADDED lines only: an existing key already in the repo is
  // not this run's doing, and flagging it would block every unrelated change.
  const diff = await git(executor, "git diff --cached --unified=0");
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  for (const { pattern, describe } of SECRET_PATTERNS) {
    // Never a warning: a published credential cannot be un-published.
    if (pattern.test(added)) blocking.push(`the diff appears to add ${describe}`);
  }

  const uniqueBlocking = [...new Set(blocking)];
  const uniqueWarnings = [...new Set(warnings)];
  return {
    ok: uniqueBlocking.length === 0 && uniqueWarnings.length === 0,
    blocking: uniqueBlocking,
    warnings: uniqueWarnings,
    reasons: [...uniqueBlocking, ...uniqueWarnings],
    files,
    addedLines,
  };
}

/** The PR/comment note explaining a refusal, so the run's outcome is not a mystery. */
export function refusalMessage(screen: PublishScreen): string {
  return (
    `Ship refused to publish this run's diff (${screen.files} files, ${screen.addedLines} added lines):\n` +
    screen.blocking.map((r) => `- ${r}`).join("\n") +
    `\n\nThe work is still in the run's log. Nothing here is a size limit — these are things that cannot be ` +
    `un-published once pushed, so they are refused rather than flagged.`
  );
}

/** The note attached to a draft PR raised because the diff looked unusual. */
export function warningMessage(screen: PublishScreen): string {
  return (
    `**This diff is unusual** (${screen.files} files, ${screen.addedLines} added lines), so it is a draft:\n` +
    screen.warnings.map((r) => `- ${r}`).join("\n") +
    `\n\nThat may be entirely correct for this task — review it and mark it ready. Adjust SHIP_PUBLISH_* if this ` +
    `shape of change is normal for your repository.`
  );
}

/** Limits from the environment, falling back to the defaults above. */
export function publishLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PublishLimits {
  const num = (name: string, fallback: number): number => {
    const raw = Number(env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const hard = Number(env.SHIP_PUBLISH_HARD_MAX_FILES);
  return {
    maxFiles: num("SHIP_PUBLISH_MAX_FILES", defaultPublishLimits.maxFiles),
    // Opt-in: absent or junk means "no hard cap", preserving today's behaviour.
    ...(Number.isFinite(hard) && hard > 0 ? { hardMaxFiles: hard } : {}),
    maxAddedLines: num("SHIP_PUBLISH_MAX_ADDED_LINES", defaultPublishLimits.maxAddedLines),
    maxFileBytes: num("SHIP_PUBLISH_MAX_FILE_BYTES", defaultPublishLimits.maxFileBytes),
    forbidden: defaultPublishLimits.forbidden,
  };
}
