import { type Pack, parsePack } from "@lenspack/spec";
import YAML from "yaml";

import { type SupersetClient, rison } from "./client";

// Superset's datasets are the catalogue: a dataset is an entity, its saved
// metrics are measures, its groupable columns are dimensions. The pack built
// here names Superset's own metrics (sql: { superset: <metric_name> }), so a
// number means exactly what it means in Superset and is computed there.

export type SupersetColumn = { column_name: string; verbose_name?: string | null; description?: string | null; type?: string | null; is_dttm?: boolean; groupby?: boolean; filterable?: boolean; expression?: string | null };
export type SupersetMetric = { metric_name: string; verbose_name?: string | null; description?: string | null; expression: string; d3format?: string | null; warning_text?: string | null };
export type SupersetDataset = { id: number; table_name: string; schema?: string | null; description?: string | null; main_dttm_col?: string | null; columns: SupersetColumn[]; metrics: SupersetMetric[]; database?: { id: number; database_name?: string } };

/** What lenspack adds on top of Superset's own descriptions: the parts Superset has no field for. */
export type Overlay = {
  pack?: string;
  description?: string;
  instructions?: string;
  timeZone?: string;
  /** Entity key per dataset id or table name, instead of the slugged table name. */
  entities?: Record<string, string>;
  /** Hints and labels by key, over Superset's descriptions and verbose names. */
  hints?: Record<string, string>;
  labels?: Record<string, string>;
  hierarchies?: Record<string, string[]>;
  examples?: unknown[];
  /** How the chat opens on Superset's pages by default: a floating window or a side panel. Each user can change it. */
  panel?: "float" | "dock";
};

/** How pack keys map back to Superset names: the connector and the dashboard writer read this. */
export type Binding = {
  /** Entity key → dataset. */
  datasets: Map<string, { id: number; table: string; time: string | null; countMetric: string | null }>;
  /** Dataset id → entity key. */
  entityOf: Map<number, string>;
  /** Measure key → { entity, metric name } (null metric: COUNT(*) with no saved metric). */
  metrics: Map<string, { entity: string; metric: string | null }>;
  /** Entity → (metric name → measure key). */
  measureOf: Map<string, Map<string, string>>;
  /** Dimension key → (entity → column name). */
  columns: Map<string, Map<string, string>>;
  /** Entity → (column name → dimension key). */
  dimensionOf: Map<string, Map<string, string>>;
};

export const slug = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
    .replace(/^_/, "k") || "k";

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// COUNT(*), or ClickHouse's count().
const COUNT_STAR = /^\s*count\s*\(\s*\*?\s*\)\s*$/i;

// ClickHouse spells some aggregates as functions: the -If combinator (countIf(cond), sumIf(x, cond))
// and the uniq family for distinct counts.
const CH_SUM = new Set(["countif", "sumif"]);
// The -Merge forms read a stored AggregateFunction state (uniqExactMerge(col) in a pre-aggregated mart).
const CH_DISTINCT = new Set(["uniq", "uniqexact", "uniqcombined", "uniqcombined64", "uniqhll12", "uniqtheta", "countdistinct", "uniqmerge", "uniqexactmerge", "uniqcombinedmerge", "uniqcombined64merge", "uniqhll12merge"]);
const CH_SUM_MERGE = new Set(["summerge", "countmerge"]);

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
  const t = (c.type ?? "").toUpperCase();
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
    return retry(`Superset dataset "${ref}"`, async () => {
      const found = await client.get<{ result: { id: number }[] }>(`/api/v1/dataset/?q=${encodeURIComponent(rison({ filters, columns: ["id"] }))}`);
      const n = found?.result?.length ?? 0;
      if (n !== 1) throw new Error(`Superset dataset "${ref}": ${n ? "more than one matches; name the schema" : "not found"}`);
      return found.result[0]!.id;
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

/** Datasets → a pack and the binding back to Superset names. */
export function packFromDatasets(datasets: SupersetDataset[], overlay: Overlay = {}): { pack: Pack; packYaml: string; binding: Binding } {
  const binding: Binding = { datasets: new Map(), entityOf: new Map(), metrics: new Map(), measureOf: new Map(), columns: new Map(), dimensionOf: new Map() };
  const entities: Record<string, unknown> = {};
  const dimensions: Record<string, any>[] = [];
  const measures: Record<string, unknown>[] = [];
  const usedMeasureKeys = new Set<string>();

  for (const ds of datasets) {
    const entity = overlay.entities?.[String(ds.id)] ?? overlay.entities?.[ds.table_name] ?? slug(ds.table_name);
    const time = ds.main_dttm_col && COLUMN.test(ds.main_dttm_col) ? ds.main_dttm_col : null;
    const countMetric = ds.metrics.find((m) => COUNT_STAR.test(m.expression))?.metric_name ?? null;
    if (entities[entity]) throw new Error(`Superset datasets ${binding.datasets.get(entity)?.table} and ${ds.table_name} both map to entity "${entity}"; give each its own name in overlay.entities`);
    entities[entity] = { source: `ds_${ds.id}`, grain: cut(ds.description ?? `one row of ${ds.table_name}`, 200), ...(time ? { time } : {}) };
    binding.datasets.set(entity, { id: ds.id, table: ds.table_name, time, countMetric });
    binding.entityOf.set(ds.id, entity);
    binding.measureOf.set(entity, new Map());
    binding.dimensionOf.set(entity, new Map());

    // Columns that group, other than the time column: conformed across datasets by name.
    for (const c of ds.columns) {
      if (c.groupby === false || c.is_dttm || c.column_name === time) continue;
      const key = slug(c.column_name);
      const source = COLUMN.test(c.column_name) ? { field: c.column_name } : { sql: { superset: c.column_name } };
      const existing = dimensions.find((d) => d.key === key);
      // Two columns of one entity that come to the same key (Team and team): the first one is the dimension.
      if (existing && (existing.entity === entity || existing.also?.[entity])) continue;
      if (existing) {
        existing.also = { ...(existing.also ?? {}), [entity]: source };
      } else {
        dimensions.push({
          key,
          entity,
          ...source,
          type: typeOf(c),
          label: cut(overlay.labels?.[key] ?? c.verbose_name ?? undefined, 80),
          hint: cut(overlay.hints?.[key] ?? c.description ?? undefined, 400),
        });
      }
      binding.columns.set(key, new Map([...(binding.columns.get(key) ?? []), [entity, c.column_name]]));
      binding.dimensionOf.get(entity)!.set(c.column_name, key);
    }

    const metricList = [...ds.metrics];
    // Every entity gets a plain row count: filter controls list values by it.
    if (!countMetric) metricList.unshift({ metric_name: "", verbose_name: `${ds.table_name} rows`, expression: "COUNT(*)" });
    for (const m of metricList) {
      let key = slug(m.metric_name || `${entity}_rows`);
      if (key === "count") key = `${entity}_count`;
      if (usedMeasureKeys.has(key)) key = `${entity}_${key}`;
      usedMeasureKeys.add(key);
      const agg = formatOf(m.d3format) === "percent" && aggOf(m.expression) !== "count" ? "avg" : aggOf(m.expression);
      const hint = [overlay.hints?.[key] ?? m.description, m.warning_text].filter(Boolean).join(" ");
      measures.push({
        key,
        entity,
        agg,
        // count takes no fragment: it is COUNT(*), and the binding names the saved metric.
        ...(agg === "count" ? {} : { sql: { superset: m.metric_name } }),
        format: formatOf(m.d3format),
        label: cut(overlay.labels?.[key] ?? m.verbose_name ?? m.metric_name, 80),
        hint: cut(hint || undefined, 400),
      });
      binding.metrics.set(key, { entity, metric: m.metric_name || null });
      if (m.metric_name) binding.measureOf.get(entity)!.set(m.metric_name, key);
    }
  }

  const hierarchies = Object.fromEntries(Object.entries(overlay.hierarchies ?? {}).filter(([, levels]) => levels.every((l) => dimensions.some((d) => d.key === l))));
  const raw = {
    pack: overlay.pack ?? "superset",
    version: 1,
    description: overlay.description ?? `Superset datasets: ${datasets.map((d) => d.table_name).join(", ")}`,
    ...(overlay.timeZone ? { timeZone: overlay.timeZone } : {}),
    entities,
    dimensions: dimensions.map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))),
    measures: measures.map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined))),
    hierarchies,
    ...(overlay.instructions ? { instructions: overlay.instructions } : {}),
    ...(overlay.examples?.length ? { examples: overlay.examples } : {}),
  };
  const packYaml = YAML.stringify(raw, { lineWidth: 0 });
  return { pack: parsePack(raw), packYaml, binding };
}
