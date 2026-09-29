import * as React from "react";

import { drilledDimension, selectLevel } from "@lenspack/core";

import { svgAdapter } from "./adapters/svg";
import type { ChartAdapter } from "./charts";
import type { Board, BoardOp, BoardVersion, Catalogue, LayoutItem, PatchResult, WidgetData } from "./types";
import type { BoardHost } from "./types";

type State = {
  board: Board;
  catalogue: Catalogue;
  data: Record<string, WidgetData>;
  loading: boolean;
  selections: Record<string, string>;
  setSelection(field: string, value: string): void;
  /** Select a value on a hierarchy level (clearing finer levels): a drill-down. */
  drill(dimension: string, value: string): void;
  /** For a widget grouped by `dimension`: the level its rows are at now, and what a click on one selects (null when nothing). */
  drillTarget(dimension: string): { at: string; selects: string | null };
  clearSelections(): void;
  apply(ops: BoardOp[]): Promise<PatchResult>;
  saveLayout(layout: LayoutItem[]): Promise<void>;
  refresh(): Promise<void>;
  host: BoardHost;
  editable: boolean;
  /** An older version shown read-only; null shows the current board. */
  previewing: BoardVersion | null;
  preview(version: BoardVersion | null): void;
  currency?: string;
  /** The charting library behind chart widgets; swappable at runtime. */
  charts: ChartAdapter;
};

const Ctx = React.createContext<State | null>(null);

export function useBoard() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useBoard must be used inside <BoardProvider>");
  return ctx;
}

/** Everything a chat, a command palette or a button needs to edit the board. */
export function useBoardOps() {
  const { apply, board, catalogue } = useBoard();
  return { apply, version: board.version, catalogue };
}

export function BoardProvider({
  board: initial,
  catalogue,
  host,
  editable: editableProp = true,
  currency,
  charts = svgAdapter,
  initialSelections = {},
  onSelectionsChange,
  children,
}: {
  board: Board;
  catalogue: Catalogue;
  host: BoardHost;
  editable?: boolean;
  currency?: string;
  /** Chart adapter: svg (no dependencies) by default; recharts, echarts or shadcn from `@lenspack/react/adapters/*`. */
  charts?: ChartAdapter;
  /** Selections are session state, not configuration; the host may keep them in the URL. */
  initialSelections?: Record<string, string>;
  onSelectionsChange?(selections: Record<string, string>): void;
  children: React.ReactNode;
}) {
  const [current, setBoard] = React.useState(initial);
  // Looking at an old version is not an edit: it is shown read-only until the
  // user restores it (which is) or goes back to the current board.
  const [previewing, setPreviewing] = React.useState<BoardVersion | null>(null);
  const board = React.useMemo(() => (previewing ? { ...current, config: previewing.config, version: previewing.version } : current), [current, previewing]);
  const editable = editableProp && !previewing;
  const [data, setData] = React.useState<Record<string, WidgetData>>({});
  const [loading, setLoading] = React.useState(true);
  const [selections, setSelections] = React.useState(initialSelections);

  React.useEffect(() => setBoard(initial), [initial]);

  // One load per (config, selections); a stale response never overwrites a
  // newer one.
  const seq = React.useRef(0);
  const load = React.useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const next = await host.loadBoardData(board.config, selections);
      if (my === seq.current) setData(next);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [host, board.config, selections]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const apply = React.useCallback(
    async (ops: BoardOp[]): Promise<PatchResult> => {
      if (!host.applyOps) return { ok: false, error: "This board is read-only" };
      const result = await host.applyOps(ops);
      if (result.ok) {
        setBoard(result.board);
        setPreviewing(null);
      }
      return result;
    },
    [host],
  );

  const saveLayout = React.useCallback(
    async (layout: LayoutItem[]) => {
      if (!host.saveLayout) return;
      if (previewing) return;
      const next = await host.saveLayout(layout);
      setBoard(next);
    },
    [host, previewing],
  );

  const setSelection = React.useCallback(
    (field: string, value: string) => {
      setSelections((prev) => {
        const next = { ...prev };
        if (value) next[field] = value;
        else delete next[field];
        onSelectionsChange?.(next);
        return next;
      });
    },
    [onSelectionsChange],
  );
  const hierarchies = catalogue.hierarchies;
  const drill = React.useCallback(
    (dimension: string, value: string) => {
      setSelections((prev) => {
        const next = selectLevel(prev, dimension, value, hierarchies);
        onSelectionsChange?.(next);
        return next;
      });
    },
    [hierarchies, onSelectionsChange],
  );
  const drillTarget = React.useCallback(
    (dimension: string) => {
      const at = drilledDimension(dimension, selections, hierarchies);
      const inHierarchy = Object.values(hierarchies ?? {}).some((ls) => ls.includes(at));
      // A click selects the level the rows are at, unless the finest level is
      // already selected (there is nowhere further to go).
      return { at, selects: inHierarchy && !selections[at] ? at : null };
    },
    [selections, hierarchies],
  );
  const clearSelections = React.useCallback(() => {
    setSelections({});
    onSelectionsChange?.({});
  }, [onSelectionsChange]);

  const value = React.useMemo<State>(
    () => ({ board, catalogue, data, loading, selections, setSelection, drill, drillTarget, clearSelections, apply, saveLayout, refresh: load, host, editable, previewing, preview: setPreviewing, currency, charts }),
    [board, catalogue, data, loading, selections, setSelection, drill, drillTarget, clearSelections, apply, saveLayout, load, host, editable, previewing, currency, charts],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
