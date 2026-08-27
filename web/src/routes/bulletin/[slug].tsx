import Bulletin from "../../views/bulletin.js";
import { action, loader } from "../../views/bulletin.server.js";

export const config = { mode: "app" };

/**
 * L6 — the public bulletin at `/bulletin/<slug>`.
 *
 * The ONE unauthenticated HTML page Ship serves. It is exempt from the bearer
 * middleware in _layout.tsx alongside the webhook receivers, and unlike them it
 * has no signature to check — the caller is a member of the public and proves
 * nothing. What bounds it is on the other side: a note becomes an intake
 * PROPOSAL, the repository is the board's and never the poster's, the text is
 * screened and framed as untrusted, and an unattended send needs the L3
 * change-class gate to be live (src/bulletin.ts).
 *
 * Everything here is a plain form POST and a redirect. A visitor to this page
 * did not choose to use Ship, so it must work with JavaScript off.
 */
export { loader, action };

export default Bulletin;
