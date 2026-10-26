import { type Board, type BoardConfig, type BoardStore, type BoardVersion, applyOps, boardConfigSchema, describeOps, emptyBoard } from "@lenspack/core";

import type { Dialect } from "./print/base";
import type { Executor, Writer } from "./executor";
import { toDate } from "@lenspack/engine";

// Two tables, portable DDL: config is stored as JSON text so the same store
// runs on Postgres and DuckDB. Every patch inserts a version row; the boards
// row is a pointer to the latest. A space keeps one pack's boards apart from
// another's in the same tables: lenspack serve gives each pack its own.

export const STORE_DDL = `
CREATE TABLE IF NOT EXISTS lenspack_boards (
  space VARCHAR NOT NULL,
  id VARCHAR NOT NULL,
  pack VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  owner VARCHAR,
  tenant VARCHAR,
  shared BOOLEAN NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (space, id)
);
CREATE TABLE IF NOT EXISTS lenspack_board_versions (
  space VARCHAR NOT NULL,
  board_id VARCHAR NOT NULL,
  version INTEGER NOT NULL,
  source VARCHAR NOT NULL,
  summary VARCHAR NOT NULL,
  config TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (space, board_id, version)
);`;

const ownership = (r: Record<string, unknown>) =>
  r.owner == null ? {} : { owner: String(r.owner), shared: r.shared === true || r.shared === 1, ...(r.tenant == null ? {} : { tenant: String(r.tenant) }) };

function rowToBoard(r: Record<string, unknown>): Board {
  return {
    id: String(r.id),
    pack: String(r.pack),
    config: boardConfigSchema.parse(JSON.parse(String(r.config))),
    version: Number(r.version),
    updatedAt: toDate(r.updated_at) ?? new Date(),
    ...ownership(r),
  };
}

export function sqlStore(db: { executor: Executor; writer: Writer; dialect: Dialect }, { space = "" }: { space?: string } = {}): BoardStore & { migrate(): Promise<void> } {
  const { executor, writer } = db;
  const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

  const record = async (current: Board | null, id: string, pack: string, config: BoardConfig, source: string, summary: string, owner?: string, tenant?: string): Promise<Board> => {
    const [v] = await executor.query(`SELECT COALESCE(MAX(version), 0) AS v FROM lenspack_board_versions WHERE space = $1 AND board_id = $2`, [space, id]);
    const version = Number(v?.v ?? 0) + 1;
    const json = JSON.stringify(config);
    await writer.exec(
      `INSERT INTO lenspack_board_versions (space, board_id, version, source, summary, config, created_at) VALUES ($1, $2, $3, $4, $5, $6, CAST($7 AS TIMESTAMP))`,
      [space, id, version, source, summary, json, now()],
    );
    if (!current) {
      await writer.exec(
        `INSERT INTO lenspack_boards (space, id, pack, title, owner, tenant, shared, version, config, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CAST($10 AS TIMESTAMP))`,
        [space, id, pack, config.title, owner ?? null, (owner && tenant) || null, false, version, json, now()],
      );
      return { id, pack, config, version, updatedAt: new Date(), ...(owner ? { owner, shared: false, ...(tenant ? { tenant } : {}) } : {}) };
    }
    await writer.exec(`UPDATE lenspack_boards SET title = $1, version = $2, config = $3, updated_at = CAST($4 AS TIMESTAMP) WHERE space = $5 AND id = $6`, [config.title, version, json, now(), space, id]);
    return { ...current, config, version, updatedAt: new Date() };
  };

  const store: BoardStore & { migrate(): Promise<void> } = {
    async migrate() {
      for (const stmt of STORE_DDL.split(";").map((s) => s.trim()).filter(Boolean)) await writer.exec(stmt);
      // CREATE IF NOT EXISTS keeps a table from before spaces and owners; say so rather than fail on the first board.
      await executor.query(`SELECT space, owner, tenant, shared FROM lenspack_boards WHERE 1 = 0`, []).catch(() => {
        throw new Error("lenspack_boards is from a lenspack before board owners: rename it and lenspack_board_versions aside, and the boards from files are made again");
      });
    },
    async get(id) {
      const [r] = await executor.query(`SELECT * FROM lenspack_boards WHERE space = $1 AND id = $2`, [space, id]);
      return r ? rowToBoard(r) : null;
    },
    async list() {
      const rows = await executor.query(`SELECT id, pack, title, owner, tenant, shared, version, updated_at FROM lenspack_boards WHERE space = $1 ORDER BY updated_at DESC`, [space]);
      return rows.map((r) => ({ id: String(r.id), pack: String(r.pack), title: String(r.title), version: Number(r.version), updatedAt: toDate(r.updated_at) ?? new Date(), ...ownership(r) }));
    },
    async create({ id, pack, title, config, owner, tenant }) {
      const boardId = id ?? `b_${Math.random().toString(36).slice(2, 10)}`;
      if (await store.get(boardId)) throw new Error(`Board "${boardId}" already exists`);
      return record(null, boardId, pack.pack, config ?? emptyBoard(pack, title), "create", "created", owner, tenant);
    },
    async patch({ id, ops, catalogue, source = "ops", expectedVersion }) {
      const current = await store.get(id);
      if (!current) return { ok: false, error: `No board called "${id}"` };
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        return { ok: false, error: `Board changed since version ${expectedVersion}; it is now v${current.version}` };
      const result = applyOps(current.config, ops, catalogue);
      if (!result.ok) return { ok: false, error: result.error, hint: result.hint, opIndex: result.opIndex };
      return { ok: true, board: await record(current, id, current.pack, result.config, source, describeOps(ops)) };
    },
    async replaceConfig({ id, config, source = "layout", summary = "layout changed" }) {
      const current = await store.get(id);
      if (!current) throw new Error(`No board called "${id}"`);
      return record(current, id, current.pack, config, source, summary);
    },
    async versions(id) {
      const rows = await executor.query(`SELECT version, source, summary, config, created_at FROM lenspack_board_versions WHERE space = $1 AND board_id = $2 ORDER BY version DESC`, [space, id]);
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
      const [r] = await executor.query(`SELECT config FROM lenspack_board_versions WHERE space = $1 AND board_id = $2 AND version = $3`, [space, id, version]);
      const current = await store.get(id);
      if (!r || !current) return null;
      const config = boardConfigSchema.parse(JSON.parse(String(r.config)));
      // Restoring what is already there records nothing.
      if (JSON.stringify(config) === JSON.stringify(current.config)) return current;
      return record(current, id, current.pack, config, "revert", `restored v${version}`);
    },
    async share(id, shared) {
      const current = await store.get(id);
      if (!current?.owner) return null;
      await writer.exec(`UPDATE lenspack_boards SET shared = $1 WHERE space = $2 AND id = $3`, [shared, space, id]);
      return { ...current, shared };
    },
    async delete(id) {
      await writer.exec(`DELETE FROM lenspack_board_versions WHERE space = $1 AND board_id = $2`, [space, id]);
      await writer.exec(`DELETE FROM lenspack_boards WHERE space = $1 AND id = $2`, [space, id]);
    },
  };
  return store;
}
