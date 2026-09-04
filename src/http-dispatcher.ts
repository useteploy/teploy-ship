import { Agent, fetch as undiciFetch } from "undici";

/**
 * A fetch whose transport never gives up on a quiet response.
 *
 * Node's global `fetch` abandons a response after five minutes without a
 * byte (undici's `bodyTimeout` / `headersTimeout` defaults) and reports it
 * as the bare `TypeError: fetch failed`. A sandbox exec streams for the
 * whole command, and `cargo test -q` over a 347k-line crate is silent for
 * longer than that while it compiles — so a Rust project's baseline suite
 * died mid-build with nothing on the run but "Sandbox request failed: fetch
 * failed" (run-386d5413, 2026-09-04).
 *
 * The deadlines that should bind an exec already exist: the daemon enforces
 * `timeoutSec` and the client sets its own request deadline above it. The
 * transport's idle limit adds a third, shorter clock, so the sandbox client
 * gets this fetch instead of the global one.
 *
 * Why a fetch and not `setGlobalDispatcher`: the npm `undici` package and the
 * undici Node bundles for its global fetch are separate instances, and the
 * package's global dispatcher does not reach Node's fetch — this module's
 * test proved that by failing. Handing the client a fetch from the same
 * package as the dispatcher is the only arrangement that is checkable.
 */
const longRequestAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export const longRequestFetch: typeof globalThis.fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: longRequestAgent,
  }) as unknown as Promise<Response>;
