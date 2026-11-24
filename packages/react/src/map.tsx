import * as React from "react";

import type { Widget } from "@lenspack/core";

import { formatValue } from "./format";
import type { WidgetData } from "./types";

// A map of points: the rows of an entity with a location, plotted in Web
// Mercator and fitted to their own extent. Colour is a category (one of the
// series colours, the rest grouped), size a measure (by area, so a point twice
// as big holds twice as much). No tiles by default: a host that has a tile
// server it may use passes one (MapTiles), and the points sit on it.

export type MapTiles = {
  /** An XYZ raster template, e.g. "https://tiles.example.org/{z}/{x}/{y}.png". */
  url: string;
  /** Shown in the corner, as the tile provider's terms require. */
  attribution: string;
  maxZoom?: number;
};

export const MAP_COLOURS = 8;
const R_FIXED = 5;
const R_MIN = 3;
const R_MAX = 18;

export type MapPoint = { x: number; y: number; lat: number; lon: number; label: string | null; category: string | null; size: number | null };

export type MapSpec = {
  title: string;
  points: MapPoint[];
  /** Categories in legend order, each with its colour step (1..MAP_COLOURS, 0: grouped as other). */
  categories: { name: string; step: number }[];
  colorName: string | null;
  sizeName: string | null;
  sizeRange: [number, number] | null;
  format: (v: number) => string;
  legend: boolean;
  /** How much smaller points are drawn when there are many (1 for a few hundred or fewer). */
  density: number;
};

/** Points shrink as they multiply, so thousands still read as a pattern rather than a blot. */
export const densityOf = (n: number) => (n > 2000 ? 0.45 : n > 500 ? 0.7 : 1);

/** Web Mercator, as a fraction of the world (0..1 across, 0..1 down). */
export function project(lat: number, lon: number): { x: number; y: number } {
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return { x: (lon + 180) / 360, y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 };
}

/** Back from the world fraction to degrees. */
export function unproject(x: number, y: number): { lat: number; lon: number } {
  return { lon: x * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI };
}

const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildMapSpec(
  widget: Extract<Widget, { kind: "chart" }>,
  data: WidgetData,
  opts: { currency?: string; colorName?: string; sizeName?: string } = {},
): MapSpec | null {
  const q = widget.query;
  if (q.kind !== "points" || !data.records) return null;
  const points: MapPoint[] = [];
  for (const r of data.records) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const size = q.size && typeof r[q.size] === "number" ? (r[q.size] as number) : null;
    points.push({ ...project(lat, lon), lat, lon, label: q.label && r[q.label] != null ? String(r[q.label]) : null, category: q.color ? String(r[q.color] ?? "(none)") : null, size });
  }
  if (points.length === 0) return null;
  // The most common categories get their own colour; the rest share one.
  const counts = new Map<string, number>();
  for (const p of points) if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const kept = new Set([...counts.entries()].sort((a, b) => b[1] - a[1] || byText.compare(a[0], b[0])).slice(0, counts.size > MAP_COLOURS ? MAP_COLOURS - 1 : MAP_COLOURS).map(([k]) => k));
  const names = [...kept].sort(byText.compare);
  const categories = names.map((name, i) => ({ name, step: i + 1 }));
  if (counts.size > kept.size) categories.push({ name: `other (${counts.size - kept.size})`, step: 0 });
  const sizes = points.map((p) => p.size).filter((v): v is number => v !== null);
  return {
    title: widget.title,
    points,
    categories,
    colorName: q.color ? (opts.colorName ?? q.color) : null,
    sizeName: q.size ? (opts.sizeName ?? q.size) : null,
    sizeRange: sizes.length ? [Math.min(...sizes), Math.max(...sizes)] : null,
    format: (v) => formatValue(v, data.format, { currency: opts.currency }),
    legend: widget.options.legend,
    density: densityOf(points.length),
  };
}

/** A point's radius in pixels: by area between R_MIN and R_MAX, or one size for all. */
export function radiusOf(size: number | null, range: [number, number] | null): number {
  if (size === null || !range) return R_FIXED;
  const [lo, hi] = range;
  if (!(hi > lo)) return (R_MIN + R_MAX) / 2;
  const t = (Math.sqrt(Math.max(0, size - lo)) / Math.sqrt(hi - lo)) || 0;
  return R_MIN + t * (R_MAX - R_MIN);
}

/** The view that fits every point in a w×h box with a margin: a scale in pixels per world and the world point at the top-left. */
export function fit(points: { x: number; y: number }[], w: number, h: number, pad = 28): { scale: number; x0: number; y0: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // A single point (or a line of them) still gets a sensible zoom: about 50 km across.
  const spanX = Math.max(maxX - minX, 0.00014);
  const spanY = Math.max(maxY - minY, 0.00014);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  return { scale, x0: (minX + maxX) / 2 - w / 2 / scale, y0: (minY + maxY) / 2 - h / 2 / scale };
}

/** Round degree steps for the grid: about four lines across the view. */
export function gridStep(spanDegrees: number): number {
  const raw = spanDegrees / 4;
  for (const s of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45, 90]) if (s >= raw) return s;
  return 90;
}

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

function Tiles({ tiles, view, w, h }: { tiles: MapTiles; view: { scale: number; x0: number; y0: number }; w: number; h: number }) {
  // The zoom whose 256px tiles are drawn closest to their own size, then scaled to fit.
  const z = Math.max(0, Math.min(tiles.maxZoom ?? 18, Math.round(Math.log2(view.scale / 256))));
  const n = 2 ** z;
  const px = view.scale / n;
  const out: React.ReactNode[] = [];
  const [tx0, ty0] = [Math.floor(view.x0 * n), Math.floor(view.y0 * n)];
  const [tx1, ty1] = [Math.floor((view.x0 + w / view.scale) * n), Math.floor((view.y0 + h / view.scale) * n)];
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 64) return null;
  for (let ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const x = ((tx % n) + n) % n;
      const src = tiles.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(ty));
      out.push(<img key={`${tx}/${ty}`} src={src} alt="" draggable={false} style={{ left: (tx / n - view.x0) * view.scale, top: (ty / n - view.y0) * view.scale, width: px + 0.5, height: px + 0.5 }} />);
    }
  return <div className="lp-map-tiles" aria-hidden="true">{out}</div>;
}

export function MapChart({ spec, tiles }: { spec: MapSpec; tiles?: MapTiles }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [tip, setTip] = React.useState<{ x: number; y: number; p: MapPoint } | null>(null);
  const { w, h } = size;
  const view = w && h ? fit(spec.points, w, h) : null;
  const at = (p: { x: number; y: number }) => (view ? { cx: (p.x - view.x0) * view.scale, cy: (p.y - view.y0) * view.scale } : { cx: 0, cy: 0 });
  const stepOf = new Map(spec.categories.map((c) => [c.name, c.step]));
  // Big points first, so a small one is never hidden under a big one.
  const drawn = [...spec.points].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

  let grid: React.ReactNode = null;
  if (view && !tiles) {
    const nw = unproject(view.x0, view.y0);
    const se = unproject(view.x0 + w / view.scale, view.y0 + h / view.scale);
    // From the shorter side, so both directions get lines.
    const step = gridStep(Math.min(se.lon - nw.lon, nw.lat - se.lat));
    const lines: React.ReactNode[] = [];
    const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (let lon = Math.ceil(nw.lon / step) * step; lon <= se.lon; lon += step) {
      const x = at(project(0, lon)).cx;
      lines.push(<line key={`x${lon}`} x1={x} x2={x} y1={0} y2={h} />, <text key={`tx${lon}`} x={x + 3} y={h - 4}>{`${Math.abs(lon).toFixed(digits)}°${lon < 0 ? "W" : "E"}`}</text>);
    }
    for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
      const y = at(project(lat, 0)).cy;
      lines.push(<line key={`y${lat}`} x1={0} x2={w} y1={y} y2={y} />, <text key={`ty${lat}`} x={3} y={y - 3}>{`${Math.abs(lat).toFixed(digits)}°${lat < 0 ? "S" : "N"}`}</text>);
    }
    grid = <g className="lp-map-grid" aria-hidden="true">{lines}</g>;
  }

  const describe = (p: MapPoint) =>
    [p.label ?? "Point", p.category !== null && spec.colorName ? `${spec.colorName}: ${p.category}` : null, p.size !== null && spec.sizeName ? `${spec.sizeName}: ${spec.format(p.size)}` : null].filter(Boolean).join(", ");

  return (
    <div className="lp-map" role="img" aria-label={`${spec.title}: ${spec.points.length} points${spec.colorName ? ` coloured by ${spec.colorName}` : ""}${spec.sizeName ? `, sized by ${spec.sizeName}` : ""}`}>
      <div ref={ref} className="lp-map-body" onMouseLeave={() => setTip(null)}>
        {view && tiles && <Tiles tiles={tiles} view={view} w={w} h={h} />}
        {view && (
          <svg width={w} height={h}>
            {grid}
            {drawn.map((p, i) => {
              const { cx, cy } = at(p);
              const step = p.category === null ? 1 : (stepOf.get(p.category) ?? 0);
              return (
                <circle
                  key={i}
                  cx={cx}
                  cy={cy}
                  r={radiusOf(p.size, spec.sizeRange) * spec.density}
                  className={`lp-map-pt lp-map-c${step}${spec.density < 1 ? " lp-map-dense" : ""}`}
                  aria-label={describe(p)}
                  onMouseEnter={() => setTip({ x: cx, y: cy, p })}
                />
              );
            })}
          </svg>
        )}
        {tiles && <span className="lp-map-attr">{tiles.attribution}</span>}
        {tip && (
          // Above the point, or below it near the top; pinned to a side near the left or right edge.
          <div
            className={`lp-map-tip${tip.y < 72 ? " lp-map-tip-below" : ""}${tip.x < 90 ? " lp-map-tip-l" : tip.x > w - 90 ? " lp-map-tip-r" : ""}`}
            style={{ left: tip.x, top: tip.y }}
          >
            <b>{tip.p.label ?? "Point"}</b>
            {tip.p.category !== null && spec.colorName && <span>{`${spec.colorName}: ${tip.p.category}`}</span>}
            {tip.p.size !== null && spec.sizeName && <span>{`${spec.sizeName}: ${spec.format(tip.p.size)}`}</span>}
            <span className="lp-map-ll">{`${tip.p.lat.toFixed(3)}, ${tip.p.lon.toFixed(3)}`}</span>
          </div>
        )}
      </div>
      {spec.legend && (spec.categories.length > 0 || spec.sizeRange) && (
        <div className="lp-map-legend" aria-hidden="true">
          {spec.colorName && spec.categories.length > 0 && <span className="lp-map-lname">{spec.colorName}</span>}
          {spec.categories.map((c) => (
            <span key={c.name} className="lp-map-key">
              <i className={`lp-map-c${c.step}`} />
              {c.name}
            </span>
          ))}
          {spec.sizeRange && spec.sizeName && (
            <span className="lp-map-key">
              <i className="lp-map-size lp-map-size-s" />
              <i className="lp-map-size lp-map-size-l" />
              {`${spec.sizeName}: ${spec.format(spec.sizeRange[0])} to ${spec.format(spec.sizeRange[1])}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
