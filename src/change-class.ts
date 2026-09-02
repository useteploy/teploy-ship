/**
 * How much does this change deserve a human? (L3 / D2)
 *
 * Ship opens pull requests, so today every change gets the same treatment: it
 * lands as a PR and waits for review. That is fine while a person reads every
 * one, and it stops being fine in both directions the moment they do not — a
 * one-line typo fix sits in the same queue as a migration, and the queue
 * teaches its reader to skim.
 *
 * The gate names three classes and treats them differently:
 *
 *   serious — park BEFORE pushing and ask. Migrations, auth, payments, deploy
 *             config, deletions, and anything large enough that "review it"
 *             is not a real answer.
 *   trivial — small, contained, covered by a green suite. Publish it
 *             non-draft; L5 may later merge it without a human.
 *   normal  — everything else. Exactly today's behaviour.
 *
 * WHY IT HAS TO EXIST BEFORE ANYTHING UNATTENDED. L5 (auto-merge) and L6 (a
 * public board driving unattended runs) are both "Ship acts without a human in
 * the loop", and neither is safe without a rule for which changes may skip the
 * human. Building them first would mean choosing that rule implicitly, in the
 * places least likely to be read.
 *
 * The classifier is PURE — file stats in, class and reasons out. No executor,
 * no clock, no environment: it is called from inside a recorded step and its
 * answer has to be identical on replay.
 */

export type ChangeClass = "trivial" | "normal" | "serious";

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  /** The file is gone, not merely edited. */
  isDelete: boolean;
}

export interface ChangeVerdict {
  class: ChangeClass;
  /**
   * Why, in a human's words. Every rule that fired, not just the first —
   * "touches a migration" and "deletes 3 files" are different worries and the
   * person answering the park deserves both.
   */
  reasons: string[];
}

export interface ChangeClassConfig {
  /**
   * Globs whose match makes a change serious no matter how small. A one-line
   * edit to a migration is exactly the change that most deserves a person.
   */
  sensitivePaths: string[];
  seriousLines: number;
  seriousFiles: number;
  trivialFiles: number;
  trivialLines: number;
}

/**
 * The defaults, and the reasoning for the ones that are not obvious.
 *
 * Lockfiles and manifests are here because a dependency change is a supply
 * chain change; `teploy.yml` and Dockerfiles because they are how the thing
 * gets deployed; `**\/*auth*`, `**\/*payment*`, `**\/*stripe*` because getting
 * them subtly wrong is expensive in a way that does not show up in a suite.
 */
export const defaultChangeClassConfig: ChangeClassConfig = {
  sensitivePaths: [
    "**/migrations/**",
    "**/migration/**",
    "**/migrate/**",
    "**/schema.sql",
    "**/*auth*",
    "**/*payment*",
    "**/*stripe*",
    "**/teploy.yml",
    "**/teploy.yaml",
    "**/Dockerfile*",
    "**/*.env*",
    "go.mod",
    "go.sum",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "Cargo.lock",
    "**/security/**",
    "**/.github/workflows/**",
    "**/.forgejo/workflows/**",
  ],
  seriousLines: 400,
  seriousFiles: 15,
  trivialFiles: 3,
  trivialLines: 40,
};

/**
 * The marker a plan emits when it has hit a product or behaviour choice.
 *
 * A decision is not a size problem — it is a "nobody asked me whether this is
 * what you wanted" problem, and no line count detects it. The plan prompt is
 * told to write it, and the classifier honours it.
 */
export const DECISION_MARKER = "DECISION:";

/**
 * The paths whose change still parks MID-RUN, before anything is pushed (C1).
 *
 * Every other change the run may not merge on its own authority — a `serious`
 * one always, a `trivial` or `normal` one wherever the authority stops short
 * — runs to a verified draft pull request and parks at the merge boundary,
 * because a person can undo a pull request. A deletion or a schema migration
 * is the exception: its blast radius is the one thing a draft does not
 * contain, and the plan's own rule is that the mid-run park survives only for
 * a run that would delete or migrate.
 */
export const MIGRATION_PATHS: readonly string[] = ["**/migrations/**", "**/migration/**", "**/migrate/**", "**/schema.sql"];

/**
 * Why this change must park before the push rather than at the boundary, as
 * reasons; empty when a draft pull request is a safe place to ask. Pure, like
 * classifyChange, and for the same reason: it is called inside a recorded
 * step and must replay identically.
 */
export function midRunParkReasons(files: ChangedFile[]): string[] {
  const reasons: string[] = [];
  const deletes = files.filter((f) => f.isDelete);
  if (deletes.length > 0) {
    reasons.push(`deletes ${deletes.map((f) => f.path).slice(0, 5).join(", ")}${deletes.length > 5 ? ", …" : ""}`);
  }
  for (const file of files) {
    const hit = MIGRATION_PATHS.find((glob) => matchesGlob(file.path, glob));
    if (hit !== undefined) reasons.push(`${file.path} is a schema or migration path (${hit})`);
  }
  return reasons;
}

export function changeClassConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChangeClassConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
  };
  const paths = (env.SHIP_CLASS_SENSITIVE_PATHS ?? "").split(/[,\n]+/).map((p) => p.trim()).filter((p) => p !== "");
  return {
    sensitivePaths: paths.length > 0 ? paths : defaultChangeClassConfig.sensitivePaths,
    seriousLines: num("SHIP_CLASS_SERIOUS_LINES", defaultChangeClassConfig.seriousLines),
    seriousFiles: num("SHIP_CLASS_SERIOUS_FILES", defaultChangeClassConfig.seriousFiles),
    trivialFiles: num("SHIP_CLASS_TRIVIAL_FILES", defaultChangeClassConfig.trivialFiles),
    trivialLines: num("SHIP_CLASS_TRIVIAL_LINES", defaultChangeClassConfig.trivialLines),
  };
}

/**
 * Match a repo-relative path against one glob.
 *
 * A deliberately small glob dialect — `**`, `*`, `?` — rather than a
 * dependency. `*` does not cross a `/`, `**` does, and a pattern with no `/`
 * matches the BASENAME, so `*auth*` catches `src/lib/oauth.ts` the way an
 * operator writing that pattern expects. Case-insensitive: `Dockerfile` and
 * `dockerfile` are the same worry.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  const target = glob.includes("/") ? normalized : (normalized.split("/").pop() ?? normalized);
  const pattern = glob.includes("/") ? glob : glob.replace(/^\*\*\//, "");
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000SLASHSTAR\u0000")
    .replace(/\*\*/g, "\u0000STARSTAR\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000SLASHSTAR\u0000/g, "(?:.*/)?")
    .replace(/\u0000STARSTAR\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(target);
}

export interface ClassifyInput {
  files: ChangedFile[];
  /** The plan's text, when the run planned. Scanned for DECISION_MARKER. */
  planText?: string;
  /**
   * Did the project's suite pass over this change? Only `true` can make a
   * change trivial: "small" without "tested" is not the same claim.
   */
  testsPassed?: boolean;
  /**
   * Paths the task itself named. A change confined to the files an issue cited
   * is doing what it was asked; one that wandered is not, however small.
   * Absent = the check is skipped rather than failed.
   */
  citedPaths?: string[];
  config?: ChangeClassConfig;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) || /_test\.go$/i.test(path);
}

/**
 * Classify. Rules are evaluated in order and the FIRST class to fire wins, but
 * every serious reason is collected: a person answering a park wants all of
 * them, not the alphabetically first.
 */
export function classifyChange(input: ClassifyInput): ChangeVerdict {
  const config = input.config ?? defaultChangeClassConfig;
  const files = input.files;
  const reasons: string[] = [];

  const totalLines = files.reduce((n, f) => n + f.added + f.deleted, 0);

  for (const file of files) {
    const hit = config.sensitivePaths.find((glob) => matchesGlob(file.path, glob));
    if (hit !== undefined) reasons.push(`${file.path} matches the sensitive path rule ${hit}`);
  }
  const deletes = files.filter((f) => f.isDelete);
  if (deletes.length > 0) {
    reasons.push(
      `deletes ${deletes.length} file${deletes.length === 1 ? "" : "s"} (${deletes.slice(0, 5).map((f) => f.path).join(", ")}` +
        `${deletes.length > 5 ? ", …" : ""})`,
    );
  }
  if (totalLines > config.seriousLines) reasons.push(`${totalLines} changed lines, over the ${config.seriousLines} line threshold`);
  if (files.length > config.seriousFiles) reasons.push(`${files.length} files, over the ${config.seriousFiles} file threshold`);
  if (input.planText !== undefined && input.planText.includes(DECISION_MARKER)) {
    const line = input.planText
      .split("\n")
      .find((l) => l.includes(DECISION_MARKER))
      ?.trim();
    reasons.push(`the plan says a decision is needed — ${line ?? DECISION_MARKER}`);
  }
  if (reasons.length > 0) return { class: "serious", reasons };

  if (files.length === 0) {
    // Nothing changed. Not trivial — trivial is a claim about a change, and
    // there isn't one; the empty-diff path is handled elsewhere.
    return { class: "normal", reasons: ["no files changed"] };
  }

  const trivialReasons: string[] = [];
  if (files.length > config.trivialFiles) trivialReasons.push(`${files.length} files (trivial is at most ${config.trivialFiles})`);
  if (totalLines > config.trivialLines) trivialReasons.push(`${totalLines} changed lines (trivial is at most ${config.trivialLines})`);
  if (input.testsPassed !== true) trivialReasons.push("the suite did not pass over this change, so it is not demonstrably safe");
  if (input.citedPaths !== undefined) {
    const cited = new Set(input.citedPaths.map((p) => p.replace(/^\.\//, "")));
    const wandered = files.filter((f) => !isTestPath(f.path) && !cited.has(f.path.replace(/^\.\//, "")));
    if (wandered.length > 0) {
      trivialReasons.push(`touches ${wandered.map((f) => f.path).join(", ")}, which the task did not name`);
    }
  }
  if (trivialReasons.length === 0) {
    return {
      class: "trivial",
      reasons: [`${files.length} file${files.length === 1 ? "" : "s"}, ${totalLines} changed lines, suite green`],
    };
  }
  return { class: "normal", reasons: trivialReasons };
}

/** Parse `git diff --numstat` output into ChangedFile records. */
export function parseNumstat(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...pathParts] = parts;
    const path = pathParts.join("\t").trim();
    if (path === "") continue;
    // `-` in place of a count is git's marker for a binary file.
    const added = addedRaw === "-" ? 0 : Number(addedRaw);
    const deleted = deletedRaw === "-" ? 0 : Number(deletedRaw);
    files.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      // numstat alone cannot say "deleted" — a delete looks like N deletions
      // and 0 additions, which a full-file rewrite also does. The caller passes
      // the real answer from --diff-filter=D; see changedFiles in durable.ts.
      isDelete: false,
    });
  }
  return files;
}

/** The park's summary, for the run page, the approval row and the log. */
export function changeClassSummary(verdict: ChangeVerdict, files: ChangedFile[]): string {
  const total = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const head =
    `This change is classified **${verdict.class}** — ${files.length} file${files.length === 1 ? "" : "s"}, ` +
    `${total} changed line${total === 1 ? "" : "s"}.`;
  if (verdict.class !== "serious") return head;
  return (
    `${head}\n\nIt is held for a decision because:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}\n\n` +
    "Approve to push it and open the pull request; deny to end the run without pushing. The work is not lost either way."
  );
}

/** The boundary park's summary (C1): the work is done and verified; the question is the merge. */
export function mergeParkSummary(verdict: ChangeVerdict, files: ChangedFile[], pr: string, conflict?: string[]): string {
  const total = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const head =
    `This change is classified **${verdict.class}** — ${files.length} file${files.length === 1 ? "" : "s"}, ` +
    `${total} changed line${total === 1 ? "" : "s"}. It is published as a draft pull request: ${pr}`;
  const why =
    verdict.class === "serious"
      ? `\n\nIt is held at the merge boundary because:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`
      : `\n\nIt is held at the merge boundary because this repository does not merge a ${verdict.class} change unattended; the classifier said:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`;
  const conflicts =
    conflict !== undefined && conflict.length > 0
      ? `\n\nThe branch could not be rebased onto the default branch; these files conflict:\n${conflict.map((f) => `- ${f}`).join("\n")}\n\nResolve the conflict on the branch (or on the default branch) and approve again.`
      : "";
  return (
    `${head}${why}${conflicts}\n\n` +
    "Approve to rebase it, re-run its verification and merge it; " +
    "deny to close the pull request with your reason. The branch is kept either way."
  );
}
