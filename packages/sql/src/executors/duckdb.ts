import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { SourceSchema } from "@lenspack/engine";

import { type Executor, type ExecutorOptions, type Row, type Writer, capRows, collectSchema, timeoutOf } from "../executor";

// DuckDB is in-process, so read-only is a property of how the connection is
// used: the executor prepares exactly one statement, refuses it unless it is
// a SELECT, and the timeout interrupts the connection rather than trusting
// the statement to finish. A file opened as a source (openDuckdb with
// readOnly) is also opened READ_ONLY with no access to other files.

// duckdb's StatementType.SELECT; a WITH … SELECT is a SELECT too.
const SELECT = 1;

type Values = Parameters<DuckDBConnection["runAndReadAll"]>[1];

function normalise(rows: Record<string, unknown>[]): Row[] {
  // Values come back as DuckDB wrapper objects; the executor contract is plain
  // JS. Dates and decimals are converted by @lenspack/sql's toDate/toNumber,
  // which understand the wrappers, so here only bigint needs care for JSON.
  return rows;
}

export function duckdbExecutor(connection: DuckDBConnection, opts: ExecutorOptions = {}): Executor {
  // One statement at a time per connection: DuckDB connections are not safe
  // for concurrent use, so calls are serialised through a promise chain.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    dialect: "duckdb",
    query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const work = async () => {
        const statements = await connection.extractStatements(sql);
        if (statements.count !== 1) throw new Error(`One statement at a time (got ${statements.count})`);
        const prepared = await statements.prepare(0);
        const timer = setTimeout(() => connection.interrupt(), timeout);
        try {
          if (prepared.statementType !== SELECT) throw new Error("Only a SELECT runs on a source; this statement would change it");
          prepared.bind(params as NonNullable<Values>);
          const reader = await prepared.runAndReadAll();
          return capRows(normalise(reader.getRowObjects() as Record<string, unknown>[]), opts.maxRows);
        } finally {
          clearTimeout(timer);
          prepared.destroySync();
        }
      };
      const result = chain.then(work, work);
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

export function duckdbWriter(connection: DuckDBConnection): Writer {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    exec(sql, params = []) {
      const work = async () => {
        const reader = await connection.runAndReadAll(sql, params as Values);
        return reader.getRowObjects() as Row[];
      };
      const result = chain.then(work, work);
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

export async function introspectDuckdb(executor: Executor): Promise<SourceSchema> {
  const columns = await executor.query(
    `SELECT table_schema AS s, table_name AS t, column_name AS name, data_type AS type FROM information_schema.columns
     WHERE table_catalog = current_database() AND table_name NOT LIKE 'lenspack\_%' ESCAPE '\' ORDER BY table_schema, table_name, ordinal_position`,
    [],
  );
  const estimates = await executor.query(`SELECT schema_name AS s, table_name AS t, estimated_size AS n FROM duckdb_tables() WHERE database_name = current_database()`, []);
  return collectSchema(columns, estimates, "main");
}

/**
 * A DuckDB database: a file, or ":memory:". `readOnly` is how a source is
 * opened: the file cannot be written and no other file can be read, so even
 * run_sql cannot reach past the database it was pointed at.
 */
export async function openDuckdb(path = ":memory:", opts: ExecutorOptions & { readOnly?: boolean } = {}) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance: DuckDBInstance = await DuckDBInstance.create(path, opts.readOnly ? { access_mode: "READ_ONLY", enable_external_access: "false" } : undefined);
  const connection = await instance.connect();
  const executor = duckdbExecutor(connection, opts);
  return {
    dialect: "duckdb" as const,
    executor,
    writer: duckdbWriter(connection),
    connection,
    instance,
    introspect: () => introspectDuckdb(executor),
    close: async () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
