import { repoSlug, canonicalRepositoryURL } from "./repository-reference.js";
export { canonicalRepositoryURL } from "./repository-reference.js";

export class ProjectIdentityError extends Error {
  constructor(repo:string){
    super(`Repository identity conflicts with project ${repo}. Use its full clone URL; ambiguous short names and unbound legacy records need an explicit repository connection.`);
    this.name='ProjectIdentityError';
  }
}
export function projectReference(project:{repo:string;url?:string}):string {
  return project.url ? canonicalRepositoryURL(project.url) ?? project.url : project.repo;
}
export function resolveProject<T extends {repo:string;url?:string}>(projects:T[],reference:string):T|null {
  const identity=canonicalRepositoryURL(reference);
  const slug=repoSlug(reference);
  if(identity){
    const exact=projects.filter(p=>p.url&&canonicalRepositoryURL(p.url)===identity);
    if(exact.length>1)throw new ProjectIdentityError(slug??reference);
    if(exact.length===1)return exact[0]!;
    if(projects.some(p=>p.repo===slug&&!p.url))throw new ProjectIdentityError(slug!);
    return null;
  }
  if(slug===null&&!reference.includes(":")&&!reference.includes("/")){
    return projects.find(p=>!p.url&&p.repo===reference.trim().toLowerCase())??null;
  }
  if(slug!==reference.trim().toLowerCase())throw new ProjectIdentityError(slug??'unknown');
  const matches=projects.filter(p=>p.repo===slug);
  if(matches.length>1)throw new ProjectIdentityError(slug!);
  return matches[0]??null;
}
