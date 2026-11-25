// What differs on Superset 6.1, with payloads shaped as Superset 6.1 sends and saves them.
import { describe, expect, it } from "vitest";

import type { SupersetClient } from "../src/client";
import { MAPBOX_LIGHT, OSM_STREETS, chartToWidget, defaultMapStyle, packFromDatasets, queryContextOf, supersetVersion, widgetToChart, type SupersetDataset } from "../src/index";

// Made-up visits with a date, as a stock dataset has them.
const DATASETS: SupersetDataset[] = [
  {
    id: 1,
    table_name: "visits",
    main_dttm_col: "visit_date",
    columns: [
      { column_name: "visit_date", is_dttm: true, type: "DATE" },
      { column_name: "region", groupby: true, type: "VARCHAR" },
      { column_name: "children", groupby: false, type: "INTEGER" },
    ],
    metrics: [{ metric_name: "count", expression: "COUNT(*)" }, { metric_name: "children_sum", expression: "SUM(children)" }],
  },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "1": "visit" } });

const client = (answers: Record<string, unknown>): SupersetClient => ({
  url: "http://superset",
  get: async (path: string) => {
    if (!(path in answers)) throw new Error(`404 ${path}`);
    return answers[path] as never;
  },
  post: async () => ({}) as never,
  put: async () => ({}) as never,
  delete: async () => ({}) as never,
});

describe("Superset's version", () => {
  it("comes from the plugin's route, else Superset 6.1's own /version, else is taken as 5", async () => {
    expect(await supersetVersion(client({ "/api/v1/lenspack/version": { result: { superset: "6.1.0" } } }))).toEqual({ version: "6.1.0", major: 6 });
    expect(await supersetVersion(client({ "/api/v1/lenspack/version": { result: { superset: "5.0.0" } }, "/version": {} }))).toEqual({ version: "5.0.0", major: 5 });
    // A plugin from before the route, on Superset 6.1: its public /version, as 6.1 answers it.
    expect(await supersetVersion(client({ "/version": { build_number: null, version_sha: "abc1234", version_string: "6.1.0" } }))).toEqual({ version: "6.1.0", major: 6 });
    // Superset 5 (or 6.0) with an older plugin: neither answers.
    expect(await supersetVersion(client({}))).toEqual({ version: null, major: 5 });
    expect(await supersetVersion(client({ "/version": { version_string: "dev" } }))).toEqual({ version: null, major: 5 });
  });

  it("picks the maps' basemap: Superset 6's OpenStreetMap default, Mapbox on 5", () => {
    expect(defaultMapStyle(6)).toBe(OSM_STREETS);
    expect(defaultMapStyle(7)).toBe(OSM_STREETS);
    expect(defaultMapStyle(5)).toBe(MAPBOX_LIGHT);
  });

  it("writes maps on the binding's basemap", () => {
    const w = { title: "Visits", kind: "chart", chart: "map", query: { kind: "points", entity: "visit", limit: 100 } } as const;
    const geo = packFromDatasets([{ ...DATASETS[0]!, columns: [...DATASETS[0]!.columns, { column_name: "latitude", type: "FLOAT" }, { column_name: "longitude", type: "FLOAT" }] }], { pack: "t", entities: { "1": "visit" } });
    expect((widgetToChart(w as never, geo.pack, { ...geo.binding, mapStyle: OSM_STREETS })!.params as Record<string, unknown>).mapbox_style).toBe(OSM_STREETS);
  });
});

describe("a table over time", () => {
  it("saves a query grouped by the date at its grain, as Superset's table builds it", () => {
    const spec = widgetToChart({ title: "Visits per week", kind: "table", query: { kind: "series", measure: "visit_count", grain: "week" } } as never, pack, binding)!;
    expect(spec.viz_type).toBe("table");
    const q = (queryContextOf(spec) as { queries: Record<string, any>[] }).queries[0]!;
    // Not the bare column, which would list one row per day.
    expect(q.columns).toEqual([{ timeGrain: "P1W", columnType: "BASE_AXIS", sqlExpression: "visit_date", label: "visit_date", expressionType: "SQL" }]);
  });
});

describe("form data as Superset 6.1 hands it back", () => {
  it("is read back whatever order its keys come in", () => {
    // Superset 6 returns every object in a chart's form data with its keys sorted.
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;
    for (const widget of [
      { title: "Visits per month", kind: "table", pageSize: 10, query: { kind: "series", measure: "visit_count", grain: "month" } },
      { title: "Children by region", kind: "chart", chart: "bar", query: { kind: "breakdown", dimension: "region", measure: "children_sum", limit: 10, filters: [{ dimension: "region", op: "in", value: ["north", "south"] }] } },
    ]) {
      const spec = widgetToChart(widget as never, pack, binding)!;
      const back = chartToWidget({ slice_name: widget.title, viz_type: spec.viz_type, params: sortKeys(spec.params) as Record<string, unknown>, datasource_id: 1 }, pack, binding);
      expect(back.widget, "reason" in back ? String(back.reason) : undefined).toMatchObject({ kind: widget.kind, query: widget.query });
    }
  });
});
