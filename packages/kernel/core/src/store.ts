import type { Catalogue } from "./catalogue";
import { describeChanges } from "./changes";
import { type ApplyResult, type BoardOp, applyOps } from "./ops";
import { type BoardConfig, emptyBoard } from "./schema";

// Every edit is a new immutable version, and a rollback appends rather than
// rewinds, so a rollback can itself be undone. Auth and tenancy around the
// store are the host application's concern; a store never reads a session.
// It keeps who made a board and who it is shared with; the host decides what
// that lets a caller see and change.

/**
 * Who a board belongs to. No owner: the pack's own board, from its board
 * files. A board made under a tenant stays that tenant's, shared or not.
 * `everyone` shares it with everyone in that tenant, `people` with the users
 * named; `shared` says it is shared with anyone at all.
 */
export type Ownership = { owner?: string; tenant?: string; shared?: boolean; everyone?: boolean; people?: string[] };
/** Who an owned board is shared with: everyone in its tenant, or the users named, or both; neither is its owner only. */
export type Sharing = { everyone: boolean; people: string[] };
export const NOT_SHARED: Sharing = { everyone: false, people: [] };

/** The ownership fields of a board: none for the pack's own boards. */
export function ownershipOf(owner?: string | null, tenant?: string | null, to: Sharing = NOT_SHARED): Ownership {
  if (!owner) return {};
  return { owner, ...(tenant ? { tenant } : {}), shared: to.everyone || to.people.length > 0, everyone: to.everyone, people: [...to.people] };
}
export type Board = { id: string; pack: string; config: BoardConfig; version: number; updatedAt: Date } & Ownership;
export type BoardSummary = { id: string; pack: string; title: string; version: number; updatedAt: Date } & Ownership;
export type BoardVersion = { version: number; source: string; summary: string; createdAt: Date; config: BoardConfig };

export type PatchResult =
  | { ok: true; board: Board }
  | { ok: false; error: string; hint?: string; opIndex?: number };

export interface BoardStore {
  get(id: string): Promise<Board | null>;
  list(): Promise<BoardSummary[]>;
  create(input: { id?: string; pack: { pack: string; version: number }; title: string; config?: BoardConfig; owner?: string; tenant?: string }): Promise<Board>;
  patch(input: { id: string; ops: BoardOp[]; catalogue: Catalogue; source?: string; expectedVersion?: number }): Promise<PatchResult>;
  replaceConfig(input: { id: string; config: BoardConfig; source?: string; summary?: string }): Promise<Board>;
  versions(id: string): Promise<BoardVersion[]>;
  revertTo(id: string, version: number): Promise<Board | null>;
  /** Says who an owned board is shown to besides its owner, replacing what it said before. Not a version: the board itself is unchanged. */
  share(id: string, to: Sharing): Promise<Board | null>;
  delete(id: string): Promise<void>;
  /** Notes that a user name has used this store's boards under a tenant: a name to offer when sharing. Names only, nothing else about them. */
  noteUser(user: string, tenant?: string): Promise<void>;
  /** The user names noted under a tenant, as they signed in. */
  users(tenant?: string): Promise<string[]>;
}

/** The ops in a few words, for a version's summary. `board`, the board before them, names a removed filter by its label. */
export function describeOps(ops: BoardOp[], board?: BoardConfig) {
  return ops
    .map((op) => {
      switch (op.op) {
        case "add_widget": return `added ${op.id}`;
        case "update_widget": return `changed ${op.id}`;
        case "remove_widget": return `removed ${op.id}`;
        case "move_widget": return `moved ${op.id}`;
        case "resize_widget": return `resized ${op.id}`;
        case "set_title": return `renamed to “${op.title}”`;
        case "add_filter": return `added filter ${op.filter.label || op.filter.field}`;
        case "update_filter": return `changed filter ${op.filter.label || op.filter.field}`;
        case "remove_filter": {
          const gone = board?.filters.find((f) => f.id === op.id);
          return `removed filter ${gone?.label || gone?.field || op.id}`;
        }
        case "set_layout_mode": return [op.density ? `density ${op.density}` : "", op.fill === undefined ? "" : op.fill ? "packed" : "unpacked"].filter(Boolean).join(", ") || "layout mode";
      }
    })
    .join(", ");
}

/** The reference store: correct, in-process, and gone when the process is. */
export function memoryStore(): BoardStore {
  const boards = new Map<string, Board>();
  const history = new Map<string, BoardVersion[]>();
  const seen = new Map<string, Set<string>>();
  let counter = 0;

  const record = (id: string, config: BoardConfig, source: string, summary: string, ownership: Ownership = {}) => {
    const list = history.get(id) ?? [];
    const version = list.length + 1;
    list.push({ version, source, summary, createdAt: new Date(), config: structuredClone(config) });
    history.set(id, list);
    const { owner, tenant, everyone, people } = boards.get(id) ?? ownership;
    const board: Board = { id, pack: config.pack, config: structuredClone(config), version, updatedAt: new Date(), ...ownershipOf(owner, tenant, { everyone: !!everyone, people: people ?? [] }) };
    boards.set(id, board);
    return board;
  };

  return {
    async get(id) {
      const b = boards.get(id);
      return b ? { ...b, config: structuredClone(b.config) } : null;
    },
    async list() {
      return [...boards.values()].map((b) => ({ id: b.id, pack: b.pack, title: b.config.title, version: b.version, updatedAt: b.updatedAt, ...ownershipOf(b.owner, b.tenant, { everyone: !!b.everyone, people: b.people ?? [] }) }));
    },
    async create({ id, pack, title, config, owner, tenant }) {
      const boardId = id ?? `b${++counter}`;
      if (boards.has(boardId)) throw new Error(`Board "${boardId}" already exists`);
      return record(boardId, config ?? emptyBoard(pack, title), "create", "created", ownershipOf(owner, tenant));
    },
    async patch({ id, ops, catalogue, source = "ops", expectedVersion }) {
      const current = boards.get(id);
      if (!current) return { ok: false, error: `No board called "${id}"` };
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        return { ok: false, error: `Board changed since version ${expectedVersion}; it is now v${current.version}` };
      const result: ApplyResult = applyOps(current.config, ops, catalogue);
      if (!result.ok) return { ok: false, error: result.error, hint: result.hint, opIndex: result.opIndex };
      return { ok: true, board: record(id, result.config, source, describeOps(ops, current.config)) };
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
      // Restoring what is already there records nothing.
      const current = boards.get(id);
      if (current && JSON.stringify(current.config) === JSON.stringify(target.config)) return current;
      return record(id, target.config, "revert", `restored v${version}`);
    },
    async share(id, to) {
      const b = boards.get(id);
      if (!b?.owner) return null;
      Object.assign(b, ownershipOf(b.owner, b.tenant, to));
      return { ...b, config: structuredClone(b.config) };
    },
    async noteUser(user, tenant) {
      seen.set(tenant ?? "", (seen.get(tenant ?? "") ?? new Set()).add(user));
    },
    async users(tenant) {
      return [...(seen.get(tenant ?? "") ?? [])];
    },
    async delete(id) {
      boards.delete(id);
      history.delete(id);
    },
  };
}

/** A store whose edits to one board wait for commit(). */
export type StagedStore = BoardStore & {
  /**
   * Saves the held edits to the store underneath, all of them or none. In order, one version
   * each; `asOne` saves only where they ended up, as a single version, so an edit that was later
   * corrected never reaches the store. When the board changed underneath meanwhile, the edits
   * are applied again on top of that change and saved as one version, or, when one of them no
   * longer applies, nothing is saved and commit throws, saying which. Returns the versions it
   * saved, numbered as the store underneath numbered them (none when nothing was held).
   */
  commit(opts?: { asOne?: boolean }): Promise<SavedVersion[]>;
  /** Drops the held edits, the board staying as the store underneath has it; returns the version numbers they had held. */
  discard(): number[];
};

/** A version a commit saved: its number in the store underneath, and what it changed. */
export type SavedVersion = { version: number; summary: string };

/**
 * Holds edits to one board back from the store underneath until commit().
 * Reads of that board see the held edits, numbered as the versions they will
 * become; nothing reaches the store underneath (or a dashboard it writes to)
 * before commit(), and discard() leaves it untouched. Other boards pass
 * straight through. A chat turn edits through one so that a change found
 * wrong before the turn ends is never saved.
 */
export function stagedStore(inner: BoardStore, boardId: string): StagedStore {
  type Write = { ops: BoardOp[]; catalogue: Catalogue; source: string } | { config: BoardConfig; source: string; summary: string };
  let held: { version: BoardVersion; write: Write }[] = [];
  // The board as it was when the first edit was held.
  let base: Board | null = null;

  const current = async (): Promise<Board | null> => {
    const last = held.at(-1)?.version;
    if (!last || !base) return inner.get(boardId);
    return { ...base, config: structuredClone(last.config), version: last.version, updatedAt: last.createdAt };
  };
  const hold = (board: Board, config: BoardConfig, source: string, summary: string, write: Write): Board => {
    if (!held.length) base = board;
    const version: BoardVersion = { version: board.version + 1, source, summary, createdAt: new Date(), config: structuredClone(config) };
    held.push({ version, write });
    return { ...board, config: structuredClone(config), version: version.version, updatedAt: version.createdAt };
  };
  const versions = async (id: string) => {
    const saved = await inner.versions(id);
    return id === boardId ? [...held.map((h) => ({ ...h.version, config: structuredClone(h.version.config) })).reverse(), ...saved] : saved;
  };

  return {
    get: (id) => (id === boardId ? current() : inner.get(id)),
    list: () => inner.list(),
    create: (input) => inner.create(input),
    share: (id, to) => inner.share(id, to),
    delete: (id) => inner.delete(id),
    noteUser: (user, tenant) => inner.noteUser(user, tenant),
    users: (tenant) => inner.users(tenant),
    versions,
    async patch(input) {
      if (input.id !== boardId) return inner.patch(input);
      const board = await current();
      if (!board) return { ok: false, error: `No board called "${input.id}"` };
      if (input.expectedVersion !== undefined && board.version !== input.expectedVersion)
        return { ok: false, error: `Board changed since version ${input.expectedVersion}; it is now v${board.version}` };
      const result = applyOps(board.config, input.ops, input.catalogue);
      if (!result.ok) return { ok: false, error: result.error, hint: result.hint, opIndex: result.opIndex };
      const source = input.source ?? "ops";
      return { ok: true, board: hold(board, result.config, source, describeOps(input.ops, board.config), { ops: input.ops, catalogue: input.catalogue, source }) };
    },
    async replaceConfig(input) {
      if (input.id !== boardId) return inner.replaceConfig(input);
      const board = await current();
      if (!board) throw new Error(`No board called "${input.id}"`);
      const { config, source = "layout", summary = "layout changed" } = input;
      return hold(board, config, source, summary, { config, source, summary });
    },
    async revertTo(id, version) {
      if (id !== boardId) return inner.revertTo(id, version);
      const board = await current();
      const target = (await versions(id)).find((v) => v.version === version);
      if (!board || !target) return null;
      // Restoring what is already there records nothing.
      if (JSON.stringify(board.config) === JSON.stringify(target.config)) return board;
      const summary = `restored v${version}`;
      return hold(board, target.config, "revert", summary, { config: target.config, source: "revert", summary });
    },
    async commit(opts = {}) {
      const writes = held.map((h) => h.write);
      const summaries = held.map((h) => h.version.summary);
      const last = held.at(-1)?.version;
      const from = base;
      held = [];
      base = null;
      if (!last || !from) return [];
      const now = await inner.get(boardId);
      if (!now) throw new Error(`No board called "${boardId}"`);
      const saveOne = async (before: BoardConfig, config: BoardConfig) => {
        const summary = describeChanges(before, config).join(", ") || last.summary;
        const board = await inner.replaceConfig({ id: boardId, config, source: last.source, summary });
        return [{ version: board.version, summary }];
      };
      if (now.version !== from.version) {
        // Changed meanwhile (by hand, or in the host). The ops are applied again rather than their
        // result copied, so that change is kept, all of them before anything is saved: a turn
        // whose later edit no longer fits is saved not at all rather than in part.
        let config = now.config;
        for (const w of writes) {
          if (!("ops" in w)) config = w.config;
          else {
            const r = applyOps(config, w.ops, w.catalogue);
            if (!r.ok) throw new Error(`the board was changed meanwhile, and "${describeOps(w.ops, config)}" no longer fits it (${r.error}). Nothing was saved`);
            config = r.config;
          }
        }
        return saveOne(now.config, config);
      }
      if (opts.asOne) return saveOne(from.config, last.config);
      const saved: SavedVersion[] = [];
      try {
        for (const [i, w] of writes.entries()) {
          let board: Board;
          if ("ops" in w) {
            const r = await inner.patch({ id: boardId, ...w });
            if (!r.ok) throw new Error(r.error);
            board = r.board;
          } else board = await inner.replaceConfig({ id: boardId, ...w });
          saved.push({ version: board.version, summary: summaries[i]! });
        }
      } catch (e) {
        // The store underneath refused a later edit (a host that would not take it): the board goes
        // back to where it was, so the turn is not left saved in part.
        if (saved.length) await inner.revertTo(boardId, from.version);
        throw e;
      }
      return saved;
    },
    discard() {
      const dropped = held.map((h) => h.version.version);
      held = [];
      base = null;
      return dropped;
    },
  };
}
