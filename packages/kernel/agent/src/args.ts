import { z } from "zod";

import { CHART_KINDS, type Compute, type ComputeStep, type FilterClause, GRAINS, type Query, overTime, querySchema } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

// Every input is a flat scalar and the query is assembled here. Weaker models
// corrupt nested tool arguments, so a tool that asked for a widget object
// would fail on roughly every call.

// Lenient scalars: a null, a numeric string or a "true" from a weaker model
// is an argument to accept and coerce, not a reason to end the turn. A model
// clearing an argument writes "null" or "none" as text: that is empty too.
const EMPTY = /^\s*(null|none|undefined)\s*$/i;
export const str = (fallback = "") => z.string().nullish().transform((v) => (v == null || EMPTY.test(v) ? fallback : v));
export const num = (fallback: number, min: number, max: number) =>
  z
    .union([z.number(), z.string(), z.null(), z.undefined()])
    .transform((v) => (v === null || v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));
// fallback undefined means "omitted leaves it as it is".
export const bool = <F extends boolean | undefined = boolean>(fallback: F) =>
  z.union([z.boolean(), z.string(), z.null(), z.undefined()]).transform((v) => (v === null || v === undefined || v === "" ? fallback : v === true || v === "true"));
export const oneOf = <const T extends readonly [string, ...string[]], F extends T[number] | "">(values: T, fallback: F) =>
  z.union([z.enum(values), z.null(), z.undefined(), z.literal("")]).transform((v) => (v ? v : fallback) as T[number] | F);

// Calendar periods by name: models mangle a negative number in a tool call
// ("-1" arrives as "--1"), so "last" is a word, never an offset.
const PERIODS = {
  today: ["day", 0], yesterday: ["day", -1], this_week: ["week", 0], last_week: ["week", -1], this_month: ["month", 0], last_month: ["month", -1],
  this_quarter: ["quarter", 0], last_quarter: ["quarter", -1], this_year: ["year", 0], last_year: ["year", -1],
} as const;
type PeriodName = keyof typeof PERIODS;
// "last month", "Last-Month" and a bare "month" (this one) all read as a name.
const period = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s === "day" ? "today" : ["week", "month", "quarter", "year"].includes(s) ? `this_${s}` : s;
}, oneOf(["", ...(Object.keys(PERIODS) as PeriodName[])], ""));

export const WIDGET_KINDS = ["chart", "kpi", "table", "text"] as const;
export const PLACE = str("bottom").describe('Where to put it: "top", "bottom", "after:<widgetId>" (beside that widget; a full row makes room by narrowing its widgets) or "below:<widgetId>" (a new row under that widget\'s row)');
export const WIDTH = oneOf(["full", "half", "third", "quarter"], "half").describe("full is the whole row, half is two across, third is three across, quarter is four across");
export const CHART = oneOf(CHART_KINDS, "bar");
export const PAGE_SIZE = num(0, 0, 200).describe("For a table: rows per page, up to 200; 0 for the default (25). A table of rows pages through all matching rows with Prev/Next");

export const QUERY_SHAPE = {
  query_kind: z.enum(["breakdown", "series", "value", "rows", "points"]).describe("breakdown = a measure per group; series = a measure over time; value = one number; rows = a list of records; points = each record's location, for a map (entities with a location only)"),
  measure: str().describe("Measure key from list_metrics (not for rows). For points: optional, sizes each point (a measure of the entity)"),
  measures: str().describe("Optional, comma-separated: further measures over the same groups, as extra table columns or chart series (not with a split series)"),
  dimension: str().describe("For breakdown: the dimension to group by. For series: optional split. For rows: comma-separated columns. For points: optional, colours each point by this category"),
  entity: str().describe("For rows or points: the entity to list"),
  label: str().describe("For points: optional dimension that names each point (shown on hover and in answers)"),
  grain: oneOf(GRAINS, "").describe("For series: the time bucket (default day). With compute on a breakdown or value: the bucket the steps run over (day for a daily average)"),
  compute: str().describe(
    'Optional steps computed after the source answers, in order, separated by commas: change or pct_change (each time bucket against the one before), rolling_mean 7 or rolling_sum 7 (a window of buckets), running_total, ratio <measure> (this measure over another; first), and to end a breakdown or value, one number per group from its buckets: mean, sum, min, max, median or last. E.g. "pct_change, mean" with grain day = the average day-on-day % change',
  ),
  time_last: str().describe('Rolling window back from now, like "30d", "12w", "6m" ("last 30 days" -> "30d", "last 10 weeks" -> "10w"); empty means all time. For a calendar period ("this month", "last week") use time_period'),
  time_period: period.describe('Calendar period, weeks from Monday: "this_month" is to date, "last_month" the whole previous one. Not with time_last or time_from'),
  time_count: num(1, 1, 500).describe('With time_period: how many periods, ending with it ("the last 3 whole months" -> last_month, 3)'),
  time_from: str().describe('Absolute start, ISO 8601 with offset, e.g. "2026-09-01T00:00:00Z" (inclusive); use with time_to, not with time_last'),
  time_to: str().describe('Absolute end, ISO 8601 with offset (exclusive), e.g. "2026-10-01T00:00:00Z" for all of September'),
  compare: bool(false).describe("For value or breakdown: also compute the previous period, the same length just before (so not the previous calendar month)"),
  share: bool(false).describe("For breakdown: each group's share of the whole population, not of the groups shown"),
  other: bool(false).describe('For breakdown: add one "(other)" row for everything outside the groups shown'),
  limit: num(0, 0, 5000).describe("Max groups (500), rows (1000) or points (5000); 0 for the default"),
  sort: oneOf(["asc", "desc"], "desc").describe('For breakdown: "desc" = largest first (default), "asc" = smallest first ("lowest first", "bottom N")'),
  split: str().describe("For breakdown: a second dimension within each group, drawn as stacked bars, or as the rows of a heatmap (dimension is then its columns)"),
  order_by: str().describe('For rows: the column to order the list by, e.g. a time column to list newest first; empty keeps the source order'),
  order: oneOf(["asc", "desc"], "desc").describe('For rows with order_by: "desc" = newest or largest first (default), "asc" = oldest or smallest first'),
  filters: str().describe('Optional: clauses separated by ";", e.g. "channel = web; language in en, fr; status != failed; size >= 18". Ops: =, !=, >=, <=, in (comma-separated), contains, between <a> and <b>'),
  filter_dimension: str().describe("Optional: narrow by this dimension"),
  filter_value: str().describe("Optional: the value the filter dimension must equal"),
};
export const QUERY = z.object(QUERY_SHAPE);
export type QueryArgs = z.infer<typeof QUERY>;

const OPS = { "=": "eq", "!=": "neq", ">=": "gte", "<=": "lte", in: "in", contains: "contains", between: "between" } as const;
const CLAUSE = /^([a-z][a-z0-9_]*)\s*(?:(!=|>=|<=|=)|\s(in|contains|between)\s)\s*(.+)$/i;
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

// Nested filter objects are what weaker models corrupt, so filters arrive as
// one string in a small closed grammar and become IR clauses here.
function parseFilters(text: string, pack: Pack): FilterClause[] {
  return text
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((clause) => {
      const m = CLAUSE.exec(clause);
      // An unquoted value starting with an operator is a misread op ("==", "=<"), not a value.
      if (!m || /^[=<>!]/.test(m[4]!)) throw new Error(`Cannot read the filter "${clause}": write <dimension> <op> <value>, op one of =, !=, >=, <=, in, contains, between <a> and <b>`);
      const dimension = m[1]!;
      const op = OPS[(m[2] ?? m[3]!.toLowerCase()) as keyof typeof OPS];
      const values = (op === "in" ? m[4]!.split(",") : op === "between" ? m[4]!.split(/\s+and\s+/i) : [m[4]!]).map(unquote).filter(Boolean);
      if (op === "between" ? values.length !== 2 : !values.length) throw new Error(`Cannot read the filter "${clause}": ${op === "between" ? "between needs <a> and <b>" : "it has no value"}`);
      const typed = op === "contains" ? values : values.map((v) => typedValue(pack, dimension, v, clause));
      return { dimension, op, value: op === "in" || op === "between" ? typed : typed[0]! };
    });
}

// A value is typed by its dimension: "18" is a number on a number dimension
// and stays a string on a code.
function typedValue(pack: Pack, dimension: string, v: string, clause: string) {
  const type = pack.dimensions.find((d) => d.key === dimension)?.type;
  // A time compared as text fails in the database; the window has its own arguments.
  if (type === "time") throw new Error(`Cannot read the filter "${clause}": ${dimension} is a time; give the window as time_from and time_to (or time_period, time_last), not as a filter`);
  if (type === "number") {
    if (!v.trim() || !Number.isFinite(Number(v))) throw new Error(`Cannot read the filter "${clause}": ${dimension} is a number, "${v}" is not`);
    return Number(v);
  }
  if (type === "boolean") {
    if (!/^(true|false)$/i.test(v)) throw new Error(`Cannot read the filter "${clause}": ${dimension} is true or false, "${v}" is neither`);
    return v.toLowerCase() === "true";
  }
  return v;
}

const SUMMARIES: Record<string, Extract<ComputeStep, { op: "over_time" }>["fn"]> = {
  mean: "mean", avg: "mean", average: "mean", sum: "sum", total: "sum", min: "min", minimum: "min", lowest: "min", max: "max", maximum: "max", highest: "max", median: "median", last: "last", latest: "last",
};
const FN = (w: string) => (/^(sum|total)$/.test(w) ? "sum" : "mean") as "mean" | "sum";
const STEP_HELP = "write change, pct_change, rolling_mean 7, rolling_sum 7, running_total, ratio <measure>, or a summary to end with: mean, sum, min, max, median or last";

// Steps arrive as one string in a small grammar, like filters, and become IR here.
function parseStep(raw: string): ComputeStep {
  const s = raw.trim().toLowerCase().replace(/%/g, " pct ").replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
  let m: RegExpExecArray | null;
  if (/^(change|diff|difference|delta|absolute_change)$/.test(s)) return { op: "change" };
  if (/^((pct|percent|percentage)_?(change|diff)|(change|diff)_?(pct|percent|percentage)|growth|growth_rate)$/.test(s)) return { op: "change", percent: true };
  if ((m = /^rolling_(?:(mean|avg|average|sum|total)_)?(\d+)(?:_[a-z]+?)?(?:_(mean|avg|average|sum|total))?$/.exec(s))) return { op: "rolling", fn: FN(m[1] ?? m[3] ?? "mean"), window: Number(m[2]) };
  if ((m = /^(\d+)_?[a-z]*_rolling_(mean|avg|average|sum|total)$/.exec(s))) return { op: "rolling", fn: FN(m[2]!), window: Number(m[1]) };
  if (/^(running_total|running_sum|cumulative|cumulative_sum|cumulative_total|cumsum|cum_sum)$/.test(s)) return { op: "running_total" };
  const summary = SUMMARIES[s.replace(/_(over_time|per_group)$/, "")];
  if (summary) return { op: "over_time", fn: summary };
  if ((m = /^(?:ratio|ratio_to|per|divided_by|divide_by|over)_([a-z][a-z0-9_]*?)(?:_(pct|percent))?$/.exec(s))) return { op: "ratio", to: m[1]!, ...(m[2] ? { percent: true } : {}) };
  throw new Error(`Cannot read the step "${raw.trim()}": ${STEP_HELP}`);
}

/** The compute string → IR; an empty string is no compute. A breakdown or value keeps the grain its steps over time run on. */
export function parseCompute(text: string, kind: string, grain: string): Compute | undefined {
  const parts = text.split(/\s*(?:,|;|->|→|>|\|| then )\s*/i).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const steps = parts.map(parseStep);
  return { ...(kind !== "series" && grain && steps.some(overTime) ? { grain: grain as Compute["grain"] } : {}), steps };
}

/** IR → the compute string, for a patch that rebuilds a stored query. */
export function formatCompute(c: Compute | undefined): string {
  if (!c) return "";
  return c.steps
    .map((s) => {
      switch (s.op) {
        case "change":
          return s.percent ? "pct_change" : "change";
        case "rolling":
          return `rolling_${s.fn} ${s.window}`;
        case "running_total":
          return "running_total";
        case "ratio":
          return `ratio ${s.to}${s.percent ? " pct" : ""}`;
        case "over_time":
          return s.fn;
      }
    })
    .join(", ");
}

export function assembleQuery(a: QueryArgs, pack: Pack): Query {
  if (Boolean(a.time_from) !== Boolean(a.time_to)) throw new Error("time_from and time_to go together: give both, or use time_last");
  if (a.time_period && (a.time_last || a.time_from)) throw new Error("time_period goes alone: not with time_last or time_from/time_to");
  const clauses = parseFilters(a.filters, pack);
  if (a.filter_dimension) clauses.push({ dimension: a.filter_dimension, op: "eq", value: typedValue(pack, a.filter_dimension, a.filter_value, `${a.filter_dimension} = ${a.filter_value}`) });
  const filters = clauses.length ? clauses : undefined;
  const [unit, offset] = a.time_period ? PERIODS[a.time_period as PeriodName] : [];
  const period = unit ? { period: unit, ...(offset ? { offset } : {}), ...(a.time_count > 1 ? { count: a.time_count } : {}) } : undefined;
  const time = a.time_from && a.time_to ? { from: a.time_from, to: a.time_to } : period ?? (a.time_last ? { last: a.time_last } : undefined);
  const more = a.measures.split(",").map((s) => s.trim()).filter((s) => s && s !== a.measure);
  const base = { ...(filters ? { filters } : {}), ...(time ? { time } : {}), ...(more.length && a.query_kind !== "rows" && a.query_kind !== "points" ? { measures: more } : {}) };
  const compute = a.query_kind === "rows" || a.query_kind === "points" ? undefined : parseCompute(a.compute, a.query_kind, a.grain);
  const computed = compute ? { compute } : {};
  switch (a.query_kind) {
    case "breakdown":
      return querySchema.parse({
        kind: "breakdown",
        dimension: a.dimension,
        measure: a.measure,
        sort: a.sort,
        ...(a.split ? { by: a.split } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
        ...(a.compare ? { compare: "previous_period" } : {}),
        ...(a.share ? { share: true } : {}),
        ...(a.other ? { other: true } : {}),
        ...computed,
        ...base,
      });
    case "series":
      return querySchema.parse({ kind: "series", measure: a.measure, grain: a.grain || "day", ...(a.split || a.dimension ? { by: a.split || a.dimension } : {}), ...computed, ...base });
    case "value":
      return querySchema.parse({ kind: "value", measure: a.measure, ...(a.compare ? { compare: "previous_period" } : {}), ...computed, ...base });
    case "rows":
      return querySchema.parse({
        kind: "rows",
        entity: a.entity,
        columns: a.dimension.split(",").map((s) => s.trim()).filter(Boolean),
        ...(a.order_by ? { orderBy: { key: a.order_by, dir: a.order } } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
        ...base,
      });
    case "points":
      return querySchema.parse({
        kind: "points",
        entity: a.entity,
        ...(a.dimension.trim() ? { color: a.dimension.trim() } : {}),
        ...(a.measure.trim() ? { size: a.measure.trim() } : {}),
        ...(a.label.trim() ? { label: a.label.trim() } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
        ...base,
      });
  }
}

// In a patch an omitted, null or empty field means "leave it", so none of
// them falls back to a default the way a new widget's fields do.
export const given = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), s.optional());
export const PATCH_SHAPE = Object.fromEntries(Object.entries(QUERY_SHAPE).map(([k, s]) => [k, given(s)])) as {
  [K in keyof typeof QUERY_SHAPE]: z.ZodEffects<z.ZodOptional<(typeof QUERY_SHAPE)[K]>, z.infer<(typeof QUERY_SHAPE)[K]> | undefined, unknown>;
};

// The scalars a stored query is rebuilt from. The rest (time, filters,
// further measures, a breakdown's split, sortBy, orderBy) carries over from
// the query itself unless the patch names it.
function scalarsOf(q: Query) {
  switch (q.kind) {
    case "breakdown":
      return { query_kind: q.kind, measure: q.measure, dimension: q.dimension, sort: q.sort, compare: !!q.compare, share: !!q.share, other: !!q.other, compute: formatCompute(q.compute), grain: q.compute?.grain ?? "" };
    case "series":
      return { query_kind: q.kind, measure: q.measure, grain: q.grain, dimension: q.by, compute: formatCompute(q.compute) };
    case "value":
      return { query_kind: q.kind, measure: q.measure, compare: !!q.compare, compute: formatCompute(q.compute), grain: q.compute?.grain ?? "" };
    case "rows":
      return { query_kind: q.kind, entity: q.entity, dimension: q.columns.join(","), order_by: q.orderBy?.key ?? "", order: q.orderBy?.dir ?? "desc" };
    case "points":
      return { query_kind: q.kind, entity: q.entity, dimension: q.color ?? "", measure: q.size ?? "", label: q.label ?? "" };
  }
}

// What a patch can take off a widget's query by name, and the query field each one is. An empty
// field in a patch means "leave it" (weaker models send empty values for every field they do not
// mean), so removing a part has to be asked for by name.
const CLEARABLE = { filters: "filters", time: "time", split: "by", measures: "measures", compute: "compute" } as const;
export type Clearable = keyof typeof CLEARABLE;
// The other names a model may give a part: the arguments that set it, or plain words.
const CLEAR_WORDS: Record<string, Clearable> = {
  filter: "filters", filter_dimension: "filters", time_window: "time", window: "time", dates: "time", time_last: "time", time_period: "time", time_from: "time",
  by: "split", further_measures: "measures", steps: "compute",
};

/** The clear argument → the parts it names: "filters, time" or "the time window". An unknown name is an error, not a no-op. */
export function parseClear(text: string): Clearable[] {
  const names = text.split(/\s*[,;]\s*|\s+and\s+/i).map((w) => w.trim().toLowerCase().replace(/^the\s+/, "").replace(/[\s-]+/g, "_")).filter(Boolean);
  return [...new Set(names.map((n) => {
    const part = Object.hasOwn(CLEARABLE, n) ? (n as Clearable) : Object.hasOwn(CLEAR_WORDS, n) ? CLEAR_WORDS[n] : undefined;
    if (!part) throw new Error(`Cannot clear "${n}": name ${Object.keys(CLEARABLE).join(", ")}`);
    return part;
  }))];
}

export function patchQuery(current: Query | undefined, changed: Partial<QueryArgs>, pack: Pack, clear: Clearable[] = []): Query {
  if (!current || (changed.query_kind && changed.query_kind !== current.kind)) return assembleQuery(QUERY.parse(changed), pack);
  // Cleared last, so a part named in clear is gone whatever the other fields say.
  if (clear.length) return querySchema.parse({ ...patchQuery(current, changed, pack), ...Object.fromEntries(clear.map((c) => [CLEARABLE[c], undefined])) });
  if (Object.keys(changed).length === 0) return current;
  const next = assembleQuery(QUERY.parse({ ...scalarsOf(current), ...changed }), pack);
  // A new primary measure leaves the further ones, so it is not listed twice.
  const more = "measures" in current && !changed.measures ? current.measures?.filter((m) => m !== changed.measure) : undefined;
  // filter_dimension adds its clause to the widget's filters; a filters string replaces them.
  const kept = changed.filter_dimension && !changed.filters ? (current.filters ?? []).filter((f) => f.dimension !== changed.filter_dimension) : [];
  // The rebuilt query has the default limit unless one was given, and compare,
  // share, other and compute only when still asked for, so a patch can turn them off.
  return querySchema.parse({
    ...current,
    compare: undefined,
    share: undefined,
    other: undefined,
    compute: undefined,
    ...(more ? { measures: more.length ? more : undefined } : {}),
    ...next,
    ...(kept.length ? { filters: [...kept, ...next.filters!] } : {}),
    ...("limit" in current && !changed.limit ? { limit: current.limit } : {}),
  });
}
