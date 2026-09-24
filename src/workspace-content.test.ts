import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspaceContent } from "./workspace-content.js";

test("editor content preserves the full byte cap, scopes references, and rejects corruption and expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "editor-content-"));
  try {
    const store = new FileWorkspaceContent(dir);
    const content = 'é"\n'.repeat(50_000);
    assert.equal(Buffer.byteLength(content), 200_000);
    await store.put("run-a", "req-a", content);
    assert.equal(await store.get("run-a", "req-a"), content);
    await assert.rejects(store.put("run-a", "too-big", content + "x"), /200000/);
    await assert.rejects(store.get("run-b", "req-a"), /missing/);
    await assert.rejects(store.get("../escape", "req-a"), /Invalid/);
    await store.put("run-a", "empty", "");
    assert.equal(await store.get("run-a", "empty"), "");
    const path = join(dir, "run-a.req-a.json");
    const row = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...row, data: "corrupt" }));
    await assert.rejects(store.get("run-a", "req-a"), /corrupt/);
    row.manifest.expires = "2000-01-01T00:00:00.000Z";
    await writeFile(path, JSON.stringify(row));
    await assert.rejects(store.get("run-a", "req-a"), /expired/);
    await store.prune();
    assert.deepEqual(await readdir(dir), ["run-a.empty.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
