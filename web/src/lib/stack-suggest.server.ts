import { detectRepository } from "../../../dist/stack-import.js";
import { stackDetectEnabled } from "../../../dist/stack-propose.js";
import { suggestionView } from "./stack-suggest.js";
import type { SuggestionView } from "./stack-suggest.js";

/**
 * Setup-page suggestions. Off unless SHIP_STACK_DETECT is on, and then only
 * when the operator asks (`?detect=1`): a detection shallow-clones the repo
 * into a temp directory, which is not something a page view should do on its
 * own. Results are memoised for a few minutes and at most one detection per
 * repository runs at a time, so repeated clicks cannot fan out into clones.
 *
 * The dashboard deliberately holds no worker credentials, so a private
 * repository fails here with an explanation; `teploy-ship project detect`
 * from a host that has a token gives the same proposal.
 */
export type SuggestionResult = { view: SuggestionView } | { error: string };

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; result: SuggestionResult }>();
const inflight = new Map<string, Promise<SuggestionResult>>();

export async function suggestionsFor(url: string, image: string | undefined): Promise<SuggestionResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const running = inflight.get(url);
  if (running) return running;
  const job = (async (): Promise<SuggestionResult> => {
    try {
      const view = suggestionView(await detectRepository(url, image !== undefined ? { image } : {}));
      return { view };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `Could not read the repository from the dashboard (${msg.slice(0, 300)}). A private repository needs a clone credential this process does not hold; run \`teploy-ship project detect <url>\` from the worker host.` };
    }
  })();
  inflight.set(url, job);
  try {
    const result = await job;
    if ("view" in result) cache.set(url, { at: Date.now(), result });
    return result;
  } finally {
    inflight.delete(url);
  }
}

export { stackDetectEnabled };
