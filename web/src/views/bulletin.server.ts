import { randomUUID } from "node:crypto";

import {
  BULLETIN_SOURCE,
  BulletinPolicyError,
  FileBulletinStore,
  NucleusBulletinStore,
  PostRejected,
  assertBoardSendable,
  changeClassGateEnabled,
  dedupeKeyFor,
  findSimilar,
  normalizeBoard,
  normalizePost,
  publicStatus,
  redactPost,
  sweepBulletin,
  taskDetailFor,
  titleSimilarity,
  voterHash,
} from "teploy-ship/bulletin";
import type { BulletinBoard, BulletinPost, BulletinStore, BulletinSweepResult, PostKind } from "teploy-ship/bulletin";
import { RepoNotAllowedError, proposeExternal } from "teploy-ship/runtime";
import type { NucleusShipRuntime, ShipRuntime } from "teploy-ship/runtime";

import { may } from "../lib/authority.server.js";
import { trustProxy } from "../lib/oidc.server.js";
import { checkRateLimit, clientKey, delay } from "../lib/ratelimit.server.js";
import { currentUser } from "../lib/session.server.js";
import { redirect } from "../lib/http.server.js";
import { shipRuntime, webToken } from "../lib/store.server.js";
import type { AdminBoard, AdminNote, BulletinAdminData, BulletinData, NoteView } from "./bulletin.js";

/**
 * L6 — server half of the Bulletin.
 *
 * Everything node-only lives here rather than in the route modules for the
 * build reason documented in lib/webhook.server.ts: a route module's default
 * export goes into the CLIENT bundle and takes its imports with it, and
 * `teploy-ship/bulletin` reaches node:fs through its store.
 *
 * The security posture of this file in one line: the public loader and the
 * public action are the ONLY code in Ship that runs for a caller with no
 * identity of any kind, so they hand back nothing that was not built for a
 * stranger to read — {@link toPublicNote} is the boundary, and the operator's
 * loader is a separate function precisely so no flag can be forgotten in a
 * shared one.
 */

let store: Promise<BulletinStore> | null = null;

export function bulletinStore(): Promise<BulletinStore> {
  store ??= (async (): Promise<BulletinStore> => {
    const runtime = await shipRuntime();
    return runtime.kind === "nucleus"
      ? new NucleusBulletinStore((runtime as NucleusShipRuntime).db)
      : new FileBulletinStore();
  })();
  return store;
}

/**
 * Rate limits for a surface with no accounts.
 *
 * Never lockable — see ratelimit.server.ts on why a hard lock on a key an
 * attacker chooses is itself the denial of service. With no declared proxy
 * every visitor shares one bucket, so a flood slows the whole board rather than
 * locking anyone out of it; that is the correct trade for a page whose worst
 * case is "a note was not pinned this second".
 */
const pinLimits = { limit: 3, windowMs: 10 * 60_000, lockoutMs: 0, maxConcurrent: 4 };
const voteLimits = { limit: 30, windowMs: 10 * 60_000, lockoutMs: 0, maxConcurrent: 4 };

/**
 * Above this, a fresh note is treated as the same note.
 *
 * Higher than SIMILAR_THRESHOLD (0.5, which only earns a "this looks like…"
 * nudge) because refusing a post is destructive: at 0.9 the titles share nearly
 * every content word, which is a re-submit or a brigade, not a second person
 * describing a second problem.
 */
const DUPLICATE_THRESHOLD = 0.9;

const VOTER_COOKIE = "ship_bulletin";

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * The visitor identity a vote is counted against.
 *
 * A cookie, not an address: addresses are shared by whole offices and whole
 * countries, so counting votes per address silently disenfranchises them. The
 * cookie is clearable and therefore weak — see voterHash in src/bulletin.ts for
 * why the threshold it feeds is not load-bearing on its own.
 */
function voterOf(request: Request): { id: string; fresh: boolean } {
  const existing = cookieValue(request, VOTER_COOKIE);
  if (existing !== null && existing !== "") return { id: existing, fresh: false };
  return { id: randomUUID(), fresh: true };
}

function voterCookie(id: string, secure: boolean): string {
  return [
    `${VOTER_COOKIE}=${encodeURIComponent(id)}`,
    "Path=/bulletin",
    "Max-Age=31536000",
    "SameSite=Lax",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Fixed sentences, addressed by code.
 *
 * The banner text is chosen HERE and the URL carries only a key, so nothing a
 * caller types can be reflected onto the page. A public board with a
 * `?error=<attacker's sentence>` parameter is a phishing kit with Ship's
 * styling on it.
 */
const NOTICES: Record<string, string> = {
  pinned: "Pinned. It is on the board now.",
  voted: "Your vote is counted.",
  "already-voted": "You have already voted for that note.",
  duplicate: "That note is already on the board — your vote has been added to it instead.",
};

const ERRORS: Record<string, string> = {
  closed: "This board is not accepting new notes.",
  slow: "That is a lot of notes in a short time. Try again in a few minutes.",
  short: "Give the note a title of at least six characters.",
  email: "That email address does not look like an address. Leave it blank to post anonymously.",
  unknown: "That note is not on this board.",
  invalid: "Something in that note could not be read. Try again.",
};

function noteFilter(filter: string): (post: BulletinPost, status: string) => boolean {
  if (filter === "bugs") return (post) => post.kind === "bug";
  if (filter === "requests") return (post) => post.kind === "request";
  if (filter === "shipped") return (_post, status) => status === "shipped";
  return () => true;
}

/**
 * Resolve the status of every note that has been promoted.
 *
 * One task read and at most one run read per promoted note. Bounded by the
 * board's size on purpose: deriving the status is what keeps the post record
 * from becoming a second, stale copy of the truth (see publicStatus), and a
 * board with enough notes for this to matter has a bigger problem than latency.
 */
async function statusesFor(runtime: ShipRuntime, posts: BulletinPost[]): Promise<Map<string, ReturnType<typeof publicStatus>>> {
  const out = new Map<string, ReturnType<typeof publicStatus>>();
  for (const post of posts) {
    if (post.taskId === undefined) {
      out.set(post.postId, publicStatus({ post }));
      continue;
    }
    const task = await runtime.intake.get(post.taskId).catch(() => null);
    const meta = task?.runId === undefined ? null : await runtime.loadMeta(task.runId).catch(() => null);
    out.set(
      post.postId,
      publicStatus({
        post,
        ...(task !== null ? { taskState: task.state } : {}),
        ...(meta !== null ? { runStatus: meta.status } : {}),
      }),
    );
  }
  return out;
}

/** The ONLY shape a note leaves the server in for an anonymous caller. */
function toPublicNote(post: BulletinPost, status: ReturnType<typeof publicStatus>, voter: string, secret: string): NoteView {
  return {
    postId: post.postId,
    kind: post.kind,
    title: post.title,
    body: post.body,
    votes: post.votes,
    status,
    createdAt: post.createdAt,
    voted: post.voters.includes(voterHash(secret, post.postId, voter)),
  };
}

export async function loader({ params, request }: { params: { slug: string }; request: Request }): Promise<BulletinData | Response> {
  const bulletin = await bulletinStore();
  const board = await bulletin.getBoard(params.slug);
  // 404 rather than a redirect: a wrong slug is a wrong URL, and bouncing an
  // anonymous visitor to /login would be Ship advertising its console.
  if (board === null) return new Response("No such board.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

  const url = new URL(request.url);
  const filter = ["bugs", "requests", "shipped"].includes(url.searchParams.get("filter") ?? "")
    ? url.searchParams.get("filter")!
    : "all";
  const runtime = await shipRuntime();
  const posts = await bulletin.listPosts(board.slug);
  const statuses = await statusesFor(runtime, posts);
  const voter = voterOf(request);
  const secret = webToken();
  const keep = noteFilter(filter);

  const notes = posts
    .filter((post) => keep(post, statuses.get(post.postId) ?? "pinned"))
    // redactPost as well as toPublicNote: the mapping already never reads the
    // email, and stripping it a second time is what keeps that true if the
    // mapping ever grows a field.
    .map((post) => toPublicNote(redactPost(post), statuses.get(post.postId) ?? "pinned", voter.id, secret));

  const similarId = url.searchParams.get("similar");
  const similar = similarId === null ? null : posts.find((p) => p.postId === similarId) ?? null;

  return {
    view: "bulletin",
    board: { slug: board.slug, title: board.title, blurb: board.blurb ?? "", open: board.open },
    notes,
    filter,
    notice: NOTICES[url.searchParams.get("ok") ?? ""] ?? null,
    error: ERRORS[url.searchParams.get("error") ?? ""] ?? null,
    similar: similar === null ? null : { postId: similar.postId, title: similar.title },
  };
}

function back(slug: string, query: string, cookie?: string): Response {
  const response = redirect(`/bulletin/${slug}${query}`);
  if (cookie !== undefined) response.headers.set("set-cookie", cookie);
  return response;
}

export async function action({ params, request }: { params: { slug: string }; request: Request }): Promise<Response> {
  const bulletin = await bulletinStore();
  const board = await bulletin.getBoard(params.slug);
  if (board === null) return new Response("No such board.", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const voter = voterOf(request);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const cookie = voter.fresh ? voterCookie(voter.id, secure) : undefined;
  const client = clientKey(request, trustProxy());

  if (intent === "vote") {
    const limited = checkRateLimit(`bulletin-vote:${client.key}`, Date.now(), voteLimits, false);
    if (limited.delayMs !== undefined) await delay(limited.delayMs);
    const postId = String(form.get("postId") ?? "");
    const existing = await bulletin.getPost(postId);
    if (existing === null || existing.board !== board.slug) return back(board.slug, "?error=unknown", cookie);
    const hash = voterHash(webToken(), postId, voter.id);
    if (existing.voters.includes(hash)) return back(board.slug, `?ok=already-voted#${postId}`, cookie);
    await bulletin.updatePost(postId, (post) => ({
      ...post,
      votes: post.votes + 1,
      voters: [...post.voters, hash],
      updatedAt: new Date().toISOString(),
    }));
    return back(board.slug, `?ok=voted#${postId}`, cookie);
  }

  if (intent !== "pin") return back(board.slug, "?error=invalid", cookie);
  if (!board.open) return back(board.slug, "?error=closed", cookie);

  const limited = checkRateLimit(`bulletin-pin:${client.key}`, Date.now(), pinLimits, false);
  if (limited.delayMs !== undefined) await delay(limited.delayMs);

  let post: BulletinPost;
  try {
    post = normalizePost({
      board: board.slug,
      kind: String(form.get("kind") ?? ""),
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      notifyEmail: String(form.get("email") ?? ""),
    });
  } catch (error) {
    if (!(error instanceof PostRejected)) throw error;
    return back(board.slug, `?error=${/email/.test(error.message) ? "email" : "short"}`, cookie);
  }

  const existing = await bulletin.listPosts(board.slug);
  const twin = existing.find((p) => titleSimilarity(p.title, post.title) >= DUPLICATE_THRESHOLD);
  if (twin !== undefined) {
    // The same note, said again. Counting it as a vote is strictly better than
    // either storing a duplicate (which splits the signal the threshold reads)
    // or dropping it silently (which reads as the board being broken).
    const hash = voterHash(webToken(), twin.postId, voter.id);
    if (!twin.voters.includes(hash)) {
      await bulletin.updatePost(twin.postId, (p) => ({
        ...p,
        votes: p.votes + 1,
        voters: [...p.voters, hash],
        updatedAt: new Date().toISOString(),
      }));
    }
    return back(board.slug, `?ok=duplicate&similar=${twin.postId}#${twin.postId}`, cookie);
  }

  await bulletin.addPost(post);
  const [similar] = findSimilar(existing, post.title);
  return back(
    board.slug,
    `?ok=pinned${similar !== undefined ? `&similar=${similar.postId}` : ""}#${post.postId}`,
    cookie,
  );
}

// ── The operator's half ───────────────────────────────────────────────────

const ADMIN_NOTICES: Record<string, string> = {
  saved: "Board saved.",
  sent: "Sent to Ship. It is an intake proposal now — the Inbox decides whether it runs.",
  declined: "Declined. Notes with similar titles will not be auto-sent for 30 days.",
  shipped: "Marked shipped. The board now says so.",
  reopened: "Reopened.",
};

async function adminBoard(bulletin: BulletinStore, board: BulletinBoard): Promise<AdminBoard> {
  const posts = await bulletin.listPosts(board.slug);
  return {
    slug: board.slug,
    title: board.title,
    blurb: board.blurb ?? "",
    repo: board.repo ?? "",
    shipPolicy: board.shipPolicy,
    autoMinVotes: board.autoMinVotes,
    autoKinds: board.autoKinds,
    dailyAutoCap: board.dailyAutoCap,
    open: board.open,
    noteCount: posts.length,
    flaggedCount: posts.filter((p) => p.flags.length > 0).length,
  };
}

export async function adminLoader({ request }: { request: Request }): Promise<BulletinAdminData> {
  const [bulletin, runtime, me] = await Promise.all([bulletinStore(), shipRuntime(), currentUser(request)]);
  const url = new URL(request.url);
  const slug = url.searchParams.get("board") ?? "";
  const boards = await bulletin.listBoards();
  const selected = boards.find((b) => b.slug === slug) ?? null;

  const posts = selected === null ? [] : await bulletin.listPosts(selected.slug);
  const statuses = await statusesFor(runtime, posts);
  const notes: AdminNote[] = [];
  for (const post of posts) {
    const task = post.taskId === undefined ? null : await runtime.intake.get(post.taskId).catch(() => null);
    const meta = task?.runId === undefined ? null : await runtime.loadMeta(task.runId).catch(() => null);
    notes.push({
      postId: post.postId,
      kind: post.kind,
      title: post.title,
      body: post.body,
      votes: post.votes,
      status: statuses.get(post.postId) ?? "pinned",
      createdAt: post.createdAt,
      voted: false,
      flags: post.flags,
      taskId: post.taskId ?? "",
      taskState: task?.state ?? "",
      runId: task?.runId ?? "",
      runStatus: meta?.status ?? "",
      sentAt: post.sentAt ?? "",
    });
  }

  const [canEdit, canAuto, policies] = await Promise.all([
    may("policies", me),
    may("auto", me),
    runtime.policies.list().catch(() => []),
  ]);

  return {
    view: "bulletin-admin",
    boards: await Promise.all(boards.map((b) => adminBoard(bulletin, b))),
    selected: selected === null ? null : await adminBoard(bulletin, selected),
    notes,
    gateOn: changeClassGateEnabled(),
    sourcePolicy: policies.find((p) => p.source === BULLETIN_SOURCE)?.policy ?? "propose",
    publicBase: (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    canEdit,
    canAuto,
    store: runtime.kind,
    notice: ADMIN_NOTICES[url.searchParams.get("ok") ?? ""] ?? null,
    // Capped, and rendered as text by Preact rather than as markup: the sentence
    // comes from Ship's own validators, but a crafted link is the reason it is
    // bounded rather than trusted.
    error: (url.searchParams.get("error") ?? "").slice(0, 300) || null,
  };
}

function adminBack(slug: string, params: string): Response {
  const query = slug === "" ? params : `board=${encodeURIComponent(slug)}&${params}`;
  return redirect(`/bulletin-admin?${query}`);
}

export async function adminAction({ request }: { request: Request }): Promise<Response> {
  const [bulletin, runtime, me] = await Promise.all([bulletinStore(), shipRuntime(), currentUser(request)]);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Same two grants the Sources page uses (governance.ts): a board IS a policy,
  // and turning one to `auto` is unattended execution and spend.
  if (!(await may("policies", me))) return adminBack("", "error=Your+account+may+not+change+policies");

  if (intent === "save-board") {
    const slug = String(form.get("slug") ?? "");
    const shipPolicy = String(form.get("shipPolicy") ?? "manual") === "auto" ? "auto" : "manual";
    if (shipPolicy === "auto" && !(await may("auto", me))) {
      return adminBack(slug, "error=Your+account+may+not+set+a+board+to+auto");
    }
    const kinds = String(form.get("autoKinds") ?? "bug")
      .split(",")
      .map((k) => k.trim())
      .filter((k): k is PostKind => k === "bug" || k === "request");
    try {
      const board = normalizeBoard({
        slug,
        title: String(form.get("title") ?? ""),
        blurb: String(form.get("blurb") ?? ""),
        repo: String(form.get("repo") ?? ""),
        shipPolicy,
        autoMinVotes: Number(form.get("autoMinVotes") ?? 3),
        autoKinds: kinds,
        dailyAutoCap: Number(form.get("dailyAutoCap") ?? 5),
        open: form.get("open") !== null,
      });
      // Refused HERE, at save time, not only at send time: the two settings
      // this checks live in different stores, and a board that is stored as
      // `auto` while unable to send is a configuration that lies to whoever
      // reads it next.
      assertBoardSendable({
        board,
        project: board.repo === undefined ? null : await runtime.projects.forRepo(board.repo),
      });
      await bulletin.setBoard(board);
      return adminBack(board.slug, "ok=saved");
    } catch (error) {
      if (!(error instanceof BulletinPolicyError)) throw error;
      return adminBack(slug, `error=${encodeURIComponent(error.message)}`);
    }
  }

  const slug = String(form.get("board") ?? "");
  const postId = String(form.get("postId") ?? "");
  const post = await bulletin.getPost(postId);
  if (post === null) return adminBack(slug, "error=that+note+is+gone");

  if (intent === "decline" || intent === "shipped") {
    await bulletin.updatePost(postId, (p) => ({
      ...p,
      staffStatus: intent === "decline" ? "declined" : "shipped",
      updatedAt: new Date().toISOString(),
    }));
    return adminBack(slug, intent === "decline" ? "ok=declined" : "ok=shipped");
  }

  if (intent === "reopen") {
    await bulletin.updatePost(postId, (p) => {
      const { staffStatus: _cleared, ...rest } = p;
      return { ...rest, updatedAt: new Date().toISOString() };
    });
    return adminBack(slug, "ok=reopened");
  }

  if (intent !== "send") return adminBack(slug, "error=unknown+action");

  const board = await bulletin.getBoard(slug);
  if (board === null) return adminBack("", "error=that+board+is+gone");
  if (board.repo === undefined || board.repo === "") {
    return adminBack(slug, "error=name+a+repository+on+this+board+first");
  }
  try {
    // proposeExternal, not intake.propose: the repo allowlist is re-checked at
    // `trust: "external"` because the TEXT came from the public, even though the
    // repository came from an operator.
    const { task } = await proposeExternal(runtime, {
      source: BULLETIN_SOURCE,
      kind: post.kind === "bug" ? "issue" : "request",
      repo: board.repo,
      title: post.title,
      detail: taskDetailFor(board, post),
      dedupeKey: dedupeKeyFor(post),
    });
    await bulletin.updatePost(postId, (p) => ({
      ...p,
      taskId: task.taskId,
      sentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    return adminBack(slug, "ok=sent");
  } catch (error) {
    if (error instanceof RepoNotAllowedError) {
      return adminBack(slug, `error=${encodeURIComponent(error.message.slice(0, 200))}`);
    }
    throw error;
  }
}

/**
 * One sweep of every auto board, for `POST /api/bulletin/sweep`.
 *
 * Lives on an authenticated API route rather than in the worker's tick because
 * the worker is not this lane's to edit — see docs/bulletin.md for the one-line
 * patch that makes it a resident sweep, which is where it belongs.
 */
export async function runBulletinSweep(log: (line: string) => void = () => {}): Promise<BulletinSweepResult> {
  const [bulletin, runtime] = await Promise.all([bulletinStore(), shipRuntime()]);
  return sweepBulletin({
    store: bulletin,
    propose: (input) => proposeExternal(runtime, input),
    projectFor: (repo) => runtime.projects.forRepo(repo),
    log,
  });
}
