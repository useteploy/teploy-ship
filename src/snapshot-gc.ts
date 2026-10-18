/**
 * Garbage collection for park snapshots — the images no record owns.
 *
 * A park's snapshot/restore pair leaks an image by design: the boundary park
 * (`merge-snapshot`) and the delegate park (`turn-N-delegate-snapshot`) each
 * take an image, the restore boots a container FROM that image and disposes
 * the old one, and nothing ever deletes the image itself — one sandbox host
 * held 100+ `teploy-sbx-snap:*` refs within weeks of the feature shipping.
 * The thread-warm sweeper (thread-warm.ts) covers only the images a live
 * warm record names; these park images are named by nothing, so this sweeper
 * derives them from the runs' own logs.
 *
 * OWNERSHIP FROM THE LOG, NOT NEW STATE. A park step's recorded result IS the
 * image ref (a plain, host-tagged string), so image -> run ownership is a log
 * read and the sweep holds no persistent record of what it deleted: each pass
 * re-derives its candidates, an in-process tombstone set absorbs the repeats,
 * and a delete that comes back "not there" (the daemon's 404, a pool host no
 * longer configured) is treated as done rather than retried forever. A leaked
 * image is a disk problem, never a run problem.
 *
 * WHEN AN IMAGE MAY BE DELETED — both must hold:
 *
 *  1. The run whose log names it is terminal, per BOTH its meta status and a
 *     terminal event in its log. The log is what decides whether anything can
 *     still replay or restore (the upgrade fence's rule: meta can lag); the
 *     meta filter is what keeps the sweep from loading every live run's log
 *     on every pass. Either half saying "still going" keeps the image.
 *  2. No live thread-warm record points at it. D4-c2 keeps a merge-park image
 *     as its thread's warmth; that image is the thread-warm sweeper's to
 *     claim when the record expires, never this one's.
 *
 * Never deleted: anything taken by a run that is queued, running, parked
 * (`waiting`) or `cancelling` — a parked run RESTORES from its image when its
 * decision arrives, and a run that re-parks (a merge conflict, a second
 * delegate turn) owns several images at once, all of them live until it
 * settles.
 *
 * Bounded like everything that walks runs: the newest `SNAPSHOT_GC_RUNS`
 * metas per pass (newest first), one log load per terminal run among them.
 * Images older than that window — including the pre-feature backlog — are the
 * operator note in docs/DEPLOY.md.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

/** Runs examined per pass, newest first. The sweep's whole bound. */
export const SNAPSHOT_GC_RUNS = 200;

/** The tombstone set's cap: FIFO, sized at a few passes' worth of images. */
const GONE_CAP = 2048;

const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["run-completed", "run-failed", "run-cancelled"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** The park steps whose recorded result is a bare image ref. */
function isParkSnapshotStep(name: string): boolean {
  return name === "merge-snapshot" || /^(?:attempt-\d+-)?turn-\d+-delegate-snapshot$/.test(name);
}

/**
 * The park images a run's log names, in recorded order. Only steps whose
 * result is a non-empty string count: that is exactly the shape
 * `ctx.step("merge-snapshot", () => executor.snapshot(...))` records, and a
 * log written by any other shape (or hand-edited) yields nothing rather than
 * a guess. The ask park's `turn-N-snapshot` is deliberately not swept here —
 * this sweeper exists for the two park pairs that had no owner at all.
 */
export function parkSnapshotImages(events: readonly WorkflowEvent[]): string[] {
  const images: string[] = [];
  for (const e of events) {
    if (e.type !== "step-completed" || e.name === undefined || !isParkSnapshotStep(e.name)) continue;
    const result = (e.data as { result?: unknown } | undefined)?.result;
    if (typeof result === "string" && result !== "" && !images.includes(result)) images.push(result);
  }
  return images;
}

/** What parkSnapshotSweeper reads — structural so tests share one shape. */
export interface SnapshotSweepDeps {
  /** Recent runs, newest first; the limit passed is the sweep's bound. */
  listMeta(options?: { limit?: number }): Promise<{ runId: string; status: string }[]>;
  /** A run's event log. A read failure skips that run, never the sweep. */
  loadEvents(runId: string): Promise<readonly WorkflowEvent[]>;
  /** Images live thread-warm records point at — not this sweeper's to delete. */
  warmImages(): Promise<string[]>;
  /** The provider's deleteSnapshot (sandbox-pool routes it by host tag). */
  deleteSnapshot(image: string): Promise<void>;
}

/**
 * A delete failure that means the image is not there to delete: the daemon's
 * 404 (the provider embeds the status in its own message), docker's "no such
 * image", or a pool host that is no longer configured — its images are
 * unreachable from this worker forever. Retrying any of these is log noise;
 * every other failure is a real one and is retried next sweep.
 */
function deleteFoundNothing(message: string): boolean {
  return /status 404|no such|not found|no longer configured/i.test(message);
}

/**
 * The sweeper. Create once (the worker's interval); each `sweep()` is one
 * bounded pass that never throws — a failing store or daemon is logged and
 * retried on the next pass, because a sweeper that threw would take the
 * worker's timers down with it.
 */
export function parkSnapshotSweeper(
  deps: SnapshotSweepDeps,
  options: { limit?: number; log?: (line: string) => void } = {},
): { sweep: () => Promise<number> } {
  const limit = options.limit ?? SNAPSHOT_GC_RUNS;
  const log = options.log ?? (() => {});
  // Images this process has deleted (or found already gone). The candidates
  // come from immutable logs, so without this set every cleaned image would
  // be deleted again on the next pass — and after a restart, one 404 each.
  const gone = new Set<string>();
  const tombstone = (image: string): void => {
    if (gone.size >= GONE_CAP) gone.delete(gone.values().next().value!);
    gone.add(image);
  };
  return {
    async sweep(): Promise<number> {
      let metas: { runId: string; status: string }[];
      try {
        metas = await deps.listMeta({ limit });
      } catch (error) {
        log(`[snapshot-gc] could not list runs: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      }
      let deleted = 0;
      // null means the warm records were unreadable: keep everything this
      // pass. An over-keep costs disk for a minute; the reverse would cost
      // warmth a follow-up is about to boot from.
      let warm: Set<string> | null;
      try {
        warm = new Set(await deps.warmImages());
      } catch (error) {
        warm = null;
        log(`[snapshot-gc] thread-warm records unreadable, keeping every image this pass: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const meta of metas) {
        // Cheap filter first: a non-terminal meta never gets its log loaded.
        if (!TERMINAL_STATUSES.has(meta.status)) continue;
        let events: readonly WorkflowEvent[];
        try {
          events = await deps.loadEvents(meta.runId);
        } catch (error) {
          log(`[snapshot-gc] ${meta.runId}: log unreadable, skipping this pass (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        const images = parkSnapshotImages(events);
        if (images.length === 0) continue;
        // The log gets the final word (the meta may have drifted ahead of it);
        // anything less than terminal here keeps the run's images.
        if (!events.some((e) => TERMINAL_EVENTS.has(e.type))) continue;
        for (const image of images) {
          if (gone.has(image)) continue;
          // A live warm record owns this image until the thread-warm sweeper
          // expires it; an UNREADABLE warm store keeps every image this pass.
          if (warm === null || warm.has(image)) continue;
          try {
            await deps.deleteSnapshot(image);
            tombstone(image);
            deleted++;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (deleteFoundNothing(message)) {
              tombstone(image);
              log(`[snapshot-gc] ${meta.runId}'s snapshot ${image} was already gone`);
            } else {
              log(`[snapshot-gc] ${meta.runId}'s snapshot ${image} could not be deleted: ${message}`);
            }
          }
        }
      }
      return deleted;
    },
  };
}
