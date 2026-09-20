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
  return Promise.all(
    [
      ["Model gateway", "AI_GATEWAY_URL"],
      ["Sandbox service", "SHIP_SANDBOX_URL"],
      ["Teploy Observe", "OBSERVE_URL"],
    ].map(async ([name, key]) => {
      const raw = env[key];
      if (!raw)
        return {
          name,
          state: "Not configured",
          detail: `Set ${key} in the deployment environment if this service is needed.`,
        };
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
    }),
  );
}
