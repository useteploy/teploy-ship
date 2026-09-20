import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { upsertByKey } from "./upsert.js";
export interface Artifact {
  id: string;
  name: string;
  mime: "image/png" | "video/webm";
  data: string;
  bytes: number;
}
export interface ArtifactStore {
  put(name: string, bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Artifact | null>;
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
  if (!png && !webm)
    throw new Error("Only PNG images and WebM recordings are supported");
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    name: name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120),
    mime: png ? "image/png" : "video/webm",
    data: Buffer.from(bytes).toString("base64"),
    bytes: bytes.length,
  };
}
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export class FileArtifacts implements ArtifactStore {
  constructor(private dir = join(stateDir(), "artifacts")) {}
  async put(name: string, bytes: Uint8Array): Promise<string> {
    const a = artifact(name, bytes);
    await writeJsonFile(join(this.dir, a.id + ".json"), a);
    return a.id;
  }
  async get(id: string): Promise<Artifact | null> {
    return validId(id)
      ? readJsonFile(join(this.dir, id + ".json"), null)
      : null;
  }
}
/** Dedicated table; 8 KiB chunks fit Nucleus’s 16 KiB inline row limit. Manifest is written last. */
export class NucleusArtifacts implements ArtifactStore {
  private ready: Promise<unknown> | undefined;
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
    const a = artifact(name, bytes);
    await this.ensure();
    const size = 8192,
      chunks = Math.ceil(a.data.length / size);
    for (let i = 0; i < chunks; i++)
      await this.write(`${a.id}:${i}`, a.data.slice(i * size, (i + 1) * size));
    await this.write(a.id, JSON.stringify({ ...a, data: "", chunks }));
    return a.id;
  }
  async get(id: string): Promise<Artifact | null> {
    if (!validId(id)) return null;
    await this.ensure();
    const raw = await this.read(id);
    if (!raw) return null;
    const a = JSON.parse(raw) as Artifact & { chunks: number };
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
      createHash("sha256").update(bytes).digest("hex") !== id
    )
      throw new Error("Artifact integrity check failed");
    return { ...a, data };
  }
}
