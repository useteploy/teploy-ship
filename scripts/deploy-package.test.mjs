import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The container installs `deploy/package.ship.json` AS the teploy-ship
 * package (Dockerfile: `COPY deploy/package.ship.json package.json`), so a
 * subpath export that exists only in the repo's own package.json resolves
 * locally and 500s in production.
 *
 * That is not hypothetical: `teploy-ship/fence` was added to the web app on
 * 2026-08-27 and every run detail page answered 500 — "Missing './fence'
 * specifier in 'teploy-ship'" — until 2026-08-30, on two deployed builds.
 * Nothing failed anywhere else: the suites pass, the web build passes, and the
 * dashboard's other pages render, because they import other subpaths.
 */
function subpathsUsedBy(dir) {
  const found = new Set();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const s of subpathsUsedBy(path)) found.add(s);
      continue;
    }
    if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(/from\s+"teploy-ship(\/[a-z-]+)?"/g)) {
      found.add(m[1] === undefined ? "." : `.${m[1]}`);
    }
  }
  return found;
}

test("every teploy-ship subpath the web app imports is exported by the DEPLOYED package.json", () => {
  const deployed = JSON.parse(readFileSync(join(root, "deploy/package.ship.json"), "utf8"));
  const exported = new Set(Object.keys(deployed.exports ?? {}));
  const used = subpathsUsedBy(join(root, "web/src"));
  assert.ok(used.size > 0, "the scan found no imports at all — the matcher is broken, not the package");
  for (const subpath of [...used].sort()) {
    assert.ok(
      exported.has(subpath),
      `web/src imports "teploy-ship${subpath === "." ? "" : subpath.slice(1)}" but deploy/package.ship.json does not export ` +
        `${JSON.stringify(subpath)} — the deployed container would answer 500 on every route that reaches it`,
    );
  }
});

test("the deployed package exports nothing that the build does not produce", () => {
  const deployed = JSON.parse(readFileSync(join(root, "deploy/package.ship.json"), "utf8"));
  for (const [subpath, target] of Object.entries(deployed.exports ?? {})) {
    const file = join(root, target.import);
    assert.ok(statSync(file).isFile(), `${subpath} points at ${target.import}, which \`pnpm run build\` did not produce`);
  }
});
