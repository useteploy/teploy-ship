import type { EventStore } from '@neutron-build/workflow';
import type { RepoStatsStore, RepoStatEntry } from './repo-stats.js';
import { canonicalRepositoryURL, ProjectIdentityError } from './project-identity.js';
import { repoSlug } from './observe.js';

/** Recover historical scope from immutable run input, never from today's project
 * settings. Keep unresolved rows explicitly unscoped. No historical row is edited.
 */
export class ScopedRepoStatsStore implements RepoStatsStore {
  private origins=new Map<string,Promise<string|undefined>>();
  constructor(private inner:RepoStatsStore,private events:EventStore){}
  record(entry:RepoStatEntry){return this.inner.record(entry)}
  attach(entry:RepoStatEntry){return this.inner.attach(entry)}
  private origin(runId:string):Promise<string|undefined> {
    const old=this.origins.get(runId);if(old)return old;
    const read=this.events.load(runId).then(events=>{
      const input=(events.find(e=>e.type==='run-started')?.data as {input?:{repo?:string}})?.input;
      return typeof input?.repo==='string' ? canonicalRepositoryURL(input.repo) ?? undefined : undefined;
    });
    this.origins.set(runId,read);
    if(this.origins.size>10000)this.origins.delete(this.origins.keys().next().value!);
    void read.then(value=>{if(!value)this.origins.delete(runId)},()=>this.origins.delete(runId));
    return read;
  }
  async list(repo?:string):Promise<RepoStatEntry[]> {
    const rows=await this.inner.list(),out=new Array<RepoStatEntry>(rows.length);
    let next=0;
    await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
      while(next<rows.length){
        const index=next++,row=rows[index]!;
        if(canonicalRepositoryURL(row.repo)){out[index]=row;continue;}
        const origin=await this.origin(row.runId);
        out[index]=origin&&repoSlug(origin)===row.repo ? {...row,repo:origin} : row;
      }
    }));
    if(repo===undefined)return out;
    const identity=canonicalRepositoryURL(repo);
    if(identity)return out.filter(row=>canonicalRepositoryURL(row.repo)===identity);
    const matching=out.filter(row=>repoSlug(row.repo)===repoSlug(repo));
    if(new Set(matching.map(row=>row.repo)).size>1)throw new ProjectIdentityError(repo);
    return matching;
  }
}
