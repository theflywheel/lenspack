import pg, { type Pool, type PoolClient } from "pg";

import type { Executor, Row, Writer } from "../executor";

// Naive timestamps and dates come back as text rather than as local-time Date
// objects: node-postgres would otherwise shift a "2026-01-01 00:00" bucket by
// the machine's UTC offset. lenspack treats naive time as UTC everywhere, and
// toDate() parses these strings accordingly.
const OID = { date: 1082, timestamp: 1114 } as const;
export const naiveTimeAsText = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === OID.date || oid === OID.timestamp) return (v: string) => v;
    // Defer to pg's defaults for everything else.
    return pg.types.getTypeParser(oid, format as never) as (v: string) => unknown;
  },
};

// Read-only transaction and statement timeout on every query: the guards live
// here, not in the SQL, so nothing a caller passes can remove them.

export function pgExecutor(pool: Pool, opts: { defaultTimeoutMs?: number } = {}): Executor {
  return {
    dialect: "postgres",
    async query(sql, params, o) {
      const timeout = Math.max(100, Math.floor(o?.timeoutMs ?? opts.defaultTimeoutMs ?? 15_000));
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${timeout}`);
        const result = await client.query({ text: sql, values: params, types: naiveTimeAsText });
        await client.query("ROLLBACK");
        return result.rows as Row[];
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export function pgWriter(pool: Pool): Writer {
  return {
    async exec(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows as Row[];
    },
  };
}

export async function openPostgres(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    dialect: "postgres" as const,
    executor: pgExecutor(pool),
    writer: pgWriter(pool),
    pool,
    close: () => pool.end(),
  };
}
