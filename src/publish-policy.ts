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
 * These are deliberately blunt structural limits, not a code reviewer: size,
 * shape, and a handful of things that must never be committed. Refusing is
 * always safe (the work stays in the run's log and the operator is told why);
 * silently publishing is not.
 */

export interface PublishLimits {
  /** Refuse a diff touching more files than this. */
  maxFiles: number;
  /** Refuse when total added lines exceed this. */
  maxAddedLines: number;
  /** Refuse when any single file is bigger than this, in bytes. */
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
  ok: boolean;
  /** Why publication was refused, in operator-readable terms. */
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
  const reasons: string[] = [];

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
      reasons.push(`adds a symlink (${path}) — a link can point outside anything a reviewer reads`);
    }
    if (dstMode === "160000" || srcMode === "160000") {
      reasons.push(`changes a submodule pointer (${path})`);
    }
    if (dstMode === "100755" && srcMode === "100644") {
      reasons.push(`makes ${path} executable`);
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
  if (files > limits.maxFiles) {
    reasons.push(`touches ${files} files (limit ${limits.maxFiles})`);
  }
  if (addedLines > limits.maxAddedLines) {
    reasons.push(`adds ${addedLines} lines (limit ${limits.maxAddedLines})`);
  }
  if (binaryFiles > 0) {
    reasons.push(`adds or changes ${binaryFiles} binary file(s) — Ship does not publish binaries`);
  }

  for (const path of paths) {
    if (limits.forbidden.some((p) => p.test(path))) {
      reasons.push(`touches a forbidden path (${path})`);
    }
  }

  // Oversized single files: ls-files -s gives blob shas, cat-file -s the size.
  for (const path of paths) {
    const size = Number(await git(executor, `git cat-file -s :"${path.replace(/"/g, '\\"')}" 2>/dev/null`));
    if (Number.isFinite(size) && size > limits.maxFileBytes) {
      reasons.push(`${path} is ${Math.round(size / 1024)}KB (limit ${Math.round(limits.maxFileBytes / 1024)}KB)`);
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
    if (pattern.test(added)) reasons.push(`the diff appears to add ${describe}`);
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], files, addedLines };
}

/** The PR/comment note explaining a refusal, so the run's outcome is not a mystery. */
export function refusalMessage(screen: PublishScreen): string {
  return (
    `Ship refused to publish this run's diff (${screen.files} files, ${screen.addedLines} added lines):\n` +
    screen.reasons.map((r) => `- ${r}`).join("\n") +
    `\n\nThe work is still in the run's log. Adjust the task, or raise the limits via SHIP_PUBLISH_* if this is expected.`
  );
}

/** Limits from the environment, falling back to the defaults above. */
export function publishLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PublishLimits {
  const num = (name: string, fallback: number): number => {
    const raw = Number(env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    maxFiles: num("SHIP_PUBLISH_MAX_FILES", defaultPublishLimits.maxFiles),
    maxAddedLines: num("SHIP_PUBLISH_MAX_ADDED_LINES", defaultPublishLimits.maxAddedLines),
    maxFileBytes: num("SHIP_PUBLISH_MAX_FILE_BYTES", defaultPublishLimits.maxFileBytes),
    forbidden: defaultPublishLimits.forbidden,
  };
}
