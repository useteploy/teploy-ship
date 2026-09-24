import {parseRepoUrl} from './git.js';
import {canonicalRepositoryURL} from './repository-reference.js';

/** Version 1 remains the scope of parked workflows. New recorded runs use v2. */
export function repoKeyOf(repoUrl:string,version?:2):string {
  const ref=parseRepoUrl(repoUrl);
  if(version===2){
    const key=canonicalRepositoryURL(repoUrl);
    if(!key)throw new Error('Repository scope requires a credential-free clone URL');
    return key;
  }
  const origin=ref.base.replace(/^https?:\/\//,'').replace(/\/+$/,'');
  return `${origin}/${ref.owner}/${ref.repo}`;
}

/**
 * The per-repository execution lock key (C7). The v1 shape — scheme-free, so
 * http and https spellings of one repository share one queue — folded to
 * lower case for forge URLs, because `Tyler/app` and `tyler/app` are one
 * repository on every forge Ship speaks (S01-3, repository-reference.ts);
 * two runs spelling it differently must not both hold "its" lock. `file:`
 * remotes keep their case: a filesystem path is case-sensitive.
 */
export function repoLockKey(repoUrl:string):string {
  const key=repoKeyOf(repoUrl);
  return parseRepoUrl(repoUrl).base==='file://' ? key : key.toLowerCase();
}
