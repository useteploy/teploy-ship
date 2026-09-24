import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalRepositoryURL, repositoryKeyFold, repositoryKeyTwins } from "./repository-reference.js";
import { FileProjectStore, resolveProject } from "./projects.js";

// S01-3. The rule, per forge: GitHub and Forgejo/Gitea (the only forge kinds
// Ship speaks) resolve owner/name case-insensitively — verified live against
// Forgejo 14.0.5 on 2026-09-23 (three spellings, one repository id) — so an
// http(s) path folds; a file: path is case-sensitive and never folds; the
// scheme is never inferred away.
test("S01-3: forge paths fold case, file paths and schemes never do", () => {
  const forms = [
    "https://github.com/UseTeploy/Teploy-Ship",
    "https://github.com/useteploy/teploy-ship.git",
    "https://GitHub.com/USETEPLOY/TEPLOY-SHIP/",
  ];
  assert.equal(new Set(forms.map(canonicalRepositoryURL)).size, 1, "GitHub case twins are one identity");
  assert.equal(
    canonicalRepositoryURL("http://100.108.123.49:49152/Tyler/teploy-ship.git"),
    canonicalRepositoryURL("http://100.108.123.49:49152/tyler/teploy-ship"),
    "Forgejo case twins are one identity",
  );
  assert.notEqual(canonicalRepositoryURL("file:///srv/Team/App"), canonicalRepositoryURL("file:///srv/team/app"), "file paths keep case");
  assert.notEqual(canonicalRepositoryURL("http://forge.example/team/app"), canonicalRepositoryURL("https://forge.example/team/app"), "scheme stays distinct (F03)");
  assert.notEqual(canonicalRepositoryURL("https://a.example/team/app"), canonicalRepositoryURL("https://b.example/team/app"), "origin stays distinct");
  assert.equal(repositoryKeyFold("forge.example:3000/Tyler/App"), "forge.example:3000/tyler/app", "v1 scope keys fold");
  assert.equal(repositoryKeyFold("Tyler/App"), "tyler/app", "slugs fold");
  assert.equal(repositoryKeyFold("file:///srv/Team/App"), "file:///srv/Team/App");
});

test("S01-3: twin detection groups spellings of one repository and never groups distinct ones", () => {
  const twins = repositoryKeyTwins([
    "https://forge.example/team/app",
    "https://forge.example/Team/App.git",
    "forge.example/Team/App",
    "forge.example/team/app",
    "http://forge.example/team/app",
    "file:///srv/Team/App",
    "file:///srv/team/app",
    "team/other",
    "",
  ]);
  assert.deepEqual(twins, [
    { identity: "forge.example/team/app", keys: ["forge.example/Team/App", "forge.example/team/app"] },
    { identity: "https://forge.example/team/app", keys: ["https://forge.example/Team/App.git", "https://forge.example/team/app"] },
  ]);
  assert.deepEqual(repositoryKeyTwins(["https://forge.example/team/app", "https://forge.example/team/app"]), [], "one key repeated is not a twin");
});

test("S01-3: a project registered under one spelling is found, and updated, under its case twin — never duplicated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-case-twins-"));
  try {
    const store = new FileProjectStore(dir);
    await store.set({ repo: "Tyler/App", url: "http://forge.example:3000/Tyler/App.git", autoMerge: false, autoDeploy: false, testCommand: "npm test" });
    const found = await store.forRepo("http://forge.example:3000/tyler/app");
    assert.equal(found?.testCommand, "npm test");
    await store.set({ repo: "tyler/app", url: "http://forge.example:3000/tyler/app", autoMerge: false, autoDeploy: false, testCommand: "pnpm test" });
    const all = await store.list();
    assert.equal(all.length, 1, "the twin spelling updates the one project");
    assert.equal(all[0]!.testCommand, "pnpm test");
    // Case-distinct file: remotes are distinct repositories.
    await store.set({ repo: "team/mirror", url: "file:///srv/Team/mirror", autoMerge: false, autoDeploy: false });
    await store.set({ repo: "team/mirror", url: "file:///srv/team/mirror", autoMerge: false, autoDeploy: false, testCommand: "make" });
    assert.equal((await store.list()).length, 3);
    assert.equal(resolveProject(await store.list(), "file:///srv/Team/mirror")?.testCommand, undefined);
    assert.equal(resolveProject(await store.list(), "file:///srv/team/mirror")?.testCommand, "make");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
