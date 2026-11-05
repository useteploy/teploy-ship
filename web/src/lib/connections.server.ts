import { observeBaseFromEnv } from "../../../dist/observe-endpoint.js";
import { observeServiceAuthFromEnv, readAlertRules } from "../../../dist/observe-service.js";

export interface ConnectionCheck {
  name: string;
  state: string;
  detail: string;
}
/** Only installed server endpoints, never a URL supplied by a web request; no credential forwarding or redirects. */
export async function checkConnections(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionCheck[]> {
  const plain = await Promise.all(
    [
      ["Model gateway", "AI_GATEWAY_URL"],
      ["Sandbox service", "SHIP_SANDBOX_URL"],
    ].map(async ([name, key]) => {
      const raw = env[key];
      if (!raw)
        return {
          name,
          state: "Not configured",
          detail: `Set ${key} in the deployment environment if this service is needed.`,
        };
      return await ping(name, raw, key, fetcher);
    }),
  );
  return [...plain, await checkObserve(env, fetcher)];
}

async function ping(name: string, raw: string, key: string, fetcher: typeof fetch): Promise<ConnectionCheck> {
  let url: URL;
  try {
    url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    url.pathname = url.pathname.replace(/\/$/, "") + "/health";
    url.search = "";
    url.hash = "";
  } catch {
    return {
      name,
      state: "Invalid address",
      detail: `Check ${key}; the address is hidden because it may contain credentials.`,
    };
  }
  try {
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return {
      name,
      state: response.ok
        ? "Reachable"
        : response.status === 401 || response.status === 403
          ? "Authentication required"
          : "HTTP " + response.status,
      detail: response.ok
        ? "Health endpoint responded. This does not test model inference, credentials, or worker-to-service networking."
        : "Service responded, but its health endpoint did not confirm readiness. Check the service address and deployment configuration.",
    };
  } catch {
    return {
      name,
      state: "Unreachable",
      detail:
        "No response within five seconds from this dashboard. Check the service, network route, and configured address.",
    };
  }
}

/**
 * The Observe row resolves its endpoint through the family env contract
 * (OBSERVE_ENDPOINT, the OTLP spelling, or the deprecated OBSERVE_URL —
 * observe-endpoint.ts), so every spelling shows the same connection state.
 *
 * When a service token is configured, the health ping is followed by ONE
 * alerts:read call against /api/v1/service/* (observe-service.ts): a plain
 * /health 200 only proves a server answered, while a service-token read
 * proves the endpoint, the credential, the scope AND the site ownership —
 * the whole wiring the incidents page depends on. A refused read is reported
 * as its own state with Observe's documented reason, never folded into
 * "reachable".
 */
async function checkObserve(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<ConnectionCheck> {
  const base = observeBaseFromEnv(env);
  if (base === null) {
    return {
      name: "Teploy Observe",
      state: "Not configured",
      detail: "Set OBSERVE_ENDPOINT (the deprecated OBSERVE_URL also works) in the deployment environment if telemetry is wanted.",
    };
  }
  const health = await ping("Teploy Observe", base.base, "OBSERVE_ENDPOINT", fetcher);
  if (health.state !== "Reachable") return health;

  const auth = observeServiceAuthFromEnv(env);
  if (auth === undefined) {
    return {
      ...health,
      detail:
        "Health endpoint responded. Optional: set OBSERVE_SERVICE_TOKEN (an obs_svc_ token with alerts:read) and OBSERVE_SITE to prove the connection with a service-token read and show alert state on the incidents page.",
    };
  }
  const read = await readAlertRules(auth, { fetch: fetcher });
  if (read.kind === "ok") {
    return {
      name: "Teploy Observe",
      state: "Reachable",
      detail: `Health endpoint responded and the service token is accepted: ${read.value.length} alert rule(s) readable on site ${auth.siteId}. Alert state is shown on the incidents page.`,
    };
  }
  return {
    name: "Teploy Observe",
    state: "Token refused",
    detail: `Observe is up, but the alerts:read service-token check failed — ${read.reason}. The dashboard and telemetry keep working; the incidents page will show no alert state.`,
  };
}
