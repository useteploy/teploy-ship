import pg from "pg";

/** Guard for SQL-inlined numbers. */
function int(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`);
  return n;
}

/**
 * Minimal Nucleus client over the PostgreSQL wire protocol — the
 * ecosystem's canonical connection path (`nucleus start`, no gateway in
 * between). Implements exactly the three structural surfaces the
 * Workflow SDK needs (KVLike, StreamsLike, DocumentLike), nothing more.
 *
 * The DocumentLike surface is backed by a plain SQL table rather than
 * Nucleus's document model: run records are flat, their fields are known
 * (the union of RunRecord and RunMeta), and the document scalar functions
 * have no update — while SQL UPDATE is the engine's best-tested path.
 */
export interface QueryResultLike {
  rows: unknown[];
  rowCount: number | null;
}

/**
 * Optional bounds on a `document.find`.
 *
 * Both are OPT-IN, and a `find` called without them emits exactly the statement
 * it always did — `SELECT * FROM ship_docs WHERE …`, no ORDER BY, no LIMIT.
 * That matters more than it looks: the Workflow SDK's `RunIndex.due` calls this
 * same primitive three times a tick (`status = 'sleeping' | 'retrying' |
 * 'wake'`) and MUST see every due run. A default limit there would silently
 * strand whichever runs fell off the end, which is the failure mode this file
 * already exists to argue against. So the caller that can prove a bound is safe
 * asks for one; nobody gets one imposed.
 */
export interface FindOptions {
  /**
   * `AND run_id IN (…)`. An empty list matches nothing, and short-circuits
   * without a round trip rather than emitting `IN ()` for Nucleus to parse.
   *
   * This is how a caller that has ALREADY chosen its rows fetches the second
   * collection it joins against: instead of dragging a whole collection back to
   * join in JavaScript, it names the handful of ids the join can possibly touch.
   */
  runIds?: readonly string[];
  /**
   * Return only the newest `limit` docs, ranked and cut in SQL.
   *
   * "Newest" is the doc's own `updated_at`, unless `freshenedBy` names another
   * collection in the same table — then it is the LATER of this doc's stamp and
   * that collection's stamp for the same `runId`. That second form exists for
   * `listMeta`, which overlays a run's `ship_runs` record onto its `ship_meta`
   * doc and takes the newer of the two `updatedAt`s. Rank on the meta stamp
   * alone and the bound is not a bound on the same ordering: a long-lived run
   * whose meta row is old but whose index row was touched a minute ago drops
   * out of the page it belongs at the top of.
   *
   * That is not a theoretical worry. Measured against a live Nucleus v0.1.8
   * (2026-08-30) over 400 metas where two thirds carried a run record with an
   * independent stamp, a naive `ORDER BY updated_at DESC LIMIT 50` on the meta
   * collection alone returned 45 of 50 rows that do not belong in the answer.
   * The joined rank returned the exact set, over six trials at 500–1500 docs.
   */
  newest?: { limit: number; freshenedBy?: string };
}

export interface PoolClientLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  /** `release(true)` destroys the client instead of returning it to the pool. */
  release(destroy?: boolean): void;
}

/**
 * One connection of its own, used and closed — the retry path's transport.
 * Narrow for the same reason PoolLike is.
 */
export interface SoloClientLike {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  end(): Promise<void>;
}

/** The slice of pg.Pool Ship uses — narrow so a test can stand in a fake. */
export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  connect(): Promise<PoolClientLike>;
  on(event: "error", listener: (err: Error) => void): unknown;
  end(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : `${typeof error}: ${String(error)}`;
}

/**
 * A pool rejection worth one retry on a fresh connection: anything that is
 * not an Error at all, pg-pool's masked `reading 'name'` TypeError, a
 * connection that died under us, or an acquire timeout. Database errors
 * (`pg` DatabaseError carries a SQLSTATE `code`) are never retried.
 */
export function isTransientPoolFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if ("code" in error && typeof (error as { code?: unknown }).code === "string" && /^[0-9A-Z]{5}$/.test((error as { code: string }).code)) {
    return false;
  }
  return /reading 'name'|Connection terminated|ECONNRESET|ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error/.test(
    error.message,
  );
}

export class NucleusPgwire {
  #pool: PoolLike;
  #owner: string;
  #docsReady: Promise<void> | null = null;
  /** How the retry path opens a connection that shares nothing with the pool. */
  #solo: (() => SoloClientLike) | null;

  /**
   * @param owner Same identifier callers already pass to `nucleusRuntime`
   *   (`web-{host}-{pid}`, `worker-{host}-{pid}`, `cli-{host}-{pid}`) — reused
   *   here as the correlation tag on pool-level log lines, since a pool
   *   'error' isn't tied to any single in-flight query/run.
   */
  constructor(url: string, owner = "unknown", deps: { pool?: PoolLike; solo?: () => SoloClientLike } = {}) {
    this.#owner = owner;
    this.#solo = deps.solo ?? (url === "" ? null : () => new pg.Client({ connectionString: url }) as unknown as SoloClientLike);
    this.#pool = deps.pool ?? new pg.Pool({
      connectionString: url,
      max: 4,
      // Fail loud instead of hanging forever when ship-nucleus is down or
      // unreachable (container restart, accessory upgrade, network blip):
      // 5s to acquire a connection — either dialing fresh or waiting on the
      // pool when all 4 are checked out — well above normal Tailscale-mesh
      // latency but short enough that a caller sees a real error quickly.
      connectionTimeoutMillis: 5_000,
      // Asks for a 30s server-side cap on any one query, via the startup
      // packet node-postgres sends on every connection it opens.
      //
      // Against Nucleus today this is INERT: the wire layer stores startup
      // parameters as metadata and never applies them, and its own built-in
      // statement cap already happens to be 30s — so this changes nothing
      // now, and is here so the intent survives if Nucleus starts honouring
      // the parameter (or this pool is ever pointed at real Postgres).
      // Deliberately matched to the engine default rather than set tighter:
      // the heaviest work on this pool is code-index vector search and bulk
      // chunk writes, and code-index.ts caches its rejected promise, so a
      // timeout there would disable search for the life of the process.
      statement_timeout: 30_000,
    });
    // An idle pooled connection dying (engine restart, accessory upgrade)
    // emits 'error' on the pool; unhandled, that event CRASHES the process.
    // Bit live 2026-07-10: a nucleus accessory upgrade took the worker down
    // with "Unhandled 'error' event on BoundPool". In-flight queries still
    // reject through their own promises — this handler only absorbs the
    // idle-client death so the pool can mint fresh connections.
    this.#pool.on("error", (err) => {
      console.error(`[nucleus-pgwire] pool connection error (${this.#owner}, will reconnect): ${err.message}`);
    });
  }

  /**
   * Every statement goes through here. Under load the pool rejects with
   * `TypeError: Cannot read properties of undefined (reading 'name')` — pg
   * replaces the stack on its way out (client.js `Error.captureStackTrace`),
   * so the message names nothing and the real reason is lost. It broke
   * settle, meta updates and `approve` on live runs in August, and on
   * 2026-08-30 it hit the deployed worker roughly every sweep: twelve in
   * thirty minutes on `document.find`, and when it landed on the scheduler's
   * `due` query the worker launched nothing at all until it was restarted.
   *
   * What that day's measurements RULED OUT, against the live store from
   * inside the worker's own container: the SQL (a standalone client runs both
   * failing queries fine), the startup parameters (same with
   * statement_timeout and connectionTimeoutMillis set), and concurrency alone
   * (a fresh 4-connection pool took 48 concurrent copies of the same queries
   * without a single failure). What is left is state that accumulates on a
   * LONG-LIVED pool — so the retry must not go back to it.
   *
   * THE CAUSE IS NOW KNOWN, and it is not in this file. Reproduced 2026-08-30
   * against `ghcr.io/neutron-build/nucleus:v0.1.8` — the deployed image — on a
   * laptop: Nucleus answers a query with ANOTHER STATEMENT'S RowDescription
   * while sending this statement's own DataRows. pg builds its row objects from
   * `fields[i].name` (result.js), so when the borrowed description is NARROWER
   * than the row it throws exactly this TypeError — and when it is WIDER it
   * throws nothing at all and silently labels every column with the other
   * statement's names. In one two-minute read-only run over 24 tables, 6,838
   * queries threw and 7,799 were relabelled in silence.
   *
   * The silent half is the dangerous half, because `rowToDoc` below reads by
   * column NAME: a relabelled ship_docs row yields an EMPTY doc rather than an
   * error. That is a listMeta page of blanks, and a `RunIndex.due` that finds
   * nothing due and launches nothing — with no exception anywhere to notice.
   *
   * It is a collision, not a race. Over 24 tables and 552 possible (asked-for,
   * got) pairings, just TWO pairings accounted for all 6,052 faults in one run,
   * and in 90% of them the stray description belonged to a statement no other
   * connection was running at the time. It follows the SQL TEXT, not the table:
   * one table read three different ways collided on two of the three texts, with
   * a different neighbour each time. Two tables never reproduced it at any load;
   * six, twelve and twenty-four did, non-monotonically. That is why the
   * container measurements above came back clean — two `document.find` texts on
   * their own are not enough distinct statements to collide.
   *
   * Ship cannot fix this from here; it needs a Nucleus fix. Note meanwhile that
   * changing a statement's text (as the bounded reads below do) moves it to a
   * different slot, which shuffles which statements collide rather than
   * removing the collision.
   *
   * That is the change here. `pool.connect()` hands back a POOLED client,
   * very often the same one that just failed, which is why the old retry
   * failed as reliably as the attempt it was retrying. The retry now opens a
   * connection of its own, uses it for exactly this statement, and closes it
   * — the shape that was measured to work. It costs one connection on a path
   * that is already the exceptional one, and it is bounded to a single
   * attempt. A rejection that is a genuine database error (bad SQL,
   * constraint) is still thrown as-is; those are not transient.
   */
  async #run(sql: string, params: unknown[] = []): Promise<QueryResultLike> {
    try {
      return await this.#pool.query(sql, params);
    } catch (error) {
      if (!isTransientPoolFailure(error)) throw error;
      console.error(
        `[nucleus-pgwire] pool query failed (${this.#owner}), retrying on a connection of its own: ${describe(error)}`,
      );
      if (this.#solo === null) {
        // No way to open one (an injected pool with no solo seam): fall back
        // to the pooled checkout rather than failing the caller outright.
        const client = await this.#pool.connect();
        try {
          const result = await client.query(sql, params);
          client.release();
          return result;
        } catch (again) {
          client.release(true);
          throw again instanceof Error ? again : new Error(`nucleus query rejected with a non-error value: ${describe(again)}`);
        }
      }
      const solo = this.#solo();
      try {
        await solo.connect();
        return await solo.query(sql, params);
      } catch (again) {
        throw again instanceof Error ? again : new Error(`nucleus query rejected with a non-error value: ${describe(again)}`);
      } finally {
        // Never let closing the throwaway connection mask the result or the
        // error above it.
        await solo.end().catch(() => {});
      }
    }
  }

  /** Raw parameterized query — rows as objects. The intake store builds on this. */
  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const result = await this.#run(sql, params);
    return result.rows as Record<string, unknown>[];
  }

  /** Parameterized statement returning the affected-row count (conditional claims). */
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.#run(sql, params);
    return result.rowCount ?? 0;
  }

  async #fetchval<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.#run(sql, params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const value = Object.values(row)[0];
    return (value ?? null) as T | null;
  }

  readonly kv = {
    // Numeric arguments are inlined: node-postgres ships parameters as
    // text, and Nucleus's scalar functions type-check them as TEXT. All
    // numbers here are internally generated (never user input).
    setNX: async (key: string, value: string, opts?: { ttl?: number }): Promise<boolean> => {
      const acquired =
        opts?.ttl !== undefined
          ? await this.#fetchval<boolean>(`SELECT KV_SETNX($1, $2, ${int(opts.ttl)})`, [key, value])
          : await this.#fetchval<boolean>("SELECT KV_SETNX($1, $2)", [key, value]);
      return acquired === true;
    },
    cdel: async (key: string, expected: string): Promise<boolean> =>
      (await this.#fetchval<boolean>("SELECT KV_CDEL($1, $2)", [key, expected])) === true,
    cexpire: async (key: string, expected: string, seconds: number): Promise<boolean> =>
      (await this.#fetchval<boolean>(`SELECT KV_CEXPIRE($1, $2, ${int(seconds)})`, [key, expected])) === true,
  };

  readonly streams = {
    xadd: async (stream: string, fields: Record<string, unknown>): Promise<string> => {
      const args: unknown[] = [stream];
      for (const [key, value] of Object.entries(fields)) args.push(key, value);
      const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
      return (await this.#fetchval<string>(`SELECT STREAM_XADD(${placeholders})`, args)) ?? "";
    },
    xrange: async (
      stream: string,
      startMs: number,
      endMs: number,
      count: number,
    ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> => {
      const raw = await this.#fetchval<string>(
        `SELECT STREAM_XRANGE($1, ${int(startMs)}, ${int(endMs)}, ${int(count)})`,
        [stream],
      );
      if (raw === null || raw === "") return [];
      return JSON.parse(raw) as Array<{ id: string; fields: Record<string, unknown> }>;
    },
  };

  readonly document = {
    insert: async (collection: string, doc: Record<string, unknown>): Promise<number> => {
      await this.#ensureDocs();
      // Skip undefined/null fields rather than String()-ing them — otherwise an
      // optional field (eventName, workspace, ranOn…) present-but-undefined gets
      // stored as the literal "undefined"/"null" and reads back as truthy.
      const cols = ["collection"];
      const values: (string | null)[] = [collection];
      for (const [key, value] of Object.entries(doc)) {
        if (value === undefined || value === null) continue;
        cols.push(column(key));
        values.push(String(value));
      }
      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      await this.#run(
        `INSERT INTO ship_docs (${cols.join(", ")}) VALUES (${placeholders})`,
        values,
      );
      return 1;
    },
    /**
     * Every doc in `collection` matching `filter`, optionally bounded.
     *
     * Unbounded this is `SELECT *` over a table that only ever grows — 213 rows
     * per collection on the deployed worker as of 2026-08-30, dragged through
     * the wire layer twice on every upgrade-hold sweep and three more times on
     * every scheduler tick. See FindOptions for why the bound is opt-in.
     */
    find: async (
      collection: string,
      filter: Record<string, unknown>,
      options?: FindOptions,
    ): Promise<Record<string, unknown>[]> => {
      await this.#ensureDocs();
      // `IN ()` is not valid SQL and "one of nothing" has one answer anyway.
      if (options?.runIds !== undefined && options.runIds.length === 0) return [];
      const { where, params } = whereClause(collection, filter);
      const clauses = [where];
      const args: string[] = [...params];
      if (options?.runIds !== undefined) {
        const placeholders = options.runIds.map((_, i) => `$${args.length + i + 1}`).join(", ");
        clauses.push(`run_id IN (${placeholders})`);
        args.push(...options.runIds);
      }
      let sql = `SELECT * FROM ship_docs WHERE ${clauses.join(" AND ")}`;
      if (options?.newest !== undefined) {
        const { limit, freshenedBy } = options.newest;
        let rank = "ship_docs.updated_at";
        if (freshenedBy !== undefined) {
          // Qualified by table name rather than an alias: `SELECT m.*` also
          // works against Nucleus, but the unaliased form keeps the projection
          // and the WHERE clause byte-identical to the unbounded statement, so
          // the only thing the option changes is the ordering and the cut.
          rank =
            `GREATEST(ship_docs.updated_at, COALESCE((SELECT MAX(r.updated_at) FROM ship_docs r ` +
            `WHERE r.collection = $${args.length + 1} AND r.run_id = ship_docs.run_id), ship_docs.updated_at))`;
          args.push(freshenedBy);
        }
        // The limit is inlined for the same reason every other number in this
        // file is: node-postgres ships parameters as text and Nucleus's
        // planner wants a literal here. int() is the guard that keeps that
        // safe — and the value is always internally derived, never user input.
        sql += ` ORDER BY ${rank} DESC LIMIT ${int(Math.max(1, Math.trunc(limit)))}`;
      }
      const result = await this.#run(sql, args);
      return (result.rows as Record<string, unknown>[]).map(rowToDoc);
    },
    update: async (
      collection: string,
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<number> => {
      await this.#ensureDocs();
      const keys = Object.keys(update);
      if (keys.length === 0) return 0;
      const sets = keys.map((k, i) => `${column(k)} = $${i + 1}`).join(", ");
      // undefined/null → SQL NULL (clears the column), not the string "undefined".
      const setParams = keys.map((k) => {
        const v = update[k];
        return v === undefined || v === null ? null : String(v);
      });
      const { where, params } = whereClause(collection, filter, setParams.length);
      const result = await this.#run(
        `UPDATE ship_docs SET ${sets} WHERE ${where}`,
        [...setParams, ...params],
      );
      return result.rowCount ?? 0;
    },
  };

  #ensureDocs(): Promise<void> {
    this.#docsReady ??= this.#pool
      .query(
        `CREATE TABLE IF NOT EXISTS ship_docs (
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
      )
      .then(() => undefined);
    return this.#docsReady;
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}

/**
 * Union of RunRecord and RunMeta fields — the only docs the runtime stores.
 *
 * This map is load-bearing and easy to forget: column() THROWS on an unmapped
 * key, and saveMeta hands it the whole RunMeta. Adding a field to RunMeta
 * without adding it here takes down every write that carries the new field
 * (`source` did exactly that — see migration 001). Anything added here also
 * needs a column in the ship_docs DDL above AND a migration, because Nucleus
 * cannot ALTER a populated table.
 */
const COLUMNS: Record<string, string> = {
  runId: "run_id",
  workflow: "workflow",
  status: "status",
  wakeAt: "wake_at",
  eventName: "event_name",
  task: "task",
  model: "model",
  workspace: "workspace",
  source: "source",
  ranOn: "ran_on",
  actor: "actor",
  actorKind: "actor_kind",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

/** Every RunMeta/RunRecord field this store can persist. */
export const DOC_FIELDS: readonly string[] = Object.keys(COLUMNS);

function column(key: string): string {
  const col = COLUMNS[key];
  if (col === undefined) throw new RangeError(`unknown run-record field: ${key}`);
  return col;
}

function whereClause(
  collection: string,
  filter: Record<string, unknown>,
  offset = 0,
): { where: string; params: string[] } {
  const clauses = [`collection = $${offset + 1}`];
  const params = [collection];
  for (const [key, value] of Object.entries(filter)) {
    clauses.push(`${column(key)} = $${offset + params.length + 1}`);
    params.push(String(value));
  }
  return { where: clauses.join(" AND "), params };
}

function rowToDoc(row: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(COLUMNS)) {
    const value = row[col];
    if (value !== null && value !== undefined) doc[key] = value;
  }
  return doc;
}
