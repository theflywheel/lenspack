import { type Pack, parsePack } from "@lenspack/spec";
import YAML from "yaml";

import type { SupersetClient } from "./client";

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
  /** Entity key per dataset id, instead of the slugged table name. */
  entities?: Record<string, string>;
  /** Hints and labels by key, over Superset's descriptions and verbose names. */
  hints?: Record<string, string>;
  labels?: Record<string, string>;
  hierarchies?: Record<string, string[]>;
  examples?: unknown[];
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
const COUNT_STAR = /^\s*count\s*\(\s*\*\s*\)\s*$/i;

/** The aggregate a metric's expression behaves like, for what lenspack lets you do with it (share, Other, totals). */
export function aggOf(expression: string): "count" | "sum" | "avg" | "min" | "max" | "count_distinct" {
  const e = expression.trim();
  if (COUNT_STAR.test(e)) return "count";
  // A ratio or arithmetic over aggregates does not add up over groups.
  const outer = /^(\w+)\s*\(/.exec(e)?.[1]?.toLowerCase();
  const balanced = outer ? closesAtEnd(e) : false;
  if (!balanced) return "avg";
  if (outer === "count") return /^count\s*\(\s*distinct\b/i.test(e) ? "count_distinct" : "sum";
  if (outer === "sum") return "sum";
  if (outer === "min") return "min";
  if (outer === "max") return "max";
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

export async function fetchDatasets(client: SupersetClient, ids: number[]): Promise<SupersetDataset[]> {
  return Promise.all(ids.map(async (id) => (await client.get<{ result: SupersetDataset }>(`/api/v1/dataset/${id}`)).result));
}

/** Datasets → a pack and the binding back to Superset names. */
export function packFromDatasets(datasets: SupersetDataset[], overlay: Overlay = {}): { pack: Pack; packYaml: string; binding: Binding } {
  const binding: Binding = { datasets: new Map(), entityOf: new Map(), metrics: new Map(), measureOf: new Map(), columns: new Map(), dimensionOf: new Map() };
  const entities: Record<string, unknown> = {};
  const dimensions: Record<string, any>[] = [];
  const measures: Record<string, unknown>[] = [];
  const usedMeasureKeys = new Set<string>();

  for (const ds of datasets) {
    const entity = overlay.entities?.[String(ds.id)] ?? slug(ds.table_name);
    const time = ds.main_dttm_col && COLUMN.test(ds.main_dttm_col) ? ds.main_dttm_col : null;
    const countMetric = ds.metrics.find((m) => COUNT_STAR.test(m.expression))?.metric_name ?? null;
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
