import { z } from "zod";

// A dashboard is data, not code. The model never emits JSX and never emits a
// query — it edits this document, and the renderer is the only code.
//
// Nothing in this file names a domain. A widget names a dimension and a measure
// by key; whether those keys exist is decided by the catalogue the caller
// passes to the validator (see ops.ts), never by anything imported here.

export const GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export const FORMATS = ["number", "percent", "currency", "compact", "duration"] as const;
export const DIMENSION_TYPES = ["string", "number", "boolean", "time", "enum"] as const;
// heatmap: one measure over two dimensions as a grid of shaded cells. Columns are a
// breakdown's dimension (or a series' time buckets) and rows its `by`.
// map: the rows of an entity with a location, as points (a points query).
export const CHART_KINDS = ["bar", "line", "pie", "area", "heatmap", "map"] as const;
export const MAX_POINTS = 5000;
// A rows query's deepest page: capped so it stays a small top-N sort in the source.
export const MAX_OFFSET = 10000;
// subtree: a node of a dotted path and everything under it ("a.b" matches
// "a.b" and "a.b.c", not "a.bc").
// segment: one of the values is a whole segment of a "|"-separated path
// (a boundary path "KE|BOMET|SOTIK" has segment "BOMET", not "BOM").
// not_in: none of the values. Like neq, a row with no value is left out, on every source.
export const FILTER_OPS = ["eq", "neq", "in", "not_in", "gte", "lte", "between", "contains", "subtree", "segment"] as const;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const filterClauseSchema = z.object({
  dimension: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).min(1).max(100)]),
});
export type FilterClause = z.infer<typeof filterClauseSchema>;
/** A row filter the server puts on a caller (ctx.scope). With an entity, it narrows only the queries that read that entity. */
export type ScopeClause = FilterClause & { entity?: string };

// Relative ranges are resolved against "now" at query time, so a saved board
// keeps meaning "the last 30 days" rather than freezing the dates it was made.
// A calendar range counts whole periods in the pack's time zone, weeks from
// Monday: offset 0 is the current period up to now, -1 the one before it, and
// count takes that many periods ending at offset ("last month" is month, -1).
export const timeRangeSchema = z.union([
  z.object({ last: z.string().regex(/^[1-9]\d{0,3}[hdwmy]$/, 'e.g. "30d", "12w", "6m"') }),
  z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
  z.object({
    period: z.enum(GRAINS).exclude(["hour"]),
    offset: z.number().int().min(-500).max(0).optional(),
    count: z.number().int().min(1).max(500).optional(),
  }),
]);
export type TimeRange = z.infer<typeof timeRangeSchema>;

const common = {
  time: timeRangeSchema.optional(),
  filters: z.array(filterClauseSchema).max(20).optional(),
};

// Further measures over the same groups, drawn beside `measure` as table
// columns or extra series. `measure` stays the one that is sorted and ranked.
const alsoMeasures = { measures: z.array(z.string()).min(1).max(11).optional() };

// Arithmetic on the numbers the source returned, in steps, one after another.
// The source still computes every measure; these only combine its aggregated
// answers: a change between consecutive time buckets, a rolling window, a
// running total, one measure over another, and a summary of the buckets per
// group. See docs/features/compute.md for what each does with zeros and gaps.
export const COMPUTE_SUMMARIES = ["mean", "sum", "min", "max", "median", "last"] as const;
export const computeStepSchema = z.discriminatedUnion("op", [
  // The measure over another measure, per group (and per time bucket), before any other step.
  z.object({ op: z.literal("ratio"), to: z.string(), percent: z.boolean().optional() }),
  // Each time bucket against the one before it: the difference, or the relative change.
  z.object({ op: z.literal("change"), percent: z.boolean().optional() }),
  // Each time bucket with the window-1 before it, averaged or added.
  z.object({ op: z.literal("rolling"), fn: z.enum(["mean", "sum"]), window: z.number().int().min(2).max(366) }),
  z.object({ op: z.literal("running_total") }),
  // The time buckets of each group as one number. Always the last step.
  z.object({ op: z.literal("over_time"), fn: z.enum(COMPUTE_SUMMARIES) }),
]);
export type ComputeStep = z.infer<typeof computeStepSchema>;
export const computeSchema = z.object({
  // The time buckets the steps run over. A series has its own grain; a
  // breakdown or a value with a step over time names one here.
  grain: z.enum(GRAINS).optional(),
  steps: z.array(computeStepSchema).min(1).max(4),
});
export type Compute = z.infer<typeof computeSchema>;
const computed = { compute: computeSchema.optional() };

// What a widget is looking at. A closed union: every variant is something the
// compiler already knows how to build, and every string in it is a key.
export const querySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("breakdown"),
    dimension: z.string(),
    // A second dimension within each group: one row per (group, by) pair,
    // drawn as stacked or grouped bars.
    by: z.string().optional(),
    measure: z.string(),
    limit: z.number().int().min(2).max(500).default(12),
    sort: z.enum(["asc", "desc"]).default("desc"),
    // What the sort is on: the measure (largest first), or the group itself
    // (a date, a code) for a breakdown that reads in its own order.
    // "value" (the default) breaks ties by group so the same data always
    // lists the same way. "measure" sorts on the measure alone and "none"
    // keeps the source's grouping order: both for a migrated dashboard that
    // must list tied rows exactly as the system it replaces did.
    sortBy: z.enum(["value", "measure", "group", "none"]).optional(),
    // Each group beside its previous-period value, its share of the whole
    // population, and one "(other)" row for the population outside the groups
    // shown: numbers the reader would otherwise work out by hand, and get wrong.
    compare: z.enum(["previous_period"]).optional(),
    share: z.boolean().optional(),
    other: z.boolean().optional(),
    ...alsoMeasures,
    ...computed,
    ...common,
  }),
  z.object({
    kind: z.literal("series"),
    measure: z.string(),
    grain: z.enum(GRAINS).default("day"),
    by: z.string().optional(),
    ...alsoMeasures,
    ...computed,
    ...common,
  }),
  // The whole population rather than a breakdown of it. Its own variant
  // because a rate over everything is not the average of per-group rates.
  z.object({
    kind: z.literal("value"),
    measure: z.string(),
    compare: z.enum(["previous_period"]).optional(),
    ...alsoMeasures,
    ...computed,
    ...common,
  }),
  z.object({
    kind: z.literal("rows"),
    entity: z.string(),
    columns: z.array(z.string()).min(1).max(20),
    limit: z.number().int().min(1).max(1000).default(50),
    orderBy: z.object({ key: z.string(), dir: z.enum(["asc", "desc"]).default("desc") }).optional(),
    // Rows skipped before the first one returned: a later page of a paged
    // table. Set per request, not stored on a board.
    offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
    ...common,
  }),
  // The rows of an entity that has a location, one point each: its latitude and
  // longitude, a dimension that colours it by category, a measure that sizes it
  // (aggregated per point, so rows at one spot add up) and a dimension that names
  // it. With a size, the largest points are kept when there are more than limit;
  // without one, the source's own order, never one that would keep a corner of the map.
  z.object({
    kind: z.literal("points"),
    entity: z.string(),
    color: z.string().optional(),
    size: z.string().optional(),
    label: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_POINTS).default(MAX_POINTS),
    ...common,
  }),
]);
export type Query = z.infer<typeof querySchema>;

// Grid columns (of 12) per named width.
export const WIDTHS: Record<string, number> = { full: 12, half: 6, third: 4, quarter: 3 };
const placementWidth = z.union([z.enum(["full", "half", "third", "quarter"]), z.number().int().min(1).max(12)]);

// Intent rather than coordinates. Grid arithmetic is the one thing a language
// model reliably gets wrong, so the vocabulary it is given cannot express an
// overlap: the server packs, and overlap is unrepresentable rather than merely
// discouraged.
export const placementSchema = z.object({
  place: z.union([z.enum(["top", "bottom"]), z.string().regex(/^(after|below):.+$/)]).default("bottom"),
  width: placementWidth.default("half"),
  height: z.number().int().min(1).max(20).optional(),
});
export type Placement = z.infer<typeof placementSchema>;

export const layoutItemSchema = z.object({
  i: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  static: z.boolean().optional(),
  /**
   * The width the widget had before a packed board (grid.fill) widened it to the row's
   * edge. Placement treats the extra as free, so the next widget asked for that row can
   * still sit beside it; the widget gives the room back and the new last one is widened.
   */
  fw: z.number().int().min(1).optional(),
});
export type LayoutItem = z.infer<typeof layoutItemSchema>;

const baseWidget = { title: z.string().min(1).max(120) };

export const widgetSchema = z.preprocess(migrateKpi, z.discriminatedUnion("kind", [
  z.object({
    ...baseWidget,
    kind: z.literal("chart"),
    chart: z.enum(CHART_KINDS),
    query: querySchema,
    options: z
      .object({
        legend: z.boolean().default(true),
        // Named, never a colour value: the renderer owns the palette.
        colorScheme: z.enum(["default", "sequential"]).default("default"),
      })
      .default({}),
  }),
  // One number: a value query's answer, or a series' latest bucket drawn with its trend.
  // A summary of the buckets (the mean per day, the total) is a value query whose
  // compute ends with over_time.
  z.object({
    ...baseWidget,
    kind: z.literal("kpi"),
    query: querySchema,
    format: z.enum(FORMATS).optional(),
  }),
  z.object({
    ...baseWidget,
    kind: z.literal("table"),
    query: querySchema,
    // Rows per page. A rows query pages through the source (Prev/Next), a
    // breakdown pages through the groups it fetched.
    pageSize: z.number().int().min(5).max(200).default(10),
  }),
  z.object({
    ...baseWidget,
    kind: z.literal("text"),
    // A short note in a small markdown subset (bold, italics, lists, code), drawn as
    // elements, never as HTML: nothing in a config is ever interpreted as code, HTML
    // or CSS. A board holds no URLs, so a link in a note is drawn as its text.
    body: z.string().max(2000),
  }),
]));
export type Widget = z.infer<typeof widgetSchema>;

// A KPI saved before its summary over time was a compute step carries `aggregate`:
// how the renderer folded a series' buckets into one number. Read as follows:
// - "last", or none: dropped. A KPI of a series shows its latest bucket anyway.
// - "sum", "avg", "max" or "min" on a series: the KPI becomes a value query over the
//   same window and filters, whose steps end with that summary over the series'
//   buckets (avg becomes mean). The compute rules then apply: an empty bucket is 0
//   for a count or a sum and is skipped otherwise, and a percentage or an average is
//   never added up (such a sum is refused on the widget rather than shown).
// - Anything else is dropped, and the KPI shows the series' latest bucket: "count"
//   (how many buckets came back) has no step, a series split by a dimension added
//   up every split's buckets together, and a compute already four steps long has no
//   room for one more. On a value query the field never did anything.
const OVER_TIME = { sum: "sum", avg: "mean", max: "max", min: "min" } as const;
function migrateKpi(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "kpi" || !("aggregate" in raw)) return raw;
  const { aggregate, ...widget } = raw as { aggregate: unknown; query?: { kind?: unknown; by?: unknown; grain?: unknown; measures?: unknown; compute?: { steps?: unknown[] } } };
  const fn = OVER_TIME[aggregate as keyof typeof OVER_TIME];
  const q = widget.query;
  if (!fn || q?.kind !== "series" || q.by || (q.compute?.steps?.length ?? 0) >= 4) return widget;
  const { grain = "day", measures: _measures, compute, ...rest } = q;
  return { ...widget, query: { ...rest, kind: "value", compute: { grain, steps: [...(compute?.steps ?? []), { op: "over_time", fn }] } } };
}

export const filterSchema = z.object({
  id: z.string(),
  // "host": a filter of the system the board is kept in (a Superset dashboard's own filter bar)
  // that Lenspack cannot express. It is shown to the model by its note, kept exactly as the host
  // has it, and can be removed but not changed or added here.
  type: z.enum(["select", "search", "daterange", "host"]),
  label: z.string().min(1),
  // Filters narrow by a dimension the pack actually has. A daterange filter
  // sets the time window of the widgets it applies to instead; its field is
  // "time". A host filter's field is the dimension it is on, if any, else "".
  field: z.string(),
  applies: z.array(z.string()).min(1),
  // The selection before anyone picks one. A daterange's window: the last N
  // calendar months or days up to today, in the pack's time zone. A select's
  // values: the board opens narrowed to them.
  default: z
    .object({
      months: z.number().int().min(1).max(60).optional(),
      days: z.number().int().min(1).max(3660).optional(),
      values: z.array(z.string()).min(1).max(100).optional(),
    })
    .optional(),
  // A host filter in words: what it does, for the model to repeat.
  note: z.string().max(400).optional(),
});
export type Filter = z.infer<typeof filterSchema>;

export const boardConfigSchema = z.object({
  version: z.literal(2),
  pack: z.string().min(1),
  packVersion: z.number().int().min(1),
  title: z.string().min(1).max(160),
  grid: z
    .object({
      cols: z.number().int().min(4).max(24).default(12),
      rowHeight: z.number().int().min(20).max(120).default(40),
      // How much air around widgets; the renderer maps it to gutters, padding
      // and row height.
      density: z.enum(["comfortable", "compact"]).default("comfortable"),
      // Whether rows are packed: gaps closed and the last widget on each row
      // widened to the grid edge, on every edit.
      fill: z.boolean().default(false),
    })
    .default({}),
  layout: z.array(layoutItemSchema).default([]),
  widgets: z.record(z.string(), widgetSchema).default({}),
  filters: z.array(filterSchema).default([]),
});
export type BoardConfig = z.infer<typeof boardConfigSchema>;

export function emptyBoard(pack: { pack: string; version: number }, title: string): BoardConfig {
  return boardConfigSchema.parse({
    version: 2,
    pack: pack.pack,
    packVersion: pack.version,
    title,
    grid: {},
    layout: [],
    widgets: {},
    filters: [],
  });
}

/** A query that computes a measure (rather than listing rows or points). */
export type MeasuredQuery = Extract<Query, { kind: "breakdown" | "series" | "value" }>;
export const measured = (query: Query): query is MeasuredQuery => query.kind === "breakdown" || query.kind === "series" || query.kind === "value";

/** The measure a ratio step divides by, if the query has one. */
export const ratioTo = (query: Query): string[] =>
  measured(query) ? (query.compute?.steps ?? []).flatMap((s) => (s.op === "ratio" ? [s.to] : [])) : [];

/** What a key in a query names. */
export type KeyKind = "dimension" | "measure" | "entity";

/**
 * Walks every key a query names, a ratio's second measure included: `visit` sees each
 * key with what it names and returns the key to put in its place. Returns the new
 * query; the one passed in is left alone.
 */
export function mapQueryKeys(query: Query, visit: (key: string, kind: KeyKind) => string): Query {
  const dim = (key: string) => visit(key, "dimension");
  const measure = (key: string) => visit(key, "measure");
  const q = structuredClone(query);
  for (const clause of q.filters ?? []) clause.dimension = dim(clause.dimension);
  if (measured(q)) {
    if (q.measures) q.measures = q.measures.map(measure);
    for (const s of q.compute?.steps ?? []) if (s.op === "ratio") s.to = measure(s.to);
  }
  switch (q.kind) {
    case "breakdown":
      q.dimension = dim(q.dimension);
      if (q.by) q.by = dim(q.by);
      q.measure = measure(q.measure);
      break;
    case "series":
      q.measure = measure(q.measure);
      if (q.by) q.by = dim(q.by);
      break;
    case "value":
      q.measure = measure(q.measure);
      break;
    case "rows":
      q.entity = visit(q.entity, "entity");
      q.columns = q.columns.map(dim);
      if (q.orderBy) q.orderBy.key = dim(q.orderBy.key);
      break;
    case "points":
      q.entity = visit(q.entity, "entity");
      if (q.color) q.color = dim(q.color);
      if (q.label) q.label = dim(q.label);
      if (q.size) q.size = measure(q.size);
      break;
  }
  return q;
}

/** Every key a query refers to, for validation and for cache keys. */
export function queryKeys(query: Query): { dimensions: string[]; measures: string[]; entities: string[] } {
  const keys = { dimension: new Set<string>(), measure: new Set<string>(), entity: new Set<string>() };
  mapQueryKeys(query, (key, kind) => (keys[kind].add(key), key));
  return { dimensions: [...keys.dimension], measures: [...keys.measure], entities: [...keys.entity] };
}

/**
 * Renames dimension and measure keys across a board when a pack renames one. A
 * function, not an op: it runs as a migration by whoever owns the pack, never by the model.
 */
export function migrateKeys(config: BoardConfig, renames: Record<string, string>): BoardConfig {
  const rename = (key: string) => renames[key] ?? key;
  const widgets = Object.fromEntries(
    Object.entries(config.widgets).map(([id, w]) => [id, w.kind === "text" ? w : { ...w, query: mapQueryKeys(w.query, (key, kind) => (kind === "entity" ? key : rename(key))) }]),
  );
  return boardConfigSchema.parse({ ...config, widgets, filters: config.filters.map((f) => ({ ...f, field: rename(f.field) })) });
}

/** What is wrong with an edit or a query, and the nearest thing that would work. */
export type Problem = { error: string; hint?: string };
