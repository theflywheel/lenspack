import type { Catalogue } from "./catalogue";
import { type ApplyResult, type BoardOp, applyOps } from "./ops";
import { type BoardConfig, emptyBoard } from "./schema";

// Every edit is a new immutable version, and a rollback appends rather than
// rewinds, so a rollback can itself be undone. Auth and tenancy around the
// store are the host application's concern; a store never reads a session.

export type Board = { id: string; pack: string; config: BoardConfig; version: number; updatedAt: Date };
export type BoardSummary = { id: string; pack: string; title: string; version: number; updatedAt: Date };
export type BoardVersion = { version: number; source: string; summary: string; createdAt: Date; config: BoardConfig };

export type PatchResult =
  | { ok: true; board: Board }
  | { ok: false; error: string; hint?: string; opIndex?: number };

export interface BoardStore {
  get(id: string): Promise<Board | null>;
  list(): Promise<BoardSummary[]>;
  create(input: { id?: string; pack: { pack: string; version: number }; title: string; config?: BoardConfig }): Promise<Board>;
  patch(input: { id: string; ops: BoardOp[]; catalogue: Catalogue; source?: string; expectedVersion?: number }): Promise<PatchResult>;
  replaceConfig(input: { id: string; config: BoardConfig; source?: string; summary?: string }): Promise<Board>;
  versions(id: string): Promise<BoardVersion[]>;
  revertTo(id: string, version: number): Promise<Board | null>;
  delete(id: string): Promise<void>;
}

export function describeOps(ops: BoardOp[]) {
  return ops
    .map((op) => {
      switch (op.op) {
        case "add_widget": return `added ${op.id}`;
        case "update_widget": return `changed ${op.id}`;
        case "remove_widget": return `removed ${op.id}`;
        case "move_widget": return `moved ${op.id}`;
        case "resize_widget": return `resized ${op.id}`;
        case "set_title": return `renamed to “${op.title}”`;
        case "add_filter": return `added filter ${op.filter.field}`;
        case "remove_filter": return `removed filter ${op.id}`;
        case "set_layout_mode": return [op.density ? `density ${op.density}` : "", op.fill === undefined ? "" : op.fill ? "packed" : "unpacked"].filter(Boolean).join(", ") || "layout mode";
      }
    })
    .join(", ");
}

/** The reference store: correct, in-process, and gone when the process is. */
export function memoryStore(): BoardStore {
  const boards = new Map<string, Board>();
  const history = new Map<string, BoardVersion[]>();
  let counter = 0;

  const record = (id: string, config: BoardConfig, source: string, summary: string) => {
    const list = history.get(id) ?? [];
    const version = list.length + 1;
    list.push({ version, source, summary, createdAt: new Date(), config: structuredClone(config) });
    history.set(id, list);
    const board: Board = { id, pack: config.pack, config: structuredClone(config), version, updatedAt: new Date() };
    boards.set(id, board);
    return board;
  };

  return {
    async get(id) {
      const b = boards.get(id);
      return b ? { ...b, config: structuredClone(b.config) } : null;
    },
    async list() {
      return [...boards.values()].map((b) => ({ id: b.id, pack: b.pack, title: b.config.title, version: b.version, updatedAt: b.updatedAt }));
    },
    async create({ id, pack, title, config }) {
      const boardId = id ?? `b${++counter}`;
      if (boards.has(boardId)) throw new Error(`Board "${boardId}" already exists`);
      return record(boardId, config ?? emptyBoard(pack, title), "create", "created");
    },
    async patch({ id, ops, catalogue, source = "ops", expectedVersion }) {
      const current = boards.get(id);
      if (!current) return { ok: false, error: `No board called "${id}"` };
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        return { ok: false, error: `Board changed since version ${expectedVersion}; it is now v${current.version}` };
      const result: ApplyResult = applyOps(current.config, ops, catalogue);
      if (!result.ok) return { ok: false, error: result.error, hint: result.hint, opIndex: result.opIndex };
      return { ok: true, board: record(id, result.config, source, describeOps(ops)) };
    },
    async replaceConfig({ id, config, source = "layout", summary = "layout changed" }) {
      if (!boards.has(id)) throw new Error(`No board called "${id}"`);
      return record(id, config, source, summary);
    },
    async versions(id) {
      return [...(history.get(id) ?? [])].reverse().map((v) => ({ ...v, config: structuredClone(v.config) }));
    },
    async revertTo(id, version) {
      const target = history.get(id)?.find((v) => v.version === version);
      if (!target) return null;
      return record(id, target.config, "revert", `restored v${version}`);
    },
    async delete(id) {
      boards.delete(id);
      history.delete(id);
    },
  };
}
