import { test } from "node:test";
import assert from "node:assert/strict";

import { knownRole, claimStrings, resolveUsername, resolveRole, parseScopes } from "./oidc-map.js";
import type { RoleMapOptions } from "./oidc-map.js";

const opts: RoleMapOptions = {
  roleClaim: "teploy_role",
  groupsClaim: "groups",
  adminGroup: "ship-admins",
  editorGroup: "ship-editors",
  viewerGroup: "ship-viewers",
  defaultRole: "viewer",
};

test("resolveRole: direct role claim wins over groups", () => {
  assert.equal(resolveRole({ teploy_role: "editor", groups: ["ship-admins"] }, opts), "editor");
});

test("resolveRole: unknown role claim falls through to groups", () => {
  assert.equal(resolveRole({ teploy_role: "superuser", groups: ["ship-editors"] }, opts), "editor");
});

test("resolveRole: group precedence admin > editor > viewer", () => {
  assert.equal(resolveRole({ groups: ["ship-viewers", "ship-editors", "ship-admins"] }, opts), "admin");
});

test("resolveRole: default when nothing matches", () => {
  assert.equal(resolveRole({ groups: ["unrelated"] }, opts), "viewer");
});

test("resolveRole: empty configured group never escalates", () => {
  assert.equal(resolveRole({ groups: [""] }, { ...opts, adminGroup: "" }), "viewer");
});

test("resolveUsername: preferred_username → email → sub priority", () => {
  assert.equal(resolveUsername({ preferred_username: "jane", email: "j@x", sub: "abc" }, "preferred_username"), "jane");
  assert.equal(resolveUsername({ email: "j@x", sub: "abc" }, "preferred_username"), "j@x");
  assert.equal(resolveUsername({ sub: "abc" }, "preferred_username"), "abc");
  assert.equal(resolveUsername({}, "preferred_username"), "");
});

test("knownRole: only canonical roles, case/space-insensitive", () => {
  for (const r of ["admin", "ADMIN", " editor ", "viewer"]) assert.notEqual(knownRole(r), null);
  assert.equal(knownRole("root"), null);
  assert.equal(knownRole(123), null);
});

test("claimStrings: string, array-of-any, nil", () => {
  assert.deepEqual(claimStrings("solo"), ["solo"]);
  assert.deepEqual(claimStrings(["a", "b", 3, "c"]), ["a", "b", "c"]);
  assert.deepEqual(claimStrings(undefined), []);
});

test("parseScopes: default + openid always leads, deduped", () => {
  assert.deepEqual(parseScopes(""), ["openid", "profile", "email"]);
  const s = parseScopes("email, groups profile");
  assert.equal(s[0], "openid");
  assert.equal(new Set(s).size, s.length);
});
