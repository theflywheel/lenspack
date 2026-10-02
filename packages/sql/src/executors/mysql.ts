import type { SourceSchema } from "@lenspack/engine";
import type { Connection as CoreConnection } from "mysql2";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";

import { type Executor, type ExecutorOptions, type Row, type Writer, capRows, collectSchema, timeoutOf } from "../executor";

// MySQL 8 and MariaDB through one driver. Every statement runs in a
// read-only transaction under the server's own statement timer (MySQL's
// max_execution_time, MariaDB's max_statement_time) as a prepared statement,
// which holds exactly one statement and carries its values out of band.

const options = {
  // Times as text, read as UTC by toDate: no shift by this machine's offset.
  dateStrings: true,
  timezone: "Z",
  decimalNumbers: true,
  supportBigNumbers: true,
  multipleStatements: false,
  charset: "utf8mb4",
  // Each connection caches its prepared statements; bound them well under the server's global limit.
  maxPreparedStatements: 256,
} as const;

export function mysqlExecutor(pool: Pool, opts: ExecutorOptions & { mariadb?: boolean } = {}): Executor {
  return {
    dialect: "mysql",
    async query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const conn: PoolConnection = await pool.getConnection();
      try {
        await conn.query(opts.mariadb ? `SET SESSION max_statement_time = ${timeout / 1000}` : `SET SESSION max_execution_time = ${timeout}`);
        await conn.query("START TRANSACTION READ ONLY");
        // The client's timer backs up the server's, which MySQL applies to SELECT only.
        const [rows] = await conn.execute({ sql, timeout: timeout + 1000 }, params as never[]);
        await conn.query("ROLLBACK");
        return capRows(rows as Row[], opts.maxRows);
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        conn.release();
      }
    },
  };
}

/**
 * Seeding and examples only. Its sessions read "double quotes" as identifiers
 * (ANSI_QUOTES) so portable DDL runs unchanged; the read-only executor's
 * sessions never do, so a pack's string literals mean what they say.
 */
export function mysqlWriter(pool: Pool): Writer {
  return {
    async exec(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return (Array.isArray(rows) ? rows : []) as Row[];
    },
    async insert(table, columns, rows) {
      const per = Math.max(1, Math.floor(20_000 / columns.length));
      for (let i = 0; i < rows.length; i += per) {
        const batch = rows.slice(i, i + per).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));
        await pool.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ?`, [batch]);
      }
    },
  };
}

export async function introspectMysql(executor: Executor): Promise<SourceSchema> {
  const columns = await executor.query(
    `SELECT table_name AS t, column_name AS name, column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`,
    [],
  );
  const estimates = await executor.query(`SELECT table_name AS t, table_rows AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`, []);
  return collectSchema(columns, estimates);
}

// A new pooled connection arrives as the callback-API connection, whatever
// the pool's own API; one whose session setting fails is closed, so nothing
// runs on it without the setting.
const session = (c: unknown, sql: string) => {
  const conn = c as CoreConnection;
  conn.query(sql, (err) => err && conn.destroy());
};

/** mysql://user:pass@host:3306/db (or mariadb://…). */
export async function openMysql(url: string, opts: ExecutorOptions = {}) {
  const uri = url.replace(/^mariadb:/i, "mysql:");
  const pool = mysql.createPool({ uri, ...options, connectionLimit: 10 });
  // Every transaction on a reading session is read-only, not just the ones the executor opens.
  pool.on("connection", (c) => session(c, "SET SESSION TRANSACTION READ ONLY"));
  const writes = mysql.createPool({ uri, ...options, connectionLimit: 2 });
  writes.on("connection", (c) => session(c, "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')"));
  const [[version]] = (await pool.query("SELECT VERSION() AS v")) as unknown as [{ v: string }[]];
  const executor = mysqlExecutor(pool, { ...opts, mariadb: /mariadb/i.test(version?.v ?? "") });
  return {
    dialect: "mysql" as const,
    executor,
    writer: mysqlWriter(writes),
    pool,
    version: version?.v ?? "",
    introspect: () => introspectMysql(executor),
    close: async () => void (await Promise.all([pool.end(), writes.end()])),
  };
}
