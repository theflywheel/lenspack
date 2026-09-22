import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

import type { Executor, Row, Writer } from "../executor";

// DuckDB is in-process, so read-only is a property of how the connection is
// used: the executor only ever runs the compiled statement, and the timeout
// interrupts the connection rather than trusting the statement to finish.

type Values = Parameters<DuckDBConnection["runAndReadAll"]>[1];

function normalise(rows: Record<string, unknown>[]): Row[] {
  // Values come back as DuckDB wrapper objects; the executor contract is plain
  // JS. Dates and decimals are converted by @lenspack/sql's toDate/toNumber,
  // which understand the wrappers, so here only bigint needs care for JSON.
  return rows;
}

export function duckdbExecutor(connection: DuckDBConnection, opts: { defaultTimeoutMs?: number } = {}): Executor {
  // One statement at a time per connection: DuckDB connections are not safe
  // for concurrent use, so calls are serialised through a promise chain.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    dialect: "duckdb",
    query(sql, params, o) {
      const timeout = Math.max(100, Math.floor(o?.timeoutMs ?? opts.defaultTimeoutMs ?? 15_000));
      const work = async () => {
        const timer = setTimeout(() => connection.interrupt(), timeout);
        try {
          const reader = await connection.runAndReadAll(sql, params as Values);
          return normalise(reader.getRowObjects() as Record<string, unknown>[]);
        } finally {
          clearTimeout(timer);
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

export async function openDuckdb(path = ":memory:") {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance: DuckDBInstance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  return {
    dialect: "duckdb" as const,
    executor: duckdbExecutor(connection),
    writer: duckdbWriter(connection),
    connection,
    instance,
    close: async () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
