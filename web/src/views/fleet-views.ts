import type { SubNavItem } from "../lib/subnav.js";

export const FLEET_VIEWS: SubNavItem[] = [
  { key: "workers", label: "Workers", href: "/fleet" },
  { key: "spend", label: "Spend", href: "/fleet?view=spend" },
];
