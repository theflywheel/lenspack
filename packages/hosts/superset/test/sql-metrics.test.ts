import { describe, expect, it } from "vitest";

import { type SupersetDataset, adhocAggregate, chartToWidget, packFromDatasets, simpleAggregate, widgetToChart } from "../src/index";

// A made-up shop. Charts made in Superset often use ad hoc SQL metrics (SUM(quantity), COUNT(*)) rather than the
// dataset's saved metrics: a simple one is read as the pack measure that says the same, so the chat can answer about
// the tile. Anything else stays Superset's.
const ORDERS: SupersetDataset = {
  id: 11,
  table_name: "orders",
  main_dttm_col: "ordered_on",
  columns: [
    { column_name: "ordered_on", is_dttm: true, type: "DATE" },
    { column_name: "store", groupby: true, type: "TEXT" },
    { column_name: "status", groupby: true, type: "TEXT" },
    { column_name: "customer_id", groupby: true, type: "TEXT" },
    { column_name: "quantity", groupby: false, type: "INTEGER" },
    { column_name: "price", groupby: false, type: "NUMERIC" },
    // Computed by Superset from an expression: SQL naming it and Superset's own editor read it differently.
    { column_name: "net", groupby: false, type: "NUMERIC", expression: "price - discount" },
  ],
  metrics: [
    { metric_name: "orders", expression: "COUNT(*)" },
    { metric_name: "items_sold", expression: "SUM(quantity)" },
    { metric_name: "customers", expression: "count(distinct customer_id)" },
    { metric_name: "average_price", expression: "AVG(price)" },
    { metric_name: "net_sales", expression: "SUM(net)" },
  ],
};
const { pack, binding } = packFromDatasets([ORDERS], {
  pack: "shop",
  entities: { "11": "order" },
  notDimensions: ["customer_id"],
  measures: [
    { dataset: "orders", name: "lowest_price", agg: "min", column: "price" },
    // With conditions: matched only by its own ad hoc metric, never as a plain MIN.
    { dataset: "orders", name: "lowest_open_price", agg: "min", column: "price", where: [{ column: "status", op: "eq", value: "open" }] },
  ],
});

const sql = (sqlExpression: string) => ({ expressionType: "SQL", sqlExpression, label: sqlExpression });
const kpi = (metric: unknown, adhoc_filters: unknown[] = []) => chartToWidget({ slice_name: "Tile", viz_type: "big_number_total", params: { datasource: "11__table", metric, adhoc_filters } }, pack, binding);
const measureOf = (metric: unknown) => {
  const r = kpi(metric);
  return r.widget && r.widget.kind === "kpi" ? r.widget.query.kind === "value" && r.widget.query.measure : `kept: ${r.widget ? "?" : r.reason}`;
};

describe("a simple aggregate in SQL", () => {
  it("is read in any case, with spaces and quoted columns", () => {
    expect(simpleAggregate("SUM(quantity)")).toEqual({ agg: "sum", column: "quantity" });
    expect(simpleAggregate("  sum ( `quantity` ) ")).toEqual({ agg: "sum", column: "quantity" });
    expect(simpleAggregate('Max("price")')).toEqual({ agg: "max", column: "price" });
    expect(simpleAggregate("COUNT(*)")).toEqual({ agg: "count", column: null });
    expect(simpleAggregate("count()")).toEqual({ agg: "count", column: null });
    expect(simpleAggregate("COUNT(customer_id)")).toEqual({ agg: "count", column: "customer_id" });
    expect(simpleAggregate("COUNT( DISTINCT customer_id )")).toEqual({ agg: "count_distinct", column: "customer_id" });
    expect(simpleAggregate("avg(price)")).toEqual({ agg: "avg", column: "price" });
  });

  it("is nothing else", () => {
    for (const s of ["SUM(quantity) / NULLIF(COUNT(*), 0)", "SUM(DISTINCT quantity)", "SUM(quantity * price)", "SUM(CASE WHEN status = 'open' THEN 1 END)", "COUNT(DISTINCT *)", "MAX(*)", "uniqExact(customer_id)", "SUM(quantity) FILTER (WHERE status = 'open')", "SUM(o.quantity)"])
      expect(simpleAggregate(s), s).toBeNull();
  });

  it("covers Superset's own metric editor too", () => {
    expect(adhocAggregate({ expressionType: "SIMPLE", column: { column_name: "price" }, aggregate: "COUNT_DISTINCT", label: "x" })).toEqual({ agg: "count_distinct", column: "price" });
    expect(adhocAggregate({ expressionType: "SIMPLE", column: { column_name: "price" }, aggregate: "MEDIAN", label: "x" })).toBeNull();
  });
});

describe("a chart whose metric is ad hoc SQL", () => {
  it("is read as the saved metric or overlay measure with the same aggregation and column", () => {
    expect(measureOf(sql("SUM(quantity)"))).toBe("items_sold");
    expect(measureOf(sql("sum( `quantity` )"))).toBe("items_sold");
    expect(measureOf(sql("COUNT(*)"))).toBe("orders");
    expect(measureOf(sql("count()"))).toBe("orders");
    expect(measureOf(sql("COUNT(DISTINCT customer_id)"))).toBe("customers");
    expect(measureOf(sql("AVG(price)"))).toBe("average_price");
    // An overlay measure without conditions.
    expect(measureOf(sql("MIN(price)"))).toBe("lowest_price");
    // Superset's own kind of ad hoc metric, matched to a saved metric as well as to an overlay measure.
    expect(measureOf({ expressionType: "SIMPLE", column: { column_name: "quantity" }, aggregate: "SUM", label: "Items" })).toBe("items_sold");
    expect(measureOf({ expressionType: "SIMPLE", column: { column_name: "price" }, aggregate: "MIN", label: "Lowest" })).toBe("lowest_price");
  });

  it("stays Superset's when no measure says the same, or it is more than one aggregate", () => {
    for (const m of [sql("MAX(price)"), sql("COUNT(quantity)"), sql("SUM(quantity) / NULLIF(COUNT(*), 0)"), sql("SUM(DISTINCT quantity)"), sql("SUM(net)")])
      expect(measureOf(m)).toBe("kept: its metric is neither a saved metric of the dataset nor a simple aggregate one of its measures matches");
  });

  it("reads every metric of a table or time chart the same way", () => {
    const table = chartToWidget({ slice_name: "By store", viz_type: "table", params: { datasource: "11__table", query_mode: "aggregate", groupby: ["store"], metrics: [sql("SUM(quantity)"), sql("COUNT(DISTINCT customer_id)")], row_limit: 10 } }, pack, binding);
    expect(table.widget).toMatchObject({ kind: "table", query: { kind: "breakdown", dimension: "store", measure: "items_sold", measures: ["customers"] } });
    const line = chartToWidget({ slice_name: "Daily", viz_type: "echarts_timeseries_line", params: { datasource: "11__table", x_axis: "ordered_on", time_grain_sqla: "P1D", metrics: [sql("COUNT(*)")] } }, pack, binding);
    expect(line.widget).toMatchObject({ kind: "chart", chart: "line", query: { kind: "series", measure: "orders", grain: "day" } });
  });
});

describe("a chart's IN and NOT IN filters on a dimension", () => {
  it("are read as the widget's filters", () => {
    const r = kpi(sql("SUM(quantity)"), [
      { expressionType: "SIMPLE", clause: "WHERE", subject: "status", operator: "NOT IN", comparator: ["cancelled", "refunded"] },
      { expressionType: "SIMPLE", clause: "WHERE", subject: "store", operator: "IN", comparator: ["north", "south"] },
    ]);
    expect(r.widget).toMatchObject({
      kind: "kpi",
      query: {
        kind: "value",
        measure: "items_sold",
        filters: [
          { dimension: "status", op: "not_in", value: ["cancelled", "refunded"] },
          { dimension: "store", op: "in", value: ["north", "south"] },
        ],
      },
    });
  });

  it("are written back to Superset as the same filters, and read again unchanged", () => {
    const widget = { title: "Kept orders", kind: "kpi", query: { kind: "value", measure: "orders", filters: [{ dimension: "status", op: "not_in", value: ["cancelled"] }] } } as never;
    const spec = widgetToChart(widget, pack, binding)!;
    expect(spec.params.adhoc_filters).toContainEqual({ expressionType: "SIMPLE", clause: "WHERE", subject: "status", operator: "NOT IN", comparator: ["cancelled"] });
    const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
    expect(chartToWidget({ slice_name: "Kept orders", viz_type: spec.viz_type, params: plain, datasource_id: spec.datasetId }, pack, binding).widget).toEqual(widget);
  });

  it("keep a custom SQL filter as Superset's, as before", () => {
    expect(kpi(sql("SUM(quantity)"), [{ expressionType: "SQL", clause: "WHERE", sqlExpression: "status NOT IN ('cancelled')" }])).toMatchObject({ widget: null, reason: "it has a custom SQL filter" });
  });
});
