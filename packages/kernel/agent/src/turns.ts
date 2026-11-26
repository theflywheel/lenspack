import type { BoardConfig } from "@lenspack/core";

// What a chat turn did, kept for a short while under a key the client makes for each question. A reply can be cut
// off on its way to the browser (a phone changing networks, a proxy, a restart) after the turn has already changed
// the board. With this record the client finds out what happened instead of asking again, and asking again with the
// same key never repeats the turn: the server answers from the record (docs/features/dashboard-edits.md, "When the reply is cut off").

/** The widgets a turn added, removed or changed, by title as the asker is shown them; other: anything else changed (the title, a filter, the layout). */
export type WidgetChanges = { added: string[]; removed: string[]; changed: string[]; other: boolean };

export type TurnResult = {
  state: "running" | "done";
  /** The board's version when the turn started, and when it ended. */
  from: number;
  to?: number;
  changes?: WidgetChanges;
  /** The reply's words, when the turn ran to its end. */
  reply?: string;
  /** The turn ended without a reply worth showing (it failed part-way, or was turned away). */
  failed?: boolean;
};

/** Whose turn, on which board, under which client key. Another user, or another board, never sees the record. */
export type TurnScope = { user: string; board: string; key: string };

export interface TurnLog {
  /**
   * Starts a record. False when the turn was asked before and is still running, changed the board or answered: it is
   * not run again. A turn that failed without changing anything may be asked again, and starts afresh.
   */
  begin(scope: TurnScope, from: number): boolean;
  end(scope: TurnScope, outcome: Omit<TurnResult, "state">): void;
  get(scope: TurnScope): TurnResult | undefined;
  /** The record once it is done, waiting up to `ms` while the turn still runs. */
  settled(scope: TurnScope, ms: number): Promise<TurnResult | undefined>;
}

/** A key the client made: letters, digits, - and _, 8 to 64 of them. Anything else is no key. */
export function turnKeyOf(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/**
 * Kept in the process, for `ttlMs` (15 minutes by default) and at most `max` records: long enough for a person to
 * press Retry, short enough that nothing builds up. A restart forgets them, and the client then compares the
 * board's version instead (chat.js).
 */
export function memoryTurnLog(o: { ttlMs?: number; max?: number; now?: () => number } = {}): TurnLog {
  const ttl = o.ttlMs ?? 15 * 60_000;
  const max = o.max ?? 2000;
  const now = o.now ?? Date.now;
  const records = new Map<string, TurnResult & { at: number }>();
  const id = (s: TurnScope) => JSON.stringify([s.user, s.board, s.key]);
  const prune = () => {
    const old = now() - ttl;
    for (const [k, r] of records) if (r.at < old || records.size > max) records.delete(k);
  };
  const get = (s: TurnScope) => {
    const r = records.get(id(s));
    if (!r || r.at < now() - ttl) return undefined;
    const { at: _, ...out } = r;
    return out;
  };
  return {
    begin(s, from) {
      prune();
      const was = get(s);
      if (was && !(was.state === "done" && was.failed && !((was.to ?? was.from) > was.from))) return false;
      records.set(id(s), { state: "running", from, at: now() });
      return true;
    },
    end(s, outcome) {
      const r = records.get(id(s));
      if (!r) return;
      records.set(id(s), { ...r, ...outcome, state: "done", at: now() });
    },
    get,
    async settled(s, ms) {
      const until = Date.now() + ms;
      for (;;) {
        const r = get(s);
        if (!r || r.state === "done" || Date.now() >= until) return r;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
  };
}

/** What changed between two versions of a board, widget by widget. */
export function widgetChanges(before: BoardConfig, after: BoardConfig): WidgetChanges {
  const was = before.widgets;
  const now = after.widgets;
  const added = Object.keys(now).filter((k) => !was[k]).map((k) => now[k]!.title);
  const removed = Object.keys(was).filter((k) => !now[k]).map((k) => was[k]!.title);
  const changed = Object.keys(now).filter((k) => was[k] && JSON.stringify(was[k]) !== JSON.stringify(now[k])).map((k) => now[k]!.title);
  const other =
    before.title !== after.title ||
    JSON.stringify(before.filters) !== JSON.stringify(after.filters) ||
    (!added.length && !removed.length && JSON.stringify(before.layout) !== JSON.stringify(after.layout));
  return { added, removed, changed, other };
}
