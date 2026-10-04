import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalExecutor } from "@neutron-build/agents";
import { setupRepo } from "./git.js";
import { secretEnvNames } from "./guard.js";
import { assertRepoAllowed, credentialFor, policyFromEnv } from "./repo-policy.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import { proposeFromExecutor } from "./stack-propose.js";
import type { StackProposal } from "./stack-propose.js";

/**
 * `ship project detect <repo>` and the setup page's suggestions share this:
 * resolve a target to a checked-out tree, read it, propose, clean up.
 *
 * A directory that exists is read IN PLACE (nothing is written to it). A URL is
 * shallow-cloned into a fresh temp directory under the repo allowlist and the
 * credential rules every other clone obeys (a token only ever goes to an
 * allowed origin), then deleted. Operator trust: an operator typed the target.
 * Only the fixed read operations in stack-propose.ts run in the tree; no
 * command from the repository is executed.
 */
export async function detectRepository(
  target: string,
  options: { policy?: RepoPolicyConfig; image?: string } = {},
): Promise<StackProposal> {
  const extra = options.image !== undefined ? { image: options.image } : {};
  const asPath = resolve(target);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && existsSync(asPath) && statSync(asPath).isDirectory()) {
    const executor = new LocalExecutor({ root: asPath, envDenylist: secretEnvNames() });
    return proposeFromExecutor(executor, extra);
  }
  const policy = options.policy ?? policyFromEnv();
  const ref = assertRepoAllowed(target, { trust: "operator", config: policy });
  const token = credentialFor(ref, policy);
  const root = await mkdtemp(join(tmpdir(), "ship-detect-"));
  try {
    const executor = new LocalExecutor({ root, envDenylist: secretEnvNames() });
    await setupRepo(executor, { ref, token, runId: "detect" });
    return await proposeFromExecutor(executor, extra);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
