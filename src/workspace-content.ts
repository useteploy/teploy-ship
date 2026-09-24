import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { upsertByKey } from "./upsert.js";

export const WORKSPACE_CONTENT_BYTES = 200_000;
const TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 8192;
type Manifest = { bytes: number; chunks: number; digest: string; expires: string };

/** Temporary editor transport, scoped to a run AND a request; never a public artifact. */
export interface WorkspaceContentStore {
  put(runId: string, requestId: string, content: string): Promise<void>;
  get(runId: string, requestId: string): Promise<string>;
  prune(): Promise<void>;
}

function key(runId: string, requestId: string): string {
  if (![runId, requestId].every(s => /^[A-Za-z0-9_-]{1,100}$/.test(s)))
    throw new Error("Invalid workspace content reference");
  return `${runId}:${requestId}`;
}
function encode(content: string): { manifest: Manifest; data: string } {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > WORKSPACE_CONTENT_BYTES)
    throw new Error(`File content is limited to ${WORKSPACE_CONTENT_BYTES} UTF-8 bytes`);
  const data = bytes.toString("base64");
  return { data, manifest: {
    bytes: bytes.length, chunks: Math.ceil(data.length / CHUNK_BYTES),
    digest: createHash("sha256").update(bytes).digest("hex"),
    expires: new Date(Date.now() + TTL_MS).toISOString(),
  } };
}
function manifest(raw: unknown): Manifest {
  const m = raw as Manifest | null;
  if (!m || !Number.isInteger(m.bytes) || m.bytes < 0 || m.bytes > WORKSPACE_CONTENT_BYTES
    || m.chunks !== Math.ceil(Math.ceil(m.bytes / 3) * 4 / CHUNK_BYTES)
    || !/^[a-f0-9]{64}$/.test(m.digest) || !Number.isFinite(Date.parse(m.expires)))
    throw new Error("Invalid workspace content manifest");
  if (Date.parse(m.expires) <= Date.now()) throw new Error("Editor content expired; open the file again");
  return m;
}
function decode(m: Manifest, data: string): string {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== m.bytes || createHash("sha256").update(bytes).digest("hex") !== m.digest)
    throw new Error("Editor content is incomplete or corrupt; open the file again");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class FileWorkspaceContent implements WorkspaceContentStore {
  constructor(private dir = join(stateDir(), "workspace-content")) {}
  async put(runId: string, requestId: string, content: string): Promise<void> {
    await writeJsonFile(join(this.dir, key(runId, requestId).replace(":", ".") + ".json"), encode(content));
  }
  async get(runId: string, requestId: string): Promise<string> {
    const row = await readJsonFile<{ manifest: Manifest; data: string } | null>(join(this.dir, key(runId, requestId).replace(":", ".") + ".json"), null);
    if (!row) throw new Error("Editor content is missing; open the file again");
    return decode(manifest(row.manifest), row.data);
  }
  async prune(): Promise<void> {
    let files: string[];
    try { files = await readdir(this.dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const file of files) {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.json$/.test(file)) continue;
      const row = await readJsonFile<{ manifest: Manifest } | null>(join(this.dir, file), null);
      if (row && Date.parse(row.manifest?.expires) <= Date.now()) await unlink(join(this.dir, file));
    }
  }
}

export class NucleusWorkspaceContent implements WorkspaceContentStore {
  private ready?: Promise<unknown>;
  constructor(private db: NucleusPgwire) {}
  private async ensure() {
    await (this.ready ??= this.db.query("CREATE TABLE IF NOT EXISTS ship_workspace_content (content_key TEXT, content_value TEXT, expires_at TEXT)")
      .catch(e => { this.ready = undefined; throw e; }));
  }
  private async write(k: string, value: string, expires: string) {
    await upsertByKey(this.db, {
      table: "ship_workspace_content", keyColumn: "content_key", key: k,
      update: () => this.db.query("UPDATE ship_workspace_content SET content_value = $1, expires_at = $2 WHERE content_key = $3", [value, expires, k]),
      insert: () => this.db.query("INSERT INTO ship_workspace_content (content_key, content_value, expires_at) VALUES ($1, $2, $3)", [k, value, expires]),
    });
    if (await this.read(k) !== value) throw new Error("Editor content write did not settle; retry the request");
  }
  private async read(k: string): Promise<string | null> {
    const rows = await this.db.query("SELECT content_value FROM ship_workspace_content WHERE content_key = $1", [k]);
    return typeof rows[0]?.content_value === "string" ? rows[0].content_value : null;
  }
  async put(runId: string, requestId: string, content: string): Promise<void> {
    const k = key(runId, requestId), { manifest: m, data } = encode(content);
    await this.ensure();
    for (let i = 0; i < m.chunks; i++) await this.write(`${k}:${i}`, data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), m.expires);
    await this.write(k, JSON.stringify(m), m.expires);
  }
  async get(runId: string, requestId: string): Promise<string> {
    const k = key(runId, requestId);
    await this.ensure();
    const raw = await this.read(k);
    if (raw === null) throw new Error("Editor content is missing; open the file again");
    const m = manifest(JSON.parse(raw));
    let data = "";
    for (let i = 0; i < m.chunks; i++) {
      const chunk = await this.read(`${k}:${i}`);
      if (chunk === null) throw new Error("Editor content is incomplete; open the file again");
      data += chunk;
    }
    return decode(m, data);
  }
  async prune(): Promise<void> {
    await this.ensure();
    await this.db.query("DELETE FROM ship_workspace_content WHERE expires_at < $1", [new Date().toISOString()]);
  }
}
