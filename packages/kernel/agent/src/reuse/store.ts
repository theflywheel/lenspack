// The answer store. AnswerStore is the interface the reuse layer uses; it is asynchronous so that a
// shared backend (a Postgres table, for a host running more than one copy) can implement it as it
// stands. fileAnswerStore is the one there is today: one JSON file in the state directory
// (reuse.json, beside settings.json and the audit log), read at start and written whole (a
// temporary file renamed into place) a moment after each change, so it survives restarts and a
// crash never leaves half a file. It is bounded: past maxEntries, the least recently used entry
// that is not pinned goes first.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Ctx } from "@lenspack/engine";

import type { Call, Slot } from "./slots";

export type Tier = "t1" | "t2" | "t3" | "t4";
export type TierCounts = Record<Tier, number>;

export type Entry = {
  id: string;
  kind: "answer" | "edit";
  pack: string;
  /** The board it was asked on. An edit replays on any board whose content is the same (boardBefore). */
  board: string;
  /** Who may be served it: a hash of the asker's effective access (tenant, row scope, hidden keys and datasets). */
  scope: string;
  /** That access itself, so a scheduled refresh runs the plan under it and nothing wider. */
  access?: Access;
  /** What else must be the same: the pack, its definitions, the prompt version, the board's filters, the language rules. */
  version: string;
  lang: string;
  /** The language the reply was asked in ("auto" or a pick). */
  replyLang: string;
  question: string;
  norm: string;
  /** Other wordings that were served this entry. */
  variants: string[];
  pattern?: string;
  slots?: Slot[];
  /** The calls that answered: data calls with their results, or the edits. */
  plan: Call[];
  reply: string;
  /** When the results in the plan were read from the source. */
  dataAsOf: string;
  /** Edits: the board's content (hash) the plan was accepted on. */
  boardBefore?: string;
  /** What the turn that made it cost, and on which model. */
  costUsd: number;
  model: string;
  createdAt: string;
  lastHit: string | null;
  hits: number;
  /** When it was asked (made or served), newest last, at most 60: how often, for suggestions and chart candidates. */
  asked: number[];
  tierCounts: TierCounts;
  pinned: boolean;
};

export type Access = { tenant?: string; scope?: unknown[]; hidden?: string[]; hiddenEntities?: string[] };

/** The access an engine context grants, as data: kept with an entry so a refresh runs under exactly it. */
export const accessOf = (ctx: Ctx): Access => ({ ...(ctx.tenant ? { tenant: ctx.tenant } : {}), ...(ctx.scope?.length ? { scope: ctx.scope } : {}), ...(ctx.hidden?.size ? { hidden: [...ctx.hidden].sort() } : {}), ...(ctx.hiddenEntities?.size ? { hiddenEntities: [...ctx.hiddenEntities].sort() } : {}) });
/** An engine context from kept access, at the host's "now". */
export const ctxOf = (a: Access, now?: Date): Ctx => ({ ...(a.tenant ? { tenant: a.tenant } : {}), ...(now ? { now } : {}), ...(a.scope ? { scope: a.scope as Ctx["scope"] } : {}), ...(a.hidden ? { hidden: new Set(a.hidden) } : {}), ...(a.hiddenEntities ? { hiddenEntities: new Set(a.hiddenEntities) } : {}) });

export type BoardInfo = { edits: number[]; widgets: string[] };

export type Stats = { since: string; turns: number; hits: TierCounts; misses: number; savedUsd: number };

type File = { version: 1; stats: Stats; entries: Entry[]; avg: Record<string, { n: number; usd: number }>; boards: Record<string, BoardInfo> };

export const emptyTiers = (): TierCounts => ({ t1: 0, t2: 0, t3: 0, t4: 0 });

/** Where saved answers live. Every method may be a round trip to a shared database. */
export interface AnswerStore {
  entries(): Promise<Entry[]>;
  get(id: string): Promise<Entry | undefined>;
  /** Adds or replaces an entry (by id); past the limit, the least recently used unpinned one goes. */
  put(e: Entry): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** A turn counted: served at a tier (with what it saved), or answered by the full assistant. */
  count(c: { tier?: Tier; savedUsd?: number }): Promise<void>;
  /** A full turn's cost on a model, for the running average a saved answer is said to save. */
  turnCost(model: string, usd: number): Promise<void>;
  averageTurn(model: string): Promise<number | null>;
  board(id: string): Promise<BoardInfo>;
  setBoard(id: string, info: BoardInfo): Promise<void>;
  boards(): Promise<Record<string, BoardInfo>>;
  stats(): Promise<Stats>;
  /** Writes anything still waiting. */
  flush(): Promise<void>;
}

// Stores with a write still waiting are written on the way out (SIGTERM exits through process.exit).
// Registered with the first store, so importing this module has no side effect.
const pending = new Set<() => unknown>();
let exitHook = false;

function writeWhole(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const copy = <T>(v: T): T => structuredClone(v);

/** The answer store in one JSON file. Entries are handed out as copies: a change is kept only through put(). */
export function fileAnswerStore(path: string, o: { maxEntries: () => number; now?: () => Date; log?: (s: string) => void }): AnswerStore {
  const now = o.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true });
  let file: File = { version: 1, stats: { since: now().toISOString(), turns: 0, hits: emptyTiers(), misses: 0, savedUsd: 0 }, entries: [], avg: {}, boards: {} };
  if (existsSync(path)) {
    try {
      const read = JSON.parse(readFileSync(path, "utf8")) as File;
      if (read?.version === 1 && Array.isArray(read.entries)) file = { ...file, ...read };
    } catch (e) {
      o.log?.(`answer store ${path} could not be read (${e instanceof Error ? e.message : String(e)}); starting empty`);
    }
  }
  const byId = new Map(file.entries.map((e) => [e.id, e]));
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      writeWhole(path, JSON.stringify({ ...file, entries: [...byId.values()] }));
    } catch (e) {
      o.log?.(`answer store ${path} could not be saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const save = () => {
    if (timer) return;
    timer = setTimeout(flush, 1000);
    timer.unref?.();
  };
  pending.add(() => timer && flush());
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const f of pending) f();
    });
  }

  /** Least recently used first, pinned never: down to the limit. */
  const trim = () => {
    const max = Math.max(1, o.maxEntries());
    if (byId.size <= max) return;
    const unpinned = [...byId.values()].filter((e) => !e.pinned).sort((a, b) => (a.lastHit ?? a.createdAt).localeCompare(b.lastHit ?? b.createdAt));
    for (const e of unpinned.slice(0, byId.size - max)) byId.delete(e.id);
  };

  return {
    flush: async () => flush(),
    stats: async () => copy(file.stats),
    entries: async () => [...byId.values()].map(copy),
    get: async (id) => {
      const e = byId.get(id);
      return e && copy(e);
    },
    async put(e) {
      byId.set(e.id, copy(e));
      trim();
      save();
    },
    async delete(id) {
      const had = byId.delete(id);
      if (had) save();
      return had;
    },
    async count(t) {
      file.stats.turns++;
      if (t.tier) file.stats.hits[t.tier]++;
      else file.stats.misses++;
      file.stats.savedUsd = Math.round((file.stats.savedUsd + (t.savedUsd ?? 0)) * 1e6) / 1e6;
      save();
    },
    async turnCost(model, usd) {
      const a = (file.avg[model] ??= { n: 0, usd: 0 });
      a.usd = (a.usd * a.n + usd) / (a.n + 1);
      a.n = Math.min(a.n + 1, 500);
      save();
    },
    averageTurn: async (model) => file.avg[model]?.usd ?? null,
    board: async (id) => copy(file.boards[id] ?? { edits: [], widgets: [] }),
    async setBoard(id, info) {
      file.boards[id] = copy(info);
      save();
    },
    boards: async () => copy(file.boards),
  };
}
