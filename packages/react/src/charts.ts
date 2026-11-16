import type * as React from "react";

import type { GRAINS, Widget } from "@lenspack/core";

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
  /** Set when a click on a bar, slice or point means something (a drill-down): called with the group. */
  onSelect?: (group: string) => void;
  /** Set for a series: groups are time buckets of this grain, so the x axis is time, spaced by date. */
  time?: { grain: Grain };
};

export interface ChartAdapter {
  name: string;
  Chart: React.ComponentType<{ spec: ChartSpec }>;
}

/**
 * How wide the value axis must be for its own labels. A fixed width clips
 * "US$100,000" to "00,000" — the formatter knows how long its output is, so
 * ask it rather than guessing.
 */
export function axisWidth(spec: ChartSpec, charPx = 7.2, padding = 14) {
  let longest = 0;
  for (const row of spec.rows)
    for (const k of spec.keys) {
      const v = row[k];
      if (typeof v === "number") longest = Math.max(longest, spec.format(v).length);
    }
  return Math.min(120, Math.max(40, Math.ceil(longest * charPx) + padding));
}

export const SERIES_VARS = Array.from({ length: 8 }, (_, i) => `var(--lp-series-${i + 1})`);
export type Grain = (typeof GRAINS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A time bucket's label ("2025-06-16", "2025-06-16T14:00") to epoch ms, read as UTC like the engine writes it. */
export function timeOf(group: string): number {
  const iso = /T\d\d:\d\d$/.test(group) ? `${group}:00Z` : /^\d{4}-\d{2}-\d{2}$/.test(group) ? `${group}T00:00:00Z` : group;
  return Date.parse(iso);
}

/** A short tick label for a bucket; the year is shown only when the axis spans more than one. */
export function formatTick(ms: number, grain: Grain, multiYear: boolean): string {
  const d = new Date(ms);
  const day = d.getUTCDate(), mon = MONTHS[d.getUTCMonth()], yr = d.getUTCFullYear();
  if (grain === "year") return String(yr);
  if (grain === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${yr}`;
  if (grain === "month") return multiYear ? `${mon} ${yr}` : mon!;
  const date = multiYear ? `${day} ${mon} ${String(yr).slice(2)}` : `${day} ${mon}`;
  return grain === "hour" ? `${date} ${String(d.getUTCHours()).padStart(2, "0")}:00` : date;
}

const DAY_MS = 86_400_000;

/**
 * Tick positions on calendar boundaries between two instants: hours, days,
 * Mondays, month starts, quarter starts or years, whichever step gives at most
 * `max` ticks. Charts that space buckets by date mark these, so a reader can
 * tell which span is which day.
 */
export function timeTicks(min: number, max: number, grain: Grain, maxTicks = 8): number[] {
  if (!(max > min)) return Number.isFinite(min) ? [min] : [];
  const out: number[] = [];
  const span = max - min;
  const fixed = (step: number, start: number) => {
    for (let t = start; t <= max; t += step) if (t >= min) out.push(t);
    return out;
  };
  if (grain === "hour" && span / 3_600_000 <= maxTicks * 6) {
    const step = [1, 2, 3, 6].find((h) => span / (h * 3_600_000) <= maxTicks) ?? 6;
    return fixed(step * 3_600_000, Math.ceil(min / (step * 3_600_000)) * step * 3_600_000);
  }
  if ((grain === "hour" || grain === "day") && span / DAY_MS <= maxTicks) return fixed(DAY_MS, Math.ceil(min / DAY_MS) * DAY_MS);
  if ((grain === "hour" || grain === "day" || grain === "week") && span / (7 * DAY_MS) <= maxTicks) {
    const d = new Date(Math.ceil(min / DAY_MS) * DAY_MS);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7)); // next Monday
    return fixed(7 * DAY_MS, d.getTime());
  }
  const months = (span / DAY_MS) / 30.44;
  const step = [1, 2, 3, 6, 12, 24, 60].find((m) => months / m <= maxTicks) ?? 120;
  const first = new Date(min);
  let y = first.getUTCFullYear(), m = first.getUTCMonth();
  if (first.getUTCDate() !== 1 || first.getUTCHours() !== 0) m += 1;
  if (step % 3 === 0) m = Math.ceil(m / step) * step; // quarter, half and year steps start on their boundaries
  for (;;) {
    const t = Date.UTC(y, m, 1);
    if (t > max) break;
    if (t >= min) out.push(t);
    m += step;
  }
  return out;
}

/** The full label for one bucket, as a tooltip heading. */
export function formatBucket(ms: number, grain: Grain): string {
  const d = new Date(ms);
  const day = d.getUTCDate(), mon = MONTHS[d.getUTCMonth()], yr = d.getUTCFullYear();
  if (grain === "year") return String(yr);
  if (grain === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${yr}`;
  if (grain === "month") return `${mon} ${yr}`;
  if (grain === "week") return `Week of ${day} ${mon} ${yr}`;
  const date = `${DAYS[d.getUTCDay()]} ${day} ${mon} ${yr}`;
  return grain === "hour" ? `${date}, ${String(d.getUTCHours()).padStart(2, "0")}:00` : date;
}

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

// Several measures over the same groups: one column per measure.
export function widen(rows: WidgetData["rows"], measures: NonNullable<WidgetData["measures"]>) {
  const [primary, ...rest] = measures;
  return {
    rows: rows.map((r) => ({ group: r.group, [primary!.key]: r.value, ...Object.fromEntries(rest.map((m) => [m.key, r.values?.[m.key] ?? null])) })),
    keys: measures.map((m) => m.key),
  };
}

export function buildChartSpec(
  widget: Extract<Widget, { kind: "chart" }>,
  data: WidgetData,
  opts: { currency?: string; measureLabel?: string; labelOf?: (key: string) => string | undefined; onSelect?: (group: string) => void } = {},
): ChartSpec | null {
  const rows = data.rows.filter((r) => r.value !== null);
  if (rows.length === 0) return null;
  const { rows: wide, keys } = data.measures?.length ? widen(rows, data.measures) : pivot(rows);
  return {
    chart: widget.chart,
    title: widget.title,
    rows: wide,
    groupKey: "group",
    keys,
    label: (key) => (key === "value" ? (opts.measureLabel ?? widget.title) : (opts.labelOf?.(key) ?? key)),
    format: (v) => formatValue(v, data.format, { currency: opts.currency }),
    palette: widget.options.colorScheme === "sequential" ? SEQUENTIAL_VARS : SERIES_VARS,
    legend: widget.options.legend,
    ...(opts.onSelect ? { onSelect: opts.onSelect } : {}),
    ...(widget.query.kind === "series" ? { time: { grain: widget.query.grain } } : {}),
  };
}
