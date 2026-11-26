import { type ScopeClause, filterClauseSchema } from "@lenspack/core";
import { type BuiltPack, type Pack, type PackDimension, WHERE_OPS, emitPack, packBuilder, slug as packSlug } from "@lenspack/pack";

import { type SupersetClient, rison } from "./client";
import { examplesForPack } from "./examples";

// Superset's datasets are the catalogue: a dataset is an entity, its saved
// metrics are measures, its groupable columns are dimensions. The pack built
// here names Superset's own metrics (sql: { superset: <metric_name> }), so a
// number means exactly what it means in Superset and is computed there.

export type SupersetColumn = { column_name: string; verbose_name?: string | null; description?: string | null; type?: string | null; is_dttm?: boolean; groupby?: boolean; filterable?: boolean; expression?: string | null };
export type SupersetMetric = { metric_name: string; verbose_name?: string | null; description?: string | null; expression: string; d3format?: string | null; warning_text?: string | null };
export type SupersetDataset = { id: number; table_name: string; schema?: string | null; description?: string | null; main_dttm_col?: string | null; columns: SupersetColumn[]; metrics: SupersetMetric[]; database?: { id: number; database_name?: string } };

/** Words in one language, or by language: `Nets handed out` or `{ en: Nets handed out, fr: Moustiquaires remises }`. */
export type Words = string | Record<string, string>;

/** The aggregates an overlay measure may use: simple base measures (rates come from Lenspack's compute step). */
export const OVERLAY_AGGS = ["sum", "count", "count_distinct", "min", "max"] as const;
export type OverlayAgg = (typeof OVERLAY_AGGS)[number];

/**
 * A base measure made from a dataset's column, for a deployment that cannot add saved metrics in Superset. It is sent
 * to Superset as an ad hoc metric (a sum, count, distinct count, min or max of the column), so Superset computes it
 * and the user's dataset access and row-level security apply, as for a saved metric. Nothing here is SQL.
 */
export type OverlayMeasure = {
  /** The dataset, by id, table name or entity key: one listed in datasets. */
  dataset: number | string;
  /** The measure's key (made a pack key: lowercase words joined by "_"). */
  name: string;
  agg: OverlayAgg;
  /** The column it reads. count without one counts rows. */
  column?: string;
  /** Rows it counts or adds up: each a column, an operator (eq, neq, in, gt, gte, lt, lte, exists, missing) and a value. */
  where?: { column: string; op?: (typeof WHERE_OPS)[number]; value?: string | number | boolean | (string | number | boolean)[] }[];
  label?: Words;
  hint?: Words;
  format?: "number" | "percent" | "currency" | "compact";
};

/** What lenspack adds on top of Superset's own descriptions: the parts Superset has no field for. */
export type Overlay = {
  pack?: string;
  description?: string;
  instructions?: string;
  timeZone?: string;
  /** Entity key per dataset id or table name, instead of the slugged table name. */
  entities?: Record<string, string>;
  /**
   * Hints and labels by key, over Superset's descriptions and verbose names. Either may be written per language
   * ({ en, fr }): the English (else the first) is the key's label, and the others are words the chat also knows it by.
   */
  hints?: Record<string, Words>;
  labels?: Record<string, Words>;
  /**
   * What the pack never uses, whatever Superset's flags say, on every dataset: columns (and saved metrics) by name,
   * matched without regard to case, and whole datasets by id or table name. An excluded column is never a dimension,
   * a measure, a map's coordinates or a time column, and no query can read it; a dashboard filter on it is not passed
   * to the chat. It wins over notDimensions and measures.
   */
  exclude?: { columns?: string[]; datasets?: (number | string)[] };
  /** Columns that Superset lets you group by but the pack does not make dimensions (amounts and counts), by name. */
  notDimensions?: string[];
  /** Base measures from datasets' columns, compiled as Superset ad hoc metrics (see OverlayMeasure). */
  measures?: OverlayMeasure[];
  hierarchies?: Record<string, string[]>;
  examples?: unknown[];
  /**
   * Each entity's coordinate columns (latitude and longitude, in degrees), by entity key, dataset
   * id or table name; false for none. Without one, columns named latitude/lat and longitude/lon/lng
   * are found by name, grouped by Superset or not.
   */
  geo?: Record<string, { lat: string; lon: string } | false>;
  /**
   * The basemap of maps Lenspack writes to Superset. Superset 6 takes a Mapbox style (mapbox://styles/...), an
   * OpenStreetMap tile URL or tile://<tile server URL>; Superset 5 takes Mapbox styles only. By default Superset's own
   * default for its version: OpenStreetMap streets on 6, Mapbox light on 5.
   */
  mapStyle?: string;
  /** How the chat opens on Superset's pages by default: a floating window or a side panel. Each user can change it. */
  panel?: "float" | "dock";
};

/** How pack keys map back to Superset names: the connector and the dashboard writer read this. */
export type Binding = {
  /** Entity key → dataset. */
  datasets: Map<string, { id: number; table: string; time: string | null; countMetric: string | null }>;
  /** Dataset id → entity key. */
  entityOf: Map<number, string>;
  /**
   * Measure key → { entity, metric name } (null metric: COUNT(*) with no saved metric). An overlay measure has no
   * saved metric; `adhoc` says what Superset is asked to compute instead.
   */
  metrics: Map<string, { entity: string; metric: string | null; adhoc?: AdhocSpec }>;
  /** Entity → (metric name → measure key). */
  measureOf: Map<string, Map<string, string>>;
  /** Dimension key → (entity → column name). */
  columns: Map<string, Map<string, string>>;
  /** Entity → (column name → dimension key). */
  dimensionOf: Map<string, Map<string, string>>;
  /** Entity → its coordinate columns, for an entity with a location. */
  geo: Map<string, { lat: string; lon: string }>;
  /** The basemap written into maps: overlay.mapStyle, else the default for the Superset version (set by the server). */
  mapStyle?: string;
  /** Column names the overlay excludes (lowercase): a dashboard filter on one is described without its name or values. */
  excluded?: Set<string>;
  /**
   * Entity → (simple aggregate → measure key): "sum|nets", "count|*", "count_distinct|household_id". Each saved metric
   * whose SQL is one simple aggregate of a column, and each overlay measure without conditions, so a chart's ad hoc
   * metric that says the same (SUM(nets), or Superset's own SUM of nets) is read as that measure. A saved metric
   * comes before an overlay measure; a column Superset computes from an expression is never matched.
   */
  aggregates?: Map<string, Map<string, string>>;
};

/** An overlay measure as Superset computes it: an aggregate of one column (or of rows), over the rows its conditions keep. */
export type AdhocSpec = { agg: OverlayAgg; column: string | null; where: { column: string; op: (typeof WHERE_OPS)[number]; value?: unknown }[] };

export const slug = (s: string) => packSlug(s, { camel: true, digit: "k", empty: "k" });

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A column type that holds calendar dates with no time of day, as Superset reports it: DATE, Date, Date32, Nullable(Date).
const DATE_TYPE = /^\s*(nullable\(\s*)?date(32)?\s*\)?\s*$/i;
// COUNT(*), or ClickHouse's count().
const COUNT_STAR = /^\s*count\s*\(\s*\*?\s*\)\s*$/i;

// ClickHouse spells some aggregates as functions: the -If combinator (countIf(cond), sumIf(x, cond))
// and the uniq family for distinct counts.
const CH_SUM = new Set(["countif", "sumif"]);
// The -Merge forms read a stored AggregateFunction state (uniqExactMerge(col) in a pre-aggregated mart).
const CH_DISTINCT = new Set(["uniq", "uniqexact", "uniqcombined", "uniqcombined64", "uniqhll12", "uniqtheta", "countdistinct", "uniqmerge", "uniqexactmerge", "uniqcombinedmerge", "uniqcombined64merge", "uniqhll12merge"]);
const CH_SUM_MERGE = new Set(["summerge", "countmerge"]);

/** The aggregates a chart's metric is matched to a measure by: a plain aggregate of one column, or of rows. */
export type SimpleAgg = "sum" | "count" | "count_distinct" | "min" | "max" | "avg";

// SUM(col), COUNT(*), COUNT(col), COUNT(DISTINCT col), MIN, MAX and AVG of one column, in any case, with optional
// spaces, and the column bare or quoted (`col` or "col"). count() is ClickHouse's COUNT(*).
const SIMPLE_AGG = /^\s*(sum|count|min|max|avg)\s*\(\s*(?:(distinct)\s+)?(\*|`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)?\s*\)\s*$/i;

/**
 * The simple aggregate a metric's SQL is, or null for anything else (arithmetic, a CASE, a function of a column, a
 * DISTINCT inside anything but COUNT). Only the shape is read: nothing here is run.
 */
export function simpleAggregate(sql: string): { agg: SimpleAgg; column: string | null } | null {
  const m = SIMPLE_AGG.exec(sql);
  if (!m) return null;
  const fn = m[1]!.toLowerCase() as "sum" | "count" | "min" | "max" | "avg";
  const distinct = !!m[2];
  const operand = m[3];
  // COUNT(*) and count(): rows. Any other function needs a column, and DISTINCT a column of COUNT.
  if (operand === undefined || operand === "*") return fn === "count" && !distinct ? { agg: "count", column: null } : null;
  if (distinct && fn !== "count") return null;
  return { agg: distinct ? "count_distinct" : fn, column: operand.replace(/^[`"](.*)[`"]$/, "$1") };
}

/** A simple aggregate as the key Binding.aggregates is read by. */
export const aggregateKey = (a: { agg: SimpleAgg; column: string | null }) => `${a.agg}|${a.column ?? "*"}`;

/** The aggregate a metric's expression behaves like, for what lenspack lets you do with it (share, Other, totals). */
export function aggOf(expression: string): "count" | "sum" | "avg" | "min" | "max" | "count_distinct" {
  const e = expression.trim();
  if (COUNT_STAR.test(e)) return "count";
  // A ratio or arithmetic over aggregates does not add up over groups.
  const outer = /^(\w+)\s*\(/.exec(e)?.[1]?.toLowerCase();
  const balanced = outer ? closesAtEnd(e) : false;
  if (!balanced) return "avg";
  if (outer === "count") return /^count\s*\(\s*distinct\b/i.test(e) ? "count_distinct" : "sum";
  if (outer === "sum" || CH_SUM.has(outer!) || CH_SUM_MERGE.has(outer!)) return "sum";
  if (CH_DISTINCT.has(outer!)) return "count_distinct";
  if (outer === "min" || outer === "minif") return "min";
  if (outer === "max" || outer === "maxif") return "max";
  return "avg";
}

// True when the first "(" closes at the very end, or is followed only by one
// FILTER (...) clause: SUM(x) and COUNT(*) FILTER (WHERE y) yes, SUM(x)/COUNT(*) no.
function closesAtEnd(e: string) {
  const close = (from: number) => {
    let depth = 0;
    for (let i = from; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")" && --depth === 0) return i;
    }
    return -1;
  };
  const end = close(e.indexOf("("));
  if (end < 0) return false;
  const rest = e.slice(end + 1);
  if (!rest.trim()) return true;
  const filter = /^\s*filter\s*\(/i.exec(rest);
  if (!filter) return false;
  const fEnd = close(end + 1 + filter[0].length - 1);
  return fEnd > 0 && e.slice(fEnd + 1).trim() === "";
}

const formatOf = (d3?: string | null) => (!d3 ? "number" : d3.includes("%") ? "percent" : d3.includes("$") ? "currency" : d3.includes("s") ? "compact" : "number");
const typeOf = (c: SupersetColumn) => {
  // Any type Superset reports that is none of these (an array, a map, one it doesn't know) reads as text.
  const t = String(c.type ?? "").toUpperCase();
  if (c.is_dttm) return "time" as const;
  if (/BOOL/.test(t)) return "boolean" as const;
  if (/INT|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL/.test(t)) return "number" as const;
  return "string" as const;
};
const cut = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined);

/** Why a dataset response can't be built into a pack, or null when it is complete. */
export function incompleteDataset(ds: SupersetDataset | undefined, id: number, table?: string): string | null {
  if (!ds) return "empty response";
  if (ds.id !== id) return `asked for dataset ${id}, got ${ds.id}`;
  if (table && ds.table_name !== table) return `asked for "${table}", got "${ds.table_name}"`;
  if (!Array.isArray(ds.columns) || ds.columns.length === 0) return "no columns";
  if (!Array.isArray(ds.metrics)) return "no metrics list";
  const dup = (names: string[]) => names.find((n, i) => names.indexOf(n) !== i);
  const col = dup(ds.columns.map((c) => c.column_name));
  if (col) return `column "${col}" listed twice`;
  const met = dup(ds.metrics.map((m) => m.metric_name));
  if (met) return `metric "${met}" listed twice`;
  return null;
}

export type FetchOptions = {
  /** Attempts per lookup and per dataset (default 4). */
  attempts?: number;
  /** Waits between attempts in ms (default 500, 1000, 2000). */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
};

/**
 * Datasets by id, or by table name ("schema.table" or "table"), which stays the same when Superset is set up again.
 * Under load Superset can answer a name lookup with nothing, or a dataset with no or duplicated columns: each lookup
 * and each dataset is retried until it comes back complete, so a pack is never built from a partial answer.
 * Datasets are fetched one at a time, in the order given, to keep the load on Superset low.
 */
export async function fetchDatasets(client: SupersetClient, refs: (number | string)[], opts: FetchOptions = {}): Promise<SupersetDataset[]> {
  const attempts = opts.attempts ?? 4;
  const backoff = opts.backoffMs ?? [500, 1000, 2000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function retry<T>(what: string, once: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await once();
      } catch (e) {
        last = e;
        if (i < attempts - 1) {
          opts.log?.(`${what}: ${e instanceof Error ? e.message : String(e)}; trying again`);
          await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 1000);
        }
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  const idOf = (ref: number | string): Promise<number> => {
    if (typeof ref === "number" || /^\d+$/.test(ref)) return Promise.resolve(Number(ref));
    const [schema, table] = ref.includes(".") ? ref.split(".", 2) : [null, ref];
    const filters = [{ col: "table_name", opr: "eq", value: table }, ...(schema ? [{ col: "schema", opr: "eq", value: schema }] : [])];
    // Superset's list endpoint (Flask-AppBuilder 4 and 5, in Superset 5 and 6) shares one filter object between the threads of a worker,
    // so under concurrent list requests it can apply another request's filter and answer with a different
    // dataset. Ask for the name back and keep only exact matches: a swapped answer is retried, never trusted.
    return retry(`Superset dataset "${ref}"`, async () => {
      const found = await client.get<{ result: { id: number; table_name?: string; schema?: string | null }[] }>(`/api/v1/dataset/?q=${encodeURIComponent(rison({ filters, columns: ["id", "table_name", "schema"] }))}`);
      const rows = found?.result ?? [];
      const exact = rows.filter((r) => r.table_name === table && (!schema || r.schema === schema));
      if (exact.length === 1) return exact[0]!.id;
      if (exact.length > 1) throw new Error(`Superset dataset "${ref}": more than one matches; name the schema`);
      throw new Error(`Superset dataset "${ref}": ${rows.length ? `the lookup answered with ${rows.map((r) => `"${r.schema ? `${r.schema}.` : ""}${r.table_name}"`).join(", ")}` : "not found"}`);
    });
  };
  const out: SupersetDataset[] = [];
  for (const ref of refs) {
    const id = await idOf(ref);
    const table = typeof ref === "string" && !/^\d+$/.test(ref) ? (ref.includes(".") ? ref.split(".", 2)[1] : ref) : undefined;
    out.push(
      await retry(`Superset dataset ${id}${table ? ` ("${table}")` : ""}`, async () => {
        const ds = (await client.get<{ result: SupersetDataset }>(`/api/v1/dataset/${id}`))?.result;
        const why = incompleteDataset(ds, id, table);
        if (why) throw new Error(`Superset dataset ${id}${table ? ` ("${table}")` : ""} came back incomplete: ${why}`);
        return ds;
      }),
    );
  }
  return out;
}

const LAT = /^(lat|latitude)$/i;
const LON = /^(lon|lng|long|longitude)$/i;
const NUMERIC = /^(float|double|decimal|numeric|real|int|bigint|smallint|number|uint)/i;

/** A dataset's coordinate columns: as configured (false: none), else found by name among its numeric columns. */
export function geoOf(ds: SupersetDataset, configured: { lat: string; lon: string } | false | undefined): { lat: string; lon: string } | null {
  const names = new Set(ds.columns.map((c) => c.column_name));
  if (configured === false) return null;
  if (configured) {
    for (const c of [configured.lat, configured.lon]) if (!names.has(c)) throw new Error(`overlay.geo names "${c}", which is not a column of Superset dataset ${ds.table_name}`);
    return { lat: configured.lat, lon: configured.lon };
  }
  const numeric = ds.columns.filter((c) => COLUMN.test(c.column_name) && (!c.type || NUMERIC.test(c.type)));
  const lat = numeric.filter((c) => LAT.test(c.column_name));
  const lon = numeric.filter((c) => LON.test(c.column_name));
  return lat.length === 1 && lon.length === 1 ? { lat: lat[0]!.column_name, lon: lon[0]!.column_name } : null;
}

const blank = (s: unknown) => typeof s !== "string" || !s.trim();

/** Words written once or per language: the English (else the first) as the main text, the rest beside it. */
export function wordsOf(w: Words | undefined): { main?: string; others: string[] } {
  if (w === undefined || w === null) return { others: [] };
  if (typeof w !== "object") return { main: String(w), others: [] };
  const entries = Object.entries(w).filter(([, v]) => typeof v === "string" && v.trim()) as [string, string][];
  const main = (entries.find(([k]) => k === "en") ?? entries[0])?.[1];
  return { main, others: entries.map(([, v]) => v).filter((v) => v !== main) };
}

/**
 * Datasets → a pack, the binding back to Superset names, and a warning for each column or metric it left out or
 * renamed. One odd column or metric in one dataset never stops the pack being built: the pack is what Lenspack starts
 * with, and a dataset's admin can change Superset's catalogue at any time, without knowing Lenspack reads it.
 */
export function packFromDatasets(datasets: SupersetDataset[], overlay: Overlay = {}): BuiltPack & { binding: Binding; warnings: string[]; problems: string[] } {
  // What the overlay keeps out of the pack: by name, on every dataset, whatever Superset's flags say.
  const lower = (s: unknown) => String(s).trim().toLowerCase();
  const excludedColumns = new Set((overlay.exclude?.columns ?? []).map(lower));
  const excludedDatasets = new Set((overlay.exclude?.datasets ?? []).map(lower));
  const notDimensions = new Set((overlay.notDimensions ?? []).map(lower));
  const excluded = (column: string) => excludedColumns.has(lower(column)) || excludedColumns.has(slug(column));
  const datasetOut = (ds: SupersetDataset) => excludedDatasets.has(String(ds.id)) || excludedDatasets.has(lower(ds.table_name)) || excludedDatasets.has(lower(`${ds.schema ?? ""}.${ds.table_name}`));
  const binding: Binding = { datasets: new Map(), entityOf: new Map(), metrics: new Map(), measureOf: new Map(), columns: new Map(), dimensionOf: new Map(), geo: new Map(), aggregates: new Map(), ...(overlay.mapStyle ? { mapStyle: overlay.mapStyle } : {}), };
  // A simple aggregate as one measure of an entity: the first to claim it keeps it. A column Superset computes from an
  // expression reads differently in SQL and in Superset's own metric editor, so neither is matched on it.
  const claim = (ds: SupersetDataset, entity: string, a: { agg: SimpleAgg; column: string | null } | null, key: string) => {
    if (!a || (a.column !== null && ds.columns.some((c) => c.column_name === a.column && !blank(c.expression)))) return;
    const own = binding.aggregates!.get(entity) ?? new Map<string, string>();
    binding.aggregates!.set(entity, own);
    if (!own.has(aggregateKey(a))) own.set(aggregateKey(a), key);
  };
  // Every column name the overlay's exclusions match, as Superset spells it (lowercase), for the filter bar's notes.
  if (excludedColumns.size) binding.excluded = new Set([...excludedColumns, ...datasets.flatMap((d) => d.columns.filter((c) => !blank(c.column_name) && excluded(c.column_name)).map((c) => lower(c.column_name)))]);
  // Mistakes in the overlay itself (a measure on a column that isn't there): left out with a warning at start-up, and
  // a reason to keep the pack already loaded on a reload.
  const problems: string[] = [];
  const entities: Record<string, unknown> = {};
  const pb = packBuilder();
  const dimensions = pb.dimensions;
  const measures: Record<string, unknown>[] = [];
  const usedMeasureKeys = new Set<string>();
  const warnings: string[] = [];
  // The column each dimension was made from, to label it again if it has to give its key to a metric.
  const columnOf = new Map<string, SupersetColumn>();
  const name = (ds: SupersetDataset) => `Superset dataset "${ds.table_name}" (${ds.id})`;
  /** A key's label, hint and other-language words: the overlay's (per language or not) over Superset's own. */
  const named = (key: string, label: Words | null | undefined, hint: Words | null | undefined) => {
    const l = wordsOf(overlay.labels?.[key] ?? label ?? undefined);
    const h = wordsOf(overlay.hints?.[key] ?? hint ?? undefined);
    const synonyms = [...new Set(l.others.filter((w) => w.length <= 40 && w !== l.main))].slice(0, 20);
    return { label: cut(l.main, 80), hint: cut(h.main, 400), ...(synonyms.length ? { synonyms } : {}) };
  };

  const used = datasets.filter((ds) => !datasetOut(ds));
  const entityKeys = new Map<SupersetDataset, string>();
  for (const ds of used) {
    const entity = overlay.entities?.[String(ds.id)] ?? overlay.entities?.[ds.table_name] ?? slug(ds.table_name);
    entityKeys.set(ds, entity);
    const time = ds.main_dttm_col && COLUMN.test(ds.main_dttm_col) && !excluded(ds.main_dttm_col) ? ds.main_dttm_col : null;
    // A metric with no name or no expression can't be asked for: Superset would refuse it too.
    const usable = ds.metrics.filter((m) => {
      if (!blank(m.metric_name) && excluded(m.metric_name)) return false;
      if (blank(m.metric_name)) warnings.push(`${name(ds)}: a metric with no name is left out`);
      else if (blank(m.expression)) warnings.push(`${name(ds)}: metric "${m.metric_name}" has no SQL expression and is left out`);
      else return true;
      return false;
    });
    const countMetric = usable.find((m) => COUNT_STAR.test(m.expression))?.metric_name ?? null;
    if (entities[entity]) throw new Error(`Superset datasets ${binding.datasets.get(entity)?.table} and ${ds.table_name} both map to entity "${entity}"; give each its own name in overlay.entities`);
    // Coordinates the overlay excludes are never read, so the dataset has no location.
    const found = geoOf(ds, overlay.geo?.[entity] ?? overlay.geo?.[String(ds.id)] ?? overlay.geo?.[ds.table_name]);
    const geo = found && !excluded(found.lat) && !excluded(found.lon) ? found : null;
    if (geo) binding.geo.set(entity, geo);
    // A time column of calendar dates (DATE, or ClickHouse's Date and Date32) says so: its days need no time zone.
    const dated = !!time && DATE_TYPE.test(ds.columns.find((c) => c.column_name === time)?.type ?? "");
    entities[entity] = { source: `ds_${ds.id}`, grain: cut(ds.description ?? `one row of ${ds.table_name}`, 200), ...(time ? { time: dated ? { field: time, type: "date" } : time } : {}), ...(geo ? { geo } : {}) };
    binding.datasets.set(entity, { id: ds.id, table: ds.table_name, time, countMetric });
    binding.entityOf.set(ds.id, entity);
    binding.measureOf.set(entity, new Map());
    binding.dimensionOf.set(entity, new Map());

    // Columns that group, other than the time column: conformed across datasets by name.
    for (const c of ds.columns) {
      if (c.groupby === false || c.is_dttm || c.column_name === time) continue;
      if (!blank(c.column_name) && (excluded(c.column_name) || notDimensions.has(lower(c.column_name)) || notDimensions.has(slug(c.column_name)))) continue;
      if (blank(c.column_name)) {
        warnings.push(`${name(ds)}: a column with no name is left out`);
        continue;
      }
      const key = slug(c.column_name);
      const source = COLUMN.test(c.column_name) ? { field: c.column_name } : { sql: { superset: c.column_name } };
      const existing = dimensions.get(key);
      // Two columns of one entity that come to the same key (Team and team): the first one is the dimension.
      if (existing && !pb.conform(existing, entity, source)) continue;
      if (!existing) columnOf.set(key, c);
      if (!existing)
        dimensions.set(key, {
          key,
          entity,
          ...source,
          type: typeOf(c),
          ...named(key, c.verbose_name, c.description),
        } as PackDimension);
      binding.columns.set(key, new Map([...(binding.columns.get(key) ?? []), [entity, c.column_name]]));
      binding.dimensionOf.get(entity)!.set(c.column_name, key);
    }

    const metricList = [...usable];
    // Every entity gets a plain row count: filter controls list values by it.
    if (!countMetric) metricList.unshift({ metric_name: "", verbose_name: `${ds.table_name} rows`, expression: "COUNT(*)" });
    for (const m of metricList) {
      let key = slug(m.metric_name || `${entity}_rows`);
      if (key === "count") key = `${entity}_count`;
      if (usedMeasureKeys.has(key)) key = `${entity}_${key}`;
      // Still taken (Total and total in one dataset): the first free of key_2, key_3, …
      for (let i = 2, stem = key; usedMeasureKeys.has(key); i++) key = `${stem}_${i}`;
      usedMeasureKeys.add(key);
      const agg = formatOf(m.d3format) === "percent" && aggOf(m.expression) !== "count" ? "avg" : aggOf(m.expression);
      const words = named(key, m.verbose_name ?? m.metric_name, m.description);
      const hint = [words.hint, m.warning_text].filter(Boolean).join(" ");
      measures.push({
        key,
        entity,
        agg,
        // count takes no fragment: it is COUNT(*), and the binding names the saved metric.
        ...(agg === "count" ? {} : { sql: { superset: m.metric_name } }),
        format: formatOf(m.d3format),
        ...words,
        hint: cut(hint || undefined, 400),
      });
      binding.metrics.set(key, { entity, metric: m.metric_name || null });
      if (m.metric_name) binding.measureOf.get(entity)!.set(m.metric_name, key);
      claim(ds, entity, simpleAggregate(m.expression), key);
    }
  }

  // Base measures from the overlay: a column's sum, count, distinct count, min or max, computed by Superset as an ad
  // hoc metric. Checked against the dataset as Superset describes it; a mistake leaves the measure out and says why.
  for (const [i, om] of (overlay.measures ?? []).entries()) {
    const where = `overlay.measures[${i}]${om && typeof om.name === "string" ? ` (${om.name})` : ""}`;
    const problem = (why: string) => void problems.push(`${where}: ${why}`);
    if (!om || typeof om !== "object") {
      problem("each measure is a map, like { dataset: orders, name: items_sold, agg: sum, column: quantity }");
      continue;
    }
    if (blank(om.name)) {
      problem("give it a name");
      continue;
    }
    const ref = lower(om.dataset ?? "");
    const ds = datasets.find((d) => String(d.id) === ref || lower(d.table_name) === ref || entityKeys.get(d) === ref);
    if (!ds) {
      problem(`dataset "${om.dataset ?? ""}" is not one of the datasets listed`);
      continue;
    }
    if (!entityKeys.has(ds)) {
      problem(`dataset "${ds.table_name}" is excluded`);
      continue;
    }
    if (!(OVERLAY_AGGS as readonly string[]).includes(om.agg)) {
      problem(`agg must be one of ${OVERLAY_AGGS.join(", ")}`);
      continue;
    }
    const entity = entityKeys.get(ds)!;
    const columnNamed = (n: string) => ds.columns.find((c) => c.column_name === n) ?? ds.columns.find((c) => lower(c.column_name) === lower(n));
    const col = om.column === undefined || om.column === null ? null : columnNamed(String(om.column));
    if (om.column !== undefined && om.column !== null && !col) {
      problem(`column "${om.column}" is not a column of Superset dataset "${ds.table_name}"`);
      continue;
    }
    if (!col && om.agg !== "count") {
      problem(`${om.agg} needs a column`);
      continue;
    }
    if (col && excluded(col.column_name)) {
      problem(`column "${col.column_name}" is excluded (overlay.exclude), so no measure may read it`);
      continue;
    }
    if (col && om.agg === "sum" && col.type && typeOf(col) !== "number") {
      problem(`column "${col.column_name}" holds ${String(col.type)}, which can't be added up`);
      continue;
    }
    const conds: AdhocSpec["where"] = [];
    let bad = false;
    for (const w of Array.isArray(om.where) ? om.where : om.where === undefined ? [] : [null]) {
      const c = w && typeof w === "object" && typeof w.column === "string" ? columnNamed(w.column) : undefined;
      const op = (w?.op ?? "eq") as AdhocSpec["where"][number]["op"];
      const v = w?.value;
      if (!c) problem(`where: ${w && typeof w === "object" && typeof w.column === "string" ? `column "${w.column}" is not a column of Superset dataset "${ds.table_name}"` : "each condition is { column, op, value }"}`);
      else if (excluded(c.column_name)) problem(`where: column "${c.column_name}" is excluded (overlay.exclude)`);
      else if (!(WHERE_OPS as readonly string[]).includes(op)) problem(`where: op must be one of ${WHERE_OPS.join(", ")}`);
      else if ((op === "exists" || op === "missing") !== (v === undefined)) problem(`where: ${op === "exists" || op === "missing" ? `${op} takes no value` : `${op} needs a value`}`);
      else if ((op === "in") !== Array.isArray(v) || (Array.isArray(v) && (!v.length || v.length > 100))) problem(`where: ${op === "in" ? "in takes a list of 1 to 100 values" : `${op} takes one value`}`);
      else if (v !== undefined && [v].flat().some((x) => !["string", "number", "boolean"].includes(typeof x))) problem("where: values are text, numbers or true/false");
      else {
        conds.push({ column: c.column_name, op, ...(v === undefined ? {} : { value: v }) });
        continue;
      }
      bad = true;
    }
    if (bad) continue;
    const key = slug(om.name);
    if (usedMeasureKeys.has(key)) {
      problem(`the key "${key}" is already a measure; name it something else`);
      continue;
    }
    usedMeasureKeys.add(key);
    const fmt = om.format && ["number", "percent", "currency", "compact"].includes(om.format) ? om.format : "number";
    const words = named(key, om.label, om.hint);
    // What the measure reads, for the pack's own checks; Superset is sent the ad hoc metric in the binding. A column
    // the pack can't name plainly is named by Superset's own name (count takes neither: it counts what Superset says).
    const reads = !col ? {} : COLUMN.test(col.column_name) ? { field: col.column_name } : om.agg === "count" ? {} : { sql: { superset: col.column_name } };
    // Its conditions too, so "How this was worked out" says which rows it reads (Superset is sent them in the ad hoc metric).
    const only = conds.length && conds.every((c) => COLUMN.test(c.column)) ? { where: conds.map((c) => ({ field: c.column, op: c.op, ...(c.value === undefined ? {} : { value: c.value }) })) } : {};
    measures.push({ key, entity, agg: om.agg, ...reads, ...only, format: fmt, ...words });
    binding.metrics.set(key, { entity, metric: null, adhoc: { agg: om.agg, column: col?.column_name ?? null, where: conds } });
    if (!conds.length) claim(ds, entity, { agg: om.agg, column: col?.column_name ?? null }, key);
    if (col && binding.dimensionOf.get(entity)?.has(col.column_name) && (om.agg === "sum" || om.agg === "min" || om.agg === "max"))
      warnings.push(`${name(ds)}: column "${col.column_name}" is measured by "${key}" and is also a dimension; list it in overlay.notDimensions if it is only ever added up`);
  }
  for (const n of overlay.exclude?.columns ?? []) if (!datasets.some((d) => d.columns.some((c) => excluded(c.column_name) && lower(c.column_name) === lower(n)) || d.metrics.some((m) => lower(m.metric_name) === lower(n)))) warnings.push(`overlay.exclude names "${n}", which no listed dataset has`);
  for (const n of overlay.notDimensions ?? []) if (!datasets.some((d) => d.columns.some((c) => lower(c.column_name) === lower(n) || slug(c.column_name) === lower(n)))) warnings.push(`overlay.notDimensions names "${n}", which no listed dataset has`);

  // A column that groups and a metric can come to the same key (a column children_reached that Superset lets you
  // group by, and the metric children_reached that sums it), and a pack's keys are unique. The metric keeps the key:
  // it is the number the dataset's admin chose to name. The column stays, as <key>_value, so whatever groups or
  // filters by it still can, and its hint says where the total is.
  for (const [key, dim] of [...dimensions]) {
    if (!usedMeasureKeys.has(key)) continue;
    let next = `${key}_value`;
    for (let i = 2; usedMeasureKeys.has(next) || dimensions.has(next); i++) next = `${key}_value_${i}`;
    const c = columnOf.get(key)!;
    dim.key = next;
    Object.assign(dim, named(next, c.verbose_name, c.description ?? `Each row's own ${c.column_name} value. For the total, use the measure ${key}.`));
    const cols = binding.columns.get(key)!;
    binding.columns.delete(key);
    binding.columns.set(next, cols);
    for (const [entity, column] of cols) {
      binding.dimensionOf.get(entity)!.set(column, next);
      const ds = datasets.find((d) => d.id === binding.datasets.get(entity)?.id)!;
      warnings.push(`${name(ds)}: column "${column}" and a metric both come to the key "${key}"; the metric keeps it, and the column is the dimension "${next}"`);
    }
  }
  // Keep the order the columns came in, with the renamed ones under their new keys.
  const ordered = [...dimensions.values()];
  dimensions.clear();
  for (const d of ordered) dimensions.set(d.key, d);

  const hierarchies = Object.fromEntries(Object.entries(overlay.hierarchies ?? {}).filter(([, levels]) => levels.every((l) => dimensions.has(l))));
  const { pack, packYaml } = emitPack({
    pack: overlay.pack ?? "superset",
    version: 1,
    description: overlay.description ?? `Superset datasets: ${used.map((d) => d.table_name).join(", ")}`,
    ...(overlay.timeZone ? { timeZone: overlay.timeZone } : {}),
    entities,
    dimensions: [...dimensions.values()],
    measures,
    hierarchies,
    ...(overlay.instructions ? { instructions: overlay.instructions } : {}),
    ...(overlay.examples?.length ? { examples: examplesForPack(overlay.examples as { question?: unknown }[]) } : {}),
  });
  return { pack, packYaml, binding, warnings, problems };
}

/**
 * superset.yaml's scope: the pack's own row filters, checked against the pack. A clause that is not a filter is an
 * error (a deployment that means to pin its answers must not start unpinned). One naming a dimension or dataset the
 * pack doesn't have is kept, so every question it should narrow is refused (OUT_OF_SCOPE) rather than answered for
 * all rows, and it is said as a warning.
 */
export function packScope(given: unknown, pack: Pack): { clauses: ScopeClause[]; warnings: string[] } {
  if (given === undefined || given === null) return { clauses: [], warnings: [] };
  if (!Array.isArray(given)) throw new Error("scope must be a list of filters, like [{ dimension: campaign, op: eq, value: 2026-spring }]");
  const clauses: ScopeClause[] = [];
  const warnings: string[] = [];
  given.forEach((c, i) => {
    const { entity, ...clause } = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const parsed = filterClauseSchema.safeParse(clause);
    if (!parsed.success) throw new Error(`scope[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(clause)"}: ${x.message}`).join("; ")}`);
    if (entity !== undefined && typeof entity !== "string") throw new Error(`scope[${i}].entity must be an entity key`);
    const out: ScopeClause = { ...parsed.data, ...(entity ? { entity } : {}) };
    const dim = pack.dimensions.find((d) => d.key === out.dimension);
    if (entity && !pack.entities[entity]) warnings.push(`scope[${i}] names the dataset "${entity}", which the pack does not have; nothing is narrowed by it`);
    else if (!dim) warnings.push(`scope[${i}] filters on "${out.dimension}", which is not a dimension of the pack: every question is refused until it is`);
    else {
      const reach = [dim.entity, ...Object.keys(dim.also ?? {})];
      const missing = Object.keys(pack.entities).filter((e) => !reach.includes(e) && (!entity || entity === e));
      if (missing.length) warnings.push(`scope[${i}] filters on "${out.dimension}", which ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not have: questions on ${missing.length === 1 ? "it" : "them"} are refused`);
    }
    clauses.push(out);
  });
  return { clauses, warnings };
}
