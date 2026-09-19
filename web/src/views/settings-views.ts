import type { SubNavItem } from "../lib/subnav.js";

export type SettingsView = "overview" | "models" | "integrations" | "team" | "system";
export const SETTINGS_VIEWS: SubNavItem[] = [
  { key: "overview", label: "Overview", href: "/settings" },
  { key: "models", label: "Models & execution", href: "/settings?view=models" },
  { key: "integrations", label: "Connections", href: "/settings?view=integrations" },
  { key: "team", label: "Team & access", href: "/settings?view=team" },
  // Keep the role-open governance route; do not move its mutations under /settings.
  { key: "governance", label: "Approval rules", href: "/policies" },
  { key: "system", label: "Advanced", href: "/settings?view=system" },
];
export function settingsView(value: string | null): SettingsView {
  return ["models", "integrations", "team", "system"].includes(value ?? "") ? value as SettingsView : "overview";
}
export function groupVisible(view: SettingsView, title: string): boolean {
  if (view === "system") return true;
  if (view === "models") return ["Harness", "AI gateway", "Sandbox", "Budget & capacity", "Evidence on the pull request"].includes(title);
  if (view === "integrations") return ["Observe (dogfood)", "Akiroo (work in, pulled)", "Intake", "Git & access"].includes(title);
  return false;
}
const LABELS: Record<string, string> = {
  SHIP_MODEL: "Default model", SHIP_HARNESS: "Agent harness", SHIP_HARNESS_ATTEMPTS: "Attempt sequence",
  SHIP_HARNESS_MODEL: "Harness model", SHIP_HARNESS_ENV: "Harness credentials", SHIP_HARNESS_TIMEOUT_MS: "Attempt timeout (ms)",
  SHIP_DAILY_BUDGET_USD: "Daily budget (USD)", SHIP_DAILY_AUTO_LIMIT: "Daily automatic runs", SHIP_MAX_CONCURRENT_RUNS: "Concurrent runs",
  SHIP_MIN_FREE_MB: "Minimum free memory (MB)", SHIP_MAX_LOAD_PER_CPU: "Maximum load per CPU", SHIP_MIN_FREE_DISK_MB: "Minimum free disk (MB)",
  SHIP_MAX_INODE_USED_PCT: "Maximum inode use (%)", SHIP_DISK_PATH: "Disk to monitor", SHIP_MAX_STEPS: "Maximum agent steps",
  AI_GATEWAY_URL: "AI gateway address", AI_GATEWAY_KEY: "Gateway credential", ANTHROPIC_API_KEY: "Anthropic credential", OPENAI_API_KEY: "OpenAI credential",
  SHIP_SANDBOX_URL: "Sandbox service", SHIP_SANDBOX_IMAGE: "Default sandbox image", SHIP_SANDBOX_NETWORK: "Network policy", SHIP_SANDBOX_TOKEN: "Sandbox credential",
  OBSERVE_URL: "Observe address", OBSERVE_API_KEY: "Ingest credential", OBSERVE_SITE: "Telemetry site", OBSERVE_READ_TOKEN: "Read credential",
  SHIP_TEST_COMMAND: "Default test command", OBSERVE_SERVICE: "Observed service", OBSERVE_REPO: "Observed repository", SHIP_PREVIEW_DIR: "Preview checkout",
  AKIROO_URL: "Akiroo address", AKIROO_PULL_TOKEN: "Workspace credential", SHIP_WEBHOOK_SECRET: "Webhook signing secret", SHIP_PUBLIC_URL: "Public Ship address",
  SHIP_INTAKE_POLICIES: "Source policies", SHIP_GIT_TOKENS: "Git credentials by origin", SHIP_GIT_TOKEN: "Default Git credential", SHIP_GITHUB_TOKEN: "GitHub credential",
  SHIP_REPO_ALLOWLIST: "Allowed repositories", SHIP_WEB_TOKEN: "Operator credential", NUCLEUS_URL: "Database address", CLAUDE_CODE_OAUTH_TOKEN: "Claude Code credential",
  store: "Storage", model: "Default model", harness: "Default harness", "baked harnesses": "Installed harness versions", connector: "Connection", emitter: "Run telemetry",
};
export function settingLabel(key: string): string { return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1); }
export function groupLabel(title: string): string {
  return ({ "Observe (dogfood)": "Teploy Observe", "Akiroo (work in, pulled)": "Akiroo workspace", "Intake": "Webhooks & task sources", "Evidence on the pull request": "Verification", "Harness": "Agent harness" } as Record<string,string>)[title] ?? title;
}
