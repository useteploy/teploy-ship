import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FileRunImages,
  MissingRunImageError,
  imageRefLine,
  parseImageRefs,
  resolveImageRefs,
} from "./run-images.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

async function tempImages(): Promise<FileRunImages> {
  return new FileRunImages(join(await mkdtemp(join(tmpdir(), "ship-images-"))));
}

test("an image roundtrips through the file store and its reference line parses back", async () => {
  const store = await tempImages();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const ref = await store.save("run-img", png, "image/png");

  assert.match(ref.id, /^img-[0-9a-f]{12}$/);
  const line = imageRefLine(ref);
  const parsed = parseImageRefs(line);
  assert.equal(parsed.length, 1);
  assert.deepEqual({ ...parsed[0!] }, { id: ref.id, sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime });

  const loaded = await store.load("run-img", ref.id);
  assert.notEqual(loaded, null);
  assert.deepEqual(Array.from(loaded!.data), Array.from(png));
});

test("the reference line is the only thing an observation needs to carry", async () => {
  const store = await tempImages();
  const png = new Uint8Array(64 * 1024).fill(7);
  const ref = await store.save("run-img", png, "image/png");
  const observation = `exit 0\nscreenshot saved\n${imageRefLine(ref)}`;

  const parsed = parseImageRefs(observation);
  assert.equal(parsed.length, 1);
  assert.deepEqual({ ...parsed[0!] }, { id: ref.id, sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime });
  // The property the design exists for: the observation's size does not move
  // with the image's size. A 64 KiB image and an 8 MiB one cost the log the
  // same one line, so replay reads stay cheap and the timeline stays legible.
  const big = await store.save("run-img", new Uint8Array(8 * 1024 * 1024).fill(9), "image/png");
  const bigObservation = `exit 0\n${imageRefLine(big)}`;
  const referenceLength = imageRefLine(big).length;
  assert.ok(bigObservation.length < referenceLength + 32);
  assert.ok(observation.length < 200);
});

test("resolving references verifies integrity and names a missing image", async () => {
  const store = await tempImages();
  const png = new Uint8Array([1, 2, 3, 4, 5]);
  const ref = await store.save("run-img", png, "image/png");

  const resolved = await resolveImageRefs(`before\n${imageRefLine(ref)}\nafter`, "run-img", (rid, id) => store.load(rid, id));
  assert.equal(resolved.length, 1);
  assert.deepEqual(Array.from(resolved[0]!.data), [1, 2, 3, 4, 5]);

  await store.deleteForRun("run-img");
  await assert.rejects(
    resolveImageRefs(imageRefLine(ref), "run-img", (rid, id) => store.load(rid, id)),
    (error: unknown) => {
      assert.ok(error instanceof MissingRunImageError);
      assert.match(error.message, new RegExp(ref.id));
      return true;
    },
    "a missing image must be a named error, not a silent placeholder",
  );
});

test("a tampered store fails integrity rather than feeding the model wrong bytes", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "ship-images-")));
  const store = new FileRunImages(dir);
  const ref = await store.save("run-img", new Uint8Array([1, 2, 3]), "image/png");

  // Swap the bytes on disk for different ones, keeping the meta.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "run-img", `${ref.id}.bin`), new Uint8Array([9, 9, 9, 9, 9]));

  await assert.rejects(
    resolveImageRefs(imageRefLine(ref), "run-img", (rid, id) => store.load(rid, id)),
    /fails integrity/,
  );
});

test("the nucleus store roundtrips through query/exec", async () => {
  // A map-backed fake, enough to prove the SQL shape and the base64 leg.
  const rows = new Map<string, Record<string, unknown>>();
  const fake = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("SELECT")) {
        const row = rows.get(String(params[0]) + ":" + String(params[1]));
        return row === undefined ? [] : [row];
      }
      return [];
    },
    async exec(sql: string, params: unknown[] = []) {
      if (sql.startsWith("CREATE TABLE")) return 0;
      if (sql.startsWith("INSERT")) {
        rows.set(String(params[0]) + ":" + String(params[1]), {
          mime: params[2],
          bytes: params[3],
          sha256: params[4],
          data: params[5],
        });
        return 1;
      }
      if (sql.startsWith("DELETE")) {
        for (const key of [...rows.keys()]) if (key.startsWith(String(params[0]) + ":")) rows.delete(key);
        return 1;
      }
      return 0;
    },
  } as unknown as NucleusPgwire;

  const store = new (await import("./run-images.js")).NucleusRunImages(fake);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7]);
  const ref = await store.save("run-n", png, "image/png");
  const loaded = await store.load("run-n", ref.id);
  assert.notEqual(loaded, null);
  assert.deepEqual(Array.from(loaded!.data), Array.from(png));
  assert.equal(loaded!.ref.sha256, ref.sha256);

  await store.deleteForRun("run-n");
  assert.equal(await store.load("run-n", ref.id), null);
});
