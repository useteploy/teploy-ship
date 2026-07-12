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
export class NucleusPgwire {
  #pool: pg.Pool;
  #docsReady: Promise<void> | null = null;

  constructor(url: string) {
    this.#pool = new pg.Pool({ connectionString: url, max: 4 });
    // An idle pooled connection dying (engine restart, accessory upgrade)
    // emits 'error' on the pool; unhandled, that event CRASHES the process.
    // Bit live 2026-07-10: a nucleus accessory upgrade took the worker down
    // with "Unhandled 'error' event on BoundPool". In-flight queries still
    // reject through their own promises — this handler only absorbs the
    // idle-client death so the pool can mint fresh connections.
    this.#pool.on("error", (err) => {
      console.error(`[nucleus-pgwire] pool connection error (will reconnect): ${err.message}`);
    });
  }

  /** Raw parameterized query — rows as objects. The intake store builds on this. */
  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const result = await this.#pool.query(sql, params);
    return result.rows as Record<string, unknown>[];
  }

  /** Parameterized statement returning the affected-row count (conditional claims). */
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.#pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  async #fetchval<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.#pool.query(sql, params);
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
      await this.#pool.query(
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
      const result = await this.#pool.query(`SELECT * FROM ship_docs WHERE ${where}`, params);
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
      const result = await this.#pool.query(
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

/** Union of RunRecord and RunMeta fields — the only docs the runtime stores. */
const COLUMNS: Record<string, string> = {
  runId: "run_id",
  workflow: "workflow",
  status: "status",
  wakeAt: "wake_at",
  eventName: "event_name",
  task: "task",
  model: "model",
  workspace: "workspace",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

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
