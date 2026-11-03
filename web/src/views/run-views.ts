import type { SubNavItem } from "../lib/subnav.js";

export const RUN_VIEWS: SubNavItem[] = [
  { key: "runs", label: "All runs", href: "/runs" },
  { key: "reviews", label: "PR reviews", href: "/runs?view=reviews" },
  { key: "incidents", label: "Incidents", href: "/incidents" },
  { key: "coordination", label: "Coordinated changes", href: "/coordination" },
];
