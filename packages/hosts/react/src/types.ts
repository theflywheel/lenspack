import type { Board, BoardConfig, BoardOp, BoardVersion, Catalogue, LayoutItem, PatchResult, Query } from "@lenspack/core";

// The renderer never touches a database or an LLM. Everything it needs to
// fetch or save arrives through these callbacks, so it works in front of any
// host: a Next.js route, an Express server, a Tauri command.

export type DataRow = { group: string; series?: string; value: number | null; count: number; values?: Record<string, number | null>; compare?: { previous: number | null; delta: number | null }; share?: number | null; other?: true };
type Format = "number" | "percent" | "currency" | "compact" | "duration";
export type WidgetData = {
  rows: DataRow[];
  records?: Record<string, unknown>[];
  columns?: string[];
  total: number;
  format: Format;
  compare?: { previous: number | null; delta: number | null };
  approximate?: boolean;
  /** Every measure drawn when a query has further measures, the primary first. */
  measures?: { key: string; format: Format }[];
  /** What the answer leaves out on purpose, shown beside the widget's title. */
  notes?: string[];
  /** The source stopped at its row limit; a note says what is shown (the latest days of a series, say). */
  truncated?: boolean;
  /** A computed answer's name for its numbers ("average daily units dispatched"): the value's label. */
  label?: string;
  /** What was computed after the source answered, in plain words: the value's tooltip. */
  computed?: string;
  error?: string;
  hint?: string;
  /** Why the widget has no answer right now, from the host (something it reads is not collected or not set up), and where to fix it. */
  notice?: { text: string; action?: { label: string; href: string } };
};

export type FilterOption = { value: string; count: number };

/** One page of a table of rows: `records` holds at most `pageSize` rows starting at `offset`. */
export type WidgetPage = WidgetData & { page: number; pageSize: number; offset: number; hasNext: boolean };

export type BoardHost = {
  /** Rows for every non-text widget, e.g. resolveBoard() on the server. */
  loadBoardData(config: BoardConfig, selections: Record<string, string>): Promise<Record<string, WidgetData>>;
  /** Apply ops and return the new board (a new version). */
  applyOps?(ops: BoardOp[]): Promise<PatchResult>;
  /** Save a drag/resize as a version of its own; `summary` says what it did ("moved “Total”"). */
  saveLayout?(layout: LayoutItem[], summary?: string): Promise<Board>;
  /** One page (0 first) of a table widget's rows, under the board's selections: Prev/Next on the table. */
  loadWidgetPage?(id: string, page: number, selections: Record<string, string>): Promise<WidgetPage>;
  /** Distinct values for a filter control. */
  loadFilterOptions?(field: string): Promise<FilterOption[]>;
  loadVersions?(): Promise<BoardVersion[]>;
  revertTo?(version: number): Promise<Board | null>;
};

export type { Board, BoardConfig, BoardOp, BoardVersion, Catalogue, LayoutItem, PatchResult, Query };
