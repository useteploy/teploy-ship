import type { PostKind, PublicStatus } from "teploy-ship/bulletin";

import { SubNav } from "../lib/subnav.js";
import { PROJECT_VIEWS } from "./project-views.js";

/**
 * L6 — the public bulletin, and the operator's view of it.
 *
 * Two components in one module because they render the same objects and must
 * agree about them; they differ in exactly one way, and it is the whole point:
 * the public component is given data that has already had the poster's email,
 * the injection flags, the task id and the run status removed. Nothing here
 * can leak them because nothing here is handed them — see bulletin.server.ts,
 * where the two loaders build different shapes.
 *
 * The public page works with JavaScript off. Every action is a plain form POST
 * followed by a redirect: a bulletin is the one surface in Ship whose visitors
 * did not choose to use Ship, so it cannot require anything of their browser.
 */

/**
 * Mirrors PUBLIC_STATUS_LABELS (src/bulletin.ts). Copied rather than imported
 * for the reason PLAN_EVENT has its own module: a component runs in the client
 * bundle, and `teploy-ship/bulletin` reaches node:fs through the store.
 */
const STATUS_LABEL: Record<PublicStatus, string> = {
  pinned: "Pinned",
  "picked-up": "Picked up",
  "fix-open": "Fix open",
  shipped: "Shipped",
  declined: "Declined",
};

/** Status colours reuse the run palette so one glance reads the same everywhere. */
const STATUS_CLASS: Record<PublicStatus, string> = {
  pinned: "",
  "picked-up": "queued",
  "fix-open": "waiting",
  shipped: "completed",
  declined: "cancelled",
};

export interface NoteView {
  postId: string;
  kind: PostKind;
  title: string;
  body: string;
  votes: number;
  status: PublicStatus;
  createdAt: string;
  /** This visitor has already voted for it (cookie identity — see voterHash). */
  voted: boolean;
}

export interface BulletinData {
  view: "bulletin";
  board: { slug: string; title: string; blurb: string; open: boolean };
  notes: NoteView[];
  /** all | bugs | requests | shipped */
  filter: string;
  notice: string | null;
  error: string | null;
  /** The existing note a fresh pin resembled, if any. */
  similar: { postId: string; title: string } | null;
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "bugs", label: "Bugs" },
  { key: "requests", label: "Requests" },
  { key: "shipped", label: "Shipped" },
];

function day(iso: string): string {
  return iso.slice(0, 10);
}

const CSS = `
.board { display: grid; gap: 10px; }
.note { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 12px 14px;
  display: grid; grid-template-columns: 62px 1fr; gap: 14px; align-items: start; }
.note .vote { display: grid; justify-items: center; gap: 3px; }
.note .vote form { margin: 0; }
.note .vote button { width: 56px; padding: 5px 0; line-height: 1.1; }
.note .vote .tally { font-size: 16px; font-weight: 600; }
.note .vote .unit { font-size: 11px; color: var(--dim); }
.note h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.note .said { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--text); }
.note .when { color: var(--dim); font-size: 12px; }
.pin { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 14px; margin: 10px 0 0; }
.pin label { display: block; margin: 10px 0 4px; font-size: 12px; color: var(--dim); }
.pin input[type=text], .pin input[type=email], .pin textarea { width: 100%; }
.pin .kinds { display: flex; gap: 14px; align-items: center; margin: 6px 0 0; }
.pin .kinds label { margin: 0; color: var(--text); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; }
.banner { border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 10px 12px; margin: 12px 0; }
.banner.ok { border-left-color: var(--green); }
.banner.bad { border-left-color: var(--red); }
`;

export default function Bulletin({ data }: { data: BulletinData }) {
  const { board, notes } = data;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1 class="page">{board.title}</h1>
      <p class="meta">{board.blurb !== "" ? board.blurb : "Pin a note about something broken or something missing. Anyone can read this board."}</p>

      {data.error !== null && <div class="banner bad">{data.error}</div>}
      {data.notice !== null && (
        <div class="banner ok">
          {data.notice}
          {data.similar !== null && (
            <>
              {" "}This looks like <a href={`#${data.similar.postId}`}>{data.similar.title}</a> — voting for that one
              helps it get picked up sooner.
            </>
          )}
        </div>
      )}

      <div class="chips">
        {FILTERS.map((f) => (
          <a
            href={f.key === "all" ? `/bulletin/${board.slug}` : `/bulletin/${board.slug}?filter=${f.key}`}
            class={data.filter === f.key ? "on" : undefined}
          >
            {f.label}
          </a>
        ))}
      </div>

      {notes.length === 0 ? (
        <p class="empty">No notes here yet. Pin the first one below.</p>
      ) : (
        <div class="board">
          {notes.map((note) => (
            <div class="note" id={note.postId}>
              <div class="vote">
                <form method="post">
                  <input type="hidden" name="intent" value="vote" />
                  <input type="hidden" name="postId" value={note.postId} />
                  <button type="submit" class="sm" disabled={note.voted} title={note.voted ? "You have voted for this" : "Vote for this note"}>
                    {note.voted ? "Voted" : "Vote"}
                  </button>
                </form>
                <span class="tally">{note.votes}</span>
                <span class="unit">{note.votes === 1 ? "vote" : "votes"}</span>
              </div>
              <div>
                <h3>{note.title}</h3>
                <span class="chip">{note.kind === "bug" ? "Bug" : "Request"}</span>{" "}
                <span class={`status ${STATUS_CLASS[note.status]}`}>{STATUS_LABEL[note.status]}</span>{" "}
                <span class="when">pinned {day(note.createdAt)}</span>
                {note.body !== "" && <p class="said">{note.body}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 class="section">Pin a note</h2>
      {board.open ? (
        <form method="post" class="pin">
          <input type="hidden" name="intent" value="pin" />
          <div class="kinds">
            <label><input type="radio" name="kind" value="bug" checked /> Something is broken</label>
            <label><input type="radio" name="kind" value="request" /> Something is missing</label>
          </div>
          <label for="title">One line: what happened</label>
          <input type="text" id="title" name="title" maxLength={140} required placeholder="The contact form loses my message" />
          <label for="body">Anything that helps someone reproduce it</label>
          <textarea id="body" name="body" rows={5} maxLength={4000} placeholder="What you did, what you expected, what happened instead." />
          <label for="email">Email for updates (optional)</label>
          <input type="email" id="email" name="email" maxLength={254} placeholder="you@example.com" />
          <p class="meta" style="margin:10px 0 12px">
            Your note is public. Do not include passwords, tokens, or anything private — your email is not shown on
            this page.
          </p>
          <button type="submit">Pin it</button>
        </form>
      ) : (
        <p class="empty">This board is closed to new notes.</p>
      )}
    </>
  );
}

// ── The operator's view ───────────────────────────────────────────────────

export interface AdminNote extends NoteView {
  /** What screenUntrusted matched at pin time. Operator-only, never public. */
  flags: string[];
  taskId: string;
  taskState: string;
  runId: string;
  runStatus: string;
  sentAt: string;
}

export interface AdminBoard {
  slug: string;
  title: string;
  blurb: string;
  repo: string;
  shipPolicy: string;
  autoMinVotes: number;
  autoKinds: PostKind[];
  dailyAutoCap: number;
  open: boolean;
  noteCount: number;
  flaggedCount: number;
}

export interface BulletinAdminData {
  view: "bulletin-admin";
  boards: AdminBoard[];
  selected: AdminBoard | null;
  notes: AdminNote[];
  /** SHIP_CHANGE_CLASS — auto boards are refused while this is off. */
  gateOn: boolean;
  /** The intake policy on the `bulletin` source: what happens to a promoted note. */
  sourcePolicy: string;
  publicBase: string;
  canEdit: boolean;
  canAuto: boolean;
  store: string;
  notice: string | null;
  error: string | null;
}

export function BulletinAdmin({ data }: { data: BulletinAdminData }) {
  const board = data.selected;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1 class="page">Projects</h1>
      <SubNav items={PROJECT_VIEWS} current="bulletin" />
      <p class="meta">
        Public boards. A note pinned by a stranger becomes an intake proposal — never a run directly. · store:{" "}
        {data.store}
      </p>

      {data.error !== null && <div class="banner bad">{data.error}</div>}
      {data.notice !== null && <div class="banner ok">{data.notice}</div>}

      <div class="card">
        <b>Two switches stand between a public note and an unattended run.</b>
        <p class="meta" style="margin:6px 0 0">
          The change-class gate (<code>SHIP_CHANGE_CLASS</code>) is{" "}
          <b style={data.gateOn ? "color:var(--green)" : "color:var(--yellow)"}>{data.gateOn ? "on" : "off"}</b> — while
          it is off, a board cannot be set to auto at all. The <code>bulletin</code> intake source is{" "}
          <b>{data.sourcePolicy}</b>: a promoted note{" "}
          {data.sourcePolicy === "auto" ? "launches a run on the next sweep" : "waits in the inbox for a person"}.{" "}
          <a href="/projects?view=sources">Change it on Sources</a>.
        </p>
      </div>

      <h2 class="section">Boards <span class="count">({data.boards.length})</span></h2>
      {data.boards.length === 0 ? (
        <p class="empty">No boards yet. Create one below.</p>
      ) : (
        <div class="table-wrap">
          <table class="runs">
            <thead>
              <tr>
                <th>Board</th>
                <th>Repo</th>
                <th>Policy</th>
                <th>Threshold</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.boards.map((b) => (
                <tr>
                  <td>
                    <a href={`/bulletin-admin?board=${encodeURIComponent(b.slug)}`}>{b.title}</a>
                    <div class="when">
                      <a href={`${data.publicBase}/bulletin/${b.slug}`}>/bulletin/{b.slug}</a>
                      {b.open ? "" : " · closed"}
                    </div>
                  </td>
                  <td>{b.repo === "" ? <span class="when">none</span> : b.repo}</td>
                  <td>
                    <span class={`status ${b.shipPolicy === "auto" ? "waiting" : ""}`}>{b.shipPolicy}</span>
                  </td>
                  <td>
                    {b.autoMinVotes} vote(s) · {b.autoKinds.join(", ")} · {b.dailyAutoCap}/day
                  </td>
                  <td>
                    {b.noteCount}
                    {b.flaggedCount > 0 && <span style="color:var(--yellow)"> · {b.flaggedCount} flagged</span>}
                  </td>
                  <td class="row-actions">
                    <a href={`/bulletin-admin?board=${encodeURIComponent(b.slug)}`}>Edit</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 class="section">{board === null ? "New board" : `Board: ${board.slug}`}</h2>
      <form method="post" class="pin">
        <input type="hidden" name="intent" value="save-board" />
        <label for="slug">Slug (the public URL)</label>
        <input type="text" id="slug" name="slug" value={board?.slug ?? ""} readOnly={board !== null} required placeholder="site-feedback" />
        <label for="btitle">Title</label>
        <input type="text" id="btitle" name="title" value={board?.title ?? ""} placeholder="Tell us what is broken" />
        <label for="blurb">One sentence under the title</label>
        <input type="text" id="blurb" name="blurb" value={board?.blurb ?? ""} />
        <label for="repo">Repository notes are sent to</label>
        <input type="text" id="repo" name="repo" value={board?.repo ?? ""} placeholder="https://forge.example/owner/repo.git" />
        <label for="policy">Send policy</label>
        <select id="policy" name="shipPolicy">
          {["manual", "auto"].map((p) => (
            <option value={p} selected={(board?.shipPolicy ?? "manual") === p}>{p}</option>
          ))}
        </select>
        <label for="votes">Votes before an auto send</label>
        <input type="number" id="votes" name="autoMinVotes" min={0} value={String(board?.autoMinVotes ?? 3)} />
        <label for="kinds">Kinds that may be auto-sent</label>
        <select id="kinds" name="autoKinds">
          <option value="bug" selected={(board?.autoKinds ?? ["bug"]).join(",") === "bug"}>bug only</option>
          <option value="bug,request" selected={(board?.autoKinds ?? []).join(",") === "bug,request"}>bug and request</option>
        </select>
        <label for="cap">Auto sends per day</label>
        <input type="number" id="cap" name="dailyAutoCap" min={1} value={String(board?.dailyAutoCap ?? 5)} />
        <label><input type="checkbox" name="open" value="1" checked={board?.open ?? true} /> Accepting new notes</label>
        <p class="meta" style="margin:10px 0 12px">
          Auto is refused while the change-class gate is off, and refused on a repository with auto-merge on.
        </p>
        <div class="row-actions">
          <button type="submit" disabled={!data.canEdit}>{board === null ? "Create board" : "Save board"}</button>
          {board !== null && <a href="/bulletin-admin">New board</a>}
        </div>
      </form>

      {board !== null && (
        <>
          <h2 class="section">Notes <span class="count">({data.notes.length})</span></h2>
          {data.notes.length === 0 ? (
            <p class="empty">Nothing pinned yet.</p>
          ) : (
            data.notes.map((note) => (
              <div class={`card${note.flags.length > 0 ? " attn" : ""}`}>
                <b>{note.title}</b>
                <div class="meta" style="margin:4px 0">
                  <span class="chip">{note.kind}</span>{" "}
                  <span class={`status ${STATUS_CLASS[note.status]}`}>{STATUS_LABEL[note.status]}</span>{" "}
                  {note.votes} vote(s) · pinned {day(note.createdAt)}
                  {note.taskId !== "" && (
                    <>
                      {" "}· task {note.taskId} ({note.taskState})
                    </>
                  )}
                  {note.runId !== "" && (
                    <>
                      {" "}· <a href={`/runs/${note.runId}`}>{note.runId}</a> {note.runStatus}
                    </>
                  )}
                </div>
                {note.flags.length > 0 && (
                  <p class="meta" style="color:var(--yellow);margin:4px 0">
                    Flagged by the injection screen: {note.flags.join("; ")}. The text is still carried verbatim and
                    framed as untrusted for the agent — this is what the operator sees, not a block.
                  </p>
                )}
                {note.body !== "" && <p class="said">{note.body}</p>}
                <form method="post" class="row-actions" style="margin-top:8px">
                  <input type="hidden" name="board" value={board.slug} />
                  <input type="hidden" name="postId" value={note.postId} />
                  <button type="submit" name="intent" value="send" class="sm" disabled={!data.canEdit || note.taskId !== ""}>
                    Send to Ship
                  </button>
                  <button type="submit" name="intent" value="shipped" class="sm approve" disabled={!data.canEdit}>
                    Mark shipped
                  </button>
                  <button type="submit" name="intent" value="decline" class="sm deny" disabled={!data.canEdit}>
                    Decline
                  </button>
                  <button type="submit" name="intent" value="reopen" class="sm" disabled={!data.canEdit}>
                    Reopen
                  </button>
                </form>
              </div>
            ))
          )}
        </>
      )}
    </>
  );
}
