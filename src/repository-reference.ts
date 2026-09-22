/** Existing supported clone spellings; transport/origin is never inferred. */
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
