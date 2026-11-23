import * as React from "react";

import type { Widget } from "@lenspack/core";

import { type Grain, formatBucket, formatTick, timeOf } from "./charts";
import { formatValue } from "./format";
import type { WidgetData } from "./types";

// A heatmap: one measure over two dimensions, as a grid of cells shaded on one
// sequential scale. Columns are a breakdown's dimension (or a series' time
// buckets), rows its split. Drawn here rather than by a chart adapter, so every
// adapter shows the same thing and none needs a heatmap of its own.

export const HEAT_STEPS = 8;

export type HeatmapSpec = {
  title: string;
  /** Column keys in reading order (time buckets oldest first). */
  xs: string[];
  /** Row keys, sorted as text (A to Z, numbers in numeric order). */
  ys: string[];
  /** Cell values by `${x}\u0000${y}`: a number, null for "no value", absent for "no row". */
  cells: Map<string, number | null>;
  min: number;
  max: number;
  format: (v: number) => string;
  xLabel: (x: string) => string;
  /** The full name of a column, for the tooltip (a bucket's date, or the label again). */
  xTitle: (x: string) => string;
  measureLabel: string;
  xName: string;
  yName: string;
  legend: boolean;
};

export const cellKey = (x: string, y: string) => `${x}\u0000${y}`;

/** The scale step (1 to HEAT_STEPS) a value falls in; one value across the grid sits mid-scale. */
export function heatStep(v: number, min: number, max: number): number {
  if (!(max > min)) return Math.ceil(HEAT_STEPS / 2);
  return Math.min(HEAT_STEPS, 1 + Math.floor(((v - min) / (max - min)) * HEAT_STEPS));
}

const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildHeatmapSpec(
  widget: Extract<Widget, { kind: "chart" }>,
  data: WidgetData,
  opts: { currency?: string; measureLabel?: string; xName?: string; yName?: string } = {},
): HeatmapSpec | null {
  const q = widget.query;
  if (q.kind !== "breakdown" && q.kind !== "series") return null;
  const grain: Grain | null = q.kind === "series" ? q.grain : null;
  const rows = data.rows.filter((r) => r.series !== undefined && !r.other);
  if (rows.length === 0) return null;
  const xs: string[] = [];
  const seenX = new Set<string>();
  const ySet = new Set<string>();
  const cells = new Map<string, number | null>();
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const y = r.series!;
    if (!seenX.has(r.group)) (seenX.add(r.group), xs.push(r.group));
    ySet.add(y);
    cells.set(cellKey(r.group, y), r.value);
    if (typeof r.value === "number") {
      min = Math.min(min, r.value);
      max = Math.max(max, r.value);
    }
  }
  if (grain) xs.sort((a, b) => timeOf(a) - timeOf(b));
  const ys = [...ySet].sort(byText.compare);
  const times = grain ? xs.map(timeOf) : [];
  const multiYear = grain ? new Date(times[0]!).getUTCFullYear() !== new Date(times.at(-1)!).getUTCFullYear() : false;
  return {
    title: widget.title,
    xs,
    ys,
    cells,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    format: (v) => formatValue(v, data.format, { currency: opts.currency }),
    xLabel: (x) => (grain && Number.isFinite(timeOf(x)) ? formatTick(timeOf(x), grain, multiYear) : x),
    xTitle: (x) => (grain && Number.isFinite(timeOf(x)) ? formatBucket(timeOf(x), grain) : x),
    measureLabel: opts.measureLabel ?? widget.title,
    xName: opts.xName ?? (q.kind === "breakdown" ? q.dimension : "time"),
    yName: opts.yName ?? q.by ?? "",
    legend: widget.options.legend,
  };
}

/** The element's size, kept current; values are drawn in cells only when they fit. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = React.useRef<T | null>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function HeatmapChart({ spec }: { spec: HeatmapSpec }) {
  const [gridRef, size] = useSize<HTMLDivElement>();
  const [tip, setTip] = React.useState<{ x: number; y: number; head: string; body: string } | null>(null);
  const nx = spec.xs.length;
  const ny = spec.ys.length;
  // Column labels thin out so they never collide: about one per 48px.
  const labelEvery = size.w ? Math.max(1, Math.ceil(nx / Math.max(1, Math.floor(size.w / 48)))) : Math.max(1, Math.ceil(nx / 12));
  const cellW = size.w / Math.max(1, nx);
  const cellH = size.h / Math.max(1, ny);
  const showValues = cellW >= 38 && cellH >= 18;
  const anyGap = spec.xs.some((x) => spec.ys.some((y) => !(typeof spec.cells.get(cellKey(x, y)) === "number")));

  const hover = (e: React.MouseEvent, x: string, y: string, v: number | null | undefined) => {
    const box = (e.currentTarget.closest(".lp-heat") as HTMLElement).getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({
      x: r.left - box.left + r.width / 2,
      y: r.top - box.top,
      head: `${y} · ${spec.xTitle(x)}`,
      body: typeof v === "number" ? `${spec.measureLabel}: ${spec.format(v)}` : v === null ? `${spec.measureLabel}: no value` : "no data",
    });
  };

  return (
    <div className="lp-heat" role="img" aria-label={`${spec.title}: ${spec.measureLabel} by ${spec.yName} and ${spec.xName}`} onMouseLeave={() => setTip(null)}>
      <div className="lp-heat-body">
        <div className="lp-heat-ylabels" style={{ gridTemplateRows: `repeat(${ny}, minmax(0, 1fr))` }}>
          {spec.ys.map((y) => (
            <span key={y} title={y}>{y}</span>
          ))}
        </div>
        <div className="lp-heat-main">
          <div ref={gridRef} className="lp-heat-grid" style={{ gridTemplateColumns: `repeat(${nx}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${ny}, minmax(0, 1fr))` }}>
            {spec.ys.map((y) =>
              spec.xs.map((x) => {
                const v = spec.cells.get(cellKey(x, y));
                const step = typeof v === "number" ? heatStep(v, spec.min, spec.max) : 0;
                const label = typeof v === "number" ? spec.format(v) : v === null ? "no value" : "no data";
                return (
                  <div
                    key={cellKey(x, y)}
                    className={`lp-heat-cell ${step ? `lp-heat-s${step}` : v === null ? "lp-heat-null" : "lp-heat-none"}`}
                    aria-label={`${y}, ${spec.xTitle(x)}: ${label}`}
                    onMouseEnter={(e) => hover(e, x, y, v)}
                  >
                    {showValues && typeof v === "number" ? spec.format(v) : null}
                  </div>
                );
              }),
            )}
          </div>
          <div className="lp-heat-xlabels" style={{ gridTemplateColumns: `repeat(${nx}, minmax(0, 1fr))` }}>
            {spec.xs.map((x, i) => (
              <span key={x} title={spec.xTitle(x)}>{i % labelEvery === 0 ? spec.xLabel(x) : ""}</span>
            ))}
          </div>
        </div>
      </div>
      {spec.legend && (
        <div className="lp-heat-legend" aria-hidden="true">
          <span>{spec.format(spec.min)}</span>
          <span className="lp-heat-ramp">
            {Array.from({ length: HEAT_STEPS }, (_, i) => (
              <i key={i} className={`lp-heat-s${i + 1}`} />
            ))}
          </span>
          <span>{spec.format(spec.max)}</span>
          {anyGap && (
            <span className="lp-heat-gap">
              <i className="lp-heat-none" /> no data
            </span>
          )}
        </div>
      )}
      {tip && (
        <div className="lp-heat-tip" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.head}</b>
          {tip.body}
        </div>
      )}
    </div>
  );
}
