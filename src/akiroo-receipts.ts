import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

export interface AkirooReceipt {
  status: "processing" | "succeeded" | "rejected" | "unknown";
  detail: string;
  startedAt: number;
}

export interface AkirooReceipts {
  get(key: string): Promise<AkirooReceipt | undefined>;
  put(key: string, receipt: AkirooReceipt): Promise<void>;
}

export class FileAkirooReceipts implements AkirooReceipts {
  #path: string;
  constructor(dir = stateDir()) { this.#path = join(dir, "akiroo-receipts.json"); }
  async get(key: string): Promise<AkirooReceipt | undefined> {
    return (await readJsonFile<Record<string, AkirooReceipt>>(this.#path, {}))[key];
  }
  async put(key: string, receipt: AkirooReceipt): Promise<void> {
    await updateJsonFile<Record<string, AkirooReceipt>>(this.#path, {}, (all) => ({ ...all, [key]: receipt }));
  }
}

export class NucleusAkirooReceipts implements AkirooReceipts {
  #db: NucleusPgwire;
  #ready: Promise<void> | undefined;
  constructor(db: NucleusPgwire) { this.#db = db; }
  async #ensure(): Promise<void> {
    this.#ready ??= this.#db.query("CREATE TABLE IF NOT EXISTS ship_akiroo_receipts (receipt_key TEXT, payload TEXT)")
      .then(() => {}).catch((error: unknown) => { this.#ready = undefined; throw error; });
    await this.#ready;
  }
  async get(key: string): Promise<AkirooReceipt | undefined> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT payload FROM ship_akiroo_receipts WHERE receipt_key=$1", [key]);
    return rows.length === 0 ? undefined : JSON.parse(String(rows[0]!.payload)) as AkirooReceipt;
  }
  async put(key: string, receipt: AkirooReceipt): Promise<void> {
    await this.#ensure();
    const payload = JSON.stringify(receipt);
    const n = await this.#db.exec("UPDATE ship_akiroo_receipts SET payload=$1 WHERE receipt_key=$2", [payload, key]);
    if (n === 0) await this.#db.query("INSERT INTO ship_akiroo_receipts (receipt_key,payload) VALUES ($1,$2)", [key, payload]);
  }
}
