import { type Board, type BoardConfig, type BoardStore, type BoardVersion, applyOps, boardConfigSchema, describeOps, emptyBoard } from "@lenspack/core";

import type { Dialect } from "./print/base";
import type { Executor, Writer } from "./executor";
import { toDate } from "./executor";

// Two tables, portable DDL: config is stored as JSON text so the same store
// runs on Postgres and DuckDB. Every patch inserts a version row; the boards
// row is a pointer to the latest.

export const STORE_DDL = `
CREATE TABLE IF NOT EXISTS lenspack_boards (
  id VARCHAR PRIMARY KEY,
  pack VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS lenspack_board_versions (
  board_id VARCHAR NOT NULL,
  version INTEGER NOT NULL,
  source VARCHAR NOT NULL,
  summary VARCHAR NOT NULL,
  config TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (board_id, version)
);`;

function rowToBoard(r: Record<string, unknown>): Board {
  return {
    id: String(r.id),
    pack: String(r.pack),
    config: boardConfigSchema.parse(JSON.parse(String(r.config))),
    version: Number(r.version),
    updatedAt: toDate(r.updated_at) ?? new Date(),
  };
}

export function sqlStore(db: { executor: Executor; writer: Writer; dialect: Dialect }): BoardStore & { migrate(): Promise<void> } {
  const { executor, writer } = db;
  const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

  const record = async (id: string, pack: string, config: BoardConfig, source: string, summary: string): Promise<Board> => {
    const [v] = await executor.query(`SELECT COALESCE(MAX(version), 0) AS v FROM lenspack_board_versions WHERE board_id = $1`, [id]);
    const version = Number(v?.v ?? 0) + 1;
    const json = JSON.stringify(config);
    await writer.exec(
      `INSERT INTO lenspack_board_versions (board_id, version, source, summary, config, created_at) VALUES ($1, $2, $3, $4, $5, CAST($6 AS TIMESTAMP))`,
      [id, version, source, summary, json, now()],
    );
    if (version === 1) {
      await writer.exec(`INSERT INTO lenspack_boards (id, pack, title, version, config, updated_at) VALUES ($1, $2, $3, $4, $5, CAST($6 AS TIMESTAMP))`, [id, pack, config.title, version, json, now()]);
    } else {
      await writer.exec(`UPDATE lenspack_boards SET title = $1, version = $2, config = $3, updated_at = CAST($4 AS TIMESTAMP) WHERE id = $5`, [config.title, version, json, now(), id]);
    }
    return { id, pack, config, version, updatedAt: new Date() };
  };

  const store: BoardStore & { migrate(): Promise<void> } = {
    async migrate() {
      for (const stmt of STORE_DDL.split(";").map((s) => s.trim()).filter(Boolean)) await writer.exec(stmt);
    },
    async get(id) {
      const [r] = await executor.query(`SELECT * FROM lenspack_boards WHERE id = $1`, [id]);
      return r ? rowToBoard(r) : null;
    },
    async list() {
      const rows = await executor.query(`SELECT id, pack, title, version, updated_at FROM lenspack_boards ORDER BY updated_at DESC`, []);
      return rows.map((r) => ({ id: String(r.id), pack: String(r.pack), title: String(r.title), version: Number(r.version), updatedAt: toDate(r.updated_at) ?? new Date() }));
    },
    async create({ id, pack, title, config }) {
      const boardId = id ?? `b_${Math.random().toString(36).slice(2, 10)}`;
      if (await store.get(boardId)) throw new Error(`Board "${boardId}" already exists`);
      return record(boardId, pack.pack, config ?? emptyBoard(pack, title), "create", "created");
    },
    async patch({ id, ops, catalogue, source = "ops", expectedVersion }) {
      const current = await store.get(id);
      if (!current) return { ok: false, error: `No board called "${id}"` };
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        return { ok: false, error: `Board changed since version ${expectedVersion}; it is now v${current.version}` };
      const result = applyOps(current.config, ops, catalogue);
      if (!result.ok) return { ok: false, error: result.error, hint: result.hint, opIndex: result.opIndex };
      return { ok: true, board: await record(id, current.pack, result.config, source, describeOps(ops)) };
    },
    async replaceConfig({ id, config, source = "layout", summary = "layout changed" }) {
      const current = await store.get(id);
      if (!current) throw new Error(`No board called "${id}"`);
      return record(id, current.pack, config, source, summary);
    },
    async versions(id) {
      const rows = await executor.query(`SELECT version, source, summary, config, created_at FROM lenspack_board_versions WHERE board_id = $1 ORDER BY version DESC`, [id]);
      return rows.map(
        (r): BoardVersion => ({
          version: Number(r.version),
          source: String(r.source),
          summary: String(r.summary),
          config: boardConfigSchema.parse(JSON.parse(String(r.config))),
          createdAt: toDate(r.created_at) ?? new Date(),
        }),
      );
    },
    async revertTo(id, version) {
      const [r] = await executor.query(`SELECT config FROM lenspack_board_versions WHERE board_id = $1 AND version = $2`, [id, version]);
      const current = await store.get(id);
      if (!r || !current) return null;
      return record(id, current.pack, boardConfigSchema.parse(JSON.parse(String(r.config))), "revert", `restored v${version}`);
    },
    async delete(id) {
      await writer.exec(`DELETE FROM lenspack_board_versions WHERE board_id = $1`, [id]);
      await writer.exec(`DELETE FROM lenspack_boards WHERE id = $1`, [id]);
    },
  };
  return store;
}
