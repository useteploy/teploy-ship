export interface NavApp {
  key: string;
  label: string;
  url: string;
}

export interface NavData {
  current: string;
  apps: NavApp[];
}

/**
 * Cross-product dashboard switcher entries: the current app (marked, no link)
 * plus any sibling Teploy dashboards whose URL is configured via
 * TEPLOY_NAV_{DASH,OBSERVE,SHIP}_URL. Same env convention across Dash, Observe,
 * and Ship, so one set of vars drives the switcher everywhere.
 */
export function teployNav(current: string): NavData {
  const products: Array<[string, string, string]> = [
    ["dash", "Dash", "TEPLOY_NAV_DASH_URL"],
    ["observe", "Observe", "TEPLOY_NAV_OBSERVE_URL"],
    ["ship", "Ship", "TEPLOY_NAV_SHIP_URL"],
  ];
  const apps: NavApp[] = [];
  for (const [key, label, env] of products) {
    const url = (process.env[env] ?? "").trim();
    if (key === current) apps.push({ key, label, url: "" });
    else if (url !== "") apps.push({ key, label, url });
  }
  return { current, apps };
}
