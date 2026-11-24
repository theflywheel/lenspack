import { type BoardStore, boardConfigSchema } from "@lenspack/core";
import { type Executor, type Row, type Writer, toDate } from "@lenspack/sql";

// Earlier versions of lenspack-mcp kept boards inside the data database, in
// lenspack_boards and lenspack_board_versions. The data is now opened
// read-only and boards live in their own store, so on a start where that
// store has no boards for this pack, the old ones are read from the data and
// copied across with their whole history. Only SELECTs reach the data: the
// read-only executor would refuse anything else anyway.

const PAGE = 1000;

/** Every row of a table, a page at a time (under any row cap), or null when the table is not there. */
async function readAll(data: Executor, table: string, order: string): Promise<Row[] | null> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let page: Row[];
    try {
      page = await data.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`, []);
    } catch (e) {
      if (offset === 0) return null;
      throw e;
    }
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// The store writes timestamps as UTC text without a zone; so does this.
const stamp = (v: unknown) => (toDate(v) ?? new Date()).toISOString().replace("T", " ").replace("Z", "");
const bool = (v: unknown) => v === true || v === 1 || v === "true" || v === "t";
// A table from before spaces has no space column: all of its boards were in the one space there was.
const inDefaultSpace = (r: Row) => r.space === undefined || r.space === null || r.space === "";

export type Imported = { boards: number; versions: number; skipped: string[] };

/**
 * Copies this pack's boards, and their version history, from the data database into `store`,
 * when the store has none of this pack's boards yet. With a SQL store's writer the rows are copied
 * exactly (versions, sources, summaries, times, owners); a memory store gets them replayed through
 * its own API. Returns null when there was nothing to copy.
 */
export async function importLegacyBoards(data: Executor, target: { store: BoardStore; writer?: Writer }, pack: { pack: string; version: number }): Promise<Imported | null> {
  const { store, writer } = target;
  if ((await store.list()).some((b) => b.pack === pack.pack)) return null;
  const boards = (await readAll(data, "lenspack_boards", "id"))?.filter((r) => inDefaultSpace(r) && String(r.pack) === pack.pack);
  if (!boards?.length) return null;
  const versions = (await readAll(data, "lenspack_board_versions", "board_id, version")) ?? [];

  const taken = new Set((await store.list()).map((b) => b.id));
  const result: Imported = { boards: 0, versions: 0, skipped: [] };

  const copyBoard = async (b: Row, id: string, history: Row[]) => {
    if (writer) {
      for (const v of history)
        await writer.exec(
          `INSERT INTO lenspack_board_versions (space, board_id, version, source, summary, config, created_at) VALUES ($1, $2, $3, $4, $5, $6, CAST($7 AS TIMESTAMP))`,
          ["", id, Number(v.version), String(v.source), String(v.summary), String(v.config), stamp(v.created_at)],
        );
      const owner = b.owner == null ? null : String(b.owner);
      await writer.exec(
        `INSERT INTO lenspack_boards (space, id, pack, title, owner, tenant, shared, version, config, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CAST($10 AS TIMESTAMP))`,
        ["", id, pack.pack, String(b.title), owner, owner && b.tenant != null ? String(b.tenant) : null, bool(b.shared), Number(b.version), String(b.config), stamp(b.updated_at)],
      );
      return;
    }
    // Replayed: the same configs in the same order, so the version numbers match; the times are now.
    const configs = history.length ? history : [b];
    const first = boardConfigSchema.parse(safeJson(configs[0]!.config));
    await store.create({ id, pack, title: first.title, config: first, ...(b.owner == null ? {} : { owner: String(b.owner), ...(b.tenant == null ? {} : { tenant: String(b.tenant) }) }) });
    for (const v of configs.slice(1)) await store.replaceConfig({ id, config: boardConfigSchema.parse(safeJson(v.config)), source: String(v.source), summary: String(v.summary) });
    if (b.owner != null && bool(b.shared)) await store.share(id, true);
  };

  // All or nothing: a copy that fails half way is undone, so the next start tries again from the beginning.
  const copied: string[] = [];
  try {
    for (const b of boards) {
      const id = String(b.id);
      const history = versions.filter((v) => inDefaultSpace(v) && String(v.board_id) === id).sort((x, y) => Number(x.version) - Number(y.version));
      // A board whose config this lenspack cannot read, or whose id another pack's board holds in a shared store, stays where it is.
      if (taken.has(id) || ![b, ...history].every((r) => boardConfigSchema.safeParse(safeJson(r.config)).success)) {
        result.skipped.push(id);
        continue;
      }
      copied.push(id);
      await copyBoard(b, id, history);
      result.boards++;
      result.versions += history.length;
    }
  } catch (e) {
    for (const id of copied) await store.delete(id).catch(() => undefined);
    throw new Error(`Could not copy the boards from the data database (nothing was copied; the data is unchanged): ${(e as Error).message}`);
  }
  return result.boards || result.skipped.length ? result : null;
}

function safeJson(v: unknown): unknown {
  try {
    return JSON.parse(String(v));
  } catch {
    return undefined;
  }
}
