import type { SubNavItem } from "../lib/subnav.js";

export const PROJECT_VIEWS: SubNavItem[] = [
  { key: "repos", label: "Repos", href: "/projects" },
  { key: "sources", label: "Sources", href: "/projects?view=sources" },
  { key: "knowledge", label: "Knowledge", href: "/projects?view=knowledge" },
];
