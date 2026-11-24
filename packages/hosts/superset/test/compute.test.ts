import { describe, expect, it } from "vitest";

import { type Tool, boardTools } from "@lenspack/agent";
import { memoryStore } from "@lenspack/core";
import { COMPUTE_ROWS, checkOps, run } from "@lenspack/engine";

import { SUPERSET_CAPABILITIES, supersetConnector } from "../src/connector";
import { chartToWidget, packFromDatasets, queryContextOf, widgetToChart, type SupersetDataset } from "../src/index";

// A made-up dataset: stock movements by ward and day.
const DATASETS: SupersetDataset[] = [
  {
    id: 3,
    table_name: "stock_movements",
    main_dttm_col: "moved_on",
    columns: [
      { column_name: "moved_on", is_dttm: true, type: "DATE" },
      { column_name: "ward", groupby: true, type: "TEXT" },
    ],
    metrics: [
      { metric_name: "dispatched", expression: "SUM(qty_out)" },
      { metric_name: "received", expression: "SUM(qty_in)" },
      { metric_name: "movements", expression: "COUNT(*)" },
      { metric_name: "avg_out", expression: "AVG(qty_out)" },
    ],
  },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "s", entities: { "3": "movement" } });
const month = { last: "30d" } as const;
const line = (compute: unknown, extra: Record<string, unknown> = {}) =>
  ({ title: "Dispatched", kind: "chart", chart: "line", options: { legend: true, colorScheme: "default" }, query: { kind: "series", measure: "dispatched", grain: "day", time: month, compute, ...extra } }) as never;
const add = (widget: unknown) => [{ op: "add_widget", id: "w", widget, placement: { place: "bottom", width: "half" } }] as never;

describe("compute as Superset's own advanced analytics", () => {
  it("a rolling average: the form controls Superset's chart reads, and the post-processing it runs", () => {
    const spec = widgetToChart(line({ steps: [{ op: "rolling", fn: "mean", window: 7 }] }), pack, binding)!;
    expect(spec.viz_type).toBe("echarts_timeseries_line");
    expect(spec.params).toMatchObject({ rolling_type: "mean", rolling_periods: 7, min_periods: 7 });
    const query = (queryContextOf(spec) as { queries: Record<string, unknown>[] }).queries[0]!;
    expect(query.post_processing).toEqual([
      { operation: "pivot", options: { index: ["moved_on"], columns: [], aggregates: { dispatched: { operator: "mean" } }, drop_missing_columns: true } },
      { operation: "rolling", options: { rolling_type: "mean", window: 7, min_periods: 7, columns: { dispatched: "dispatched" } } },
      { operation: "flatten" },
    ]);
    expect(query.time_offsets).toBeUndefined();
  });

  it("a running total is cum; split by a dimension, the pivot spreads the groups", () => {
    const spec = widgetToChart(line({ steps: [{ op: "running_total" }] }, { by: "ward" }), pack, binding)!;
    expect(spec.params).toMatchObject({ rolling_type: "cumsum", groupby: ["ward"] });
    const query = (queryContextOf(spec) as { queries: Record<string, any>[] }).queries[0]!;
    expect(query.post_processing[0].options.columns).toEqual(["ward"]);
    expect(query.post_processing[1]).toEqual({ operation: "cum", options: { operator: "sum", columns: { dispatched: "dispatched" } } });
  });

  it("a day-on-day % change is a comparison with one day back, shown as a percentage", () => {
    const spec = widgetToChart(line({ steps: [{ op: "change", percent: true }] }), pack, binding)!;
    expect(spec.params).toMatchObject({ time_compare: ["1 day ago"], comparison_type: "percentage", y_axis_format: ".1%" });
    const query = (queryContextOf(spec) as { queries: Record<string, unknown>[] }).queries[0]!;
    expect(query.time_offsets).toEqual(["1 day ago"]);
    expect(query.post_processing).toEqual([
      { operation: "pivot", options: { index: ["moved_on"], columns: [], aggregates: { dispatched: { operator: "mean" }, "dispatched__1 day ago": { operator: "mean" } }, drop_missing_columns: true } },
      { operation: "compare", options: { source_columns: ["dispatched"], compare_columns: ["dispatched__1 day ago"], compare_type: "percentage", drop_original_columns: true } },
      { operation: "flatten" },
    ]);
    const weekly = widgetToChart(line({ steps: [{ op: "change" }] }, { grain: "week" }), pack, binding)!;
    expect(weekly.params).toMatchObject({ time_compare: ["1 week ago"], comparison_type: "difference" });
  });

  it("a KPI's trend line takes a rolling window too", () => {
    const kpi = { title: "7-day average", kind: "kpi", query: { kind: "series", measure: "dispatched", grain: "day", compute: { steps: [{ op: "rolling", fn: "sum", window: 7 }] } } } as never;
    const spec = widgetToChart(kpi, pack, binding)!;
    expect(spec).toMatchObject({ viz_type: "big_number", params: { rolling_type: "sum", rolling_periods: 7, min_periods: 7 } });
    expect((queryContextOf(spec) as { queries: Record<string, any>[] }).queries[0]!.post_processing[1].operation).toBe("rolling");
  });

  it("reads its own charts back with their steps, and a chart made in Superset when it says one step exactly", () => {
    for (const compute of [{ steps: [{ op: "rolling", fn: "mean", window: 7 }] }, { steps: [{ op: "running_total" }] }, { steps: [{ op: "change", percent: true }] }]) {
      const w = line(compute);
      const spec = widgetToChart(w, pack, binding)!;
      expect(chartToWidget({ slice_name: "Dispatched", viz_type: spec.viz_type, params: spec.params, datasource_id: 3 }, pack, binding)).toEqual({ widget: w });
      // Without Lenspack's own copy of the widget, the controls alone say the same.
      const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
      const read = chartToWidget({ slice_name: "Dispatched", viz_type: spec.viz_type, params: plain, datasource_id: 3 }, pack, binding);
      expect((read.widget as { query: { compute: unknown } } | null)?.query.compute).toEqual(compute);
    }
  });

  it("keeps as Superset's a chart whose analytics Lenspack would compute differently", () => {
    const base = widgetToChart(line(undefined), pack, binding)!.params as Record<string, unknown>;
    const { lenspack: _l, ...plain } = base;
    const read = (more: Record<string, unknown>) => chartToWidget({ slice_name: "x", viz_type: "echarts_timeseries_line", params: { ...plain, ...more }, datasource_id: 3 }, pack, binding);
    expect(read({ rolling_type: "mean", rolling_periods: 7, min_periods: 1 })).toEqual({ widget: null, reason: "its rolling window shows partial windows, which Lenspack leaves out" });
    expect(read({ rolling_type: "std", rolling_periods: 7, min_periods: 7 })).toMatchObject({ widget: null });
    expect(read({ time_compare: ["1 year ago"], comparison_type: "percentage" })).toEqual({ widget: null, reason: "it compares with 1 year ago, not the day before" });
    expect(read({ time_compare: ["1 day ago"], comparison_type: "values" })).toEqual({ widget: null, reason: "it draws earlier periods beside the current one" });
  });

  it("refuses at edit time what no Superset chart recomputes, and says what to do instead", () => {
    const ratio = { title: "Share", kind: "table", pageSize: 10, query: { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", compute: { steps: [{ op: "ratio", to: "received" }] } } };
    expect(checkOps(add(ratio), pack, { capabilities: SUPERSET_CAPABILITIES })).toMatchObject({ ok: false, error: expect.stringMatching(/divides one metric by another.*give the answer in the chat, or save the series/) });
    expect(checkOps(add(line({ steps: [{ op: "change" }, { op: "rolling", fn: "mean", window: 3 }] })), pack, { capabilities: SUPERSET_CAPABILITIES })).toMatchObject({ ok: false, error: expect.stringMatching(/one step over time/) });
    expect(checkOps(add(line({ steps: [{ op: "change" }] }, { time: undefined })), pack, { capabilities: SUPERSET_CAPABILITIES })).toMatchObject({ ok: false, error: expect.stringMatching(/within a time range/) });
    expect(checkOps(add(line({ steps: [{ op: "rolling", fn: "mean", window: 7 }] })), pack, { capabilities: SUPERSET_CAPABILITIES })).toEqual({ ok: true });
    expect(() => widgetToChart(ratio as never, pack, binding)).toThrow(/divides one metric by another/);
  });

  it("answers in the chat all the same: the connector reads the base rows, the engine computes", async () => {
    const sent: { queries: { columns: unknown[]; row_limit: number; post_processing?: unknown }[] }[] = [];
    const data = [
      { __lenspack_bucket: "2026-09-01", ward: "north", dispatched: 10, __lenspack_n: 1 },
      { __lenspack_bucket: "2026-09-02", ward: "north", dispatched: 30, __lenspack_n: 1 },
      { __lenspack_bucket: "2026-09-01", ward: "south", dispatched: 4, __lenspack_n: 1 },
    ];
    const connector = supersetConnector({ post: async (_p: string, body: (typeof sent)[number]) => (sent.push(body), { result: [{ data }] }) } as never, binding);
    const answer = await run(
      { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time: { from: "2026-09-01T00:00:00Z", to: "2026-09-03T00:00:00Z" }, compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } },
      { pack, connector },
    );
    expect(answer.rows).toEqual([
      { group: "north", value: 20, count: 2 },
      { group: "south", value: 2, count: 1 },
    ]);
    expect(sent[0]!.queries[0]!.row_limit).toBe(COMPUTE_ROWS + 1);
    expect(sent[0]!.queries[0]!.post_processing).toBeUndefined();
  });
});

// A summary of each group's buckets ("the average daily units dispatched per ward") is kept as
// Superset's pivot table: a row per ward, a column per day, and the summary in each row's total,
// computed by the pivot table's own aggregation function over the cells of the row.
describe("a summary per group as Superset's pivot table", () => {
  const perWard = (measure: string, fn: string, extra: Record<string, unknown> = {}, kind: Record<string, unknown> = { kind: "table", pageSize: 10 }) =>
    ({ title: "Per ward", ...kind, query: { kind: "breakdown", dimension: "ward", measure, limit: 12, sort: "desc", time: month, compute: { grain: "day", steps: [{ op: "over_time", fn }] }, ...extra } }) as never;
  const ok = (w: unknown) => checkOps(add(w), pack, { capabilities: SUPERSET_CAPABILITIES });

  it("the chart: rows the dimension, columns the days, the summary in the row totals", () => {
    const spec = widgetToChart(perWard("dispatched", "sum"), pack, binding)!;
    expect(spec.viz_type).toBe("pivot_table_v2");
    expect(spec.params).toMatchObject({
      groupbyRows: ["ward"],
      groupbyColumns: ["moved_on"],
      temporal_columns_lookup: { moved_on: true },
      time_grain_sqla: "P1D",
      metrics: ["dispatched"],
      aggregateFunction: "Sum",
      rowTotals: true,
      colTotals: false,
      transposePivot: false,
      rowOrder: "value_z_to_a",
      row_limit: COMPUTE_ROWS,
      conditional_formatting: [{ column: "dispatched", operator: "None", colorScheme: "#ACE1C4" }],
    });
    // Superset's pivot table asks for every cell, a day at its grain then the ward, largest first, with no post-processing.
    const query = (queryContextOf(spec) as { queries: Record<string, unknown>[] }).queries[0]!;
    expect(query.columns).toEqual([{ columnType: "BASE_AXIS", sqlExpression: "moved_on", label: "moved_on", expressionType: "SQL", timeGrain: "P1D" }, "ward"]);
    expect(query.orderby).toEqual([["dispatched", false]]);
    expect(query.row_limit).toBe(COMPUTE_ROWS);
    expect(query.post_processing).toBeUndefined();
  });

  it("maps each summary to the aggregation function that computes it the same way", () => {
    const fn = (measure: string, f: string, extra?: Record<string, unknown>) => (widgetToChart(perWard(measure, f, extra), pack, binding)!.params as { aggregateFunction: string; rowOrder: string }).aggregateFunction;
    // An average has no value on a day with no records, in both: every summary agrees.
    expect(["mean", "median", "min", "max"].map((f) => fn("avg_out", f))).toEqual(["Average", "Median", "Minimum", "Maximum"]);
    // A day with no records is 0 for a count: it never beats a day with records, so the highest agrees.
    expect(fn("movements", "max")).toBe("Maximum");
    // Adding 0 changes nothing: a total agrees for any count or sum.
    expect(fn("dispatched", "sum")).toBe("Sum");
    const order = (extra: Record<string, unknown>) => (widgetToChart(perWard("dispatched", "sum", extra), pack, binding)!.params as { rowOrder: string }).rowOrder;
    expect([order({ sort: "asc" }), order({ sortBy: "group", sort: "asc" }), order({ sortBy: "group", sort: "desc" })]).toEqual(["value_a_to_z", "key_a_to_z", "key_z_to_a"]);
    // A bar chart of the summary is kept as the same pivot table.
    expect(widgetToChart(perWard("dispatched", "sum", {}, { kind: "chart", chart: "bar", options: { legend: true, colorScheme: "default" } }), pack, binding)!.viz_type).toBe("pivot_table_v2");
  });

  it("reads its own pivot tables back, and one made in Superset with the same shape as a computed table", () => {
    for (const [measure, f] of [["dispatched", "sum"], ["avg_out", "mean"], ["avg_out", "median"], ["movements", "max"]] as const) {
      const w = perWard(measure, f);
      const spec = widgetToChart(w, pack, binding)!;
      expect(chartToWidget({ slice_name: "Per ward", viz_type: spec.viz_type, params: spec.params, datasource_id: 3 }, pack, binding)).toEqual({ widget: w });
    }
    // Made by hand in Superset: no copy of a Lenspack widget, Superset's own defaults.
    const byHand = { groupbyRows: ["ward"], groupbyColumns: ["moved_on"], temporal_columns_lookup: { moved_on: true }, time_grain_sqla: "P1W", metrics: ["avg_out"], aggregateFunction: "Average", rowTotals: true, rowOrder: "value_z_to_a", row_limit: 10000, datasource: "3__table", adhoc_filters: [{ expressionType: "SIMPLE", clause: "WHERE", subject: "moved_on", operator: "TEMPORAL_RANGE", comparator: "Last month" }] };
    expect(chartToWidget({ slice_name: "Weekly average", viz_type: "pivot_table_v2", params: byHand, datasource_id: 3 }, pack, binding)).toEqual({
      widget: { title: "Weekly average", kind: "table", pageSize: 10, query: { kind: "breakdown", dimension: "ward", measure: "avg_out", limit: 500, sort: "desc", compute: { grain: "week", steps: [{ op: "over_time", fn: "mean" }] }, time: { last: "30d" } } },
    });
  });

  it("keeps as Superset's a pivot table whose totals Lenspack would compute differently, and says why", () => {
    const { lenspack: _l, ...plain } = widgetToChart(perWard("avg_out", "mean"), pack, binding)!.params as Record<string, unknown>;
    const read = (more: Record<string, unknown>) => chartToWidget({ slice_name: "x", viz_type: "pivot_table_v2", params: { ...plain, ...more }, datasource_id: 3 }, pack, binding);
    expect(read({ metrics: ["dispatched"] })).toEqual({ widget: null, reason: "it averages only the days that have records, while Lenspack counts a day with no records as 0 for a count or a sum, so the two would differ wherever a group has a day with none" });
    expect(read({ aggregateFunction: "Last" })).toEqual({ widget: null, reason: 'its aggregation "Last" has no Lenspack summary' });
    expect(read({ rowTotals: false })).toMatchObject({ widget: null, reason: expect.stringMatching(/no total per row/) });
    expect(read({ colTotals: true })).toMatchObject({ widget: null, reason: expect.stringMatching(/total row across the groups/) });
    expect(read({ series_limit: 5 })).toMatchObject({ widget: null, reason: expect.stringMatching(/top groups/) });
    expect(read({ transposePivot: true })).toMatchObject({ widget: null, reason: expect.stringMatching(/swapped/) });
    expect(read({ groupbyColumns: ["ward"], groupbyRows: ["moved_on"] })).toMatchObject({ widget: null, reason: expect.stringMatching(/columns are not the dataset's time column/) });
  });

  it("refuses at edit time a summary Superset's pivot table computes differently, with the nearest chart it keeps", () => {
    // The burn rate: units dispatched per ward and day, then the average. A day with no dispatch is
    // 0 for Lenspack and no cell for Superset's pivot table, so the averages would differ.
    expect(ok(perWard("dispatched", "mean"))).toMatchObject({
      ok: false,
      error:
        "Superset's pivot table averages only the days that have records, while Lenspack counts a day with no records as 0 for a count or a sum, so the two would differ wherever a group has a day with none. Superset keeps exactly: the total per ward over the days (the sum step), as a pivot table with a column per day; or the daily dispatched by ward as a line chart (a series split by ward).",
    });
    expect(ok(perWard("dispatched", "max"))).toMatchObject({ ok: false, error: expect.stringMatching(/takes the highest of only the days that have records.*a sum can be below 0/) });
    expect(ok(perWard("movements", "min"))).toMatchObject({ ok: false, error: expect.stringMatching(/takes the lowest of only the days/) });
    expect(ok(perWard("avg_out", "last"))).toMatchObject({ ok: false, error: expect.stringMatching(/no latest day: its "Last" is the largest value.*daily avg_out by ward as a line chart/) });
    const steps = (s: unknown[]) => ({ title: "t", kind: "table", pageSize: 10, query: { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time: month, compute: { grain: "day", steps: s } } });
    expect(ok(steps([{ op: "change", percent: true }, { op: "over_time", fn: "mean" }]))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no step before the summary, and this asks for the day-on-day % change first. Superset keeps exactly: the day-on-day % change of dispatched by ward as a line chart/),
    });
    const value = { title: "t", kind: "kpi", query: { kind: "value", measure: "avg_out", time: month, compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } } };
    expect(ok(value)).toMatchObject({ ok: false, error: expect.stringMatching(/kept per group, as a pivot table, not as one number/) });
    expect(ok(perWard("avg_out", "mean", {}, { kind: "chart", chart: "pie", options: { legend: true, colorScheme: "default" } }))).toMatchObject({ ok: false, error: expect.stringMatching(/make the widget a table or a bar chart/) });
    expect(ok(perWard("avg_out", "mean"))).toEqual({ ok: true });
  });

  it("the agent's tools save a summary Superset computes the same way, and offer the nearest one when it does not", async () => {
    const store = memoryStore();
    await store.create({ id: "b", pack, title: "Stock" });
    const connector = supersetConnector({ post: async () => ({ result: [{ data: [] }] }) } as never, binding);
    const tools = Object.fromEntries(boardTools({ pack, connector, store, boardId: "b", ctx: { now: new Date("2026-09-10T00:00:00Z") } }).map((t) => [t.name, t])) as Record<string, Tool>;
    const call = async (args: Record<string, unknown>) => (await tools.add_widget!.execute(tools.add_widget!.inputSchema.parse({ kind: "table", query_kind: "breakdown", dimension: "ward", grain: "day", time_last: "30d", ...args }) as never)) as { applied: boolean; error?: string; board?: string };
    // “Add the average dispatch per movement handled, per ward”: an average, so the pivot table agrees.
    const average = await call({ id: "avg", title: "Average dispatch per ward", measure: "avg_out", compute: "mean" });
    expect(average.applied, average.error).toBe(true);
    // “Add the busiest day per ward”: the highest daily count of movements.
    const busiest = await call({ id: "busiest", title: "Busiest day per ward", measure: "movements", compute: "max" });
    expect(busiest.applied, busiest.error).toBe(true);
    // “Add burn rate per ward to the dashboard”: the average of a sum over days, where a day with no
    // dispatch counts as 0. Not kept as is; the refusal names what Superset keeps exactly.
    const burn = await call({ id: "burn", title: "Burn rate per ward", measure: "dispatched", compute: "mean" });
    expect(burn).toMatchObject({ applied: false, error: expect.stringMatching(/the total per ward over the days \(the sum step\), as a pivot table with a column per day; or the daily dispatched by ward as a line chart/) });
    const total = await call({ id: "burn", title: "Units dispatched per ward, by day", measure: "dispatched", compute: "sum" });
    expect(total.applied, total.error).toBe(true);
    expect(total.board).toContain("dispatched → sum over days by ward");
    const board = (await store.get("b"))!;
    for (const id of ["avg", "busiest", "burn"]) expect(widgetToChart(board.config.widgets[id]!, pack, binding)!.viz_type).toBe("pivot_table_v2");
  });
});
