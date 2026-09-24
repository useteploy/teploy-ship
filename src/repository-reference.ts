/**
 * Canonical repository identity. The case rule (S01-3), decided per forge:
 *
 * Ship speaks exactly two forge kinds over http(s) — GitHub and
 * Forgejo/Gitea (git.ts parseRepoUrl) — and BOTH resolve owner and
 * repository names case-insensitively: GitHub by documented behaviour,
 * Forgejo/Gitea by schema (owner and repository names are unique on their
 * lower-cased form, so `Team/App` and `team/app` cannot both exist on one
 * instance). Verified live 2026-09-23 against Forgejo 14.0.5: `Tyler/…`,
 * `tyler/…` and `TYLER/…` spellings of one repository answered the API with
 * the same repository id, and git's smart-HTTP endpoint served each. So an
 * http(s) path folds to lower case: case twins on one origin ARE one
 * repository, and folding can never merge two distinct ones.
 *
 * What never folds: `file:` paths (a case-sensitive filesystem can hold two
 * distinct repositories that differ only by case), and the scheme (http and
 * https stay distinct identities — transport/origin is never inferred, F03).
 * The host is folded by URL parsing itself (hostnames are case-insensitive).
 */
export function canonicalRepositoryURL(value:string):string|null {
  try {
    const url=new URL(value);
    if(!['http:','https:','file:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;
    const path=url.pathname.replace(/\/+$/,'').replace(/\.git$/i,'');
    return `${url.protocol}//${url.host}${url.protocol==='file:'?path:path.toLowerCase()}`;
  }catch{return null}
}

export function repoSlug(s: string): string | null {
  const cleaned = s.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = cleaned.split(/[/:]/).filter((x) => x !== "");
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * The form a STORED repository key is compared under when looking for twins:
 * canonical for a clone URL, verbatim for a `file:` reference, lower-cased
 * for everything else (owner/name slugs and the v1 `host/owner/name` scope
 * keys, which are forge paths under the rule above).
 */
export function repositoryKeyFold(key:string):string {
  const trimmed=key.trim();
  const url=canonicalRepositoryURL(trimmed);
  if(url!==null)return url;
  return /^file:/i.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

/**
 * Stored keys that name one repository under different spellings (case,
 * `.git`, trailing slash). Detection only: each group is reported with its
 * members verbatim and nothing is rewritten — twins can carry history (notes,
 * spend buckets, results) whose merge is an operator decision with a receipt,
 * never a silent side effect of reading.
 */
export function repositoryKeyTwins(keys:Iterable<string>):Array<{identity:string;keys:string[]}> {
  const groups=new Map<string,Set<string>>();
  for(const key of keys){
    if(key.trim()==='')continue;
    const fold=repositoryKeyFold(key);
    (groups.get(fold)??groups.set(fold,new Set()).get(fold)!).add(key);
  }
  return [...groups.entries()]
    .filter(([,members])=>members.size>1)
    .map(([identity,members])=>({identity,keys:[...members].sort()}))
    .sort((a,b)=>a.identity.localeCompare(b.identity));
}
