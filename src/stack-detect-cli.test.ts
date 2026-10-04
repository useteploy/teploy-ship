import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

async function invoke(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), "stack-cli-home-"));
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_STATE_HOME: home, ...env } as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stack-cli-repo-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", packageManager: "pnpm@9.1.0", scripts: { test: "vitest run" } }, null, 2));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

test("project detect: flag off is refused, prints no proposal, and touches nothing", async () => {
  const dir = await repo();
  try {
    const before = await readdir(dir, { recursive: true });
    const r = await invoke(["project", "detect", dir], {});
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /SHIP_STACK_DETECT=on/);
    assert.equal(r.stdout, "");
    const off = await invoke(["project", "detect", dir], { SHIP_STACK_DETECT: "off" });
    assert.notEqual(off.code, 0);
    assert.deepEqual(await readdir(dir, { recursive: true }), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project detect: flag on proposes with citations, reads in place, writes nothing", async () => {
  const dir = await repo();
  try {
    const before = (await readdir(dir, { recursive: true })).sort();
    const r = await invoke(["project", "detect", dir], { SHIP_STACK_DETECT: "on" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /preparation: pnpm install --frozen-lockfile/);
    assert.match(r.stdout, /test: .*vitest|test: pnpm/);
    assert.match(r.stdout, /from package\.json:\d+/);
    assert.match(r.stdout, /nothing was run or saved/);
    assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before);
    const j = await invoke(["project", "detect", dir, "--json"], { SHIP_STACK_DETECT: "on" });
    const parsed = JSON.parse(j.stdout) as { mode: string; inputsDigest: { digest: string } };
    assert.equal(parsed.mode, "proposal-only");
    assert.match(parsed.inputsDigest.digest, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project detect: a URL outside the repo allowlist is refused before any clone", async () => {
  const r = await invoke(["project", "detect", "https://evil.example.com/o/r"], { SHIP_STACK_DETECT: "on", SHIP_REPO_ALLOWLIST: "https://github.com/useteploy" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /allow/i);
});
