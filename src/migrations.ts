import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Ordered schema migrations for the Nucleus store.
 *
 * Every store still creates its own table with CREATE TABLE IF NOT EXISTS —
 * that is what makes a FRESH install work with no migration at all. This runner
 * exists for the other case: a table that already holds rows and needs a shape
 * change. Nucleus cannot safely ALTER a populated table (adding a column to one
 * is the trap that produced observe's 027/028 rewrite), so the pattern here is
 * always rename-aside + create + copy, never ALTER and never DROP:
 *
 *   ALTER TABLE t RENAME TO t_<migration-id>   (the old rows survive, untouched)
 *   CREATE TABLE t (…new shape…)
 *   INSERT INTO t (…) SELECT … FROM t_<migration-id>
 *
 * The aside table is deliberately KEPT. Disk is cheap; a migration that eats
 * the only copy of a run history is not recoverable. Drop them by hand once a
 * deploy has proven itself.
 *
 * Migrations are recorded in ship_migrations and run at most once. They are
 * also guarded by a KV lock, because a rolling deploy starts several workers at
 * once and two processes doing a rename-aside concurrently would race one into
 * "table does not exist".
 */
export interface Migration {
  /** Stable, ordered id. Never renumber a released one. */
  id: string;
  description: string;
  /**
   * True when this migration still needs to run. Checked INSIDE the lock and
   * in addition to the ledger, so a store that was created fresh with the new
   * shape (CREATE TABLE IF NOT EXISTS already has the columns) records the
   * migration without doing pointless table surgery.
   */
  needed(db: NucleusPgwire): Promise<boolean>;
  run(db: NucleusPgwire): Promise<void>;
}

const LOCK_KEY = "ship:migrate";
const LOCK_TTL_S = 300;

/** Does `SELECT <columns> FROM <table> LIMIT 1` work? The engine-agnostic column probe. */
export async function hasColumns(db: NucleusPgwire, table: string, columns: string[]): Promise<boolean> {
  try {
    await db.query(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function tableExists(db: NucleusPgwire, table: string): Promise<boolean> {
  try {
    await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 001 — ship_docs gained `source` (which intake run costs are settled against)
 * and `ran_on` (fleet placement). Without them every saveMeta for a run that
 * carries a source threw `unknown run-record field: source`, so no run could be
 * created from the dashboard or the intake sweep at all.
 */
const docsSourceColumn: Migration = {
  id: "001-ship-docs-source-ranon",
  description: "add source + ran_on to ship_docs (rename-aside + copy)",
  async needed(db) {
    if (!(await tableExists(db, "ship_docs"))) return false; // fresh install: DDL already has them
    return !(await hasColumns(db, "ship_docs", ["source", "ran_on"]));
  },
  async run(db) {
    const aside = "ship_docs_001";
    const cols =
      "collection, run_id, workflow, status, wake_at, event_name, task, model, workspace, created_at, updated_at";
    await db.query(`ALTER TABLE ship_docs RENAME TO ${aside}`);
    await db.query(
      `CREATE TABLE ship_docs (
        collection TEXT,
        run_id TEXT,
        workflow TEXT,
        status TEXT,
        wake_at TEXT,
        event_name TEXT,
        task TEXT,
        model TEXT,
        workspace TEXT,
        source TEXT,
        ran_on TEXT,
        created_at TEXT,
        updated_at TEXT
      )`,
    );
    await db.query(`INSERT INTO ship_docs (${cols}) SELECT ${cols} FROM ${aside}`);
  },
};

/**
 * 002 — ship_steer gained `consumed_turn`, which makes a drain idempotent
 * across replay. On an existing deployment the table predates the column, so
 * the drain UPDATE referenced a column that was not there — and because the
 * durable loop catches a steer failure (correctly: a store hiccup must not kill
 * a run), mid-run steering would have stopped working in complete silence.
 */
const steerConsumedTurn: Migration = {
  id: "002-ship-steer-consumed-turn",
  description: "add consumed_turn to ship_steer (rename-aside + copy)",
  async needed(db) {
    if (!(await tableExists(db, "ship_steer"))) return false;
    return !(await hasColumns(db, "ship_steer", ["consumed_turn"]));
  },
  async run(db) {
    const aside = "ship_steer_002";
    const cols = "note_id, run_id, text, created_at, consumed";
    await db.query(`ALTER TABLE ship_steer RENAME TO ${aside}`);
    await db.query(
      `CREATE TABLE ship_steer (
        note_id TEXT,
        run_id TEXT,
        text TEXT,
        created_at TEXT,
        consumed TEXT,
        consumed_turn TEXT
      )`,
    );
    await db.query(`INSERT INTO ship_steer (${cols}) SELECT ${cols} FROM ${aside}`);
  },
};

/**
 * 003 — ship_memory gained `note_id`, so a note can be deleted by identity
 * rather than by (repo, createdAt), which removed every sibling written in the
 * same millisecond.
 *
 * This one was the dangerous omission: `recent()` selects note_id, and
 * loadRepoContext calls it INSIDE the repo-context step without catching — so
 * on an existing deployment every repo run would have failed outright at that
 * step. Legacy rows keep a NULL note_id; the store synthesises a stable
 * `legacy:<createdAt>` handle for them so they remain listable and deletable.
 */
const memoryNoteId: Migration = {
  id: "003-ship-memory-note-id",
  description: "add note_id to ship_memory (rename-aside + copy)",
  async needed(db) {
    if (!(await tableExists(db, "ship_memory"))) return false;
    return !(await hasColumns(db, "ship_memory", ["note_id"]));
  },
  async run(db) {
    const aside = "ship_memory_003";
    const cols = "repo, note, run_id, created_at";
    await db.query(`ALTER TABLE ship_memory RENAME TO ${aside}`);
    await db.query(
      `CREATE TABLE ship_memory (
        note_id TEXT,
        repo TEXT,
        note TEXT,
        run_id TEXT,
        created_at TEXT
      )`,
    );
    await db.query(`INSERT INTO ship_memory (${cols}) SELECT ${cols} FROM ${aside}`);
  },
};

export const MIGRATIONS: Migration[] = [docsSourceColumn, steerConsumedTurn, memoryNoteId];

/**
 * Apply every pending migration. Returns the ids applied by THIS call (empty
 * when another process held the lock or everything was already current).
 *
 * Failure is fatal on purpose: a process that could not bring the schema to the
 * shape its code expects must not then serve traffic against it.
 */
export async function migrate(
  db: NucleusPgwire,
  log: (line: string) => void = () => {},
  migrations: Migration[] = MIGRATIONS,
): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS ship_migrations (id TEXT, applied_at TEXT)");

  const pending: Migration[] = [];
  const applied = new Set(
    (await db.query("SELECT id FROM ship_migrations")).map((r) => String(r.id)),
  );
  for (const m of migrations) {
    if (!applied.has(m.id)) pending.push(m);
  }
  if (pending.length === 0) return [];

  // One writer at a time across the fleet. A loser does not wait: it returns
  // empty and its caller proceeds, because the winner is bringing the shared
  // schema forward and the loser's own CREATE TABLE IF NOT EXISTS paths are
  // already correct for a fresh table.
  const holder = `${process.pid}@${Date.now()}`;
  if (!(await db.kv.setNX(LOCK_KEY, holder, { ttl: LOCK_TTL_S }))) {
    log("[migrate] another process holds the migration lock; skipping");
    return [];
  }
  const done: string[] = [];
  try {
    for (const m of pending) {
      if (!(await m.needed(db))) {
        await db.query("INSERT INTO ship_migrations (id, applied_at) VALUES ($1, $2)", [
          m.id,
          new Date().toISOString(),
        ]);
        continue;
      }
      log(`[migrate] applying ${m.id}: ${m.description}`);
      await m.run(db);
      await db.query("INSERT INTO ship_migrations (id, applied_at) VALUES ($1, $2)", [
        m.id,
        new Date().toISOString(),
      ]);
      done.push(m.id);
    }
  } finally {
    await db.kv.cdel(LOCK_KEY, holder).catch(() => {});
  }
  return done;
}
