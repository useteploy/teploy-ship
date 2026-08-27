import type { SubNavItem } from "../lib/subnav.js";

export const PROJECT_VIEWS: SubNavItem[] = [
  { key: "repos", label: "Repos", href: "/projects" },
  { key: "sources", label: "Sources", href: "/projects?view=sources" },
  { key: "knowledge", label: "Knowledge", href: "/projects?view=knowledge" },
  // L6. Its own path rather than a `?view=` of /projects: the boards it manages
  // are PUBLIC pages under /bulletin/, and the operator page has to sit outside
  // that prefix (which the middleware exempts from auth, _layout.tsx) while
  // still being reachable from the group it belongs to.
  { key: "bulletin", label: "Bulletin", href: "/bulletin-admin" },
];
