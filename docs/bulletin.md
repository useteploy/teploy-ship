# The Bulletin — a public board whose notes Ship picks up

A bulletin is a page anyone can reach and anyone can write to: `/bulletin/<slug>`.
Someone pins a note about something broken, other people vote for it, and — if
you have turned the switches on — Ship promotes it into an intake proposal, a
run opens a pull request, and the note's label on the board moves from **Pinned**
to **Picked up** to **Fix open**.

It is the only surface in Ship a stranger can write to. Read the trust model
below before you make a board public.

## The trust model in one page

A note is a stranger's sentence. What bounds it is not what the sentence says,
it is what a sentence is allowed to cause.

1. **A note becomes a proposal, never a run.** Promotion puts the note in the
   same intake queue a Forgejo issue lands in, under the source `bulletin`. That
   source starts at `propose`, like every other source, so the note waits in the
   Inbox for a person until you decide otherwise on
   `/projects?view=sources`. "Public board" and "unattended run" are two
   separate switches.
2. **The repository is the board's, never the poster's.** A post has no repo
   field at all. The board names one, and it is re-checked against the allowlist
   at `trust: "external"` on the way in (`proposeExternal`, `src/runtime.ts`), so
   a board pointed at a repo Ship may not clone is refused rather than obeyed.
3. **The text is treated exactly like an issue body.** It is carried verbatim —
   nothing rewrites or summarises it — and framed as `<untrusted-content>` at
   the agent boundary (`frameUntrusted`, `src/guard.ts`), where the system prompt
   pins it as data. It is screened at pin time (`screenUntrusted`) and the
   matches are recorded on the note, so an injection attempt is visible on
   `/bulletin-admin` whether or not it is ever promoted.
4. **The change-class gate (L3) is mandatory for an unattended send.** A board
   cannot be set to `auto` while `SHIP_CHANGE_CLASS` is off. With it on, a run
   classifies its own change before pushing and PARKS anything `serious` for a
   human — which is what makes "a stranger's note reached an agent unattended"
   a bounded statement rather than an open one.
5. **A public board may not point at a repo with auto-merge on.** Refused at
   save time and again at send time, in both orders. A board plus L5 auto-merge
   is a stranger with commit access.
6. **Volume is capped.** Per-board daily cap on auto sends (default 5), a vote
   threshold (default 3), `bug` only by default, an in-process rate limit on
   pinning, and a staff `Decline` that blocks similar titles for 30 days.
7. **Nothing internal is on the public page.** No run ids, no logs, no repo
   name, no failure states, no email addresses. The public status vocabulary is
   four words wide on purpose: Pinned, Picked up, Fix open, Shipped.

## Turning one on

```
# 1. The gate. An auto board is refused without it.
SHIP_CHANGE_CLASS=1

# 2. A project record for the repo, so it is on the allowlist:
teploy-ship project set --repo https://forge.example/owner/repo.git
```

Then on the dashboard: **Projects → Bulletin → New board**. Slug, title, the
repository, and the send policy.

- `manual` (default) — notes collect; you press **Send to Ship** on the ones
  worth acting on. Nothing reaches an agent without a click.
- `auto` — a note that meets the threshold is promoted by a sweep.

The public page is then at `/bulletin/<slug>`. It needs no account, works with
JavaScript off, and is exempt from the dashboard's auth middleware (the exemption
is `path.startsWith("/bulletin/")` in `web/src/routes/_layout.tsx` — the
operator's page is `/bulletin-admin`, deliberately outside that prefix).

## The sweep

Auto boards are swept by `POST /api/bulletin/sweep`, authenticated like every
other API route:

```
curl -fsS -XPOST -H "authorization: Bearer $SHIP_WEB_TOKEN" \
     https://ship.example/api/bulletin/sweep
```

It is idempotent — a note already promoted is refused with `already-sent` — so a
doubled cron does not double-send.

**This belongs in the worker's tick, not in cron.** It is an API route today
only because `src/worker.ts` was owned by another lane while this was built.
Two patches make it resident; both are small and neither changes a recorded step
sequence, so they are safe against replay:

```diff
--- a/src/worker.ts
+++ b/src/worker.ts
@@ imports
+import { FileBulletinStore, NucleusBulletinStore, changeClassRequired, sweepBulletin } from "./bulletin.js";
+import { proposeExternal } from "./runtime.js";

@@ next to the akiroo sweep (around :1034)
+  // L6: the Bulletin. Promote eligible public notes to intake proposals on the
+  // same tick, under the same reentrancy guard. A no-op unless a board is auto.
+  const bulletin =
+    options.runtime.kind === "nucleus"
+      ? new NucleusBulletinStore(options.runtime.db)
+      : new FileBulletinStore();
+  const bulletinSweep = async (): Promise<void> => {
+    try {
+      await sweepBulletin({
+        store: bulletin,
+        propose: (input) => proposeExternal(options.runtime, input),
+        projectFor: (repo) => options.runtime.projects.forRepo(repo),
+        log,
+      });
+    } catch (error) {
+      log(`[worker] bulletin sweep: ${error instanceof Error ? error.message : String(error)}`);
+    }
+  };

@@ the tick (around :1056)
     void sweep()
       .then(() => akirooSweep())
+      .then(() => bulletinSweep())
       .then(() => retryNotifications())
```

and, in the intake launch (`src/worker.ts:995`), the per-source form of the gate:

```diff
           trust: "external",
+          // L6: a task whose text came from a public board is classified before
+          // it pushes, whatever SHIP_CHANGE_CLASS says for this deployment.
+          ...(changeClassRequired(task.source) ? { changeClass: true } : {}),
           ...(task.repo !== undefined ? { repo: task.repo } : {}),
```

Until that second patch is applied, the guarantee is bought less precisely:
`assertBoardSendable` refuses an auto board unless `SHIP_CHANGE_CLASS` is on for
the whole deployment, so a bulletin-sourced run is always classified — just not
by a rule that names the bulletin.

## What a note's status means

| Board says | What is true |
| --- | --- |
| Pinned | Ship has the note. Nobody has promoted it. |
| Picked up | It is an intake task. It may be queued, running, or parked for a human. |
| Fix open | Its run completed; a pull request exists. |
| Shipped | Staff said so. |
| Declined | Staff said so. Similar titles are not auto-sent for 30 days. |

`Picked up` deliberately covers a failed or parked run. A public page that
distinguished "running" from "the agent's run failed" would be telling strangers
how Ship is doing, which is an invitation to probe. `/bulletin-admin` shows the
real task state and run status.

## PRE-DECIDED

Each of these was a fork with no obviously right answer. The reversal condition
is the part that matters.

- **The board lives in Ship, not only in Akiroo.** The plan's L6 is written
  against Akiroo's `feedback.go`. A Ship-side board is what makes the feature
  true for a self-hosted install with no Akiroo at all, and it reuses the intake
  contract rather than a second one. *Reverse if* Akiroo becomes the only
  supported front door — then this becomes a thin proxy for
  `POST /api/feedback/promote` and the L1 hop carries it.
- **A note does not open a forge issue.** The intake task is the truth here, the
  way the work item is the truth in Akiroo. Opening an issue per public note
  would hand strangers write access to your forge through Ship's credential.
  *Reverse if* operators want notes tracked on the forge — a per-board
  `openIssue: true` calling `createLabelledIssue` (`src/akiroo.ts`) is the shape.
- **No email is sent.** Ship has no mail module, and adding one for a bulletin
  is a deployment dependency (SMTP credentials, deliverability, a bounce path)
  bought for a nicety. The address is stored, never rendered, and stripped by
  `redactPost` before a post reaches any surface. *Reverse when* Ship grows an
  outbound mail path for anything else; the field is already there.
- **A near-identical title (≥0.9 overlap) is counted as a vote, not stored.**
  Storing it splits the signal the threshold reads; dropping it silently reads
  as the board being broken. *Reverse if* real duplicates turn out to carry
  detail the first note lacked — then store it and merge on the operator's side.
- **Votes are identified by a cookie, not an address.** Addresses are shared by
  whole offices; counting per address disenfranchises them. A cookie is
  clearable, so this stops casual double-voting and nothing more — which is why
  the daily cap and the class gate, not the vote count, are what bound the
  damage. *Reverse if* a board is brigaded: raise the threshold, or add the
  optional email verification the plan describes.
- **Status is derived on read, not synced by a job.** The task state and the run
  status are already the truth; a copy on the post is a second truth that goes
  stale. Staff decisions are stored, because nothing else records them.
  *Reverse if* a board grows large enough that per-note task reads matter.
- **`Shipped` is a staff word.** Ship only learns that a change merged through
  L5's auto-merge, which is off by default and refused on a public board's repo.
  So `Shipped` is set by a person on `/bulletin-admin`. *Reverse when* the merge
  signal is available for repos a board can point at.
