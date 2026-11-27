// Which Superset dashboards the assistant works on (superset.yaml's dashboardScope and dashboards). What is in scope
// is policy's (boardScopeFrom, boardsInScope in @lenspack/policy); this file only reads the settings and names the
// dashboards as boards.

import { type BoardScope, type MadeBoard, boardScopeFrom } from "@lenspack/policy";

/** Lenspack's board for a Superset dashboard. */
export const dashboardBoard = (id: number) => `superset-${id}`;

/** The dashboard id in a board name, for messages ("superset-25" → "25"). */
export const dashboardLabel = (board: string) => board.replace(/^superset-/, "");

/** The refusal on a dashboard outside the scope, as the overlay and the chat say it. */
export const OUT_OF_SCOPE_MESSAGE = "The assistant isn't turned on for this dashboard.";

/**
 * The dashboard ids to read at start, and the scope: from LENSPACK_DASHBOARDS (ids separated by commas) and
 * LENSPACK_DASHBOARD_SCOPE, which win, else the file's dashboards and dashboardScope. Anything that is not a dashboard
 * id, an unknown scope, or "listed" with no dashboards stops the server with a message.
 */
export function dashboardScopeFrom(config: { dashboards?: unknown; dashboardScope?: unknown }, env: Record<string, string | undefined> = {}): { dashboards: number[]; scope: BoardScope } {
  const fromEnv = env.LENSPACK_DASHBOARDS !== undefined && env.LENSPACK_DASHBOARDS.trim() !== "";
  const where = fromEnv ? "LENSPACK_DASHBOARDS" : "dashboards";
  const raw: unknown[] = fromEnv ? env.LENSPACK_DASHBOARDS!.split(",").map((s) => s.trim()) : config.dashboards === undefined || config.dashboards === null ? [] : Array.isArray(config.dashboards) ? config.dashboards : [config.dashboards];
  const dashboards = raw.map((v) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${where} must be Superset dashboard ids (whole numbers${fromEnv ? ", separated by commas, like 25,31" : ""}), not "${String(v)}"`);
    return n;
  });
  const value = env.LENSPACK_DASHBOARD_SCOPE !== undefined && env.LENSPACK_DASHBOARD_SCOPE !== "" ? env.LENSPACK_DASHBOARD_SCOPE : config.dashboardScope;
  const scope = boardScopeFrom(value, dashboards.map(dashboardBoard), { scope: "dashboardScope (LENSPACK_DASHBOARD_SCOPE)", list: "dashboards (LENSPACK_DASHBOARDS)" });
  return { dashboards: [...new Set(dashboards)], scope };
}

/** People's own dashboards as boards made through Lenspack, for boardsInScope. */
export const madeBoards = (links: readonly { board: string; from: number | null }[]): MadeBoard[] => links.map((l) => ({ board: l.board, from: l.from === null ? null : dashboardBoard(l.from) }));
