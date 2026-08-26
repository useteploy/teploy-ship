import type { SubNavItem } from "../lib/subnav.js";

// Governance keeps its own path: /policies is role-open so a named viewer
// holding the `policies` grant can reach it, while /settings is admin-only.
export const SETTINGS_VIEWS: SubNavItem[] = [
  { key: "governance", label: "Governance", href: "/policies" },
  { key: "team", label: "Team", href: "/settings?view=team" },
  { key: "system", label: "System", href: "/settings?view=system" },
];
