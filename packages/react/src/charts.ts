import type * as React from "react";

import type { Widget } from "@lenspack/core";

import { formatValue } from "./format";
import type { WidgetData } from "./types";

// The seam between a board and a charting library. A chart adapter receives a
// ChartSpec — pivoted rows, series keys, a formatter, a palette of CSS
// variables — and never the board config, so what a config can express does
// not grow with the library behind it.

export type ChartKind = "bar" | "line" | "area" | "pie";

export type ChartSpec = {
  chart: ChartKind;
  title: string;
  /** One row per group; series values keyed by `keys`. */
  rows: Record<string, string | number | null>[];
  /** The x / category field in every row. */
  groupKey: "group";
  /** Series keys: ["value"] for a plain query, or the split dimension's values. */
  keys: string[];
  /** Human label for a series key (the measure label, or the key itself). */
  label: (key: string) => string;
  /** Measure formatting with currency applied; use for axes, tooltips, labels. */
  format: (value: number) => string;
  /** CSS `var(--lp-series-n)` strings in order. Canvas libraries resolve them with `resolveCssVar`. */
  palette: string[];
  legend: boolean;
};

export interface ChartAdapter {
  name: string;
  Chart: React.ComponentType<{ spec: ChartSpec }>;
}

export const SERIES_VARS = Array.from({ length: 8 }, (_, i) => `var(--lp-series-${i + 1})`);
export const SEQUENTIAL_VARS = Array.from({ length: 8 }, (_, i) => `var(--lp-sequential-${i + 1})`);

/** A `var(--x)` string to its computed colour, for libraries that draw to canvas. */
export function resolveCssVar(value: string, el?: Element | null): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m || typeof getComputedStyle !== "function") return value;
  const resolved = getComputedStyle(el ?? document.documentElement).getPropertyValue(m[1]!).trim();
  return resolved || value;
}

// A series split by a dimension arrives as long rows; every charting library
// wants one row per group with a column per series.
export function pivot(rows: WidgetData["rows"]) {
  const series = [...new Set(rows.map((r) => r.series).filter((s): s is string => s !== undefined))];
  if (series.length === 0) return { rows: rows.map((r) => ({ group: r.group, value: r.value })), keys: ["value"] };
  const byGroup = new Map<string, Record<string, number | string | null>>();
  for (const r of rows) {
    const row = byGroup.get(r.group) ?? { group: r.group };
    row[r.series!] = r.value;
    byGroup.set(r.group, row);
  }
  return { rows: [...byGroup.values()], keys: series };
}

export function buildChartSpec(widget: Extract<Widget, { kind: "chart" }>, data: WidgetData, opts: { currency?: string; measureLabel?: string } = {}): ChartSpec | null {
  const rows = data.rows.filter((r) => r.value !== null);
  if (rows.length === 0) return null;
  const { rows: wide, keys } = pivot(rows);
  return {
    chart: widget.chart,
    title: widget.title,
    rows: wide,
    groupKey: "group",
    keys,
    label: (key) => (key === "value" ? (opts.measureLabel ?? widget.title) : key),
    format: (v) => formatValue(v, data.format, { currency: opts.currency }),
    palette: widget.options.colorScheme === "sequential" ? SEQUENTIAL_VARS : SERIES_VARS,
    legend: widget.options.legend,
  };
}
