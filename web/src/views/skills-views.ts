import type { SkillVersion } from "teploy-ship/runtime";

/**
 * Pure view helpers for the skills page (Q4-a). Kept here rather than inline
 * in the route so the wording of the two warnings a reviewer reads first —
 * what an import REFUSED and what the screen flagged — is pinned by a test.
 */

/** One line describing what the import refused and what the screen flagged. Neither grants anything. */
export function importNotice(skill: Pick<SkillVersion, "strippedFrontmatter" | "flags">): string {
  const parts: string[] = [];
  if (skill.strippedFrontmatter.length > 0) {
    parts.push(`stripped frontmatter (never stored, never read): ${skill.strippedFrontmatter.join(", ")}`);
  }
  if (skill.flags.length > 0) {
    parts.push(`flagged by the injection screen: ${skill.flags.join("; ")}`);
  }
  return parts.join(" · ");
}

/** The registry row's provenance line: who imported it, when, from where. */
export function provenanceLine(skill: Pick<SkillVersion, "importedBy" | "importedAt" | "source">): string {
  const when = skill.importedAt.slice(0, 16).replace("T", " ");
  const ref = skill.source.ref !== undefined && skill.source.ref !== "" ? ` from ${skill.source.ref}` : "";
  return `${skill.source.kind}${ref} · ${skill.importedBy} · ${when} UTC`;
}
