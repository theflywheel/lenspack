// Which boards the assistant works on at all. A deployment on a host shared by several projects (one Superset with
// many teams' dashboards) may want it on its own few dashboards only: elsewhere no button, and every route that
// takes a board refuses the others. Decided here, from what the host says; hosts only ask (inBoardScope, through
// boardRights) and render.

/** The values a deployment may choose: "any" (the default) or "listed". */
export const BOARD_SCOPES = ["any", "listed"] as const;
export type BoardScopeKind = (typeof BOARD_SCOPES)[number];

/**
 * "any": every board the host lets the person open, as before. "listed": only these boards, and people's own
 * dashboards made from them through Lenspack (boardsInScope). It narrows what the host allows, never widens it, and
 * holds for everyone, admins too.
 */
export type BoardScope = { scope: "any" } | { scope: "listed"; boards: readonly string[] };

/**
 * The scope from a deployment's setting, checked. `names` are the deployment's own words for the setting and its list,
 * for the messages (Superset: "dashboardScope (LENSPACK_DASHBOARD_SCOPE)" and "dashboards (LENSPACK_DASHBOARDS)").
 * An unknown value, or "listed" with nothing listed, is refused: a server that would put the assistant nowhere, or
 * everywhere by mistake, should not start.
 */
export function boardScopeFrom(value: unknown, boards: readonly string[], names: { scope: string; list: string } = { scope: "boardScope", list: "boards" }): BoardScope {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "" || v === "any") return { scope: "any" };
  if (v !== "listed") throw new Error(`${names.scope} must be ${BOARD_SCOPES.map((s) => `"${s}"`).join(" or ")}, not "${String(value)}"`);
  if (!boards.length) throw new Error(`${names.scope} is "listed" but ${names.list} lists none, so the assistant would be on no dashboard. List them, or set ${names.scope} to "any".`);
  return { scope: "listed", boards: [...new Set(boards)] };
}

/** A board someone made through Lenspack, and the board it was copied from (null: made blank). */
export type MadeBoard = { board: string; from: string | null };

/**
 * The boards a caller may open under the scope, or undefined when it is "any" (no limit). Under "listed": the listed
 * boards, and, while people's own dashboards are on (`personalOn`), each one made through Lenspack that is a copy of a
 * board in scope (or a copy of such a copy), or made blank, since a blank one holds only what the assistant put on
 * it and is made only from the assistant's own panel. A copy of a board out of scope stays out.
 */
export function boardsInScope(scope: BoardScope, made: readonly MadeBoard[] = [], o: { personalOn?: boolean } = {}): string[] | undefined {
  if (scope.scope === "any") return undefined;
  const inScope = new Set(scope.boards);
  if (o.personalOn) {
    const from = new Map(made.map((m) => [m.board, m.from]));
    // Follows each copy back to where it came from; a loop (which records should never hold) counts as out.
    const reaches = (board: string): boolean => {
      const seen = new Set<string>();
      for (let at: string | null | undefined = board; ; ) {
        if (inScope.has(at)) return true;
        if (seen.has(at) || !from.has(at)) return false;
        seen.add(at);
        at = from.get(at);
        if (at === null) return true;
        if (at === undefined) return false;
      }
    };
    for (const m of made) if (reaches(m.board)) inScope.add(m.board);
  }
  return [...inScope].sort();
}

/** Whether a board is in the caller's scope (Identity.onlyBoards): any board, when the deployment lists none. */
export const inBoardScope = (who: { onlyBoards?: readonly string[] }, board: string): boolean => !who.onlyBoards || who.onlyBoards.includes(board);

/** The scope in one line, for the start-up log: "listed (25, 31)" or "any". `label` turns a board id into the host's name for it. */
export const boardScopeLine = (scope: BoardScope, label: (board: string) => string = (b) => b): string => (scope.scope === "any" ? "any" : `listed (${scope.boards.map(label).join(", ")})`);
