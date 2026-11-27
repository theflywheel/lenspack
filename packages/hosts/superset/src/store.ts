import { existsSync, readFileSync, renameSync } from "node:fs";

import type { Board, BoardConfig, BoardOp, BoardStore, BoardTab, BoardView } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { type DashboardState, MOVE_REFUSAL, type PlacementHint, dashboardToBoard, pushBoard, readDashboard } from "./dashboard";
import { type Position, hasTabs, nestedLayout, tabsOf } from "./layout";
import { diskProblem, writeWhole } from "@lenspack/serve";

// Superset stays the record. A board bound to a dashboard is read from
// Superset when Superset has changed (someone edited it there), and every
// change lenspack makes — the model's ops, a drag, a restore — is sent to
// Superset before it counts. A change Superset refuses is undone here too,
// so the two never disagree. Lenspack's own version history is the undo
// Superset does not have.

export type SupersetBoardsOptions = {
  inner: BoardStore;
  client: SupersetClient;
  pack: Pack;
  binding: Binding;
  /** Board id → dashboard id. */
  dashboards: Record<string, number>;
  /** Where widget ↔ chart ids are kept between restarts. */
  stateFile: string;
  /** The Superset user ids a board's new charts belong to: its owner's, on a person's own dashboard. Else Lenspack's account. */
  ownersOf?: (boardId: string) => number[] | undefined | Promise<number[] | undefined>;
  /**
   * The tabs nobody changes through Lenspack on a board (policy's protectedTabIds), given the board before a write:
   * checked against Superset's own layout as the last step before saving. The store is given the list; it doesn't decide.
   */
  protectedTabs?: (boardId: string, before: BoardConfig) => readonly string[] | Promise<readonly string[]>;
  /** How often a read checks Superset for edits made there. Default 3s. */
  checkEveryMs?: number;
  log?: (line: string) => void;
};

export type SupersetBoards = BoardStore & {
  pull(id: string, force?: boolean): Promise<void>;
  seed(): Promise<void>;
  notes: Map<string, string[]>;
  /** The board's widgets that stand for Superset charts Lenspack can't redraw. */
  lockedOf(id: string): string[];
  /** The charts Lenspack made on the board's dashboard. */
  createdOf(id: string): number[];
  /**
   * Replaces a board's config with one made from the board as it is at the moment of writing: after Superset's
   * latest is read, in the same turn as the write, so nothing changed in Superset in between is written back.
   * `make` gets that board and its widgets that stand for Superset's charts.
   */
  replaceFrom<T extends { config: BoardConfig }>(id: string, make: (board: Board, locked: string[]) => T, how: { source: string; summary: string; check?: (before: BoardConfig, after: BoardConfig) => Promise<string | null> }): Promise<{ board: Board; made: T }>;
  /** Drops a board whose dashboard is gone (deleted): its links and its versions here. */
  forget(id: string): Promise<void>;
  /**
   * A new pack and binding (an admin changed the pack while the server runs): every bound board is read again from
   * Superset under them, so a chart that now matches a measure, or no longer does, reads that way.
   */
  setPack(pack: Pack, binding: Binding): Promise<void>;
};

export function supersetBoards(opts: SupersetBoardsOptions): SupersetBoards {
  const { inner, client } = opts;
  // Replaced whole by setPack; each read and write takes the pair in force when it runs.
  let { pack, binding } = opts;
  const log = opts.log ?? (() => {});
  const { states, save } = savedStates(opts.stateFile, log);
  const lastCheck = new Map<string, number>();
  const notes = new Map<string, string[]>();
  // One change at a time per board: a pull never lands in the middle of a push.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, f: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(f);
    queues.set(id, next);
    return next;
  };
  const bound = (id: string) => opts.dashboards[id] !== undefined;
  // Each board's layout as last read from or written to Superset: its tabs, and whether a move can be written.
  const positions = new Map<string, Position>();
  // Where an edit asked for a new widget, kept from the edit (admit) to its save, which may come later (a staged turn).
  const hints = new Map<string, Map<string, PlacementHint & { at: number }>>();
  const HINT_MS = 30 * 60_000;
  const hintsFor = (id: string) => {
    const now = Date.now();
    const all = hints.get(id) ?? new Map();
    for (const [w, h] of all) if (now - h.at > HINT_MS) all.delete(w);
    hints.set(id, all);
    return all;
  };

  async function pullNow(id: string, force: boolean) {
    const dashId = opts.dashboards[id]!;
    const head = await client.get<{ result: { changed_on: string } }>(`/api/v1/dashboard/${dashId}`);
    const prior = states[id];
    if (!force && prior?.changedOn === head.result.changed_on && (await inner.get(id))) return;
    const read = await readDashboard(client, dashId);
    positions.set(id, read.position);
    const { config, state, notes: n } = dashboardToBoard(read, pack, binding, prior ?? { dashboardId: dashId, charts: {}, created: [], locked: [], markdown: {} });
    states[id] = state;
    notes.set(id, n);
    save();
    const current = await inner.get(id);
    if (!current) {
      await inner.create({ id, pack, title: config.title, config });
      log(`${id}: read dashboard ${dashId} (${Object.keys(config.widgets).length} widgets${n.length ? `, ${n.length} kept as Superset's` : ""})`);
    } else if (JSON.stringify({ ...current.config, packVersion: 0 }) !== JSON.stringify({ ...config, packVersion: 0 })) {
      await inner.replaceConfig({ id, config, source: "superset", summary: "changed in Superset" });
      log(`${id}: dashboard ${dashId} changed in Superset`);
    }
  }

  async function check(id: string) {
    if (!bound(id)) return;
    const now = Date.now();
    if (now - (lastCheck.get(id) ?? 0) < (opts.checkEveryMs ?? 3000)) return;
    lastCheck.set(id, now);
    await serial(id, () => pullNow(id, false)).catch((e) => log(`${id}: could not read Superset: ${e.message}`));
  }

  /** Runs a change here, sends it to Superset, and undoes it here if Superset refuses. */
  async function through<T extends { config: BoardConfig } | null>(id: string, change: () => Promise<T>, o: { moves?: "keep" } = {}): Promise<T> {
    if (!bound(id)) return change();
    return serial(id, async () => {
      await pullNow(id, false).catch(() => {});
      const before = (await inner.get(id))!;
      const result = await change();
      if (!result) return result;
      try {
        const waiting = hintsFor(id);
        const owners = await opts.ownersOf?.(id);
        states[id] = await pushBoard(client, before.config, result.config, pack, binding, states[id]!, { hints: Object.fromEntries(waiting), moves: o.moves, written: (p) => positions.set(id, p), log: (s) => log(`${id}: ${s}`), ...(owners ? { owners } : {}), ...(opts.protectedTabs ? { protectedTabs: (b: BoardConfig) => opts.protectedTabs!(id, b) } : {}) });
        for (const w of Object.keys(result.config.widgets)) if (!before.config.widgets[w]) waiting.delete(w);
        save();
        lastCheck.set(id, Date.now());
        return result;
      } catch (e) {
        await inner.replaceConfig({ id, config: before.config, source: "superset", summary: "undone: Superset refused the change" });
        throw e;
      }
    });
  }

  /** Refuses a move a layout with tabs or columns can't take yet; notes where each new widget was asked for. */
  async function admit(id: string, ops: BoardOp[], view?: BoardView): Promise<string | null> {
    if (!bound(id)) return null;
    if (!positions.has(id)) await serial(id, () => pullNow(id, true)).catch(() => {});
    const pos = positions.get(id);
    if (pos && nestedLayout(pos) && ops.some((op) => op.op === "move_widget")) return MOVE_REFUSAL;
    const waiting = hintsFor(id);
    for (const op of ops) if (op.op === "add_widget") waiting.set(op.id, { place: op.placement?.place ?? "bottom", ...(view?.tabs?.length ? { tabs: view.tabs } : {}), at: Date.now() });
    return null;
  }

  return {
    notes,
    lockedOf: (id) => [...(states[id]?.locked ?? [])],
    createdOf: (id) => [...(states[id]?.created ?? [])],
    async forget(id) {
      await serial(id, async () => {
        delete opts.dashboards[id];
        delete states[id];
        notes.delete(id);
        lastCheck.delete(id);
        positions.delete(id);
        save();
        await inner.delete(id);
      });
    },
    admit,
    async setPack(next, nextBinding) {
      pack = next;
      binding = nextBinding;
      for (const id of Object.keys(opts.dashboards)) await serial(id, () => pullNow(id, true)).catch((e) => log(`${id}: could not read Superset again under the new pack: ${e instanceof Error ? e.message : String(e)}`));
    },
    async tabs(id): Promise<BoardTab[]> {
      if (!bound(id)) return [];
      const pos = positions.get(id);
      const state = states[id];
      if (!pos || !state || !hasTabs(pos)) return [];
      const widgetOf = new Map<string, string>([...Object.entries(state.placements ?? {}), ...Object.entries(state.markdown)].map(([w, c]) => [c, w]));
      return tabsOf(pos).map((t) => ({ id: t.id, title: t.titles.join(" › "), widgets: t.components.map((c) => widgetOf.get(c)).filter((w): w is string => !!w) }));
    },
    async seed() {
      for (const id of Object.keys(opts.dashboards)) await serial(id, () => pullNow(id, true));
    },
    pull: (id, force = false) => serial(id, () => pullNow(id, force)),
    async get(id) {
      await check(id);
      return inner.get(id);
    },
    list: () => inner.list(),
    create: (input) => inner.create(input),
    async patch(input) {
      if (!bound(input.id)) return inner.patch(input);
      const cannot = await admit(input.id, input.ops, input.view);
      if (cannot) return { ok: false as const, error: cannot };
      try {
        let refused: Awaited<ReturnType<BoardStore["patch"]>> | null = null;
        const board = await through(input.id, async () => {
          const r = await inner.patch(input);
          if (!r.ok) {
            refused = r;
            return null;
          }
          return r.board;
        });
        return refused ?? { ok: true as const, board: board as Board };
      } catch (e) {
        return { ok: false as const, error: `Superset did not accept the change: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    replaceConfig: (input) => (input.source === "superset" ? inner.replaceConfig(input) : through(input.id, () => inner.replaceConfig(input))),
    async replaceFrom(id, make, how) {
      let made: ReturnType<typeof make> | undefined;
      const board = await through(id, async () => {
        const current = await inner.get(id);
        if (!current) throw new Error(`no board ${id}`);
        made = make(current, [...(states[id]?.locked ?? [])]);
        const refused = await how.check?.(current.config, made.config);
        if (refused) throw new Error(refused);
        return inner.replaceConfig({ id, config: made.config, source: how.source as never, summary: how.summary });
      });
      return { board: board as Board, made: made! };
    },
    versions: (id) => inner.versions(id),
    // A restore puts back what was removed and keeps charts where they are now: a layout with tabs can't take a move yet.
    revertTo: (id, version) => through(id, () => inner.revertTo(id, version), { moves: "keep" }),
    share: (id, shared) => inner.share(id, shared),
    async delete(id) {
      if (bound(id)) throw new Error("A Superset dashboard is deleted in Superset");
      return inner.delete(id);
    },
  };
}

/**
 * The widget-chart links kept between restarts, and their save. Saved whole or not at all; a disk that refuses
 * (full, read-only) doesn't fail the request: the links stay in memory, the log says so once, and the next save
 * that works catches up. A missing or unreadable file means starting from Superset's dashboards.
 */
export function savedStates(file: string, log: (line: string) => void): { states: Record<string, DashboardState>; save: () => boolean } {
  const states = loadStates(file, log);
  let unsaved: string | null = null;
  const save = () => {
    try {
      writeWhole(file, JSON.stringify(states, null, 2));
      if (unsaved) log(`saved ${file} again`);
      unsaved = null;
      return true;
    } catch (e) {
      const why = diskProblem(e);
      if (unsaved !== why) log(`could not save ${file} (${why}); widget-chart links are kept in memory until it can be saved`);
      unsaved = why;
      return false;
    }
  };
  return { states, save };
}

/** The saved links, or none when the file is missing or unreadable (an unreadable one is set aside, not lost). */
function loadStates(file: string, log: (line: string) => void): Record<string, DashboardState> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, DashboardState>;
    throw new Error("not a JSON object");
  } catch (e) {
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      /* read-only: leave it where it is */
    }
    log(`could not read ${file} (${e instanceof Error ? e.message : String(e)}); set aside as ${aside}, starting from Superset's dashboards`);
    return {};
  }
}
