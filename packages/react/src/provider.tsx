import * as React from "react";

import { svgAdapter } from "./adapters/svg";
import type { ChartAdapter } from "./charts";
import type { Board, BoardOp, Catalogue, LayoutItem, PatchResult, WidgetData } from "./types";
import type { BoardHost } from "./types";

type State = {
  board: Board;
  catalogue: Catalogue;
  data: Record<string, WidgetData>;
  loading: boolean;
  selections: Record<string, string>;
  setSelection(field: string, value: string): void;
  clearSelections(): void;
  apply(ops: BoardOp[]): Promise<PatchResult>;
  saveLayout(layout: LayoutItem[]): Promise<void>;
  refresh(): Promise<void>;
  host: BoardHost;
  editable: boolean;
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
  editable = true,
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
  const [board, setBoard] = React.useState(initial);
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
      if (result.ok) setBoard(result.board);
      return result;
    },
    [host],
  );

  const saveLayout = React.useCallback(
    async (layout: LayoutItem[]) => {
      if (!host.saveLayout) return;
      const next = await host.saveLayout(layout);
      setBoard(next);
    },
    [host],
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
  const clearSelections = React.useCallback(() => {
    setSelections({});
    onSelectionsChange?.({});
  }, [onSelectionsChange]);

  const value = React.useMemo<State>(
    () => ({ board, catalogue, data, loading, selections, setSelection, clearSelections, apply, saveLayout, refresh: load, host, editable, currency, charts }),
    [board, catalogue, data, loading, selections, setSelection, clearSelections, apply, saveLayout, load, host, editable, currency, charts],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
