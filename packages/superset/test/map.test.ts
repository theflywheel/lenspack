import { describe, expect, it } from "vitest";

import { applyOps, emptyBoard } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";

import { chartToWidget, geoOf, packFromDatasets, queryContextOf, queryObjects, widgetToChart, type SupersetDataset } from "../src/index";
import { resolve } from "@lenspack/engine";
import { SUPERSET_CAPABILITIES } from "../src/connector";

// Made-up sites with coordinates Superset does not group by, as a stock dataset has them.
const DATASETS: SupersetDataset[] = [
  {
    id: 9,
    table_name: "sites",
    columns: [
      { column_name: "latitude", groupby: false, filterable: false, type: "Float64" },
      { column_name: "longitude", groupby: false, filterable: false, type: "Float64" },
      { column_name: "site", groupby: true, type: "String" },
      { column_name: "area", groupby: true, type: "String" },
      { column_name: "band", groupby: true, type: "String" },
    ],
    metrics: [
      { metric_name: "sites", expression: "count()" },
      { metric_name: "people", expression: "sum(people)", d3format: ",d" },
      { metric_name: "share_seen", expression: "sum(seen)/sum(people)", d3format: ".1%" },
    ],
  },
  { id: 10, table_name: "visits", columns: [{ column_name: "area", groupby: true, type: "String" }], metrics: [{ metric_name: "visits", expression: "COUNT(*)" }] },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "9": "site", "10": "visit" } });
const read = (params: Record<string, unknown>, slice_name = "Sites") => chartToWidget({ slice_name, viz_type: "deck_scatter", params: { datasource: "9__table", ...params } }, pack, binding);

describe("an entity's location", () => {
  it("is found by column name, grouped by Superset or not, and told to the model", () => {
    expect(binding.geo.get("site")).toEqual({ lat: "latitude", lon: "longitude" });
    expect(pack.entities.site!.geo).toEqual({ lat: "latitude", lon: "longitude" });
    expect(binding.geo.has("visit")).toBe(false);
    expect(catalogueFrom(pack).entities.find((e) => e.key === "site")!.hasLocation).toBe(true);
    // The coordinates are not dimensions: they are the location.
    expect(pack.dimensions.some((d) => d.key === "latitude")).toBe(false);
  });

  it("can be named, or switched off, in the config", () => {
    const ds = { ...DATASETS[0]!, columns: [...DATASETS[0]!.columns, { column_name: "y_deg", type: "DOUBLE" }, { column_name: "x_deg", type: "DOUBLE" }] };
    expect(geoOf(ds, { lat: "y_deg", lon: "x_deg" })).toEqual({ lat: "y_deg", lon: "x_deg" });
    expect(geoOf(ds, false)).toBeNull();
    expect(() => geoOf(ds, { lat: "nope", lon: "x_deg" })).toThrow(/not a column/);
    // Text columns with the right names are not coordinates.
    expect(geoOf({ ...ds, columns: [{ column_name: "lat", type: "VARCHAR" }, { column_name: "lon", type: "VARCHAR" }] }, undefined)).toBeNull();
  });
});

describe("maps in Superset", () => {
  const cases = [
    { title: "Sites by band", kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query: { kind: "points", entity: "site", color: "band", label: "site", limit: 1000 } },
    { title: "People seen per site", kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query: { kind: "points", entity: "site", size: "people", limit: 5000, filters: [{ dimension: "area", op: "eq", value: "North" }] } },
    { title: "Every site", kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query: { kind: "points", entity: "site", limit: 500 } },
  ] as const;

  for (const w of cases)
    it(`writes “${w.title}” as a deck.gl scatter map and reads back the identical widget, marker or not`, () => {
      const spec = widgetToChart(w as never, pack, binding)!;
      expect(spec.viz_type).toBe("deck_scatter");
      expect(spec.params).toMatchObject({ spatial: { type: "latlong", latCol: "latitude", lonCol: "longitude" }, row_limit: w.query.limit, autozoom: true, filter_nulls: true, mapbox_style: "mapbox://styles/mapbox/light-v9" });
      expect(chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: spec.params, datasource_id: spec.datasetId }, pack, binding).widget).toEqual(w);
      const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
      expect(chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: plain, datasource_id: spec.datasetId }, pack, binding).widget).toEqual(w);
      // Superset reads a deck.gl chart from its form data alone.
      expect(queryContextOf(spec)).toBeNull();
    });

  it("colours by a column and sizes by a saved metric (Superset then groups per point)", () => {
    const [byBand, bySize] = cases.map((w) => widgetToChart(w as never, pack, binding)!.params as Record<string, unknown>);
    expect(byBand).toMatchObject({ dimension: "band", js_columns: ["site"], point_radius_fixed: { type: "fix" } });
    expect(byBand!.color_picker).toBeUndefined();
    expect(bySize).toMatchObject({ point_radius_fixed: { type: "metric", value: "people" }, point_unit: "square_km", js_columns: [] });
    expect(bySize!.dimension).toBeUndefined();
    const share = widgetToChart({ ...cases[0], query: { kind: "points", entity: "site", size: "share_seen", limit: 100 } } as never, pack, binding)!.params as Record<string, unknown>;
    expect(share).toMatchObject({ point_unit: "radius_km", multiplier: 8 });
    expect(bySize).toMatchObject({ multiplier: 0.3, min_radius: 3, max_radius: 20 });
  });

  it("takes the basemap from the config", () => {
    const styled = packFromDatasets(DATASETS, { pack: "t", entities: { "9": "site", "10": "visit" }, mapStyle: "mapbox://styles/mapbox/streets-v9" });
    expect(widgetToChart(cases[0] as never, styled.pack, styled.binding)!.params).toMatchObject({ mapbox_style: "mapbox://styles/mapbox/streets-v9" });
  });

  it("reads a map made in Superset's Explore, with its defaults", () => {
    const got = read({ spatial: { type: "latlong", latCol: "latitude", lonCol: "longitude" }, point_radius_fixed: { type: "fix", value: 1500 }, point_unit: "square_m", row_limit: 5000, color_picker: { r: 1, g: 2, b: 3, a: 1 }, mapbox_style: "mapbox://styles/mapbox/dark-v9", autozoom: true, adhoc_filters: [], time_range: "No filter", js_columns: [] }, "Facilities");
    expect(got.widget).toEqual({ title: "Facilities", kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query: { kind: "points", entity: "site", limit: 5000 } });
    // Superset's own default row limit is larger than a map holds.
    expect((read({ spatial: { type: "latlong", latCol: "latitude", lonCol: "longitude" } }).widget as { query: { limit: number } }).query.limit).toBe(5000);
  });

  it("keeps Superset's map as it is when it says something a map widget cannot", () => {
    const spatial = { type: "latlong", latCol: "latitude", lonCol: "longitude" };
    expect(read({ spatial: { type: "delimited", lonlatCol: "site" } })).toMatchObject({ widget: null, reason: expect.stringMatching(/not read from a latitude/) });
    expect(read({ spatial: { ...spatial, reverseCheckbox: true } }).widget).toBeNull();
    expect(read({ spatial: { type: "latlong", latCol: "longitude", lonCol: "latitude" } }).widget).toBeNull();
    expect(read({ spatial, time_grain_sqla: "P1D" })).toMatchObject({ reason: expect.stringMatching(/over time/) });
    expect(read({ spatial, js_tooltip: "d => d.x" })).toMatchObject({ reason: expect.stringMatching(/JavaScript/) });
    expect(read({ spatial, point_radius_fixed: { type: "metric", value: { expressionType: "SIMPLE", column: { column_name: "people" }, aggregate: "SUM" } } })).toMatchObject({ reason: expect.stringMatching(/sized by something other/) });
    expect(read({ spatial, dimension: "latitude" })).toMatchObject({ reason: expect.stringMatching(/coloured by "latitude"/) });
    expect(read({ spatial, js_columns: ["site", "area"] })).toMatchObject({ reason: expect.stringMatching(/extra columns/) });
    expect(chartToWidget({ slice_name: "x", viz_type: "deck_scatter", params: { datasource: "10__table", spatial } }, pack, binding)).toMatchObject({ reason: expect.stringMatching(/no latitude/) });
  });

  it("queries the points through chart data: coordinates, colour and name, located rows only, one past the limit", () => {
    const bound = resolve({ kind: "points", entity: "site", color: "band", label: "site", size: "people", limit: 100 }, pack, {}, SUPERSET_CAPABILITIES);
    const { queries } = queryObjects(bound, binding);
    expect(queries[0]).toMatchObject({ columns: ["latitude", "longitude", "band", "site"], metrics: ["people"], orderby: [["people", false]], row_limit: 101 });
    expect(queries[0]!.filters.slice(0, 2)).toEqual([{ col: "latitude", op: "IS NOT NULL" }, { col: "longitude", op: "IS NOT NULL" }]);
  });

  it("validates a map before it reaches the board", () => {
    const cat = catalogueFrom(pack);
    const add = (widget: unknown) => applyOps(emptyBoard(pack, "b"), [{ op: "add_widget", id: "m", widget } as never], cat);
    expect(add(cases[0]).ok).toBe(true);
    expect(add({ ...cases[0], query: { kind: "points", entity: "visit", limit: 10 } })).toMatchObject({ ok: false, error: expect.stringMatching(/"visit" has no location.*these do: site/) });
    expect(add({ ...cases[0], query: { kind: "breakdown", dimension: "band", measure: "sites" } })).toMatchObject({ ok: false, error: expect.stringMatching(/A map draws a points query/) });
    expect(add({ title: "t", kind: "kpi", aggregate: "last", query: cases[0].query })).toMatchObject({ ok: false, error: expect.stringMatching(/drawn as a map chart, or listed in a table/) });
    expect(add({ ...cases[0], query: { ...cases[0].query, size: "visits" } })).toMatchObject({ ok: false, error: expect.stringMatching(/must be a measure of the points' own entity/) });
  });
});
