import { BulletinAdmin } from "../views/bulletin.js";
import { adminAction, adminLoader } from "../views/bulletin.server.js";

export const config = { mode: "app" };

/**
 * L6 — the operator's view of the public boards.
 *
 * Deliberately NOT under `/bulletin/`: that prefix is the middleware's
 * unauthenticated exemption (_layout.tsx), so a page placed inside it would be
 * served to the public. This one sits outside it and authenticates normally,
 * which is why the path has a dash rather than a slash.
 */
export const loader = adminLoader;
export const action = adminAction;

export default BulletinAdmin;
