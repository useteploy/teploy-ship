import { tailnetBaseDomain } from "../../../dist/deploy.js";

/**
 * The preview base this dashboard may frame: `<ip>.sslip.io` from the SAME
 * SHIP_PREVIEW_TAILNET_IP the worker deploys under (one derivation,
 * deploy.ts tailnetBaseDomain). Unset or not a tailnet address: undefined,
 * and the CSP frames nothing, as before.
 */
export function previewFrameBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ip = (env.SHIP_PREVIEW_TAILNET_IP ?? "").trim();
  return ip === "" ? undefined : tailnetBaseDomain(ip);
}
