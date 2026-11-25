import { existsSync, readFileSync, renameSync } from "node:fs";

import type { Board, BoardConfig, BoardStore } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { type DashboardState, dashboardToBoard, pushBoard, readDashboard } from "./dashboard";
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
  /** How often a read checks Superset for edits made there. Default 3s. */
  checkEveryMs?: number;
  log?: (line: string) => void;
};

export function supersetBoards(opts: SupersetBoardsOptions): BoardStore & { pull(id: string, force?: boolean): Promise<void>; seed(): Promise<void>; notes: Map<string, string[]> } {
  const { inner, client, pack, binding } = opts;
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

  async function pullNow(id: string, force: boolean) {
    const dashId = opts.dashboards[id]!;
    const head = await client.get<{ result: { changed_on: string } }>(`/api/v1/dashboard/${dashId}`);
    const prior = states[id];
    if (!force && prior?.changedOn === head.result.changed_on && (await inner.get(id))) return;
    const read = await readDashboard(client, dashId);
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
  async function through<T extends { config: BoardConfig } | null>(id: string, change: () => Promise<T>): Promise<T> {
    if (!bound(id)) return change();
    return serial(id, async () => {
      await pullNow(id, false).catch(() => {});
      const before = (await inner.get(id))!;
      const result = await change();
      if (!result) return result;
      try {
        states[id] = await pushBoard(client, before.config, result.config, pack, binding, states[id]!, (s) => log(`${id}: ${s}`));
        save();
        lastCheck.set(id, Date.now());
        return result;
      } catch (e) {
        await inner.replaceConfig({ id, config: before.config, source: "superset", summary: "undone: Superset refused the change" });
        throw e;
      }
    });
  }

  return {
    notes,
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
    versions: (id) => inner.versions(id),
    revertTo: (id, version) => through(id, () => inner.revertTo(id, version)),
    share: (id, to) => inner.share(id, to),
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
