import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { shipVersion } from "./version.js";

/**
 * SHIP-05: the published 0.5.0 image reported "dev" — the image baked
 * ENV SHIP_VERSION=dev and the release workflow passed no build arg. The
 * version now comes from dist/VERSION (written by the image's builder stage),
 * with SHIP_VERSION as an override that "dev" can no longer win.
 */

function layout(files: Record<string, string>): { base: URL; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ship-version-"));
  mkdirSync(join(root, "dist"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return { base: pathToFileURL(join(root, "dist") + "/"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the baked dist/VERSION is the answer when no override is set", () => {
  const { base, cleanup } = layout({ "dist/VERSION": "0.5.1\n" });
  try {
    assert.equal(shipVersion({}, base), "0.5.1");
  } finally {
    cleanup();
  }
});

test("SHIP_VERSION overrides, but \"dev\" and blank never shadow a baked version", () => {
  const { base, cleanup } = layout({ "dist/VERSION": "0.5.1\n" });
  try {
    assert.equal(shipVersion({ SHIP_VERSION: "0.6.0-rc1" }, base), "0.6.0-rc1");
    assert.equal(shipVersion({ SHIP_VERSION: "dev" }, base), "0.5.1");
    assert.equal(shipVersion({ SHIP_VERSION: "  " }, base), "0.5.1");
  } finally {
    cleanup();
  }
});

test("a developer checkout without dist/VERSION reports the real package.json version", () => {
  const { base, cleanup } = layout({ "package.json": JSON.stringify({ name: "teploy-ship", version: "0.5.0", scripts: { build: "tsc" } }) });
  try {
    assert.equal(shipVersion({}, base), "0.5.0");
  } finally {
    cleanup();
  }
});

test("the image's runtime deploy manifest is never mistaken for the release", () => {
  // deploy/package.ship.json: same name, placeholder version, no scripts.
  const { base, cleanup } = layout({ "package.json": JSON.stringify({ name: "teploy-ship", version: "0.0.1" }) });
  try {
    assert.equal(shipVersion({}, base), "dev");
  } finally {
    cleanup();
  }
});

test("nothing to read is \"dev\", never empty and never a throw", () => {
  const { base, cleanup } = layout({});
  try {
    assert.equal(shipVersion({}, base), "dev");
  } finally {
    cleanup();
  }
});

test("this build reports the repository's package version", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(shipVersion({}), pkg.version);
});
