#!/usr/bin/env node
// S01-3 case-twin receipt. READ-ONLY: plain SELECTs over the repository-keyed
// tables, nothing created, migrated or rewritten. Prints a JSON receipt of
// every stored key group that names ONE repository under different spellings
// (case, .git, trailing slash) under the canonical rule in
// src/repository-reference.ts. Twins are reported, never merged: a merge moves
// history (notes, spend buckets, results) and is an operator decision.
//
//   NUCLEUS_URL=postgres://... node scripts/check-case-twins.mjs
//
// Exit 0: no twins. Exit 1: twins found (receipt lists them). Exit 2: usage.
import {NucleusPgwire} from '../dist/nucleus-pgwire.js';
import {repositoryKeyTwins} from '../dist/repository-reference.js';

if(!process.env.NUCLEUS_URL){console.error('NUCLEUS_URL is required (this check reads the Nucleus store)');process.exit(2)}
const db=new NucleusPgwire(process.env.NUCLEUS_URL,'case-twin-check');
const sources={
  projects:{sql:'SELECT repo FROM ship_projects_v2',keys:rows=>rows.map(r=>String(r.repo)).filter(k=>k!=='@migration')},
  legacyProjects:{sql:'SELECT repo FROM ship_projects',keys:rows=>rows.map(r=>String(r.repo))},
  memory:{sql:'SELECT repo FROM ship_memory',keys:rows=>rows.map(r=>String(r.repo))},
  repoStats:{sql:'SELECT repo FROM ship_repo_stats',keys:rows=>rows.map(r=>String(r.repo))},
  spendBuckets:{sql:'SELECT kind, key FROM ship_attributed_spend',keys:rows=>rows.filter(r=>r.kind==='repo').map(r=>String(r.key))},
  legacyEvidence:{sql:'SELECT repo FROM ship_evidence',keys:rows=>rows.map(r=>String(r.repo))},
  reviewers:{sql:'SELECT key, value FROM ship_governance',keys:rows=>rows.filter(r=>r.key==='governance').flatMap(r=>{
    try{return (JSON.parse(String(r.value)).reviewers??[]).map(x=>String(x?.repo??''))}catch{return []}
  })},
};
const receipt={checkedAt:new Date().toISOString(),rule:'http(s) forge paths fold case; file: paths and schemes never fold',stores:{},unreadable:{}};
let twinCount=0;
try {
  for(const [name,{sql,keys}] of Object.entries(sources)){
    try {
      const found=keys(await db.query(sql));
      const twins=repositoryKeyTwins(found);
      twinCount+=twins.length;
      receipt.stores[name]={distinctKeys:new Set(found).size,twins};
    }catch(error){receipt.unreadable[name]=error instanceof Error?error.message:String(error)}
  }
}finally{await db.close()}
receipt.twinGroups=twinCount;
console.log(JSON.stringify(receipt,null,2));
process.exit(twinCount>0?1:0);
