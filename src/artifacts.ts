import { createHash, randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { upsertByKey } from "./upsert.js";
export interface Artifact {
  id: string;
  name: string;
  mime: "image/png" | "image/jpeg" | "video/webm";
  data: string;
  bytes: number;
}
export interface ArtifactStore {
  put(name: string, bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Artifact | null>;
  putTemporary?(name: string, bytes: Uint8Array): Promise<string>;
  pruneExpired?(): Promise<void>;
}
function artifact(name: string, bytes: Uint8Array): Artifact {
  if (bytes.length > 4 * 1024 * 1024 || !bytes.length)
    throw new Error("Artifact must be between 1 byte and 4 MiB");
  const png = Buffer.from(bytes.subarray(0, 8)).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const webm = Buffer.from(bytes.subarray(0, 4)).equals(
    Buffer.from([26, 69, 223, 163]),
  );
  // The takeover BROWSER tab falls back to JPEG when a PNG would exceed its cap.
  const jpeg = Buffer.from(bytes.subarray(0, 3)).equals(Buffer.from([255, 216, 255]));
  if (!png && !webm && !jpeg)
    throw new Error("Only PNG/JPEG images and WebM recordings are supported");
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    name: name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120),
    mime: png ? "image/png" : jpeg ? "image/jpeg" : "video/webm",
    data: Buffer.from(bytes).toString("base64"),
    bytes: bytes.length,
  };
}
export const SCREENSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type StoredArtifact = Artifact & { digest?: string; expiresAt?: string };
function temporary(name: string, bytes: Uint8Array): StoredArtifact {
  const a = artifact(name, bytes);
  // A distinct identity prevents expiry from deleting a permanent artifact
  // with identical pixels, or a newer capture with a different expiry.
  return { ...a, digest: a.id,
    id: createHash("sha256").update(randomUUID()).update(a.id).digest("hex"),
    expiresAt: new Date(Date.now() + SCREENSHOT_RETENTION_MS).toISOString() };
}
const expired = (a: StoredArtifact) => a.expiresAt !== undefined && Date.parse(a.expiresAt) <= Date.now();
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export class FileArtifacts implements ArtifactStore {
  constructor(private dir = join(stateDir(), "artifacts")) {}
  async put(name: string, bytes: Uint8Array): Promise<string> {
    const a = artifact(name, bytes);
    await writeJsonFile(join(this.dir, a.id + ".json"), a);
    return a.id;
  }
  async putTemporary(name: string, bytes: Uint8Array): Promise<string> {
    const a = temporary(name, bytes);
    await writeJsonFile(join(this.dir, a.id + ".json"), a);
    return a.id;
  }
  async get(id: string): Promise<Artifact | null> {
    if (!validId(id)) return null;
    const a = await readJsonFile<StoredArtifact | null>(join(this.dir, id + ".json"), null);
    return a && !expired(a) ? a : null;
  }
  async pruneExpired(): Promise<void> {
    let files: string[];
    try { files = await readdir(this.dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const a = await readJsonFile<StoredArtifact | null>(join(this.dir, file), null);
      if (a && expired(a)) await unlink(join(this.dir, file));
    }
  }
}
/** Dedicated table; 8 KiB chunks fit Nucleus’s 16 KiB inline row limit. Manifest is written last. */
export class NucleusArtifacts implements ArtifactStore {
  private ready: Promise<unknown> | undefined;
  private expiryReady?: Promise<unknown>;
  constructor(private db: NucleusPgwire) {}
  private async ensure() {
    await (this.ready ??= this.db
      .query(
        "CREATE TABLE IF NOT EXISTS ship_artifacts (artifact_key TEXT, artifact_value TEXT)",
      )
      .catch((e) => {
        this.ready = undefined;
        throw e;
      }));
  }
  private async ensureExpiry() {
    await this.ensure();
    await (this.expiryReady ??= this.db.query("CREATE TABLE IF NOT EXISTS ship_artifact_expiry (artifact_id TEXT, expires_at TEXT, chunks TEXT)")
      .catch(e => { this.expiryReady = undefined; throw e; }));
  }
  private async write(key: string, value: string) {
    await upsertByKey(this.db, {
      table: "ship_artifacts",
      keyColumn: "artifact_key",
      key,
      update: () =>
        this.db.query(
          "UPDATE ship_artifacts SET artifact_value = $1 WHERE artifact_key = $2",
          [value, key],
        ),
      insert: () =>
        this.db.query(
          "INSERT INTO ship_artifacts (artifact_key, artifact_value) VALUES ($1, $2)",
          [key, value],
        ),
    });
    if ((await this.read(key)) !== value)
      throw new Error("Artifact write did not settle; retry the capture");
  }
  private async read(key: string) {
    const r = await this.db.query(
      "SELECT artifact_value FROM ship_artifacts WHERE artifact_key = $1",
      [key],
    );
    return typeof r[0]?.artifact_value === "string"
      ? r[0].artifact_value
      : null;
  }
  async put(name: string, bytes: Uint8Array): Promise<string> {
    return this.store(artifact(name, bytes));
  }
  private async store(a: StoredArtifact): Promise<string> {
    await this.ensure();
    const size = 8192,
      chunks = Math.ceil(a.data.length / size);
    for (let i = 0; i < chunks; i++)
      await this.write(`${a.id}:${i}`, a.data.slice(i * size, (i + 1) * size));
    await this.write(a.id, JSON.stringify({ ...a, data: "", chunks }));
    return a.id;
  }
  async putTemporary(name: string, bytes: Uint8Array): Promise<string> {
    const a = temporary(name, bytes);
    await this.ensureExpiry();
    // Index first so even a partial chunk write can be collected later.
    await this.db.query("INSERT INTO ship_artifact_expiry (artifact_id, expires_at, chunks) VALUES ($1, $2, $3)",
      [a.id, a.expiresAt, String(Math.ceil(a.data.length / 8192))]);
    return this.store(a);
  }
  async pruneExpired(): Promise<void> {
    await this.ensureExpiry();
    const rows = await this.db.query("SELECT artifact_id, chunks FROM ship_artifact_expiry WHERE expires_at < $1", [new Date().toISOString()]);
    for (const row of rows) {
      const id = String(row.artifact_id), chunks = Number(row.chunks);
      if (!validId(id) || !Number.isInteger(chunks) || chunks < 1 || chunks > 683)
        throw new Error("Invalid temporary artifact expiry record");
      for (let i = 0; i < chunks; i++)
        await this.db.query("DELETE FROM ship_artifacts WHERE artifact_key = $1", [`${id}:${i}`]);
      await this.db.query("DELETE FROM ship_artifacts WHERE artifact_key = $1", [id]);
      await this.db.query("DELETE FROM ship_artifact_expiry WHERE artifact_id = $1", [id]);
    }
  }
  async get(id: string): Promise<Artifact | null> {
    if (!validId(id)) return null;
    await this.ensure();
    const raw = await this.read(id);
    if (!raw) return null;
    const a = JSON.parse(raw) as StoredArtifact & { chunks: number };
    if (expired(a)) return null;
    if (!Number.isInteger(a.chunks) || a.chunks < 1 || a.chunks > 683)
      throw new Error("Invalid artifact manifest");
    let data = "";
    for (let i = 0; i < a.chunks; i++) {
      const chunk = await this.read(`${id}:${i}`);
      if (chunk === null) throw new Error("Artifact incomplete");
      data += chunk;
    }
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.length !== a.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== (a.digest ?? id)
    )
      throw new Error("Artifact integrity check failed");
    return { ...a, data };
  }
}
