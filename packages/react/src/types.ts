import type { Board, BoardConfig, BoardOp, BoardVersion, Catalogue, LayoutItem, PatchResult, Query } from "@lenspack/core";

// The renderer never touches a database or an LLM. Everything it needs to
// fetch or save arrives through these callbacks, so it works in front of any
// host: a Next.js route, an Express server, a Tauri command.

export type DataRow = { group: string; series?: string; value: number | null; count: number; values?: Record<string, number | null> };
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
  error?: string;
  hint?: string;
};

export type FilterOption = { value: string; count: number };

export type BoardHost = {
  /** Rows for every non-text widget, e.g. resolveBoard() on the server. */
  loadBoardData(config: BoardConfig, selections: Record<string, string>): Promise<Record<string, WidgetData>>;
  /** Apply ops and return the new board (a new version). */
  applyOps?(ops: BoardOp[]): Promise<PatchResult>;
  /** Save a drag/resize as a version of its own. */
  saveLayout?(layout: LayoutItem[]): Promise<Board>;
  /** Distinct values for a filter control. */
  loadFilterOptions?(field: string): Promise<FilterOption[]>;
  loadVersions?(): Promise<BoardVersion[]>;
  revertTo?(version: number): Promise<Board | null>;
};

export type { Board, BoardConfig, BoardOp, BoardVersion, Catalogue, LayoutItem, PatchResult, Query };
