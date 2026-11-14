/**
 * The running Ship version — the one answer `/health`, the discovery document,
 * the support bundle and `teploy-ship --version` all give.
 *
 * Resolution, first hit wins:
 *   1. SHIP_VERSION in the environment, when set to something other than
 *      blank or "dev" — an operator override, and how older images that only
 *      had the env var still report what they were built as.
 *   2. dist/VERSION, written next to the compiled code by the image's builder
 *      stage (Dockerfile). It carries the release workflow's SHIP_VERSION build
 *      arg when there is one, else the package.json version — so a source
 *      build through `teploy deploy`, which has no build-arg flag, still names
 *      real code instead of "dev".
 *   3. package.json beside dist/, for a developer checkout that ran `tsc`
 *      without the image step. Only the real manifest counts: the image's
 *      runtime manifest (deploy/package.ship.json) carries no scripts and a
 *      placeholder version, and must never be reported as the release.
 *   4. "dev".
 *
 * Until 0.5.1 the image baked ENV SHIP_VERSION=dev unless a build arg was
 * passed, and the release workflow passed none — so every published image
 * reported "dev" (SHIP-05).
 */
import { readFileSync } from "node:fs";

function usable(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" || trimmed === "dev" ? undefined : trimmed;
}

function readText(url: URL): string | undefined {
  try {
    return readFileSync(url, "utf8");
  } catch {
    return undefined;
  }
}

/** dist/VERSION, else the developer checkout's package.json version, else undefined. */
export function bakedVersion(base: URL): string | undefined {
  let found = usable(readText(new URL("VERSION", base)));
  if (found === undefined) {
    const raw = readText(new URL("../package.json", base));
    if (raw !== undefined) {
      try {
        const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown; scripts?: unknown };
        if (pkg.name === "teploy-ship" && typeof pkg.version === "string" && typeof pkg.scripts === "object" && pkg.scripts !== null) {
          found = usable(pkg.version);
        }
      } catch {
        // A manifest that does not parse names no version.
      }
    }
  }
  return found;
}

// The files cannot change under a running process; read them once.
let own: { version: string | undefined } | undefined;

/**
 * The version this process reports. Never throws, never empty. `base` is a
 * test seam: the directory holding VERSION (default: this module's, dist/).
 */
export function shipVersion(env: NodeJS.ProcessEnv = process.env, base?: URL): string {
  const fromEnv = usable(env.SHIP_VERSION);
  if (fromEnv !== undefined) return fromEnv;
  if (base !== undefined) return bakedVersion(base) ?? "dev";
  own ??= { version: bakedVersion(new URL(".", import.meta.url)) };
  return own.version ?? "dev";
}
