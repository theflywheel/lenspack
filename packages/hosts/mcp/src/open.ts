import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { type BoardStore, memoryStore } from "@lenspack/core";
import { type Tool, boardTools, fileProposals } from "@lenspack/agent";
import { loadPack } from "@lenspack/pack";
import { type Writer, filePath, openSource, schemeOf, sqlStore } from "@lenspack/sql";

import { sqlRawSql } from "./index";
import { type Imported, importLegacyBoards } from "./legacy";
import type { CliOptions } from "./options";

// How lenspack-mcp opens what it serves. The data is a source, opened the
// way every other host opens one (openSource): read-only, and for a file
// database no access to any other file, so run_sql reads the data and
// nothing else. Boards are kept apart from the data, in their own store.

/** A --db value as a source URL. A bare path (no scheme) is a DuckDB file, as it always was. */
export function dataUrl(db: string, base = process.cwd()): string {
  if (schemeOf(db) && !/^[a-z]:[\\/]/i.test(db)) return db;
  return `duckdb:${resolve(base, db)}`;
}

/** The file behind a DuckDB or SQLite URL, or undefined for a server database or an in-memory one. */
function fileOf(url: string, base: string): string | undefined {
  const scheme = schemeOf(url);
  if (!scheme || !["duckdb", "sqlite", "sqlite3"].includes(scheme)) return undefined;
  const file = filePath(url, base);
  return file === ":memory:" ? undefined : resolve(base, file);
}

/** Opens --db as a read-only source. A file that does not exist is an error, not a new empty database. */
export async function openData(db: string, base = process.cwd()) {
  const url = dataUrl(db, base);
  const file = fileOf(url, base);
  if (file && !existsSync(file)) throw new Error(`No database file at ${file}`);
  const { connector, connection } = await openSource(url, { base });
  return { url, file, connector, close: connection.close };
}

/** Opens the board store: "memory", a postgres:// URL, or a DuckDB file (path or duckdb: URL). Never the data itself. */
export async function openStore(spec: string, data: { url: string; file?: string }, base = process.cwd()): Promise<{ store: BoardStore; writer?: Writer; where: string; close(): Promise<void> }> {
  if (spec === "memory") return { store: memoryStore(), where: "memory (boards are lost when this process ends)", close: async () => {} };
  const scheme = schemeOf(spec);
  if (scheme === "postgres" || scheme === "postgresql") {
    if (spec === data.url) throw new Error("--store is the data database; boards are kept apart from the data, so give the store its own database");
    const db = await (await import("@lenspack/sql/pg")).openPostgres(spec);
    await sqlStore(db).migrate();
    return { store: sqlStore(db), writer: db.writer, where: "postgres", close: db.close };
  }
  if (scheme && scheme !== "duckdb" && !/^[a-z]:[\\/]/i.test(spec)) throw new Error(`--store takes "memory", a postgres:// URL or a DuckDB file, not a ${scheme}: URL`);
  const file = scheme === "duckdb" ? resolve(base, filePath(spec, base)) : resolve(base, spec);
  if (data.file && file === data.file) throw new Error("--store is the data file; boards are kept apart from the data, so give the store its own file");
  const db = await (await import("@lenspack/sql/duckdb")).openDuckdb(file);
  await sqlStore(db).migrate();
  return { store: sqlStore(db), writer: db.writer, where: file, close: db.close };
}

/** Everything a lenspack-mcp process serves: the pack, the read-only data, the board store and the tools. */
export async function openMcp(o: Pick<CliOptions, "pack" | "db" | "store" | "board" | "tenant" | "runSql">, base = process.cwd()): Promise<{ tools: Tool[]; pack: string; board: string; store: string; imported: Imported | null; close(): Promise<void> }> {
  const packPath = resolve(base, o.pack);
  const pack = await loadPack(packPath);
  const data = await openData(o.db, base);
  const closers = [data.close];
  const close = async () => {
    for (const c of closers.reverse()) await c();
  };
  try {
    const { store, writer, where, close: closeStore } = await openStore(o.store ?? join(dirname(packPath), `${pack.pack}.boards.duckdb`), data, base);
    closers.push(closeStore);
    // Boards an earlier version kept in the data database come across once, read-only.
    const imported = await importLegacyBoards(data.connector.executor, { store, writer }, pack);
    if (!(await store.get(o.board))) await store.create({ id: o.board, pack, title: `${pack.pack} board` });
    const tools = boardTools({
      pack,
      connector: data.connector,
      // run_sql runs through the source's own read-only executor, with every guard its driver applies.
      rawSql: sqlRawSql(data.connector.executor, pack),
      store,
      boardId: o.board,
      ctx: { tenant: o.tenant },
      runSql: o.runSql,
      proposals: fileProposals(join(dirname(packPath), `${pack.pack}.proposals.json`)),
    });
    return {
      tools,
      pack: pack.pack,
      board: o.board,
      store: where,
      imported,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
