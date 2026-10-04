import type {EventStore} from '@neutron-build/workflow';
import type {RecordInput,RepoMemoryStore,RepoNote} from './repo-memory.js';
import type {KnowledgeMode,KnowledgeProvenance,RetrievalContext} from './knowledge-provenance.js';
import {canonicalRepositoryURL} from './repository-reference.js';
import {repoKeyOf} from './repository-scope.js';

/** Read legacy notes only when their recorded run proves the requested origin.
 * Manual/unattributed notes remain available in Knowledge, never guessed into
 * another repository's model context. Older parked workflows keep their v1 key.
 *
 * Case twins (S01-3): a clone URL is recorded under its canonical key, and a
 * read gathers every stored spelling of the same repository — v2 keys that
 * canonicalize to it, and v1 `host/owner/name` keys that match it
 * case-insensitively (v1 kept the owner's case, so a `Tyler/app` run and a
 * `tyler/app` run filed their notes apart). Stored rows are never rewritten;
 * legacy notes still pass the recorded-run proof before entering context.
 */
export class ScopedRepoMemory implements RepoMemoryStore {
  /** `provenance` is S21 (SHIP_KNOWLEDGE_PROVENANCE); absent or mode off => every method below is the pre-S21 behaviour. */
  constructor(private inner:RepoMemoryStore,private events:EventStore,private provenance?:KnowledgeProvenance){}
  provenanceMode():KnowledgeMode{return this.provenance?.mode??'off'}
  async record(input:RecordInput){
    const {provenance:hint,...note}=input;
    const stored=await this.inner.record({...note,repo:canonicalRepositoryURL(note.repo)??note.repo});
    // Advisory, like the note itself: a provenance failure never fails a record.
    await this.provenance?.recordNote(stored,hint).catch(()=>{});
    return stored;
  }
  repos(){return this.inner.repos()}
  async remove(id:string,repo?:string){
    await this.inner.remove(id,repo);
    if(this.provenance===undefined||this.provenance.mode==='off')return;
    // Redaction must not be skipped silently: `on` surfaces a failure to the
    // caller, shadow logs it (a shadow record holds the deleted note's text).
    try{
      const {deleted}=await this.provenance.redact([id],repo);
      for(const d of deleted)await this.inner.remove(d,repo);
    }catch(error){
      if(this.provenance.mode==='on')throw error;
      console.error(JSON.stringify({event:'knowledge-provenance-error',op:'redact',noteId:id,error:String(error)}));
    }
  }
  recordSummary(input:{id:string;repo:string;runId:string;summary:string;derivedFrom:string[]}){return this.provenance?.recordSummary(input)??Promise.resolve()}
  async recent(repo:string,limit:number,options?:{context?:RetrievalContext}):Promise<RepoNote[]> {
    const p=this.provenance;
    if(p===undefined||p.mode==='off'||options?.context===undefined)return this.#gather(repo,limit);
    // `on` filters after the limit, so over-fetch to keep the block full; shadow never changes the result.
    const notes=await this.#gather(repo,p.mode==='on'?limit*3:limit);
    const screened=await p.screen(repo,notes,options.context);
    return p.mode==='on'?screened.slice(0,limit):notes;
  }
  async #gather(repo:string,limit:number):Promise<RepoNote[]> {
    const identity=canonicalRepositoryURL(repo);
    if(!identity)return this.inner.recent(repo,limit);
    const v1=repoKeyOf(identity);
    const stored=(await this.inner.repos().catch(()=>[])).map(r=>r.repo);
    const currentKeys=new Set([identity,...stored.filter(k=>canonicalRepositoryURL(k)===identity)]);
    const legacyKeys=new Set([v1,...stored.filter(k=>canonicalRepositoryURL(k)===null&&k.toLowerCase()===v1)]);
    const [current,legacy]=await Promise.all([
      Promise.all([...currentKeys].map(k=>this.inner.recent(k,limit))).then(r=>r.flat().map(note=>({...note,repo:identity}))),
      Promise.all([...legacyKeys].map(k=>this.inner.recent(k,100))).then(r=>r.flat()),
    ]);
    const accepted:RepoNote[]=[];let next=0;
    await Promise.all(Array.from({length:Math.min(4,legacy.length)},async()=>{
      while(next<legacy.length){
        const note=legacy[next++]!;if(!note.runId)continue;
        const events=await this.events.load(note.runId);
        const input=(events.find(e=>e.type==='run-started')?.data as {input?:{repo?:string}})?.input;
        if(typeof input?.repo==='string'&&canonicalRepositoryURL(input.repo)===identity)accepted.push({...note,repo:identity});
      }
    }));
    return [...new Map([...current,...accepted].map(note=>[note.noteId,note])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit);
  }
}
