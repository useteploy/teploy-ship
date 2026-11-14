/**
 * The missing-credential message for a model called WITHOUT a gateway.
 *
 * Ship has two direct providers: `anthropic/…` (ANTHROPIC_API_KEY, whose SDK
 * already names its variable) and everything else, which falls through to the
 * OpenAI-shaped adapter. That adapter's own error is "Missing API key: set
 * OPENAI_API_KEY" — so a stranger on the default model (`zai/glm-5.3`) with
 * no key was told to set an OpenAI key, which would have sent a z.ai model id
 * to api.openai.com (SHIP-10). The variable that actually fixes a non-OpenAI,
 * non-Anthropic model is the gateway pair.
 *
 * Read at CALL time, like the SDKs do: a credential can arrive after the
 * adapter is built, and a worker must keep starting without one.
 */
import { AIError, problemFromStatus } from "@neutron-build/ai";
import type { AdapterCallOptions, AdapterStreamPart, ModelAdapter } from "@neutron-build/ai";

function set(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** Undefined when the direct OpenAI-shaped call has its key; else what to tell the operator. */
export function missingDirectCredential(modelId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (set(env.OPENAI_API_KEY)) return undefined;
  if (modelId.startsWith("openai/")) {
    return `Missing model credential for ${modelId}: set OPENAI_API_KEY, or route through a gateway with AI_GATEWAY_URL + AI_GATEWAY_KEY.`;
  }
  const provider = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : undefined;
  return (
    `Missing model credential for ${modelId}: ` +
    (provider !== undefined ? `Ship has no direct "${provider}" provider, so ` : "") +
    "set AI_GATEWAY_URL + AI_GATEWAY_KEY (teploy-gateway, or an Anthropic-compatible endpoint with " +
    "SHIP_ANTHROPIC_WIRE_PREFIXES), or set SHIP_MODEL to an anthropic/ model and ANTHROPIC_API_KEY."
  );
}

/** Wrap the direct OpenAI-shaped adapter so a missing key names Ship's variables, not the SDK's. */
export function withDirectCredentialCheck(inner: ModelAdapter, modelId: string, env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  const refuse = (): void => {
    const message = missingDirectCredential(modelId, env);
    if (message !== undefined) throw new AIError(problemFromStatus(401, message), { provider: inner.provider });
  };
  return {
    provider: inner.provider,
    modelId: inner.modelId,
    doGenerate: async (options: AdapterCallOptions) => {
      refuse();
      return inner.doGenerate(options);
    },
    doStream: (options: AdapterCallOptions): AsyncIterable<AdapterStreamPart> => ({
      [Symbol.asyncIterator]() {
        refuse();
        return inner.doStream(options)[Symbol.asyncIterator]();
      },
    }),
  };
}
