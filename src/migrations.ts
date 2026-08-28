import { CONNECT_REQUEST_COLUMNS } from "./connect-requests.js";
import { RUNTIME_CONFIG_COLUMNS } from "./runtime-config.js";
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

/**
 * Does `table` really have every one of `columns`?
 *
 * This must be a WRITE-shaped probe. Nucleus resolves an unknown column in a
 * projection to NULL instead of erroring, so `SELECT missing FROM t LIMIT 1`
 * SUCCEEDS — the obvious probe reports every column present, `needed()` returns
 * false for all three migrations below, and migrate() records them as applied
 * without running them. That is strictly worse than having no migration at all:
 * the schema stays wrong, the log says it is fine, and the ledger stops the
 * fixed version from ever retrying.
 *
 * `UPDATE t SET c = c WHERE 1 = 0` resolves each name strictly (verified against
 * a real Nucleus: it raises `column "c" does not exist`) and matches no rows, so
 * the probe writes nothing. Note an INSERT-with-column-list probe does NOT work
 * — Nucleus accepts an unknown column there when the SELECT yields zero rows.
 */
export async function hasColumns(db: NucleusPgwire, table: string, columns: string[]): Promise<boolean> {
  const assignments = columns.map((c) => `${c} = ${c}`).join(", ");
  try {
    await db.query(`UPDATE ${table} SET ${assignments} WHERE 1 = 0`);
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

/**
 * 004 — ship_docs gained `actor` and `actor_kind`: who asked for the run, and
 * how that identity was established (see actor.ts).
 *
 * Exactly the shape of 001, and for exactly the same reason: column() THROWS on
 * an unmapped key, so on an existing deployment the first enqueue carrying an
 * actor would have failed the whole write — no run could be created from the
 * dashboard, the CLI or the intake sweep. A missing actor is a cosmetic gap in
 * an audit export; a missing column is a total outage of run creation.
 */
const docsActorColumns: Migration = {
  id: "004-ship-docs-actor",
  description: "add actor + actor_kind to ship_docs (rename-aside + copy)",
  async needed(db) {
    if (!(await tableExists(db, "ship_docs"))) return false; // fresh install: DDL already has them
    return !(await hasColumns(db, "ship_docs", ["actor", "actor_kind"]));
  },
  async run(db) {
    const aside = "ship_docs_004";
    const cols =
      "collection, run_id, workflow, status, wake_at, event_name, task, model, workspace, source, ran_on, created_at, updated_at";
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
        actor TEXT,
        actor_kind TEXT,
        created_at TEXT,
        updated_at TEXT
      )`,
    );
    await db.query(`INSERT INTO ship_docs (${cols}) SELECT ${cols} FROM ${aside}`);
  },
};

/**
 * 005 — ship_tasks gained `requested_by`: the handle a webhook payload asserted
 * for whoever opened the issue or sent the message. It is carried from intake
 * into the run's actor at launch, so without it every intake-launched run is
 * unattributable no matter what the enqueue surfaces do.
 *
 * Not a total outage like 004 if missed — propose() lists its columns
 * explicitly rather than going through a column map, so an absent column throws
 * on INSERT only. That is still every webhook silently failing to file a task.
 */
const tasksRequestedBy: Migration = {
  id: "005-ship-tasks-requested-by",
  description: "add requested_by to ship_tasks (rename-aside + copy)",
  async needed(db) {
    if (!(await tableExists(db, "ship_tasks"))) return false;
    return !(await hasColumns(db, "ship_tasks", ["requested_by"]));
  },
  async run(db) {
    const aside = "ship_tasks_005";
    const cols =
      "task_id, source, kind, repo, pr, title, detail, dedupe_key, state, run_id, created_at, updated_at";
    await db.query(`ALTER TABLE ship_tasks RENAME TO ${aside}`);
    await db.query(
      `CREATE TABLE ship_tasks (
        task_id TEXT,
        source TEXT,
        kind TEXT,
        repo TEXT,
        pr TEXT,
        title TEXT,
        detail TEXT,
        dedupe_key TEXT,
        state TEXT,
        run_id TEXT,
        requested_by TEXT,
        created_at TEXT,
        updated_at TEXT
      )`,
    );
    await db.query(`INSERT INTO ship_tasks (${cols}) SELECT ${cols} FROM ${aside}`);
  },
};

/**
 * 006 — ship_runtime_config: the small key/value table the browser-mediated
 * Akiroo connect writes AKIROO_URL and AKIROO_PULL_TOKEN into while Ship is
 * running. See runtime-config.ts for what it is and why a value there outranks
 * the environment variable of the same name.
 *
 * Like every migration here it is a NO-OP on a fresh install: the store's own
 * CREATE TABLE IF NOT EXISTS is what brings the table into existence, and this
 * runner exists only for a table that already holds rows and needs a shape
 * change. So there is nothing for it to do today — ship_runtime_config has
 * never been released in any other shape, and the rename-aside limb below is
 * unreachable.
 *
 * It is here anyway because of what happens NEXT. The table will grow a column
 * eventually, and the two guards that catch that are the write-shaped probe in
 * `needed()` (Nucleus resolves a missing column in a SELECT to NULL, so only an
 * UPDATE-shaped probe can see it) and the DDL-parity test in migrations.test.ts,
 * which compares this CREATE TABLE against the store's. Neither exists for a
 * table with no migration entry. Nothing is copied into the rebuilt table: the
 * columns of a shape we have never released are not knowable here, and the
 * aside table keeps whatever they held.
 *
 * The operational consequence of it ever firing, stated so nobody has to derive
 * it under pressure: the rebuilt table is EMPTY, so the Akiroo connector stops
 * until an operator re-runs the connect. Nothing is destroyed — the previous
 * rows are in ship_runtime_config_006 — but the pull token in them is not read
 * back, by design, because a value copied out of a shape we cannot name is a
 * guess about which column it lived in.
 */
const runtimeConfigTable: Migration = {
  id: "006-ship-runtime-config",
  description: "rebuild ship_runtime_config when its shape is behind the store DDL",
  async needed(db) {
    if (!(await tableExists(db, "ship_runtime_config"))) return false; // fresh install: the store DDL creates it
    return !(await hasColumns(db, "ship_runtime_config", RUNTIME_CONFIG_COLUMNS));
  },
  async run(db) {
    await db.query("ALTER TABLE ship_runtime_config RENAME TO ship_runtime_config_006");
    await db.query(
      `CREATE TABLE ship_runtime_config (
        config_key TEXT,
        config_value TEXT,
        updated_at TEXT,
        updated_by TEXT
      )`,
    );
  },
};

/**
 * 007 — ship_connect_requests: the handshakes this Ship has STARTED, and the
 * PKCE verifier for each. See connect-requests.ts for why the flow is this way
 * round and why this table is the control that closes the phishing path.
 *
 * A no-op on a fresh install, exactly like 006: the store's own CREATE TABLE IF
 * NOT EXISTS brings the table into existence and this runner exists only for a
 * table that already holds rows and needs a shape change. It is written now for
 * the same reason 006 was — the write-shaped probe in `needed()` and the
 * DDL-parity test in migrations.test.ts only exist for a table that has an
 * entry here, and the day this table grows a column is the day both are needed.
 *
 * The rebuilt table is empty. Nothing is copied because nothing should be: a
 * row here is a handshake in flight for at most ten minutes, and the correct
 * recovery for losing one is to start the connect again.
 */
const connectRequestsTable: Migration = {
  id: "007-ship-connect-requests",
  description: "rebuild ship_connect_requests when its shape is behind the store DDL",
  async needed(db) {
    if (!(await tableExists(db, "ship_connect_requests"))) return false; // fresh install: the store DDL creates it
    return !(await hasColumns(db, "ship_connect_requests", CONNECT_REQUEST_COLUMNS));
  },
  async run(db) {
    await db.query("ALTER TABLE ship_connect_requests RENAME TO ship_connect_requests_007");
    await db.query(
      `CREATE TABLE ship_connect_requests (
        request_id TEXT,
        verifier TEXT,
        akiroo_url TEXT,
        expires_at TEXT,
        used_at TEXT
      )`,
    );
  },
};

export const MIGRATIONS: Migration[] = [
  docsSourceColumn,
  steerConsumedTurn,
  memoryNoteId,
  docsActorColumns,
  tasksRequestedBy,
  runtimeConfigTable,
  connectRequestsTable,
];

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
