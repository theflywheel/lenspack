import { z } from "zod";

// A dashboard is data, not code. The model never emits JSX and never emits a
// query — it edits this document, and the renderer is the only code.
//
// Nothing in this file names a domain. A widget names a dimension and a measure
// by key; whether those keys exist is decided by the catalogue the caller
// passes to the validator (see ops.ts), never by anything imported here.

export const GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export const CHART_KINDS = ["bar", "line", "pie", "area"] as const;
export const FILTER_OPS = ["eq", "neq", "in", "gte", "lte", "between", "contains"] as const;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const filterClauseSchema = z.object({
  dimension: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).min(1).max(100)]),
});
export type FilterClause = z.infer<typeof filterClauseSchema>;

// Relative ranges are resolved against "now" at query time, so a saved board
// keeps meaning "the last 30 days" rather than freezing the dates it was made.
export const timeRangeSchema = z.union([
  z.object({ last: z.string().regex(/^[1-9]\d{0,3}[hdwmy]$/, 'e.g. "30d", "12w", "6m"') }),
  z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
]);
export type TimeRange = z.infer<typeof timeRangeSchema>;

const common = {
  time: timeRangeSchema.optional(),
  filters: z.array(filterClauseSchema).max(20).optional(),
};

// What a widget is looking at. A closed union: every variant is something the
// compiler already knows how to build, and every string in it is a key.
export const querySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("breakdown"),
    dimension: z.string(),
    measure: z.string(),
    limit: z.number().int().min(2).max(50).default(12),
    sort: z.enum(["asc", "desc"]).default("desc"),
    ...common,
  }),
  z.object({
    kind: z.literal("series"),
    measure: z.string(),
    grain: z.enum(GRAINS).default("day"),
    by: z.string().optional(),
    ...common,
  }),
  // The whole population rather than a breakdown of it. Its own variant
  // because a rate over everything is not the average of per-group rates.
  z.object({
    kind: z.literal("value"),
    measure: z.string(),
    compare: z.enum(["previous_period"]).optional(),
    ...common,
  }),
  z.object({
    kind: z.literal("rows"),
    entity: z.string(),
    columns: z.array(z.string()).min(1).max(20),
    limit: z.number().int().min(1).max(500).default(50),
    orderBy: z.object({ key: z.string(), dir: z.enum(["asc", "desc"]).default("desc") }).optional(),
    ...common,
  }),
]);
export type Query = z.infer<typeof querySchema>;

const placementWidth = z.union([z.enum(["full", "half", "third", "quarter"]), z.number().int().min(1).max(12)]);

// Intent rather than coordinates. Grid arithmetic is the one thing a language
// model reliably gets wrong, so the vocabulary it is given cannot express an
// overlap: the server packs, and overlap is unrepresentable rather than merely
// discouraged.
export const placementSchema = z.object({
  place: z.union([z.enum(["top", "bottom"]), z.string().regex(/^after:.+$/)]).default("bottom"),
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
});
export type LayoutItem = z.infer<typeof layoutItemSchema>;

const baseWidget = { title: z.string().min(1).max(120) };

export const widgetSchema = z.discriminatedUnion("kind", [
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
  z.object({
    ...baseWidget,
    kind: z.literal("kpi"),
    query: querySchema,
    // Only meaningful when the query is a series: how the points collapse to
    // one number. A value query is already one number.
    aggregate: z.enum(["sum", "avg", "max", "min", "count", "last"]).default("last"),
    format: z.enum(["number", "percent", "compact", "currency", "duration"]).optional(),
  }),
  z.object({
    ...baseWidget,
    kind: z.literal("table"),
    query: querySchema,
    pageSize: z.number().int().min(5).max(50).default(10),
  }),
  z.object({
    ...baseWidget,
    kind: z.literal("text"),
    // Rendered as a text node, never as markup: nothing in a config is ever
    // interpreted as code, HTML or CSS.
    body: z.string().max(2000),
  }),
]);
export type Widget = z.infer<typeof widgetSchema>;

export const filterSchema = z.object({
  id: z.string(),
  type: z.enum(["select", "search"]),
  label: z.string().min(1),
  // Filters narrow by a dimension the pack actually has.
  field: z.string(),
  applies: z.array(z.string()).min(1),
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

/** Every key a query refers to, for validation and for cache keys. */
export function queryKeys(query: Query): { dimensions: string[]; measures: string[]; entities: string[] } {
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  const entities = new Set<string>();
  for (const f of query.filters ?? []) dimensions.add(f.dimension);
  switch (query.kind) {
    case "breakdown":
      dimensions.add(query.dimension);
      measures.add(query.measure);
      break;
    case "series":
      measures.add(query.measure);
      if (query.by) dimensions.add(query.by);
      break;
    case "value":
      measures.add(query.measure);
      break;
    case "rows":
      entities.add(query.entity);
      for (const c of query.columns) dimensions.add(c);
      if (query.orderBy) dimensions.add(query.orderBy.key);
      break;
  }
  return { dimensions: [...dimensions], measures: [...measures], entities: [...entities] };
}
