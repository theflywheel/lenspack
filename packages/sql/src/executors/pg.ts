import pg, { type Pool, type PoolClient } from "pg";

import type { SourceSchema } from "@lenspack/engine";

import { type Executor, type ExecutorOptions, type Row, type Writer, capRows, collectSchema, timeoutOf } from "../executor";

// Naive timestamps and dates come back as text rather than as local-time Date
// objects: node-postgres would otherwise shift a "2026-01-01 00:00" bucket by
// the machine's UTC offset. lenspack treats naive time as UTC everywhere, and
// toDate() parses these strings accordingly.
const OID = { date: 1082, timestamp: 1114 } as const;
export const naiveTimeAsText = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === OID.date || oid === OID.timestamp) return (v: string) => v;
    // NUMERIC arrives as text; a JSON API returns it as a number.
    if (oid === 1700)
      return (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      };
    // Defer to pg's defaults for everything else.
    return pg.types.getTypeParser(oid, format as never) as (v: string) => unknown;
  },
};

// Read-only transaction and statement timeout on every query: the guards live
// here, not in the SQL, so nothing a caller passes can remove them. The
// extended protocol takes exactly one statement, so "…; COMMIT; …" cannot
// step outside the transaction even when there are no parameters.

export function pgExecutor(pool: Pool, opts: ExecutorOptions = {}): Executor {
  return {
    dialect: "postgres",
    async query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${timeout}`);
        const result = await client.query({ text: sql, values: params, types: naiveTimeAsText, queryMode: "extended" } as pg.QueryConfig);
        await client.query("ROLLBACK");
        return capRows(result.rows as Row[], opts.maxRows);
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

/** Tables and views in the search path's schemas, with the planner's row estimates. */
export async function introspectPostgres(executor: Executor): Promise<SourceSchema> {
  const columns = await executor.query(
    `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS name, c.data_type AS type
     FROM information_schema.columns c
     WHERE c.table_schema = ANY (current_schemas(false))
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    [],
  );
  const estimates = await executor.query(
    `SELECT n.nspname AS s, cl.relname AS t, cl.reltuples::bigint AS n
     FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = ANY (current_schemas(false)) AND cl.relkind IN ('r', 'p', 'm')`,
    [],
  );
  return collectSchema(columns, estimates);
}

export async function openPostgres(connectionString: string, opts: ExecutorOptions = {}) {
  const pool = new pg.Pool({ connectionString });
  const executor = pgExecutor(pool, opts);
  return {
    dialect: "postgres" as const,
    executor,
    writer: pgWriter(pool),
    pool,
    introspect: () => introspectPostgres(executor),
    close: () => pool.end(),
  };
}
