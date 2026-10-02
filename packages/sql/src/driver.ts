import { isAbsolute, resolve as resolvePath } from "node:path";

import type { Connector, SourceSchema } from "@lenspack/engine";

import { registerDialect } from "./dialects";
import { type Executor, type ExecutorOptions, type Writer, sqlConnector } from "./executor";
import type { DialectRules } from "./print/base";
import { clickhouseRules } from "./print/clickhouse";
import { duckdbRules } from "./print/duckdb";
import { mysqlRules } from "./print/mysql";
import { postgresRules } from "./print/postgres";
import { sqliteRules } from "./print/sqlite";

// A source is a connection URL, and its scheme picks the driver. A driver is
// a dialect (how to print) and a way to connect (how to run, read-only);
// nothing else in lenspack talks to the database, and all it ever sends is
// SQL text and bound parameters. Registering a driver is the whole of adding
// a database: the compiler, the conformance suite and `lenspack sources`
// need no change.

export type ConnectOptions = ExecutorOptions & {
  /** Directory a relative file path in the URL is resolved against (the config file's). */
  base?: string;
};

export type Connection = {
  /** Runs one read-only statement under a timeout and a row cap. */
  executor: Executor;
  /** Writes, for seeding examples and tests. Never handed to a tool or a model. */
  writer?: Writer;
  /** Tables or views, columns and types, and row counts where the database keeps them. */
  introspect(): Promise<SourceSchema>;
  close(): Promise<void>;
};

export type Driver = {
  /** Also the dialect name a pack's per-dialect fragments use. */
  name: string;
  /** URL schemes it answers, without the colon. */
  schemes: string[];
  dialect: DialectRules;
  connect(url: string, opts?: ConnectOptions): Promise<Connection>;
};

const BY_SCHEME = new Map<string, Driver>();

/** Adds a driver (or replaces the one holding its schemes). Its dialect becomes printable. */
export function registerDriver(driver: Driver) {
  registerDialect(driver.dialect);
  for (const scheme of driver.schemes) BY_SCHEME.set(scheme.toLowerCase(), driver);
}

export function drivers(): Driver[] {
  return [...new Set(BY_SCHEME.values())];
}

export function schemeOf(url: string): string | null {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? null;
}

/** The driver for a connection URL; an unknown scheme is an error naming the known ones. */
export function driverFor(url: string): Driver {
  const scheme = schemeOf(url);
  const driver = scheme ? BY_SCHEME.get(scheme) : undefined;
  if (!driver) throw new Error(`No driver for ${scheme ? `"${scheme}:"` : "this"} URL; registered schemes: ${[...BY_SCHEME.keys()].map((s) => `${s}:`).join(", ")}`);
  return driver;
}

/**
 * The file a file-database URL names: duckdb:///abs/file.duckdb, duckdb:./rel.duckdb
 * (relative to `base`), duckdb::memory:. Query strings are not part of a path.
 */
export function filePath(url: string, base?: string): string {
  const rest = url.slice(url.indexOf(":") + 1).replace(/^\/\//, "");
  if (rest === ":memory:" || rest === "") return ":memory:";
  const path = decodeURIComponent(rest.replace(/\?.*$/, ""));
  return isAbsolute(path) || !base ? path : resolvePath(base, path);
}

/** Opens a source URL as a lenspack connector, with the driver and connection behind it. */
export async function openSource(url: string, opts: ConnectOptions = {}): Promise<{ driver: Driver; connection: Connection; connector: Connector & { executor: Executor } }> {
  const driver = driverFor(url);
  const connection = await driver.connect(url, opts);
  return { driver, connection, connector: sqlConnector(connection.executor, { introspect: connection.introspect, close: connection.close }) };
}

// The drivers lenspack ships. Each loads its client library only when a URL
// asks for it, so an install needs only the clients it uses.

registerDriver({
  name: "postgres",
  schemes: ["postgres", "postgresql"],
  dialect: postgresRules,
  connect: async (url, opts) => (await import("./executors/pg")).openPostgres(url, opts),
});

registerDriver({
  name: "duckdb",
  schemes: ["duckdb"],
  dialect: duckdbRules,
  connect: async (url, opts = {}) => {
    const path = filePath(url, opts.base);
    // A source is read-only; an in-memory database cannot be opened that way (and is empty).
    return (await import("./executors/duckdb")).openDuckdb(path, { ...opts, readOnly: path !== ":memory:" });
  },
});

registerDriver({
  name: "sqlite",
  schemes: ["sqlite", "sqlite3"],
  dialect: sqliteRules,
  connect: async (url, opts = {}) => (await import("./executors/sqlite")).openSqlite(filePath(url, opts.base), { ...opts, readOnly: true }),
});

registerDriver({
  name: "mysql",
  schemes: ["mysql", "mariadb"],
  dialect: mysqlRules,
  connect: async (url, opts) => (await import("./executors/mysql")).openMysql(url, opts),
});

registerDriver({
  name: "clickhouse",
  schemes: ["clickhouse"],
  dialect: clickhouseRules,
  connect: async (url, opts) => (await import("./executors/clickhouse")).openClickhouse(url, opts),
});
