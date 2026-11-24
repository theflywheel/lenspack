import { describe, expect, it } from "vitest";

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
    const kpi = { title: "7-day average", kind: "kpi", aggregate: "last", query: { kind: "series", measure: "dispatched", grain: "day", compute: { steps: [{ op: "rolling", fn: "sum", window: 7 }] } } } as never;
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
    const perWard = { title: "Average daily", kind: "chart", chart: "bar", options: { legend: true, colorScheme: "default" }, query: { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } } };
    const refused = checkOps(add(perWard), pack, { capabilities: SUPERSET_CAPABILITIES });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/no chart that summarises the time buckets of each group.*give the answer in the chat, or save the series/) });
    expect(checkOps(add(line({ steps: [{ op: "change" }, { op: "rolling", fn: "mean", window: 3 }] })), pack, { capabilities: SUPERSET_CAPABILITIES })).toMatchObject({ ok: false, error: expect.stringMatching(/one step over time/) });
    expect(checkOps(add(line({ steps: [{ op: "change" }] }, { time: undefined })), pack, { capabilities: SUPERSET_CAPABILITIES })).toMatchObject({ ok: false, error: expect.stringMatching(/within a time range/) });
    expect(checkOps(add(line({ steps: [{ op: "rolling", fn: "mean", window: 7 }] })), pack, { capabilities: SUPERSET_CAPABILITIES })).toEqual({ ok: true });
    expect(() => widgetToChart(perWard as never, pack, binding)).toThrow(/no chart that summarises/);
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
