// The answer store: one JSON file in the state directory (reuse.json, beside settings.json and the
// audit log), read at start and written whole (a temporary file renamed into place) a moment after
// each change, so it survives restarts and a crash never leaves half a file. It is bounded: past
// maxEntries, the least recently used entry that is not pinned goes first.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeWhole } from "../settings";
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

export type BoardInfo = { edits: number[]; widgets: string[] };

export type Stats = { since: string; turns: number; hits: TierCounts; misses: number; savedUsd: number };

type File = { version: 1; stats: Stats; entries: Entry[]; avg: Record<string, { n: number; usd: number }>; boards: Record<string, BoardInfo> };

// Stores with a write still waiting are written on the way out (SIGTERM exits through process.exit).
const pending = new Set<() => unknown>();
process.once("exit", () => {
  for (const f of pending) f();
});

export const emptyTiers = (): TierCounts => ({ t1: 0, t2: 0, t3: 0, t4: 0 });

export type ReuseStore = ReturnType<typeof reuseStore>;

export function reuseStore(path: string, o: { maxEntries: () => number; now?: () => Date; log?: (s: string) => void }) {
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

  /** Least recently used first, pinned never: down to the limit. */
  const trim = () => {
    const max = Math.max(1, o.maxEntries());
    if (byId.size <= max) return;
    const unpinned = [...byId.values()].filter((e) => !e.pinned).sort((a, b) => (a.lastHit ?? a.createdAt).localeCompare(b.lastHit ?? b.createdAt));
    for (const e of unpinned.slice(0, byId.size - max)) byId.delete(e.id);
  };

  return {
    path,
    flush,
    stats: () => file.stats,
    entries: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    put(e: Entry) {
      byId.set(e.id, e);
      trim();
      save();
    },
    touch: save,
    delete(id: string) {
      const had = byId.delete(id);
      if (had) save();
      return had;
    },
    /** A turn the full agent answered (miss) or the store served (tier, with what it saved). */
    count(t: { tier?: Tier; savedUsd?: number }) {
      file.stats.turns++;
      if (t.tier) file.stats.hits[t.tier]++;
      else file.stats.misses++;
      file.stats.savedUsd = Math.round((file.stats.savedUsd + (t.savedUsd ?? 0)) * 1e6) / 1e6;
      save();
    },
    /** A full turn's cost on a model, for the running average a saved answer is said to save. */
    turnCost(model: string, usd: number) {
      const a = (file.avg[model] ??= { n: 0, usd: 0 });
      a.usd = (a.usd * a.n + usd) / (a.n + 1);
      a.n = Math.min(a.n + 1, 500);
      save();
    },
    averageTurn: (model: string): number | null => file.avg[model]?.usd ?? null,
    board(id: string): BoardInfo {
      return (file.boards[id] ??= { edits: [], widgets: [] });
    },
    boards: () => file.boards,
  };
}
