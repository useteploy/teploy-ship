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
