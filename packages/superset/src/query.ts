import { type FilterClause, MAX_POINTS, type Query, type TimeRange, type Widget } from "@lenspack/core";
import { type BoundDimension, type BoundPlan, ResolveError } from "@lenspack/engine";
import { type Pack, maybeFragmentFor } from "@lenspack/spec";

import type { Binding } from "./catalogue";

// One translation, two directions of use. A lenspack query becomes a Superset
// query object (for /api/v1/chart/data, which the connector runs) and a chart's
// form_data (what Superset saves and its own UI renders). Reading a dashboard
// back runs formDataToWidget, which recognises only what it can say exactly;
// anything else stays Superset's.

export type AdhocFilter = { expressionType: "SIMPLE" | "SQL"; clause: "WHERE"; subject?: string; operator?: string; comparator?: unknown; sqlExpression?: string };
export type QueryFilter = { col: string; op: string; val?: unknown };
export type Metric = string | { expressionType: "SQL"; sqlExpression: string; label: string };
export type Column = string | { expressionType: "SQL"; sqlExpression: string; label: string; columnType?: "BASE_AXIS"; timeGrain?: string };
export type QueryObject = {
  columns: Column[];
  metrics: Metric[];
  filters: QueryFilter[];
  orderby: [Metric | string, boolean][];
  row_limit: number;
  /** Rows skipped first: a later page of a paged table. */
  row_offset?: number;
  series_limit?: number;
  series_limit_metric?: Metric;
  extras: { where?: string; having?: string; time_grain_sqla?: string };
  is_timeseries?: boolean;
  time_range?: string;
};

export const GRAIN: Record<string, string> = { hour: "PT1H", day: "P1D", week: "P1W", month: "P1M", quarter: "P3M", year: "P1Y" };
const GRAIN_BACK = Object.fromEntries(Object.entries(GRAIN).map(([k, v]) => [v, k]));
export const N = "__lenspack_n";
export const BUCKET = "__lenspack_bucket";

const sqlString = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;
const likeEscape = (v: unknown) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
const ident = (c: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c.replace(/"/g, '""')}"`);

/** The column a bound dimension reads, as Superset names it. */
export function columnOf(def: { key: string; field?: string; sql?: unknown }): string {
  if (def.field) return def.field;
  const s = def.sql ? maybeFragmentFor(def.sql as never, "superset") : undefined;
  if (s) return s;
  throw new ResolveError("NOT_SUPPORTED", `"${def.key}" is computed by an expression Superset does not have; give it a Superset column`, def.key);
}

/** The metric a measure is in Superset: its saved metric, or COUNT(*). */
export function metricOf(key: string, binding: Binding): Metric {
  const b = binding.metrics.get(key);
  if (!b) throw new ResolveError("NOT_SUPPORTED", `"${key}" is not a Superset metric`, key);
  const ds = binding.datasets.get(b.entity);
  return b.metric ?? ds?.countMetric ?? { expressionType: "SQL", sqlExpression: "COUNT(*)", label: key };
}
export const metricLabel = (m: Metric) => (typeof m === "string" ? m : m.label);

// ---- filters ----------------------------------------------------------------

type Op = FilterClause["op"];

/** A lenspack filter as Superset filters: simple where Superset has the operator, SQL where it does not. */
export function filterParts(col: string, op: Op, value: unknown): { simple?: QueryFilter[]; sql?: string } {
  const list = Array.isArray(value) ? value : [value];
  const c = ident(col);
  switch (op) {
    case "eq":
      return { simple: [{ col, op: "==", val: value }] };
    case "neq":
      return { simple: [{ col, op: "!=", val: value }] };
    case "in":
      return { simple: [{ col, op: "IN", val: list }] };
    case "gte":
      return { simple: [{ col, op: ">=", val: value }] };
    case "lte":
      return { simple: [{ col, op: "<=", val: value }] };
    case "between":
      return { simple: [{ col, op: ">=", val: list[0] }, { col, op: "<=", val: list[1] }] };
    case "contains":
      return { simple: [{ col, op: "ILIKE", val: `%${value}%` }] };
    case "subtree":
      return { sql: `(${list.map((v) => `${c} = ${sqlString(v)} OR ${c} LIKE ${sqlString(`${likeEscape(v)}.%`)}`).join(" OR ")})` };
    case "segment":
      return { sql: `(${list.map((v) => `'|' || ${c} || '|' LIKE ${sqlString(`%|${likeEscape(v)}|%`)}`).join(" OR ")})` };
  }
}

const SIMPLE_OP: Record<string, string> = { "==": "==", "!=": "!=", IN: "IN", ">=": ">=", "<=": "<=", ILIKE: "ILIKE" };

export function adhocFilters(col: string, op: Op, value: unknown): AdhocFilter[] {
  const p = filterParts(col, op, value);
  if (p.sql) return [{ expressionType: "SQL", clause: "WHERE", sqlExpression: p.sql }];
  return p.simple!.map((f) => ({ expressionType: "SIMPLE", clause: "WHERE", subject: f.col, operator: SIMPLE_OP[f.op]!, comparator: f.val }));
}

// ---- time ---------------------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 19);
export const absoluteRange = (w: { from: Date; to: Date }) => `${iso(w.from)} : ${iso(w.to)}`;

const UNIT: Record<string, string> = { h: "hour", d: "day", w: "week", m: "month", y: "year" };

/** A lenspack time range as a Superset time_range, kept relative so the saved chart keeps meaning "the last 30 days". */
export function timeRangeOf(t: TimeRange | undefined): string {
  if (!t) return "No filter";
  if ("last" in t) {
    const n = Number(t.last.slice(0, -1));
    return `DATEADD(DATETIME("now"), -${n}, ${UNIT[t.last.slice(-1)]}) : now`;
  }
  if ("from" in t) return `${t.from.slice(0, 19)} : ${t.to.slice(0, 19)}`;
  const offset = t.offset ?? 0;
  const count = t.count ?? 1;
  const start = `DATETRUNC(DATETIME("today"), ${t.period})`;
  const from = offset - count + 1 === 0 ? start : `DATEADD(${start}, ${offset - count + 1}, ${t.period})`;
  const to = offset === 0 ? "now" : `DATEADD(${start}, ${offset + 1}, ${t.period})`;
  return `${from} : ${to}`;
}

/** Back: only the forms timeRangeOf writes (and Superset's "Last …" presets) are read; anything else is not ours to rewrite. */
export function timeRangeBack(s: string | undefined | null): TimeRange | undefined | null {
  if (!s || s === "No filter") return undefined;
  const last = /^DATEADD\(DATETIME\("now"\), -(\d+), (hour|day|week|month|year)\) : now$/.exec(s);
  if (last) return { last: `${last[1]}${Object.entries(UNIT).find(([, u]) => u === last[2])![0]}` };
  const preset: Record<string, TimeRange> = { "Last day": { last: "1d" }, "Last week": { last: "7d" }, "Last month": { last: "30d" }, "Last quarter": { last: "90d" }, "Last year": { last: "365d" } };
  if (preset[s]) return preset[s];
  const abs = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d) : (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)$/.exec(s);
  if (abs) return { from: `${abs[1]}Z`, to: `${abs[2]}Z` };
  const cal = /^(?:DATEADD\()?DATETRUNC\(DATETIME\("today"\), (day|week|month|quarter|year)\)(?:, (-?\d+), \1\))? : (now|DATEADD\(DATETRUNC\(DATETIME\("today"\), \1\), (-?\d+), \1\))$/.exec(s);
  if (cal) {
    const period = cal[1] as "day";
    const fromOff = Number(cal[2] ?? 0);
    const offset = cal[3] === "now" ? 0 : Number(cal[4]) - 1;
    return { period, offset, count: offset - fromOff + 1 };
  }
  return null;
}

// ---- the connector's query object ---------------------------------------------------

/** A bound plan as one or two Superset query objects (the second: the previous period). */
export function queryObjects(bound: BoundPlan, binding: Binding): { queries: QueryObject[]; datasetId: number; metric: Metric | null } {
  const ds = binding.datasets.get(bound.root);
  if (!ds) throw new ResolveError("UNKNOWN_ENTITY", `"${bound.root}" is not a Superset dataset`, bound.root);
  const q = bound.query;
  if (bound.measure?.kind === "derived") throw new ResolveError("NOT_SUPPORTED", `"${bound.measure.def.key}" is arithmetic over other measures; in Superset, save it as one metric`, bound.measure.def.key);
  const metric = bound.measure ? metricOf(bound.measure.def.key, binding) : null;
  const filters: QueryFilter[] = [];
  const where: string[] = [];
  for (const f of bound.filters) {
    const p = filterParts(columnOf(f.dimension.def), f.op as Op, f.value);
    if (p.simple) filters.push(...p.simple);
    if (p.sql) where.push(p.sql);
  }
  const col = (d: BoundDimension) => columnOf(d.def);
  const timed = (w: { from: Date; to: Date } | null): QueryFilter[] => (w && ds.time ? [{ col: ds.time, op: "TEMPORAL_RANGE", val: absoluteRange(w) }] : []);
  const base = (window: { from: Date; to: Date } | null): Omit<QueryObject, "columns" | "metrics" | "orderby" | "row_limit"> => ({
    filters: [...filters, ...timed(window)],
    extras: where.length ? { where: where.join(" AND ") } : {},
  });
  const n: Metric = { expressionType: "SQL", sqlExpression: "COUNT(*)", label: N };
  let queries: QueryObject[];
  switch (q.kind) {
    case "value":
      queries = [{ ...base(bound.time), columns: [], metrics: [metric!, n], orderby: [], row_limit: 1 }];
      if (bound.previous) queries.push({ ...base(bound.previous), columns: [], metrics: [metric!, n], orderby: [], row_limit: 1 });
      break;
    case "breakdown": {
      const columns = [col(bound.dimension!), ...(bound.split ? [col(bound.split)] : [])];
      const sortBy = q.sortBy ?? "value";
      const orderby: [Metric | string, boolean][] =
        sortBy === "group" ? [[columns[0]!, q.sort === "asc"]] : sortBy === "none" ? [] : [[metric!, q.sort === "asc"], ...(sortBy === "value" ? ([[columns[0]!, true]] as [string, boolean][]) : [])];
      // With a split, the limit is on groups: the top groups by the measure, every split within them.
      const one: QueryObject = { ...base(bound.time), columns, metrics: [metric!, n], orderby, row_limit: bound.split ? Math.min(10_000, q.limit * 100) : q.limit };
      queries = [one];
      if (bound.previous) queries.push({ ...base(bound.previous), columns, metrics: [metric!], orderby: [], row_limit: 10_000 });
      break;
    }
    case "series": {
      if (!ds.time) throw new ResolveError("NO_TIME", `"${bound.root}" has no time column in Superset`, q.measure);
      const axis: Column = { expressionType: "SQL", sqlExpression: ds.time, label: BUCKET, columnType: "BASE_AXIS", timeGrain: GRAIN[q.grain] };
      queries = [{ ...base(bound.time), columns: [axis, ...(bound.dimension ? [col(bound.dimension)] : [])], metrics: [metric!, n], orderby: [], row_limit: 50_000, extras: { ...base(bound.time).extras, time_grain_sqla: GRAIN[q.grain] } }];
      break;
    }
    case "rows": {
      // A page needs an order, or the next page is any rows at all: without one, the columns
      // in the order listed (as the SQL planner orders a page).
      const orderby: [string, boolean][] = bound.orderBy ? [[col(bound.orderBy.dimension), bound.orderBy.dir === "asc"]] : q.offset !== undefined ? bound.columns.map((c) => [col(c), true]) : [];
      queries = [{ ...base(bound.time), columns: bound.columns.map(col), metrics: [], orderby, row_limit: q.limit, ...(q.offset ? { row_offset: q.offset } : {}) }];
      break;
    }
    case "points": {
      // Each point's coordinates (and colour, label); with a size, grouped per point
      // and largest first. One row past the limit says the list was cut.
      const { lat, lon } = bound.geo!;
      const columns = [...new Set([lat, lon, ...bound.columns.map(col)])];
      const located: QueryFilter[] = [{ col: lat, op: "IS NOT NULL" }, { col: lon, op: "IS NOT NULL" }];
      const b = base(bound.time);
      queries = [{ ...b, filters: [...located, ...b.filters], columns, metrics: metric ? [metric] : [], orderby: metric ? [[metric, false]] : [], row_limit: q.limit + 1 }];
      break;
    }
  }
  return { queries, datasetId: ds.id, metric };
}

// ---- widgets ↔ form_data --------------------------------------------------------------

export type ChartSpec = { viz_type: string; params: Record<string, unknown>; datasetId: number };

const ECHARTS: Record<string, string> = { line: "echarts_timeseries_line", area: "echarts_area", bar: "echarts_timeseries_bar" };
// A heatmap breakdown's column order as Superset's sort_x_axis: [ascending, descending].
const HEAT_SORT_X: Record<string, [string, string] | undefined> = { group: ["alpha_asc", "alpha_desc"], value: ["value_asc", "value_desc"], measure: ["value_asc", "value_desc"] };
const D3: Record<string, string> = { percent: ".1%", compact: ".3s", currency: "$,.2f", number: ",d", duration: ",.1f" };

/** The entity a widget's query reads: the measure's, or the rows or points query's. */
export function entityOfQuery(q: Query, pack: Pack): string | null {
  if (q.kind === "rows" || q.kind === "points") return q.entity;
  return pack.measures.find((m) => m.key === q.measure)?.entity ?? null;
}

/** The column a dimension key reads on an entity. */
export function columnFor(key: string, entity: string, binding: Binding): string {
  const c = binding.columns.get(key)?.get(entity);
  if (!c) throw new ResolveError("NEEDS_JOIN", `"${key}" is not a column of the "${entity}" dataset`, key);
  return c;
}

/** A widget as a Superset chart. Null for a text widget, which is a markdown block on the dashboard instead. */
export function widgetToChart(widget: Widget, pack: Pack, binding: Binding): ChartSpec | null {
  if (widget.kind === "text") return null;
  const q = widget.query;
  const entity = entityOfQuery(q, pack);
  const ds = entity ? binding.datasets.get(entity) : undefined;
  if (!entity || !ds) throw new ResolveError("UNKNOWN_ENTITY", "This widget's query names no Superset dataset");
  const colFor = (key: string) => columnFor(key, entity, binding);
  const adhoc_filters: AdhocFilter[] = (q.filters ?? []).flatMap((f) => adhocFilters(colFor(f.dimension), f.op, f.value));
  if (ds.time) adhoc_filters.push({ expressionType: "SIMPLE", clause: "WHERE", subject: ds.time, operator: "TEMPORAL_RANGE", comparator: timeRangeOf(q.time) });
  const common = { datasource: `${ds.id}__table`, adhoc_filters, time_range: timeRangeOf(q.time), slice_name: widget.title, lenspack: { widget: { ...widget, title: undefined } } };
  if (q.kind === "points") return pointsChart(widget, q, ds.id, entity, common, colFor, pack, binding);
  const metrics = q.kind === "rows" ? [] : [metricOf(q.measure, binding), ...(q.measures ?? []).map((m) => metricOf(m, binding))];
  const fmt = q.kind === "rows" ? undefined : D3[pack.measures.find((m) => m.key === q.measure)?.format ?? "number"];

  if (widget.kind === "kpi") {
    if (q.kind === "series") return { viz_type: "big_number", datasetId: ds.id, params: { ...common, metric: metrics[0], x_axis: ds.time, time_grain_sqla: GRAIN[q.grain], show_trend_line: true, y_axis_format: fmt } };
    if (q.kind === "value") return { viz_type: "big_number_total", datasetId: ds.id, params: { ...common, metric: metrics[0], y_axis_format: fmt, ...(q.compare ? { subheader: "vs previous period: see Lenspack" } : {}) } };
  }
  if (widget.kind === "table" || q.kind === "rows" || (widget.kind === "kpi" && q.kind === "breakdown")) {
    if (q.kind === "rows") return { viz_type: "table", datasetId: ds.id, params: { ...common, query_mode: "raw", all_columns: q.columns.map(colFor), order_by_cols: q.orderBy ? [JSON.stringify([colFor(q.orderBy.key), q.orderBy.dir === "asc"])] : [], row_limit: q.limit, server_pagination: false } };
    const groupby = q.kind === "breakdown" ? [colFor(q.dimension), ...(q.by ? [colFor(q.by)] : [])] : q.kind === "series" ? [ds.time!, ...(q.by ? [colFor(q.by)] : [])] : [];
    return { viz_type: "table", datasetId: ds.id, params: { ...common, query_mode: "aggregate", groupby, metrics, ...(q.kind === "series" ? { time_grain_sqla: GRAIN[q.grain], temporal_columns_lookup: { [ds.time!]: true } } : {}), row_limit: q.kind === "breakdown" ? q.limit : 1000, order_desc: q.kind === "breakdown" ? q.sort !== "asc" : true, ...(q.kind === "breakdown" ? { timeseries_limit_metric: metrics[0] } : {}), server_pagination: false } };
  }
  if (widget.kind !== "chart") throw new ResolveError("NOT_SUPPORTED", "This widget has no Superset chart");
  const chart = widget.chart;
  if (chart === "pie") {
    if (q.kind !== "breakdown") throw new ResolveError("NOT_SUPPORTED", "A pie in Superset shows a breakdown: one dimension, one measure");
    return { viz_type: "pie", datasetId: ds.id, params: { ...common, groupby: [colFor(q.dimension)], metric: metrics[0], row_limit: q.limit, sort_by_metric: true, show_legend: widget.options?.legend !== false, number_format: fmt === ",d" ? "SMART_NUMBER" : fmt, show_labels: true, label_type: "key_percent" } };
  }
  if (chart === "heatmap") {
    // Superset's heatmap sorts a time axis by the raw column while grouping by its buckets, which
    // the database refuses, and unsorted its days come in any order: a series heatmap cannot be drawn.
    if (q.kind === "series")
      throw new ResolveError("NOT_SUPPORTED", "Superset's heatmap cannot keep a time axis in order once it is bucketed by day, week or month. Make it a breakdown instead: columns a day or date label dimension, if the pack has one, split by the rows");
    if (q.kind !== "breakdown" || !q.by) throw new ResolveError("NOT_SUPPORTED", "A heatmap in Superset shades one metric over two columns: a breakdown split by a second dimension");
    const sortX = HEAT_SORT_X[q.sortBy ?? "value"]?.[q.sort === "asc" ? 0 : 1];
    if (!sortX) throw new ResolveError("NOT_SUPPORTED", "A heatmap in Superset reads its columns in their own order or by the metric");
    return {
      viz_type: "heatmap_v2",
      datasetId: ds.id,
      params: {
        ...common,
        x_axis: colFor(q.dimension),
        // Superset's heatmap takes one row column, saved as a string rather than a list.
        groupby: colFor(q.by),
        metric: metrics[0],
        // With a split, a breakdown's limit is on columns; Superset's is on cells.
        row_limit: q.limit * 50,
        sort_x_axis: sortX,
        sort_y_axis: "alpha_asc",
        normalize_across: "heatmap",
        legend_type: "continuous",
        linear_color_scheme: "superset_seq_1",
        show_legend: widget.options?.legend !== false,
        show_values: false,
        y_axis_format: fmt === ",d" ? "SMART_NUMBER" : fmt,
      },
    };
  }
  if (q.kind === "series")
    return { viz_type: ECHARTS[chart]!, datasetId: ds.id, params: { ...common, x_axis: ds.time, time_grain_sqla: GRAIN[q.grain], metrics, groupby: q.by ? [colFor(q.by)] : [], row_limit: 10_000, ...(q.by ? { series_limit: 12 } : {}), show_legend: widget.options?.legend !== false, y_axis_format: fmt === ",d" ? "SMART_NUMBER" : fmt, ...(chart === "area" || (chart === "bar" && q.by) ? { stack: "Stack" } : {}) } };
  if (q.kind === "breakdown")
    return {
      viz_type: ECHARTS[chart]!,
      datasetId: ds.id,
      params: { ...common, x_axis: colFor(q.dimension), metrics, groupby: q.by ? [colFor(q.by)] : [], row_limit: q.limit * (q.by ? 50 : 1), x_axis_sort: q.sortBy === "group" ? colFor(q.dimension) : metricLabel(metrics[0]!), x_axis_sort_asc: q.sort === "asc", show_legend: widget.options?.legend !== false, y_axis_format: fmt === ",d" ? "SMART_NUMBER" : fmt, ...(q.by ? { stack: "Stack" } : {}) },
    };
  // A chart of one value: a big number is what Superset has for it.
  return { viz_type: "big_number_total", datasetId: ds.id, params: { ...common, metric: metrics[0], y_axis_format: fmt } };
}

export const MAPBOX_LIGHT = "mapbox://styles/mapbox/light-v9";
// A point with no size: the radius Superset's own scatter map defaults to, in metres.
const FIXED_RADIUS = 1000;

/**
 * Points as Superset's deck.gl scatter map: spatial from the entity's coordinate columns,
 * colour by a column, size by a saved metric (Superset then groups per point, as Lenspack does).
 * Superset reads this through its legacy explore_json path, from the form data alone. A table of
 * points lists them instead.
 */
function pointsChart(
  widget: Exclude<Widget, { kind: "text" }>,
  q: Extract<Query, { kind: "points" }>,
  datasetId: number,
  entity: string,
  common: Record<string, unknown>,
  colFor: (key: string) => string,
  pack: Pack,
  binding: Binding,
): ChartSpec {
  const geo = binding.geo.get(entity);
  if (!geo) throw new ResolveError("NOT_SUPPORTED", `"${entity}" has no latitude and longitude columns in Superset`, entity);
  const size = q.size ? metricOf(q.size, binding) : null;
  const named = [q.label, q.color].filter((k): k is string => !!k).map(colFor);
  if (widget.kind === "table") {
    const cols = [...new Set([geo.lat, geo.lon, ...named])];
    if (!size) return { viz_type: "table", datasetId, params: { ...common, query_mode: "raw", all_columns: cols, order_by_cols: [], row_limit: q.limit, server_pagination: false } };
    return { viz_type: "table", datasetId, params: { ...common, query_mode: "aggregate", groupby: cols, metrics: [size], row_limit: q.limit, order_desc: true, timeseries_limit_metric: size, server_pagination: false } };
  }
  if (widget.kind !== "chart" || widget.chart !== "map") throw new ResolveError("NOT_SUPPORTED", "Points are drawn as a map, or listed in a table");
  // Superset turns a size into metres (by area or radius), times the multiplier, then clamps it to the
  // pixel range. A count by area, a third of a km² per unit, spreads a handful to a few hundred over
  // that range at a state's zoom; a share by its radius, 8 km for a whole. Measured on a test map.
  const percent = q.size ? pack.measures.find((m) => m.key === q.size)?.format === "percent" : false;
  return {
    viz_type: "deck_scatter",
    datasetId,
    params: {
      ...common,
      spatial: { type: "latlong", latCol: geo.lat, lonCol: geo.lon },
      row_limit: q.limit,
      filter_nulls: true,
      point_radius_fixed: size ? { type: "metric", value: size } : { type: "fix", value: FIXED_RADIUS },
      point_unit: size ? (percent ? "radius_km" : "square_km") : "square_m",
      min_radius: 3,
      max_radius: 20,
      multiplier: size ? (percent ? 8 : 0.3) : 1,
      ...(q.color ? { dimension: colFor(q.color), color_scheme: "supersetColors" } : { color_picker: { r: 26, g: 133, b: 160, a: 1 } }),
      js_columns: q.label ? [colFor(q.label)] : [],
      mapbox_style: binding.mapStyle ?? MAPBOX_LIGHT,
      autozoom: true,
      legend_position: "tr",
      legend_format: "SMART_NUMBER",
    },
  };
}

/** The query context Superset keeps beside a chart's form_data (reports and the chart-data-by-id API read it). Null for a deck.gl map, which Superset reads from its form data. */
export function queryContextOf(spec: ChartSpec): Record<string, unknown> | null {
  if (spec.viz_type === "deck_scatter") return null;
  const p = spec.params as Record<string, any>;
  if (spec.viz_type === "heatmap_v2") return heatmapContext(spec);
  const metrics = p.metrics ?? (p.metric ? [p.metric] : []);
  const isTime = p.x_axis && p.x_axis === p.adhoc_filters?.find((f: AdhocFilter) => f.operator === "TEMPORAL_RANGE")?.subject;
  const columns =
    p.query_mode === "raw"
      ? p.all_columns
      : [...(p.x_axis ? [isTime ? { columnType: "BASE_AXIS", sqlExpression: p.x_axis, label: p.x_axis, expressionType: "SQL", timeGrain: p.time_grain_sqla } : p.x_axis] : []), ...(p.groupby ?? [])];
  return {
    datasource: { id: spec.datasetId, type: "table" },
    force: false,
    queries: [
      {
        filters: (p.adhoc_filters ?? []).filter((f: AdhocFilter) => f.expressionType === "SIMPLE").map((f: AdhocFilter) => ({ col: f.subject, op: f.operator, val: f.comparator })),
        extras: { where: (p.adhoc_filters ?? []).filter((f: AdhocFilter) => f.expressionType === "SQL").map((f: AdhocFilter) => `(${f.sqlExpression})`).join(" AND "), having: "", ...(p.time_grain_sqla ? { time_grain_sqla: p.time_grain_sqla } : {}) },
        columns,
        metrics: p.query_mode === "raw" ? [] : metrics,
        orderby: metrics.length ? [[metrics[0], false]] : [],
        row_limit: p.row_limit ?? 1000,
        time_range: p.time_range,
      },
    ],
    form_data: { ...p, viz_type: spec.viz_type },
    result_format: "json",
    result_type: "full",
  };
}

/** A heatmap's query, as Superset's heatmap_v2 builds it: both axes as columns, sorted per axis, ranked for the shading. Lenspack writes only a breakdown's, so neither axis is time. */
function heatmapContext(spec: ChartSpec): Record<string, unknown> {
  const p = spec.params as Record<string, any>;
  const columns = [p.x_axis, ...[p.groupby].flat()];
  const label = typeof p.metric === "string" ? p.metric : p.metric?.label;
  const order = (sort: string | undefined, col: unknown): [unknown, boolean][] => (sort ? [[sort.includes("value") ? p.metric : col, sort.includes("asc")]] : []);
  return {
    datasource: { id: spec.datasetId, type: "table" },
    force: false,
    queries: [
      {
        filters: (p.adhoc_filters ?? []).filter((f: AdhocFilter) => f.expressionType === "SIMPLE").map((f: AdhocFilter) => ({ col: f.subject, op: f.operator, val: f.comparator })),
        extras: { where: "", having: "" },
        columns,
        metrics: [p.metric],
        orderby: [...order(p.sort_x_axis, columns[0]), ...order(p.sort_y_axis, columns[1])],
        row_limit: p.row_limit ?? 10_000,
        time_range: p.time_range,
        post_processing: [{ operation: "rank", options: { metric: label, group_by: p.normalize_across === "x" ? p.x_axis : p.normalize_across === "y" ? columns[1] : undefined } }],
      },
    ],
    form_data: { ...p, viz_type: spec.viz_type },
    result_format: "json",
    result_type: "full",
  };
}

// ---- back: a saved chart as a widget, when it says exactly what a widget can ----

export type Recognised = { widget: Widget } | { widget: null; reason: string };

/** A Superset chart as a lenspack widget. Charts lenspack wrote carry their query; others are read when they map exactly. */
export function chartToWidget(chart: { slice_name: string; viz_type: string; params: Record<string, any>; datasource_id?: number }, pack: Pack, binding: Binding): Recognised {
  const p = chart.params ?? {};
  const title = (chart.slice_name || "Untitled chart").slice(0, 120);
  // Our own: the query it was written from, if Superset's form still says the same thing.
  if (p.lenspack?.widget?.kind) {
    const { title: _t, ...rest } = p.lenspack.widget;
    const w = { title, ...rest } as Widget;
    try {
      const again = widgetToChart(w, pack, binding);
      if (again && again.viz_type === chart.viz_type && sameForm(again.params, p)) return { widget: w };
    } catch {
      /* fall through to reading the form */
    }
  }
  const datasetId = chart.datasource_id ?? Number(String(p.datasource ?? "").split("__")[0]);
  const entity = binding.entityOf.get(datasetId);
  if (!entity) return { widget: null, reason: "its dataset is not in the pack" };
  const measureKey = (m: unknown): string | null => (typeof m === "string" ? (binding.measureOf.get(entity)?.get(m) ?? null) : null);
  const dimKey = (c: unknown): string | null => (typeof c === "string" ? (binding.dimensionOf.get(entity)?.get(c) ?? null) : null);
  const ds = binding.datasets.get(entity)!;

  // Filters and window.
  const filters: FilterClause[] = [];
  let time: TimeRange | undefined;
  for (const f of (p.adhoc_filters ?? []) as AdhocFilter[]) {
    if (f.expressionType !== "SIMPLE") return { widget: null, reason: "it has a custom SQL filter" };
    if (f.operator === "TEMPORAL_RANGE") {
      const t = timeRangeBack(f.comparator as string);
      if (t === null) return { widget: null, reason: `its time range "${f.comparator}" is not one lenspack writes` };
      time = t;
      continue;
    }
    const key = dimKey(f.subject);
    if (!key) return { widget: null, reason: `it filters on "${f.subject}", which is not a pack dimension` };
    const op = ({ "==": "eq", "!=": "neq", IN: "in", ">=": "gte", "<=": "lte" } as Record<string, FilterClause["op"]>)[f.operator ?? ""];
    if (!op) return { widget: null, reason: `its filter operator ${f.operator} has no lenspack form` };
    filters.push({ dimension: key, op, value: f.comparator as never });
  }
  const common = { ...(time ? { time } : {}), ...(filters.length ? { filters } : {}) };
  const metricKeys = (list: unknown[]) => list.map(measureKey);

  switch (chart.viz_type) {
    case "big_number_total": {
      const m = measureKey(p.metric);
      if (!m) return { widget: null, reason: "its metric is not a saved metric of the dataset" };
      return { widget: { title, kind: "kpi", aggregate: "last", query: { kind: "value", measure: m, ...common } } as Widget };
    }
    case "big_number": {
      const m = measureKey(p.metric);
      const grain = GRAIN_BACK[p.time_grain_sqla];
      if (!m || !grain) return { widget: null, reason: "its metric or time grain has no lenspack form" };
      return { widget: { title, kind: "kpi", aggregate: "last", query: { kind: "series", measure: m, grain, ...common } } as Widget };
    }
    case "pie": {
      const m = measureKey(p.metric);
      const d = dimKey(p.groupby?.[0]);
      if (!m || !d || (p.groupby?.length ?? 0) !== 1) return { widget: null, reason: "its metric or slices are not pack keys" };
      return { widget: { title, kind: "chart", chart: "pie", options: { legend: p.show_legend !== false, colorScheme: "default" }, query: { kind: "breakdown", dimension: d, measure: m, limit: Math.max(2, Math.min(500, p.row_limit ?? 12)), sort: "desc", ...common } } as Widget };
    }
    case "echarts_timeseries_line":
    case "echarts_timeseries_bar":
    case "echarts_area": {
      const kind = chart.viz_type === "echarts_area" ? "area" : chart.viz_type === "echarts_timeseries_bar" ? "bar" : "line";
      const ms = metricKeys(p.metrics ?? []);
      if (!ms.length || ms.some((m) => !m)) return { widget: null, reason: "a metric is not a saved metric of the dataset" };
      const by = p.groupby?.length ? dimKey(p.groupby[0]) : undefined;
      if (by === null || (p.groupby?.length ?? 0) > 1) return { widget: null, reason: "it is split by something other than one pack dimension" };
      const [measure, ...rest] = ms as string[];
      const options = { legend: p.show_legend !== false, colorScheme: "default" as const };
      if (p.x_axis === ds.time || !p.x_axis) {
        const grain = GRAIN_BACK[p.time_grain_sqla] ?? "day";
        return { widget: { title, kind: "chart", chart: kind, options, query: { kind: "series", measure: measure!, grain, ...(by ? { by } : {}), ...(rest.length ? { measures: rest } : {}), ...common } } as Widget };
      }
      const d = dimKey(p.x_axis);
      if (!d) return { widget: null, reason: `its x-axis "${p.x_axis}" is not a pack dimension` };
      return { widget: { title, kind: "chart", chart: kind, options, query: { kind: "breakdown", dimension: d, measure: measure!, limit: Math.max(2, Math.min(500, by ? Math.ceil((p.row_limit ?? 600) / 50) : (p.row_limit ?? 12))), sort: p.x_axis_sort_asc ? "asc" : "desc", ...(by ? { by } : {}), ...(rest.length ? { measures: rest } : {}), ...common } } as Widget };
    }
    case "table": {
      if (p.query_mode === "raw") {
        const cols = (p.all_columns ?? []).map(dimKey);
        if (!cols.length || cols.some((c: string | null) => !c)) return { widget: null, reason: "a column is not a pack dimension" };
        return { widget: { title, kind: "table", pageSize: 10, query: { kind: "rows", entity, columns: cols, limit: Math.max(1, Math.min(1000, p.row_limit ?? 50)), ...common } } as Widget };
      }
      const ms = metricKeys(p.metrics ?? []);
      if (!ms.length || ms.some((m) => !m)) return { widget: null, reason: "a metric is not a saved metric of the dataset" };
      const groups = (p.groupby ?? []).map(dimKey);
      if (groups.some((g: string | null) => !g) || groups.length > 2) return { widget: null, reason: "its groups are not pack dimensions" };
      const [measure, ...rest] = ms as string[];
      const extra = rest.length ? { measures: rest } : {};
      if (!groups.length) return { widget: { title, kind: "table", pageSize: 10, query: { kind: "value", measure: measure!, ...extra, ...common } } as Widget };
      return { widget: { title, kind: "table", pageSize: 10, query: { kind: "breakdown", dimension: groups[0], ...(groups[1] ? { by: groups[1] } : {}), measure: measure!, limit: Math.max(2, Math.min(500, p.row_limit ?? 12)), sort: p.order_desc === false ? "asc" : "desc", ...extra, ...common } } as Widget };
    }
    case "heatmap_v2": {
      const m = measureKey(p.metric);
      if (!m) return { widget: null, reason: "its metric is not a saved metric of the dataset" };
      const rowsCol = [p.groupby].flat().filter((g: unknown) => g != null && g !== "");
      if (rowsCol.length !== 1) return { widget: null, reason: "its rows are not one column" };
      const by = dimKey(rowsCol[0]);
      if (!by) return { widget: null, reason: `its rows "${rowsCol[0]}" are not a pack dimension` };
      // Lenspack shades every cell on one scale, by value, with rows A to Z.
      if ((p.normalize_across ?? "heatmap") !== "heatmap") return { widget: null, reason: `it shades each ${p.normalize_across === "x" ? "column" : "row"} on its own scale` };
      if (p.normalized) return { widget: null, reason: "it shades cells by rank, not value" };
      if (p.sort_y_axis && p.sort_y_axis !== "alpha_asc") return { widget: null, reason: "its rows are not in A to Z order" };
      const options = { legend: p.show_legend !== false, colorScheme: "sequential" as const };
      // A time axis Superset cannot keep in order (see widgetToChart), so lenspack would not draw what Superset does.
      if (p.x_axis === ds.time) return { widget: null, reason: "its columns are time, which Superset's heatmap cannot keep in order" };
      const d = dimKey(p.x_axis);
      if (!d) return { widget: null, reason: `its columns "${p.x_axis}" are not a pack dimension` };
      if (d === by) return { widget: null, reason: "its rows and columns are the same column" };
      const sortX = ({ alpha_asc: ["group", "asc"], alpha_desc: ["group", "desc"] } as Record<string, [string, string]>)[p.sort_x_axis ?? ""];
      if (!sortX) return { widget: null, reason: p.sort_x_axis ? "its columns are sorted by the metric, cell by cell" : "its columns have no order" };
      const limit = Math.max(2, Math.min(500, Math.ceil((p.row_limit ?? 10_000) / 50)));
      return { widget: { title, kind: "chart", chart: "heatmap", options, query: { kind: "breakdown", dimension: d, by, measure: m, limit, sort: sortX[1], sortBy: sortX[0], ...common } } as Widget };
    }
    case "deck_scatter": {
      const geo = binding.geo.get(entity);
      const sp = p.spatial ?? {};
      if (!geo) return { widget: null, reason: "its dataset has no latitude and longitude Lenspack knows of" };
      if (sp.type !== "latlong" || sp.reverseCheckbox) return { widget: null, reason: "its points are not read from a latitude and a longitude column" };
      if (sp.latCol !== geo.lat || sp.lonCol !== geo.lon) return { widget: null, reason: `its points are read from "${sp.latCol}" and "${sp.lonCol}", not the dataset's coordinates` };
      if (p.time_grain_sqla) return { widget: null, reason: "it animates its points over time" };
      if (p.js_data_mutator || p.js_tooltip || p.js_onclick_href) return { widget: null, reason: "it runs custom JavaScript" };
      const radius = p.point_radius_fixed ?? { type: "fix" };
      const size = radius.type === "metric" ? measureKey(radius.value) : undefined;
      if (size === null) return { widget: null, reason: "its points are sized by something other than a saved metric of the dataset" };
      const color = p.dimension ? dimKey(p.dimension) : undefined;
      if (color === null) return { widget: null, reason: `its points are coloured by "${p.dimension}", which is not a pack dimension` };
      const extra = (p.js_columns ?? []) as unknown[];
      const label = extra.length === 1 ? dimKey(extra[0]) : extra.length === 0 ? undefined : null;
      if (label === null) return { widget: null, reason: "it carries extra columns on its points that are not one pack dimension" };
      const limit = Math.max(1, Math.min(MAX_POINTS, Number(p.row_limit) || 10_000));
      const query = { kind: "points", entity, ...(color ? { color } : {}), ...(size ? { size } : {}), ...(label ? { label } : {}), limit, ...common };
      return { widget: { title, kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query } as Widget };
    }
    default:
      return { widget: null, reason: `lenspack has no ${chart.viz_type} chart` };
  }
}

// Fields a person may change in Superset that our own query would not survive.
const MEANINGFUL = ["metric", "metrics", "groupby", "x_axis", "time_grain_sqla", "adhoc_filters", "row_limit", "all_columns", "query_mode", "sort_x_axis", "sort_y_axis", "normalize_across", "normalized", "spatial", "point_radius_fixed", "dimension", "js_columns"];
function sameForm(a: Record<string, unknown>, b: Record<string, unknown>) {
  return MEANINGFUL.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}
