import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import type { SourceSchema } from "@lenspack/engine";
import type BetterSqlite3 from "better-sqlite3";

export type SqliteDatabase = BetterSqlite3.Database;

import { type Executor, type ExecutorOptions, type Row, type Writer, DEFAULT_MAX_ROWS, collectSchema, timeoutOf } from "../executor";

// SQLite runs in this process and blocks the thread it runs on, so the
// executor keeps its own connection in a worker thread: a statement that runs
// past the timeout is stopped by ending the worker, and the next query starts
// a fresh one. The file is opened read-only; a statement is prepared alone
// (a second one in the text is an error) and refused unless it only reads;
// rows stream until the cap is passed.

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.module);
const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
parentPort.on("message", ({ id, sql, params, maxRows }) => {
  try {
    const stmt = db.prepare(sql);
    if (!stmt.readonly) throw new Error("Only a statement that reads runs on a source; this one would change it");
    if (!stmt.reader) throw new Error("The statement returns no rows");
    const rows = [];
    for (const row of stmt.iterate(...params)) {
      if (rows.length === maxRows) throw new Error("The statement returned more than " + maxRows + " rows, the row cap for this source");
      rows.push(row);
    }
    parentPort.postMessage({ id, rows });
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
`;

const moduleOf = () => createRequire(import.meta.url).resolve("better-sqlite3");

export function sqliteExecutor(path: string, opts: ExecutorOptions = {}): Executor & { close(): Promise<void> } {
  let worker: Worker | null = null;
  let next = 0;
  const pending = new Map<number, { resolve(rows: Row[]): void; reject(e: Error): void }>();
  const start = () => {
    const w = new Worker(WORKER, { eval: true, workerData: { path, module: moduleOf() } });
    w.on("message", (m: { id: number; rows?: Row[]; error?: string }) => {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else p?.resolve(m.rows!);
    });
    w.on("error", (e) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      if (worker === w) worker = null;
    });
    w.unref();
    return w;
  };
  // One statement at a time: ending the worker on a timeout must not take
  // another caller's statement with it.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    dialect: "sqlite",
    query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const work = () =>
        new Promise<Row[]>((resolve, reject) => {
          worker ??= start();
          const w = worker;
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            worker = null;
            void w.terminate();
            reject(new Error(`The statement ran past the ${timeout} ms timeout and was stopped`));
          }, timeout);
          // Referenced only while a statement is out, so an idle source never keeps the process alive.
          const done = () => (clearTimeout(timer), w.unref());
          pending.set(id, {
            resolve: (rows) => (done(), resolve(rows)),
            reject: (e) => (done(), reject(e)),
          });
          w.ref();
          w.postMessage({ id, sql, params, maxRows: opts.maxRows ?? DEFAULT_MAX_ROWS });
        });
      const result = chain.then(work, work);
      chain = result.catch(() => undefined);
      return result;
    },
    async close() {
      await worker?.terminate();
      worker = null;
    },
  };
}

/** Seeding and examples only, on the main thread. SQLite stores no booleans: they are bound as 1 and 0. */
export function sqliteWriter(db: SqliteDatabase): Writer {
  const bind = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
  return {
    async exec(sql, params = []) {
      if (params.length === 0 && !/^\s*select\b/i.test(sql)) {
        db.exec(sql);
        return [];
      }
      const stmt = db.prepare(sql);
      return stmt.reader ? (stmt.all(...params.map(bind)) as Row[]) : (stmt.run(...params.map(bind)), []);
    },
    async insert(table, columns, rows) {
      const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      db.transaction(() => {
        for (const r of rows) stmt.run(...r.map(bind));
      })();
    },
  };
}

export async function introspectSqlite(executor: Executor): Promise<SourceSchema> {
  const columns = await executor.query(
    `SELECT m.name AS t, p.name AS name, lower(p.type) AS type FROM sqlite_schema m JOIN pragma_table_info(m.name) p
     WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid`,
    [],
  );
  // SQLite keeps no row estimate; a count is exact and, for a table, cheap enough to ask once.
  const tables = await executor.query(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`, []);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const counts = tables.length ? await executor.query(tables.map((t) => `SELECT '${String(t.name).replace(/'/g, "''")}' AS t, count(*) AS n FROM ${q(String(t.name))}`).join(" UNION ALL "), []) : [];
  return collectSchema(columns, counts);
}

/** A SQLite file. The executor reads it read-only in a worker; the writer is for seeding. */
export async function openSqlite(path: string, opts: ExecutorOptions & { readOnly?: boolean } = {}) {
  const Database = (await import("better-sqlite3")).default;
  const db: SqliteDatabase = new Database(path, { readonly: opts.readOnly ?? false });
  const executor = sqliteExecutor(path, opts);
  return {
    dialect: "sqlite" as const,
    executor,
    writer: sqliteWriter(db),
    introspect: () => introspectSqlite(executor),
    close: async () => {
      await executor.close();
      db.close();
    },
  };
}
