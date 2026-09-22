import type {EventStore} from '@neutron-build/workflow';
import type {RepoMemoryStore,RepoNote} from './repo-memory.js';
import {canonicalRepositoryURL} from './repository-reference.js';
import {repoKeyOf} from './repository-scope.js';

/** Read legacy notes only when their recorded run proves the requested origin.
 * Manual/unattributed notes remain available in Knowledge, never guessed into
 * another repository's model context. Older parked workflows keep their v1 key.
 */
export class ScopedRepoMemory implements RepoMemoryStore {
  constructor(private inner:RepoMemoryStore,private events:EventStore){}
  record(note:Omit<RepoNote,'createdAt'|'noteId'>){return this.inner.record(note)}
  repos(){return this.inner.repos()}
  remove(id:string){return this.inner.remove(id)}
  async recent(repo:string,limit:number):Promise<RepoNote[]> {
    const identity=canonicalRepositoryURL(repo);
    if(!identity)return this.inner.recent(repo,limit);
    const [current,legacy]=await Promise.all([this.inner.recent(identity,limit),this.inner.recent(repoKeyOf(identity),100)]);
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
