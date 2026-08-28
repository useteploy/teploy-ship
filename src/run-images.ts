import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

/**
 * Screenshots for durable runs, stored ASIDE from the event log.
 *
 * The log records every observation because that is what makes replay work —
 * which is exactly why an image cannot live in it: a base64 PNG in a
 * step-completed result bloats every load, slows every resume, and turns the
 * run's timeline into megabytes of noise. An image is stored here and the
 * observation carries a one-line REFERENCE instead:
 *
 *   [ship-image id=img-ab12cd34ef56 sha256=<hex> bytes=18432 mime=image/png]
 *
 * The reference is plain text, so nothing about the event wire format changes
 * (strings stay strings, replay stays byte-compatible) and the sha256 in the
 * line is what lets a load verify the bytes are the bytes the log meant.
 *
 * Missing image on replay is an ERROR, not a placeholder: a silently swapped
 * or absent image would corrupt what the agent "saw" while the run stays
 * green — the exact shape this codebase's telemetry bug already proved a
 * suite cannot catch. Reverse only if resume flapping proves costly.
 */

export interface RunImageRef {
  /** Short id, unique within a run, safe to embed in observation text. */
  id: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface RunImageStore {
  /** Persist bytes for a run; returns the reference the log will carry. */
  save(runId: string, data: Uint8Array, mime: string): Promise<RunImageRef>;
  /** Load one image; null when the store no longer holds it. */
  load(runId: string, id: string): Promise<{ ref: RunImageRef; data: Uint8Array } | null>;
  /** Retention parity with the run: nothing outlives its log. */
  deleteForRun(runId: string): Promise<void>;
}

const refToLine = (ref: RunImageRef): string =>
  `[ship-image id=${ref.id} sha256=${ref.sha256} bytes=${ref.bytes} mime=${ref.mime}]`;

const REF_LINE = /\[ship-image id=(img-[0-9a-f]{12}) sha256=([0-9a-f]{64}) bytes=(\d+) mime=([^\]\s]+)\]/g;

/** The reference line an observation carries, in one spelling. */
export function imageRefLine(ref: RunImageRef): string {
  return refToLine(ref);
}

/** Every image reference embedded in a text, in order. */
export function parseImageRefs(text: string): RunImageRef[] {
  const out: RunImageRef[] = [];
  for (const m of text.matchAll(REF_LINE)) {
    out.push({ id: m[1]!, sha256: m[2]!, bytes: Number(m[3]!), mime: m[4]! });
  }
  return out;
}

/** Loading a referenced image that the store no longer holds. */
export class MissingRunImageError extends Error {
  constructor(ref: RunImageRef) {
    super(
      `run image ${ref.id} (sha256 ${ref.sha256.slice(0, 12)}…) is missing from the store — ` +
        `the log references an image the store no longer holds, so what the agent saw cannot be reconstructed`,
    );
    this.name = "MissingRunImageError";
  }
}

/**
 * Resolve every reference in a text into bytes, verifying integrity.
 *
 * The named-error seam: a replay whose images are gone fails HERE, with the
 * id in the message, rather than feeding the model a placeholder it will
 * reason over as though it were the screenshot.
 */
export async function resolveImageRefs(
  text: string,
  runId: string,
  load: (runId: string, id: string) => Promise<{ ref: RunImageRef; data: Uint8Array } | null>,
): Promise<Array<{ ref: RunImageRef; data: Uint8Array }>> {
  const out: Array<{ ref: RunImageRef; data: Uint8Array }> = [];
  for (const ref of parseImageRefs(text)) {
    const found = await load(runId, ref.id);
    if (found === null) throw new MissingRunImageError(ref);
    const sha256 = createHash("sha256").update(found.data).digest("hex");
    if (sha256 !== ref.sha256) {
      throw new Error(
        `run image ${ref.id} fails integrity: the log recorded sha256 ${ref.sha256}, the store holds ${sha256}`,
      );
    }
    out.push(found);
  }
  return out;
}

function newImageId(): string {
  return `img-${randomBytes(6).toString("hex")}`;
}

export class FileRunImages implements RunImageStore {
  #dir: string;

  constructor(dir = join(stateDir(), "run-images")) {
    this.#dir = dir;
  }

  async save(runId: string, data: Uint8Array, mime: string): Promise<RunImageRef> {
    const ref: RunImageRef = {
      id: newImageId(),
      mime,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    const dir = join(this.#dir, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${ref.id}.bin`), data);
    await writeFile(join(dir, `${ref.id}.json`), JSON.stringify(ref, null, 2));
    return ref;
  }

  async load(runId: string, id: string): Promise<{ ref: RunImageRef; data: Uint8Array } | null> {
    try {
      const ref = JSON.parse(await readFile(join(this.#dir, runId, `${id}.json`), "utf8")) as RunImageRef;
      const data = new Uint8Array(await readFile(join(this.#dir, runId, `${id}.bin`)));
      return { ref, data };
    } catch {
      return null;
    }
  }

  async deleteForRun(runId: string): Promise<void> {
    await rm(join(this.#dir, runId), { recursive: true, force: true });
  }
}

/**
 * Nucleus-backed. The bytes travel as base64 TEXT: the pgwire transport is
 * text-shaped, and the encoding cost is paid once per image rather than once
 * per log read — which is the whole point of storing them aside.
 */
export class NucleusRunImages implements RunImageStore {
  #db: NucleusPgwire;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  async #ensure(): Promise<void> {
    await this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ship_run_images (
         run_id TEXT NOT NULL,
         id TEXT NOT NULL,
         mime TEXT NOT NULL,
         bytes BIGINT NOT NULL,
         sha256 TEXT NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (run_id, id)
       )`,
    );
  }

  async save(runId: string, data: Uint8Array, mime: string): Promise<RunImageRef> {
    await this.#ensure();
    const ref: RunImageRef = {
      id: newImageId(),
      mime,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    await this.#db.exec(
      `INSERT INTO ship_run_images (run_id, id, mime, bytes, sha256, data) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, ref.id, ref.mime, ref.bytes, ref.sha256, Buffer.from(data).toString("base64")],
    );
    return ref;
  }

  async load(runId: string, id: string): Promise<{ ref: RunImageRef; data: Uint8Array } | null> {
    await this.#ensure();
    const rows = await this.#db.query(
      `SELECT mime, bytes, sha256, data FROM ship_run_images WHERE run_id = $1 AND id = $2`,
      [runId, id],
    );
    const row = rows[0] as { mime: string; bytes: string | number; sha256: string; data: string } | undefined;
    if (row === undefined) return null;
    return {
      ref: { id, mime: row.mime, bytes: Number(row.bytes), sha256: row.sha256 },
      data: new Uint8Array(Buffer.from(row.data, "base64")),
    };
  }

  async deleteForRun(runId: string): Promise<void> {
    await this.#ensure();
    await this.#db.exec(`DELETE FROM ship_run_images WHERE run_id = $1`, [runId]);
  }
}
