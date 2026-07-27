import type { Role } from "teploy-ship/runtime";

/**
 * Pure OIDC claim → principal mapping for Ship, extracted from oidc.server.ts so
 * it can be unit-tested without pulling in openid-client or the runtime store.
 * Matches the Dash/Observe mapping: a recognized role claim wins, then a group
 * claim matched against configured groups (admin > editor > viewer), then a
 * configurable default.
 */

export interface RoleMapOptions {
  roleClaim: string;
  groupsClaim: string;
  adminGroup: string;
  editorGroup: string;
  viewerGroup: string;
  defaultRole: Role;
}

export function knownRole(s: unknown): Role | null {
  if (typeof s !== "string") return null;
  switch (s.trim().toLowerCase()) {
    case "admin":
      return "admin";
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
  }
  return null;
}

export function claimStrings(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v];
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string" && e !== "");
  return [];
}

export function resolveUsername(claims: Record<string, unknown>, usernameClaim: string): string {
  for (const c of [usernameClaim, "preferred_username", "email", "sub"]) {
    if (c === "") continue;
    const val = claims[c];
    if (typeof val === "string" && val !== "") return val;
  }
  return "";
}

export function resolveRole(claims: Record<string, unknown>, opts: RoleMapOptions): Role {
  if (opts.roleClaim !== "") {
    const direct = knownRole(claims[opts.roleClaim]);
    if (direct !== null) return direct;
  }
  if (opts.groupsClaim !== "") {
    const groups = claimStrings(claims[opts.groupsClaim]);
    if (opts.adminGroup !== "" && groups.includes(opts.adminGroup)) return "admin";
    if (opts.editorGroup !== "" && groups.includes(opts.editorGroup)) return "editor";
    if (opts.viewerGroup !== "" && groups.includes(opts.viewerGroup)) return "viewer";
  }
  return opts.defaultRole;
}

export function parseScopes(raw: string): string[] {
  const fields = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (fields.length === 0) return ["openid", "profile", "email"];
  if (!fields.includes("openid")) fields.unshift("openid");
  return [...new Set(fields)];
}
