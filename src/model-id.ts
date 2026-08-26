/**
 * The model a CLI surface runs with: `--model` flag > `SHIP_MODEL` env >
 * config file > the built-in default.
 *
 * `SHIP_MODEL` used to be read by the web process only (store.server.ts),
 * while `worker`, `run`, `enqueue`, `fix` and `eval` resolved flag > config >
 * default and never looked at the environment — so a teploy-deployed worker,
 * which has no config file, ran every intake task on the default model no
 * matter what `teploy.yml` said. Found on 2026-08-25 (OFFLOAD_LOOP_PLAN L0):
 * eleven runs recorded `anthropic/claude-sonnet-5` under
 * `SHIP_MODEL=zai/glm-5.3`.
 */
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";

export function resolveModelId(
  flag: unknown,
  env: NodeJS.ProcessEnv = process.env,
  configModel?: string,
): string {
  if (typeof flag === "string" && flag !== "") return flag;
  const fromEnv = env.SHIP_MODEL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  if (configModel !== undefined && configModel !== "") return configModel;
  return DEFAULT_MODEL_ID;
}

/**
 * Which wire a model id is spoken on through teploy-gateway. Anthropic's own
 * models, and z.ai's coding plan — the gateway routes `zai/…` as an
 * Anthropic-wire builtin (`teploy-gateway` c0b07dd) and answers 404 on
 * `/v1/chat/completions` for it. Found on the round-2 proof run
 * (2026-08-26): `turn-0-think failed: Request failed with status 404` the
 * moment the worker finally honoured `SHIP_MODEL=zai/glm-5.3`.
 * `SHIP_ANTHROPIC_WIRE_PREFIXES` overrides the list (comma-separated).
 */
export function usesAnthropicWire(modelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SHIP_ANTHROPIC_WIRE_PREFIXES;
  const prefixes =
    raw !== undefined && raw.trim() !== ""
      ? raw.split(",").map((p) => p.trim()).filter((p) => p !== "")
      : ["anthropic/", "zai/", "zai-coding-plan/"];
  return prefixes.some((p) => modelId.startsWith(p));
}
