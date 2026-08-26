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

export interface PoolClientLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  /** `release(true)` destroys the client instead of returning it to the pool. */
  release(destroy?: boolean): void;
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

  /**
   * @param owner Same identifier callers already pass to `nucleusRuntime`
   *   (`web-{host}-{pid}`, `worker-{host}-{pid}`, `cli-{host}-{pid}`) — reused
   *   here as the correlation tag on pool-level log lines, since a pool
   *   'error' isn't tied to any single in-flight query/run.
   */
  constructor(url: string, owner = "unknown", deps: { pool?: PoolLike } = {}) {
    this.#owner = owner;
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
   * Every statement goes through here. Under load on 2026-08-24/25 the pool
   * rejected with `TypeError: Cannot read properties of undefined (reading
   * 'name')` from pg-pool@3.14.0 index.js:45 — its `promisify` catch calls
   * `Error.captureStackTrace(err)` on whatever the connect path rejected
   * with, and that value was not an Error. The real reason is masked by the
   * TypeError (seen only with four sandboxes plus CLI traffic on a
   * 4-connection pool with a 5 s acquire timeout, alongside Nucleus catalog
   * write failures). It broke settle, meta updates and `approve` on live
   * runs. Bounded fix: a rejection that is not a real database error is
   * retried ONCE on a freshly checked-out client, which is destroyed if it
   * fails again, so a poisoned pooled connection cannot be handed back out.
   * A rejection that is a genuine database error (bad SQL, constraint) is
   * thrown as-is — those are not transient.
   */
  async #run(sql: string, params: unknown[] = []): Promise<QueryResultLike> {
    try {
      return await this.#pool.query(sql, params);
    } catch (error) {
      if (!isTransientPoolFailure(error)) throw error;
      console.error(
        `[nucleus-pgwire] pool query failed (${this.#owner}), retrying on a fresh connection: ${describe(error)}`,
      );
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
    find: async (
      collection: string,
      filter: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      await this.#ensureDocs();
      const { where, params } = whereClause(collection, filter);
      const result = await this.#run(`SELECT * FROM ship_docs WHERE ${where}`, params);
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
