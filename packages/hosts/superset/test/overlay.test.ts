// The overlay as the whole of a deployment's setup: what the pack leaves out (exclude), which groupable columns are not
// dimensions (notDimensions), base measures made from columns (measures) and labels in several languages, all from
// superset.yaml with no change to Superset's datasets.
import { describe, expect, it } from "vitest";

import { boardTools } from "@lenspack/agent";
import { memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { viewerSelections } from "@lenspack/policy";
import { catalogueText } from "@lenspack/serve";

import { dashboardToBoard } from "../src/dashboard";
import { filtersFromNative } from "../src/filters";
import { type Overlay, type SupersetDataset, adhocMetric, chartToWidget, packFromDatasets, packScope, queryObjects, supersetConnector, widgetToChart } from "../src/index";

// A shop's datasets as Superset describes them when nobody has tuned them: one saved metric (a row count) each, and
// every column groupable, the amounts and the personal ones too.
const ORDERS: SupersetDataset = {
  id: 11,
  table_name: "orders",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
    { column_name: "campaign", groupby: true, type: "VARCHAR" },
    { column_name: "status", groupby: true, type: "VARCHAR" },
    { column_name: "CustomerName", groupby: true, type: "VARCHAR" },
    { column_name: "loyalty_code", groupby: true, type: "VARCHAR" },
    { column_name: "latitude", groupby: true, type: "DOUBLE PRECISION" },
    { column_name: "longitude", groupby: true, type: "DOUBLE PRECISION" },
    { column_name: "quantity", groupby: true, type: "BIGINT" },
    { column_name: "basket_value", groupby: true, type: "NUMERIC(10,2)" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
};
const RETURNS: SupersetDataset = {
  id: 12,
  table_name: "returns",
  main_dttm_col: "returned_at",
  columns: [
    { column_name: "returned_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
    { column_name: "reason", groupby: true, type: "VARCHAR" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
};

const OVERLAY: Overlay = {
  pack: "shop",
  exclude: { columns: ["customername", "loyalty_code", "latitude", "longitude"] },
  notDimensions: ["quantity", "basket_value"],
  labels: { region: { en: "Region", fr: "Région" } },
  measures: [
    { dataset: "orders", name: "items_sold", agg: "sum", column: "quantity", label: { en: "Items sold", fr: "Articles vendus" } },
    { dataset: "orders", name: "delivered_orders", agg: "count", where: [{ column: "status", op: "eq", value: "delivered" }], label: "Delivered orders" },
    { dataset: 11, name: "regions_selling", agg: "count_distinct", column: "region" },
    { dataset: "orders", name: "largest_basket", agg: "max", column: "basket_value", format: "currency" },
  ],
};

const built = () => packFromDatasets([ORDERS, RETURNS], OVERLAY);
const keys = (p: ReturnType<typeof built>["pack"]) => [...p.dimensions.map((d) => d.key), ...p.measures.map((m) => m.key)];

describe("overlay.exclude", () => {
  it("keeps the columns out of the pack on every dataset, whatever Superset's flags say", () => {
    const { pack, packYaml, binding, problems } = built();
    expect(problems).toEqual([]);
    expect(keys(pack)).not.toContain("customer_name");
    expect(keys(pack)).not.toContain("loyalty_code");
    expect(keys(pack)).not.toContain("latitude");
    expect(packYaml).not.toMatch(/CustomerName|loyalty_code|latitude|longitude/i);
    // Coordinates excluded: the dataset has no location, so no map can read them.
    expect(pack.entities.orders!.geo).toBeUndefined();
    expect(binding.geo.size).toBe(0);
    expect([...binding.excluded!]).toEqual(expect.arrayContaining(["customername", "loyalty_code", "latitude", "longitude"]));
  });

  it("matches a column by its key as well as its name, and can leave out a whole dataset", () => {
    const { pack } = packFromDatasets([ORDERS, RETURNS], { exclude: { columns: ["customer_name"], datasets: ["returns"] } });
    expect(keys(pack)).not.toContain("customer_name");
    expect(pack.entities.returns).toBeUndefined();
    expect(pack.description).not.toMatch(/returns/);
  });

  it("is absent from the chat's prompt catalogue and its tools", () => {
    const { pack, binding } = built();
    const text = catalogueText(pack, catalogueFrom(pack));
    expect(text).not.toMatch(/customer|loyalty|latitude|longitude/i);
    const tools = boardTools({ pack, connector: supersetConnector({} as never, binding), store: memoryStore(), boardId: "b", ctx: {} });
    expect(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })))).not.toMatch(/customer|loyalty|latitude/i);
  });

  it("can't be read by any query: a rows query naming one is refused by the pack, and points have nothing to read", async () => {
    const { pack, binding } = built();
    const { resolve } = await import("@lenspack/engine");
    expect(() => resolve({ kind: "rows", entity: "orders", columns: ["region", "customer_name"], limit: 10 }, pack)).toThrow(/customer_name/);
    expect(() => queryObjects(resolve({ kind: "points", entity: "orders", limit: 10 } as never, pack), binding)).toThrow();
  });

  it("wins over a measure that would read the column, which is a problem, not a silent measure", () => {
    const { pack, problems } = packFromDatasets([ORDERS], { exclude: { columns: ["basket_value"] }, measures: [{ dataset: "orders", name: "spend", agg: "sum", column: "basket_value" }] });
    expect(pack.measures.map((m) => m.key)).not.toContain("spend");
    expect(problems).toEqual([expect.stringMatching(/overlay.measures\[0\] \(spend\): column "basket_value" is excluded/)]);
  });

  it("describes a dashboard filter on an excluded column without its name or default values", () => {
    const { binding } = built();
    const meta = {
      native_filter_configuration: [
        { id: "NATIVE_FILTER-a", name: "Customer", filterType: "filter_select", targets: [{ datasetId: 11, column: { name: "CustomerName" } }], defaultDataMask: { filterState: { value: ["A. Person"] } } },
        { id: "NATIVE_FILTER-b", name: "Area", filterType: "filter_range", targets: [{ datasetId: 11, column: { name: "latitude" } }], defaultDataMask: { filterState: { value: [1.5, 2.5] } } },
      ],
    };
    const filters = filtersFromNative(meta, binding, [], new Map());
    expect(filters.map((f) => f.type)).toEqual(["host", "host"]);
    const said = JSON.stringify(filters);
    expect(said).not.toMatch(/CustomerName|A\. Person|latitude|1\.5/);
    expect(filters[0]!.note).toMatch(/a field this assistant does not use/);
  });

  it("does not say an excluded column's name in a filter's own name, when that is what the filter is called", () => {
    const { binding } = built();
    const meta = { native_filter_configuration: [{ id: "NATIVE_FILTER-c", name: "Latitude", filterType: "filter_range", targets: [{ datasetId: 11, column: { name: "latitude" } }] }] };
    const [f] = filtersFromNative(meta, binding, [], new Map());
    expect(JSON.stringify(f)).not.toMatch(/latitude/i);
    expect(f!.label).toBe("Filter on a field this assistant does not use");
  });

  it("keeps excluded column names out of what the model reads of Superset's own charts: their descriptions and the board notes", () => {
    const { pack, binding } = built();
    const chart = (id: number, slice_name: string, form: Record<string, unknown>) => ({ id, slice_name, form_data: { datasource: "11__table", ...form } });
    const charts = [
      // A map of the excluded coordinates.
      chart(1, "Where orders are", { viz_type: "deck_scatter", spatial: { type: "latlong", latCol: "latitude", lonCol: "longitude" } }),
      // A bar chart by an excluded column, one filtered on one, a heatmap and a map coloured by one.
      chart(2, "Orders by customer", { viz_type: "echarts_timeseries_bar", metrics: ["count"], x_axis: "CustomerName" }),
      chart(3, "Loyal orders", { viz_type: "big_number_total", metric: "count", adhoc_filters: [{ expressionType: "SIMPLE", subject: "loyalty_code", operator: "IN", comparator: ["X1"] }] }),
      chart(4, "Heat", { viz_type: "heatmap_v2", metric: "count", groupby: "CustomerName", x_axis: "region" }),
      chart(5, "Coloured map", { viz_type: "deck_scatter", spatial: { type: "latlong", latCol: "lat2", lonCol: "lon2" }, dimension: "loyalty_code" }),
    ];
    const position = Object.fromEntries([["ROOT_ID", { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] }], ["GRID_ID", { id: "GRID_ID", type: "GRID", children: ["ROW-1"] }], ["ROW-1", { id: "ROW-1", type: "ROW", children: charts.map((c) => `CHART-${c.id}`) }], ...charts.map((c) => [`CHART-${c.id}`, { id: `CHART-${c.id}`, type: "CHART", children: [], meta: { chartId: c.id, width: 2, height: 50 } }])]);
    const read = { dash: { id: 9, dashboard_title: "Shop", position_json: JSON.stringify(position), json_metadata: null, changed_on: "2026-01-01T00:00:00" }, charts, position } as never;
    const { config, notes } = dashboardToBoard(read, pack, binding);
    expect(Object.values(config.widgets).every((w) => w.kind === "text")).toBe(true);
    const said = JSON.stringify({ bodies: Object.values(config.widgets).map((w) => (w as { body?: string }).body), notes });
    expect(said).not.toMatch(/customername|loyalty_code|latitude|longitude/i);
    expect(said).toMatch(/a field this assistant does not use/);
    expect(said).toMatch(/its points are read from fields this assistant does not use/);
  });
});

describe("viewer selections", () => {
  it("keep only fields the pack has and the caller may use; the rest are dropped and counted", () => {
    const { pack } = built();
    const v = viewerSelections({ region: "North", CustomerName: "A. Person", customer_name: "A. Person", time: "Last week" }, pack, {});
    expect(v.selections).toEqual({ region: "North", time: "Last week" });
    expect(v.dropped).toBe(2);
    // A key kept from this caller is dropped too.
    expect(viewerSelections({ region: "North" }, pack, { hidden: new Set(["region"]) })).toEqual({ selections: {}, dropped: 1 });
  });
});

describe("overlay.notDimensions and labels", () => {
  it("turns groupable amounts off as dimensions, without touching Superset", () => {
    const { pack } = built();
    expect(pack.dimensions.map((d) => d.key)).toEqual(["region", "campaign", "status", "reason"]);
    expect(pack.dimensions.map((d) => d.key)).not.toContain("quantity");
  });

  it("takes labels per language: the English is the label, the others are words the chat also knows it by", () => {
    const { pack } = built();
    expect(pack.dimensions.find((d) => d.key === "region")).toMatchObject({ label: "Region", synonyms: ["Région"] });
    expect(pack.measures.find((m) => m.key === "items_sold")).toMatchObject({ label: "Items sold", synonyms: ["Articles vendus"] });
  });

  it("warns when a summed column is still a dimension", () => {
    const { warnings } = packFromDatasets([ORDERS], { measures: [{ dataset: "orders", name: "items_sold", agg: "sum", column: "quantity" }] });
    expect(warnings.join("\n")).toMatch(/"quantity" is measured by "items_sold" and is also a dimension; list it in overlay.notDimensions/);
  });
});

describe("overlay.measures", () => {
  it("become base measures with the pack's own aggregates, never SQL", () => {
    const { pack } = built();
    const m = (k: string) => pack.measures.find((x) => x.key === k);
    expect(m("items_sold")).toMatchObject({ entity: "orders", agg: "sum", field: "quantity" });
    expect(m("delivered_orders")).toMatchObject({ entity: "orders", agg: "count", where: [{ field: "status", op: "eq", value: "delivered" }] });
    expect(m("regions_selling")).toMatchObject({ agg: "count_distinct", field: "region" });
    expect(m("largest_basket")).toMatchObject({ agg: "max", format: "currency" });
    for (const k of ["items_sold", "delivered_orders", "regions_selling", "largest_basket"]) expect(m(k)!.sql).toBeUndefined();
  });

  it("are sent to Superset as ad hoc metrics: Superset's own kind without conditions, an aggregate over the kept rows with them", () => {
    const { binding } = built();
    expect(adhocMetric(binding.metrics.get("items_sold")!.adhoc!, "items_sold")).toEqual({ expressionType: "SIMPLE", column: { column_name: "quantity" }, aggregate: "SUM", label: "items_sold" });
    expect(adhocMetric(binding.metrics.get("regions_selling")!.adhoc!, "regions_selling")).toMatchObject({ aggregate: "COUNT_DISTINCT" });
    expect(adhocMetric(binding.metrics.get("delivered_orders")!.adhoc!, "delivered_orders")).toEqual({ expressionType: "SQL", sqlExpression: "COUNT(CASE WHEN status = 'delivered' THEN 1 END)", label: "delivered_orders" });
    // Values are quoted, never pasted: a quote in a value stays inside the string.
    expect(adhocMetric({ agg: "sum", column: "quantity", where: [{ column: "status", op: "in", value: ["it's", 3] }] }, "x")).toMatchObject({ sqlExpression: "SUM(CASE WHEN status IN ('it''s', 3) THEN quantity END)" });
    expect(adhocMetric({ agg: "count_distinct", column: "region", where: [{ column: "status", op: "exists" }] }, "x")).toMatchObject({ sqlExpression: "COUNT(DISTINCT CASE WHEN status IS NOT NULL THEN region END)" });
  });

  it("run through the chart-data API like a saved metric, with the scope and filters on the query", async () => {
    const { pack, binding } = built();
    const { resolve } = await import("@lenspack/engine");
    const bound = resolve({ kind: "breakdown", measure: "items_sold", dimension: "region", limit: 10, sort: "desc" }, pack, { scope: [{ dimension: "campaign", op: "eq", value: "spring" }] });
    const { queries } = queryObjects(bound, binding);
    expect(queries[0]!.metrics[0]).toMatchObject({ expressionType: "SIMPLE", aggregate: "SUM" });
    expect(queries[0]!.filters).toContainEqual({ col: "campaign", op: "==", val: "spring" });
  });

  it("are written into charts and read back, and a chart made in Superset with the same metric reads as the measure", () => {
    const { pack, binding } = built();
    const widget = { title: "Items by region", kind: "chart", chart: "bar", query: { kind: "breakdown", measure: "items_sold", dimension: "region", limit: 10 } } as never;
    const spec = widgetToChart(widget, pack, binding)!;
    expect(JSON.stringify(spec.params)).toMatch(/"aggregate":"SUM"/);
    // Made in Explore: Superset adds its own editor fields and a label of its own.
    const made = { slice_name: "Items", viz_type: "big_number_total", datasource_id: 11, params: { metric: { expressionType: "SIMPLE", column: { column_name: "quantity", type: "BIGINT" }, aggregate: "SUM", label: "SUM(quantity)", optionName: "metric_x", hasCustomLabel: false }, adhoc_filters: [] } };
    expect(chartToWidget(made, pack, binding)).toMatchObject({ widget: { kind: "kpi", query: { kind: "value", measure: "items_sold" } } });
  });

  it("are checked against the dataset: a wrong dataset, column, aggregate, type or name is a problem and left out", () => {
    const { pack, problems } = packFromDatasets([ORDERS], {
      measures: [
        { dataset: "nowhere", name: "a", agg: "sum", column: "quantity" },
        { dataset: "orders", name: "b", agg: "sum", column: "missing" },
        { dataset: "orders", name: "c", agg: "avg" as never, column: "quantity" },
        { dataset: "orders", name: "d", agg: "sum", column: "region" },
        { dataset: "orders", name: "orders_count", agg: "sum", column: "quantity" },
        { dataset: "orders", name: "e", agg: "count", where: [{ column: "status", op: "in", value: "x" }] },
        { dataset: "orders", name: "f", agg: "max" },
      ],
    });
    expect(problems).toEqual([
      expect.stringMatching(/\[0\] \(a\): dataset "nowhere" is not one of the datasets listed/),
      expect.stringMatching(/\[1\] \(b\): column "missing" is not a column of Superset dataset "orders"/),
      expect.stringMatching(/\[2\] \(c\): agg must be one of sum, count, count_distinct, min, max/),
      expect.stringMatching(/\[3\] \(d\): column "region" holds VARCHAR, which can't be added up/),
      expect.stringMatching(/\[4\] \(orders_count\): the key "orders_count" is already a measure/),
      expect.stringMatching(/\[5\] \(e\): where: in takes a list/),
      expect.stringMatching(/\[6\] \(f\): max needs a column/),
    ]);
    expect(pack.measures.map((m) => m.key)).toEqual(["orders_count"]);
  });
});

describe("superset.yaml scope", () => {
  it("is checked: a filter that isn't one is an error, a dimension the pack lacks is kept (every question refused) and said", () => {
    const { pack } = built();
    expect(packScope([{ dimension: "campaign", op: "eq", value: "spring" }], pack)).toEqual({ clauses: [{ dimension: "campaign", op: "eq", value: "spring" }], warnings: [expect.stringMatching(/returns does not have: questions on it are refused/)] });
    expect(() => packScope({ dimension: "campaign" }, pack)).toThrow(/scope must be a list/);
    expect(() => packScope([{ dimension: "campaign", op: "like", value: "x" }], pack)).toThrow(/scope\[0\]/);
    expect(packScope([{ dimension: "season", op: "eq", value: "x" }], pack).warnings).toEqual([expect.stringMatching(/"season", which is not a dimension of the pack: every question is refused/)]);
    expect(packScope([{ entity: "orders", dimension: "campaign", op: "eq", value: "spring" }], pack).warnings).toEqual([]);
  });
});
