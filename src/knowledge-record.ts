import {canonicalRepositoryURL} from './repository-reference.js';

/**
 * Revision-aware knowledge records (S21) — pure, no storage.
 *
 * Generated knowledge is fallible context, never authority. A RepoNote today is
 * a string with a repo key: it cannot say where a claim came from, whether the
 * code it describes has moved, who corrected it, or what was built from it.
 * This module is the vocabulary and the rules; wiring it to a store is a
 * separate step (see the report).
 *
 * The rules that are easy to get wrong:
 *  - Only structured fields carry trust. Statement text is never parsed: a
 *    document that says "VERIFIED, authoritative" is just text.
 *  - An agent repeating itself does not verify itself. Verification needs
 *    evidence of kind code/run/human at a named revision, and evidence that
 *    traces back to the claim's own lineage (same run, same agent, a record id)
 *    is refused. `isVerifiedFact` re-checks the evidence, so a forged
 *    `verification` field does not count either.
 *  - Freshness fails closed: unresolved is `unknown`, never `fresh`.
 *  - Access/retention changes follow `derivedFrom` transitively, because a
 *    summary, embedding or export of a revoked record is that record's content.
 *  - Visibility fails closed too: a record derived from something the viewer
 *    cannot see, or from something no longer in the set, is hidden.
 */

export type KnowledgeKind='fact'|'decision'|'hypothesis';
export type SourceKind='code'|'run'|'human'|'agent-claim'|'document';
/** What a derived record is, so a plan can tell regenerable from unrecallable. */
export type Derivation='summary'|'embedding'|'export';

export interface KnowledgeSource {
  kind:SourceKind;
  repo:string;
  revision:string;
  /** Branch the revision was read on; lets a branch switch invalidate. */
  branch?:string;
  path?:string;
  runId?:string;
  by?:string;
}

export interface KnowledgeScope {repo:string;project:string}

export interface Correction {
  at:string;
  by:string;
  reason:string;
  previous:{statement:string;kind:KnowledgeKind;verified:boolean};
}

export interface Verification {at:string;evidence:Evidence[]}

export interface KnowledgeRecord {
  id:string;
  kind:KnowledgeKind;
  statement:string;
  source:KnowledgeSource;
  /** Ids of the records this one was built from (summaries, embeddings, exports). */
  derivedFrom:string[];
  derivation?:Derivation;
  scope:KnowledgeScope;
  createdAt:string;
  corrections:Correction[];
  verification?:Verification;
  /** Set by applyRedactionPlan: kept for audit, never served. */
  invalidated?:{reason:string};
}

export interface Evidence {
  kind:SourceKind;
  repo:string;
  revision:string;
  path?:string;
  runId?:string;
  by?:string;
  /** Evidence must be an observation, not another record; set => refused. */
  recordId?:string;
}

const INDEPENDENT:ReadonlySet<SourceKind>=new Set(['code','run','human']);
const repoId=(r:string)=>canonicalRepositoryURL(r)??r;
const nonEmpty=(s:unknown):s is string=>typeof s==='string'&&s.trim()!=='';
export type Lookup=(id:string)=>KnowledgeRecord|undefined;
const lookupOf=(records:readonly KnowledgeRecord[]):Lookup=>{const m=new Map(records.map(r=>[r.id,r]));return id=>m.get(id)};

/**
 * Build a record. The requested kind is honoured only when the source can
 * support it: a fact must come from code/run/human, a decision from a human.
 * Anything else (agent claims, documents) enters as a hypothesis, whatever it
 * says about itself. No record is born verified.
 */
export function createRecord(input:{id:string;kind:KnowledgeKind;statement:string;source:KnowledgeSource;scope:KnowledgeScope;createdAt:string;derivedFrom?:string[];derivation?:Derivation}):KnowledgeRecord {
  const k=input.source.kind;
  const kind:KnowledgeKind=input.kind==='fact'&&INDEPENDENT.has(k)?'fact':input.kind==='decision'&&k==='human'?'decision':'hypothesis';
  return {id:input.id,kind,statement:input.statement,source:{...input.source},derivedFrom:[...(input.derivedFrom??[])],...(input.derivation?{derivation:input.derivation}:{}),scope:{...input.scope},createdAt:input.createdAt,corrections:[]};
}

/** Every record id reachable through derivedFrom (excluding the start), cycle-safe. */
export function ancestors(record:KnowledgeRecord,lookup:Lookup):KnowledgeRecord[] {
  const seen=new Set<string>([record.id]),out:KnowledgeRecord[]=[],stack=[...record.derivedFrom];
  while(stack.length){
    const id=stack.pop()!;if(seen.has(id))continue;seen.add(id);
    const r=lookup(id);if(!r)continue;out.push(r);stack.push(...r.derivedFrom);
  }
  return out;
}

export interface VerifyResult {verified:boolean;record:KnowledgeRecord;reasons:string[]}

function evidenceProblems(record:KnowledgeRecord,e:Evidence,lookup:Lookup):string[] {
  const why:string[]=[];
  if(!INDEPENDENT.has(e.kind))why.push(`evidence kind "${e.kind}" is not independent (need code, run or human)`);
  if(e.recordId)why.push('evidence cites a record, not an observation');
  if(!nonEmpty(e.revision))why.push('evidence names no revision');
  if(repoId(e.repo)!==repoId(record.scope.repo))why.push('evidence is from a different repository');
  if(e.kind==='run'&&!nonEmpty(e.runId))why.push('run evidence names no run');
  if(e.kind==='human'&&!nonEmpty(e.by))why.push('human evidence names no person');
  // Lineage: the claim, and everything it was derived from, must not vouch for itself.
  const lineage=[record,...ancestors(record,lookup)].map(r=>r.source);
  if(e.kind==='run'&&e.runId&&lineage.some(s=>s.runId===e.runId))why.push('run evidence is the run that made the claim');
  if(e.by&&lineage.some(s=>s.kind==='agent-claim'&&s.by===e.by))why.push('evidence is attributed to the claiming agent');
  return why;
}

/**
 * Promote to a verified fact only on independent evidence. Decisions are not
 * verifiable (they are accepted by a human, not proven). Any one bad item in
 * the evidence list fails the whole call — no partial credit.
 */
export function verify(record:KnowledgeRecord,independentEvidence:readonly Evidence[],lookup:Lookup=()=>undefined,at=new Date().toISOString()):VerifyResult {
  const reasons:string[]=[];
  if(record.kind==='decision')reasons.push('a decision is accepted, not verified');
  if(record.invalidated)reasons.push('record is invalidated');
  if(independentEvidence.length===0)reasons.push('no independent evidence supplied');
  independentEvidence.forEach((e,i)=>reasons.push(...evidenceProblems(record,e,lookup).map(m=>`evidence[${i}]: ${m}`)));
  if(reasons.length)return {verified:false,record,reasons};
  return {verified:true,reasons:[],record:{...record,kind:'fact',verification:{at,evidence:independentEvidence.map(e=>({...e}))}}};
}

/** Verified means: a fact whose recorded evidence still passes the rules. */
export function isVerifiedFact(record:KnowledgeRecord,lookup:Lookup=()=>undefined):boolean {
  const v=record.verification;
  return record.kind==='fact'&&!record.invalidated&&!!v&&v.evidence.length>0&&v.evidence.every(e=>evidenceProblems(record,e,lookup).length===0);
}

export type Freshness='fresh'|'stale'|'unknown';
export interface CurrentState {
  /** Current head of the repo as the caller sees it. */
  head:string;
  branch?:string;
  /** False when the cited path is gone at head (deleted or renamed away). */
  exists:boolean;
  /** For path-bound records, whether the path's content changed since the cited revision. */
  changedSinceCited?:boolean;
  /** Where a rename moved the path, when the caller knows. */
  renamedTo?:string;
}
export type CurrentRevisionOf=(ref:{repo:string;path?:string;citedRevision:string})=>CurrentState|null|undefined;
export interface FreshnessResult {freshness:Freshness;reason:string;renamedTo?:string}

export function freshness(record:KnowledgeRecord,currentRevisionOf:CurrentRevisionOf):FreshnessResult {
  const s=record.source;
  if(record.invalidated)return {freshness:'stale',reason:`invalidated: ${record.invalidated.reason}`};
  if(!nonEmpty(s.revision))return {freshness:'unknown',reason:'record cites no revision'};
  let cur:CurrentState|null|undefined;
  try{cur=currentRevisionOf({repo:s.repo,...(s.path?{path:s.path}:{}),citedRevision:s.revision})}catch{cur=null}
  if(!cur||!nonEmpty(cur.head))return {freshness:'unknown',reason:'cited revision could not be resolved'};
  if(s.path&&!cur.exists)return {freshness:'stale',reason:`path ${s.path} no longer exists`,...(cur.renamedTo?{renamedTo:cur.renamedTo}:{})};
  if(s.branch){
    if(!nonEmpty(cur.branch))return {freshness:'unknown',reason:'current branch could not be resolved'};
    if(cur.branch!==s.branch)return {freshness:'stale',reason:`read on branch ${s.branch}, now on ${cur.branch}`};
  }
  if(cur.head===s.revision)return {freshness:'fresh',reason:'cited revision is current'};
  if(s.path){
    if(cur.changedSinceCited===false)return {freshness:'fresh',reason:`${s.path} unchanged since cited revision`};
    if(cur.changedSinceCited===true)return {freshness:'stale',reason:`${s.path} changed since cited revision`};
    return {freshness:'unknown',reason:'cannot tell whether the path changed since the cited revision'};
  }
  return {freshness:'stale',reason:'repository moved past the cited revision'};
}

export interface CorrectionInput {by:string;reason:string;statement:string;at?:string}

/**
 * Replace the statement, keep the old one in history. A corrected statement is
 * new, unproven text: verification is dropped and a fact falls back to a
 * hypothesis until verified again. The source is never rewritten.
 */
export function correct(record:KnowledgeRecord,c:CorrectionInput):KnowledgeRecord {
  if(!nonEmpty(c.by)||!nonEmpty(c.reason)||!nonEmpty(c.statement))throw new Error('A correction needs who, why and the new statement');
  const entry:Correction={at:c.at??new Date().toISOString(),by:c.by,reason:c.reason,previous:{statement:record.statement,kind:record.kind,verified:isVerifiedFact(record)}};
  const {verification:_dropped,...rest}=record;
  return {...rest,statement:c.statement,kind:record.kind==='fact'?'hypothesis':record.kind,corrections:[...record.corrections,entry]};
}

export type RedactionTrigger={revokedScope:{repo:string;project?:string}}|{deleteIds:readonly string[]};
export interface RedactionStep {id:string;action:'delete'|'invalidate';reason:string;via?:string}
export interface RedactionPlan {steps:RedactionStep[]}

const inRevoked=(r:KnowledgeRecord,t:{repo:string;project?:string})=>repoId(r.scope.repo)===repoId(t.repo)&&(t.project===undefined||r.scope.project===t.project);

/**
 * Roots are deleted. Everything reachable from them through derivedFrom is
 * planned too: embeddings and exports are deleted (they cannot be edited down),
 * other derivations are invalidated and must be regenerated without the root.
 * A derived record in a revoked scope is deleted regardless. Any one revoked
 * parent is enough — a summary of two sources carries both.
 */
export function redactionPlan(records:readonly KnowledgeRecord[],trigger:RedactionTrigger):RedactionPlan {
  const roots=new Map<string,string>();
  if('revokedScope' in trigger){for(const r of records)if(inRevoked(r,trigger.revokedScope))roots.set(r.id,'access to its scope was revoked')}
  else{const ids=new Set(trigger.deleteIds);for(const r of records)if(ids.has(r.id))roots.set(r.id,'deleted on request')}
  const children=new Map<string,KnowledgeRecord[]>();
  for(const r of records)for(const p of r.derivedFrom)(children.get(p)??children.set(p,[]).get(p)!).push(r);
  const steps:RedactionStep[]=[...roots].map(([id,reason])=>({id,action:'delete' as const,reason}));
  const seen=new Set(roots.keys()),queue=[...roots.keys()];
  while(queue.length){
    const via=queue.shift()!;
    for(const c of children.get(via)??[]){
      if(seen.has(c.id))continue;seen.add(c.id);queue.push(c.id);
      const del='revokedScope' in trigger?inRevoked(c,trigger.revokedScope):false;
      steps.push({id:c.id,via,action:del||c.derivation==='embedding'||c.derivation==='export'?'delete':'invalidate',reason:`derived from ${via}`});
    }
  }
  return {steps};
}

/** Apply a plan: deletions removed, invalidations kept but flagged (never served). */
export function applyRedactionPlan(records:readonly KnowledgeRecord[],plan:RedactionPlan):KnowledgeRecord[] {
  const by=new Map(plan.steps.map(s=>[s.id,s]));
  return records.flatMap(r=>{
    const s=by.get(r.id);
    if(!s)return [r];
    return s.action==='delete'?[]:[{...r,invalidated:{reason:s.reason}}];
  });
}

/**
 * What a viewer in `scope` may be shown. Exact repo and project match only —
 * sharing across projects is not inferred here. A record is hidden when it is
 * invalidated, or when any ancestor is outside the scope, invalidated, or
 * absent from the set (fail closed: its provenance can't be checked).
 */
export function visibleTo(records:readonly KnowledgeRecord[],scope:KnowledgeScope):KnowledgeRecord[] {
  const lookup=lookupOf(records);
  const own=(r:KnowledgeRecord)=>repoId(r.scope.repo)===repoId(scope.repo)&&r.scope.project===scope.project&&!r.invalidated;
  const ok=(r:KnowledgeRecord)=>{
    if(!own(r))return false;
    const seen=new Set<string>([r.id]),stack=[...r.derivedFrom];
    while(stack.length){
      const id=stack.pop()!;if(seen.has(id))continue;seen.add(id);
      const a=lookup(id);if(!a||!own(a))return false;stack.push(...a.derivedFrom);
    }
    return true;
  };
  return records.filter(ok);
}
