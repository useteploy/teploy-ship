import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventStore, WorkflowEvent } from "@neutron-build/workflow";
import { assertSafeId, readJsonFile, writeJsonFile, withFileLock } from "./file-store.js";
import { stateDir, type RunMeta, type RunMetaStore } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

export interface LaunchIntent {
  runId: string;
  requestHash: string;
  started: WorkflowEvent;
  meta: RunMeta;
  /** Cancel this held merge review before making the child runnable. */
  reviewParent?: string;
}
export interface LaunchJournal {
  get(runId: string): Promise<LaunchIntent | null>;
  prepare(intent: LaunchIntent): Promise<LaunchIntent>;
  publish(intent: LaunchIntent): Promise<void>;
  /** Bounded ID page; decoding failures are isolated during recovery. */
  pending(after?: string): Promise<string[]>;
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Object key order is not part of request identity. Array order is. */
export function launchRequestHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])) : v;
  return hash(JSON.stringify(canonical(value)));
}
/** Metadata is a display/index projection. Preserve full intent in the journal
 * and event log, but keep SQL's inline metadata row bounded (Nucleus v1.1.1). */
export function launchMetadata(intent: LaunchIntent): RunMeta {
  const raw = Buffer.from(intent.meta.task, "utf8");
  const task = raw.length <= 4000 ? intent.meta.task : raw.subarray(0,4000).toString("utf8").replace(/\ufffd$/, "") + "…";
  const meta = {...intent.meta,task};
  if (Buffer.byteLength(JSON.stringify(meta)) > 6000) throw new Error("Launch metadata exceeds the supported size");
  return meta;
}

function validate(intent: LaunchIntent): void {
  assertSafeId("run id",intent.runId);
  if (!/^[a-f0-9]{64}$/.test(intent.requestHash) || intent.meta.runId !== intent.runId || intent.started.type !== "run-started" || intent.started.seq !== 0) {
    throw new Error("Invalid launch intent");
  }
  if (intent.reviewParent !== undefined) {
    assertSafeId("review parent", intent.reviewParent);
    if (intent.reviewParent === intent.runId) throw new Error("A revision cannot replace itself");
  }
  launchMetadata(intent);
  if (Buffer.byteLength(JSON.stringify(intent)) > 1024*1024) throw new Error("Launch intent exceeds 1 MiB");
}
export function assertSameLaunch(intent: LaunchIntent, requestHash: string): void {
  if (intent.requestHash !== requestHash) throw new Error("This request ID already belongs to a different launch");
}
async function ensureStarted(store: EventStore, intent: LaunchIntent): Promise<void> {
  let events = await store.load(intent.runId);
  if (!events.length) {
    await store.append(intent.runId,intent.started);
    events = await store.load(intent.runId);
  }
  const first = events.find(e=>e.type==="run-started");
  if (!first || launchRequestHash(first) !== launchRequestHash(intent.started)) throw new Error("Run history conflicts with its accepted launch intent");
}

/** File mode is single-process. A persisted intent survives process failure;
 * retry repairs missing projections and never resets an existing run's state.
 */
export class FileLaunchJournal implements LaunchJournal {
  constructor(private store: EventStore, private meta: Pick<RunMetaStore,"load"|"save">, private dir=join(stateDir(),"launches"), private beforePublish?: (intent:LaunchIntent)=>Promise<void>) {}
  private path(id:string) { return join(this.dir,assertSafeId("run id",id)+".json"); }
  async get(id:string):Promise<LaunchIntent|null> {
    const entry = await readJsonFile<{intent:LaunchIntent;published:boolean}|null>(this.path(id),null);
    if (!entry) return null;
    validate(entry.intent);
    if (entry.intent.runId !== id) throw new Error("Launch file identity mismatch");
    return entry.intent;
  }
  async prepare(intent:LaunchIntent):Promise<LaunchIntent> {
    validate(intent);
    return withFileLock(this.path(intent.runId),async()=>{
      const existing=await this.get(intent.runId);
      if(existing){assertSameLaunch(existing,intent.requestHash);return existing;}
      if((await this.store.load(intent.runId)).length) throw new Error("Run ID already has history outside the launch journal");
      await writeJsonFile(this.path(intent.runId),{intent,published:false});
      return intent;
    });
  }
  async publish(intent:LaunchIntent):Promise<void> {
    await withFileLock(this.path(intent.runId),async()=>{
      const entry=await readJsonFile<{intent:LaunchIntent;published:boolean}|null>(this.path(intent.runId),null);
      if(!entry)throw new Error("Launch intent has not been accepted");
      assertSameLaunch(entry.intent,intent.requestHash);
      if(entry.published)return;
      if (entry.intent.reviewParent && !this.beforePublish) throw new Error("Revision recovery is unavailable");
      await this.beforePublish?.(entry.intent);
      await ensureStarted(this.store,entry.intent);
      if(await this.meta.load(intent.runId)===null)await this.meta.save(launchMetadata(entry.intent));
      await writeJsonFile(this.path(intent.runId),{intent:entry.intent,published:true});
    });
  }
  async pending(after?:string):Promise<string[]> {
    let names:string[];
    try { names=await readdir(this.dir); } catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    const out:string[]=[];
    for(const name of names.filter(n=>n.endsWith(".json")).sort()){
      const id=name.slice(0,-5);
      if(after !== undefined && id <= after)continue;
      try {
        const entry=await readJsonFile<{published:boolean}|null>(join(this.dir,name),null);
        if(entry?.published)continue;
      } catch { /* Include a corrupt file so recovery reports it individually. */ }
      out.push(id);
      if(out.length===100)break;
    }
    return out;
  }
}

/** SQL primary keys arbitrate acceptance and projection, without expiring
 * ownership. SQL commit publishes metadata, scheduling and the receipt together.
 * Large immutable intents use 8 KiB base64 chunks to fit Nucleus inline rows.
 */
export class NucleusLaunchJournal implements LaunchJournal {
  private ready:Promise<void>|undefined;
  constructor(private db:NucleusPgwire,private store:EventStore, private beforePublish?: (intent:LaunchIntent)=>Promise<void>) {}
  private ensure():Promise<void> {
    return this.ready??=(async()=>{
      await this.db.query("CREATE TABLE IF NOT EXISTS ship_launch_chunks (chunk_id TEXT PRIMARY KEY, value TEXT)");
      await this.db.query("CREATE TABLE IF NOT EXISTS ship_launches (run_id TEXT PRIMARY KEY, request_hash TEXT, blob_id TEXT, parts TEXT, bytes TEXT, state TEXT, created_at TEXT)");
      await this.db.query("CREATE TABLE IF NOT EXISTS ship_launch_commits (run_id TEXT PRIMARY KEY)");
    })().catch(error=>{this.ready=undefined;throw error;});
  }
  private async decode(row:Record<string,unknown>):Promise<LaunchIntent> {
    const count=Number(row.parts),bytes=Number(row.bytes),id=String(row.blob_id);
    if(!/^[a-f0-9]{64}$/.test(id)||!Number.isSafeInteger(count)||count<1||count>172||!Number.isSafeInteger(bytes)||bytes<1||bytes>1024*1024)throw new Error("Invalid launch manifest");
    const chunks:Buffer[]=[];
    for(let i=0;i<count;i++){
      const [part]=await this.db.query("SELECT value FROM ship_launch_chunks WHERE chunk_id = $1",[`${id}:${i}`]);
      if(typeof part?.value!=="string")throw new Error("Accepted launch is missing an intent chunk");
      chunks.push(Buffer.from(part.value,"base64"));
    }
    const body=Buffer.concat(chunks);
    if(body.length!==bytes||hash(body)!==id)throw new Error("Launch intent integrity check failed");
    const intent=JSON.parse(body.toString("utf8")) as LaunchIntent;
    validate(intent);
    if(intent.runId!==row.run_id||intent.requestHash!==row.request_hash)throw new Error("Launch manifest identity mismatch");
    return intent;
  }
  async get(runId:string):Promise<LaunchIntent|null> {
    assertSafeId("run id",runId);await this.ensure();
    const [row]=await this.db.query("SELECT * FROM ship_launches WHERE run_id = $1",[runId]);
    return row?this.decode(row):null;
  }
  async prepare(intent:LaunchIntent):Promise<LaunchIntent> {
    validate(intent);await this.ensure();
    const existing=await this.get(intent.runId);
    if(existing){assertSameLaunch(existing,intent.requestHash);return existing;}
    if((await this.store.load(intent.runId)).length)throw new Error("Run ID already has history outside the launch journal");
    const bytes=Buffer.from(JSON.stringify(intent)),id=hash(bytes),parts=Math.ceil(bytes.length/6144);
    for(let i=0;i<parts;i++){
      try {await this.db.query("INSERT INTO ship_launch_chunks (chunk_id,value) VALUES ($1,$2)",[`${id}:${i}`,bytes.subarray(i*6144,(i+1)*6144).toString("base64")]);}
      catch(error){if((error as {code?:string}).code!=="23505")throw error;}
    }
    try {await this.db.query("INSERT INTO ship_launches (run_id,request_hash,blob_id,parts,bytes,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",[intent.runId,intent.requestHash,id,String(parts),String(bytes.length),"pending",intent.meta.createdAt]);}
    catch(error){if((error as {code?:string}).code!=="23505")throw error;}
    const accepted=await this.get(intent.runId);
    if(!accepted)throw new Error("Launch acceptance could not be read back");
    assertSameLaunch(accepted,intent.requestHash);return accepted;
  }
  async publish(intent:LaunchIntent):Promise<void> {
    await this.ensure();
    const accepted=await this.get(intent.runId);
    if(!accepted)throw new Error("Launch intent has not been accepted");
    assertSameLaunch(accepted,intent.requestHash);
    if ((await this.db.query("SELECT run_id FROM ship_launch_commits WHERE run_id = $1",[accepted.runId])).length) return;
    if (accepted.reviewParent && !this.beforePublish) throw new Error("Revision recovery is unavailable");
    await this.beforePublish?.(accepted);
    await ensureStarted(this.store,accepted);
    try {
      await this.db.transaction(async tx=>{
        // The unique fence and all SQL projections commit or roll back together.
        await tx.query("INSERT INTO ship_launch_commits (run_id) VALUES ($1)",[accepted.runId]);
        for(const collection of ["ship_meta","ship_runs"]){
          if((await tx.document.find(collection,{runId:accepted.runId})).length)throw new Error("Launch projection already exists without its commit receipt");
        }
        await tx.document.insert("ship_meta",{...launchMetadata(accepted)});
        await tx.document.insert("ship_runs",{runId:accepted.runId,workflow:(accepted.started.data as {workflow:string}).workflow,status:"wake",updatedAt:accepted.meta.updatedAt});
        const changed = await tx.exec("UPDATE ship_launches SET state = 'published' WHERE run_id = $1",[accepted.runId]);
        if (changed !== 1) throw new Error("Launch manifest disappeared during publication");
      });
    }catch(error){
      if((error as {code?:string}).code!=="23505")throw error;
      if(!(await this.db.query("SELECT run_id FROM ship_launch_commits WHERE run_id = $1",[accepted.runId])).length)throw error;
    }
  }
  async pending(after?:string):Promise<string[]> {
    await this.ensure();
    const rows=await this.db.query(`SELECT run_id FROM ship_launches WHERE state = 'pending'${after === undefined ? "" : " AND run_id > $1"} ORDER BY run_id LIMIT 100`,after === undefined ? [] : [after]);
    return rows.map(row=>String(row.run_id));
  }
}

/** Repair only already accepted work. Never enqueue a new intent or re-check a
 * model's guess. A bad record cannot prevent unrelated accepted work recovering.
 * Advance through bounded pages even when the first page contains bad records.
 */
export async function recoverLaunches(journal: LaunchJournal, options: {
  after?: string;
  onError?: (runId: string, error: unknown) => void;
} = {}): Promise<{ recovered: string[]; after?: string }> {
  const ids = await journal.pending(options.after);
  const recovered: string[] = [];
  for (const id of ids) {
    try {
      const intent = await journal.get(id);
      if (!intent) throw new Error("Pending launch intent is missing");
      await journal.publish(intent);
      recovered.push(id);
    } catch (error) { options.onError?.(id,error); }
  }
  return { recovered, ...(ids.length === 100 ? { after: ids.at(-1)! } : {}) };
}
