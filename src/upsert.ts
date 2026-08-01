import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Update-or-insert keyed by a logical identity, for tables that cannot express
 * that identity themselves.
 *
 * Every store here creates its table from application code with plain TEXT
 * columns and no primary key, because Nucleus cannot ALTER a populated table
 * and the schema has to stay addable-to. That leaves SELECT-then-INSERT as the
 * only shape available — and under concurrency two callers both see no row and
 * both insert, so the "identity" quietly becomes two rows. Later updates then
 * modify both, and reads return whichever comes back first.
 *
 * The KV's atomic setNX supplies the missing uniqueness: exactly one caller can
 * claim a key, so exactly one INSERT happens. The claim is held briefly — it
 * only has to cover the gap between the existence check and the insert — and
 * a caller that loses it falls back to UPDATE, which is what it would have done
 * had it seen the winner's row.
 */
export async function upsertByKey(
  db: NucleusPgwire,
  options: {
    table: string;
    keyColumn: string;
    key: string;
    update: () => Promise<unknown>;
    insert: () => Promise<unknown>;
  },
): Promise<void> {
  const { table, keyColumn, key } = options;
  const existing = await db.query(`SELECT ${keyColumn} FROM ${table} WHERE ${keyColumn} = $1`, [key]);
  if (existing.length > 0) {
    await options.update();
    return;
  }
  const guard = `ship:upsert:${table}:${key}`;
  if (await db.kv.setNX(guard, "1", { ttl: 30 })) {
    // We hold the right to create this row. Re-check first: another caller may
    // have inserted and released between our SELECT and our claim.
    const again = await db.query(`SELECT ${keyColumn} FROM ${table} WHERE ${keyColumn} = $1`, [key]);
    if (again.length === 0) {
      await options.insert();
      return;
    }
  }
  // Someone else is creating (or created) it — update theirs rather than adding a twin.
  await options.update();
}
