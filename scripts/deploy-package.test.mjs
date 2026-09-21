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

// SSR executes framework source in the deployed image. Testing a newer local
// framework while pinning an older deployment tree misses security fixes and
// route/runtime regressions even when the browser build is green.
test("deployment pins match the installed packages exercised by Ship's suites", () => {
  for (const [manifest, base] of [["deploy/package.ship.json", root], ["deploy/package.web.json", join(root, "web")]]) {
    const deployed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    for (const [name, version] of Object.entries(deployed.dependencies)) {
      if (name === "teploy-ship") continue;
      const installed = JSON.parse(readFileSync(join(base, "node_modules", name, "package.json"), "utf8"));
      assert.equal(version, installed.version, `${manifest}: ${name} must deploy the tested version`);
    }
  }
});

test("production npm retains every web security override used by local pnpm", () => {
  const local = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8"));
  const deployed = JSON.parse(readFileSync(join(root, "deploy/package.web.json"), "utf8"));
  assert.ok(Object.keys(local.pnpm.overrides).length > 0);
  for (const [name, version] of Object.entries(local.pnpm.overrides)) {
    assert.equal(deployed.overrides[name], version, `${name}: production must retain the tested security override`);
  }
});

test("production lockfiles describe the deployed manifests and Docker installs them frozen", () => {
  for (const name of ["ship", "web"]) {
    const manifest = JSON.parse(readFileSync(join(root, `deploy/package.${name}.json`), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, `deploy/package-lock.${name}.json`), "utf8"));
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path.startsWith("node_modules/") || pkg.link) continue;
      assert.ok(pkg.integrity, `${name}: ${path} needs registry integrity`);
    }
  }
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY deploy\/package-lock.ship.json package-lock.json/);
  assert.match(dockerfile, /COPY deploy\/package-lock.web.json web\/package-lock.json/);
  assert.equal((dockerfile.match(/npm ci --omit=dev/g) ?? []).length, 2);
  assert.doesNotMatch(dockerfile, /--no-lockfile|--no-package-lock/);
});
