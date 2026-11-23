import { describe, expect, it } from "vitest";

import { chartToWidget, packFromDatasets, queryContextOf, widgetToChart, type SupersetDataset } from "../src/index";

// A made-up dataset: visits to sites, by day.
const DATASETS: SupersetDataset[] = [
  {
    id: 7,
    table_name: "site_visits",
    main_dttm_col: "visit_date",
    columns: [
      { column_name: "visit_date", is_dttm: true, type: "DATE" },
      { column_name: "site", groupby: true, type: "TEXT", verbose_name: "Site" },
      { column_name: "region", groupby: true, type: "TEXT" },
      { column_name: "day_label", groupby: true, type: "TEXT" },
    ],
    metrics: [
      { metric_name: "visits", expression: "COUNT(*)" },
      { metric_name: "people_seen", expression: "SUM(people)" },
    ],
  },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "7": "visit" } });
const read = (params: Record<string, unknown>, slice_name = "Heat") => chartToWidget({ slice_name, viz_type: "heatmap_v2", params: { datasource: "7__table", ...params }, datasource_id: 7 }, pack, binding);

describe("heatmaps in Superset", () => {
  const cases = [
    {
      title: "People seen, site by day",
      kind: "chart",
      chart: "heatmap",
      options: { legend: true, colorScheme: "sequential" },
      query: { kind: "breakdown", dimension: "day_label", by: "site", measure: "people_seen", limit: 40, sort: "asc", sortBy: "group", filters: [{ dimension: "region", op: "eq", value: "North" }] },
    },
    { title: "Visits per day by site", kind: "chart", chart: "heatmap", options: { legend: false, colorScheme: "sequential" }, query: { kind: "series", measure: "visits", grain: "day", by: "site", time: { last: "30d" } } },
  ] as const;

  for (const w of cases)
    it(`writes a ${w.query.kind} heatmap as heatmap_v2 and reads back the identical widget, with or without lenspack's marker`, () => {
      const spec = widgetToChart(w as never, pack, binding)!;
      expect(spec.viz_type).toBe("heatmap_v2");
      expect(spec.params).toMatchObject({ groupby: "site", metric: w.query.measure, sort_y_axis: "alpha_asc", normalize_across: "heatmap", show_legend: w.options.legend });
      const ours = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: spec.params, datasource_id: spec.datasetId }, pack, binding);
      expect(ours.widget).toEqual(w);
      const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
      const theirs = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: plain, datasource_id: spec.datasetId }, pack, binding);
      expect(theirs.widget).toEqual(w);
    });

  it("puts time on the x axis at the series' grain, and a breakdown's column on it otherwise", () => {
    const [byDay, series] = cases.map((w) => widgetToChart(w as never, pack, binding)!.params as Record<string, unknown>);
    expect(byDay).toMatchObject({ x_axis: "day_label", sort_x_axis: "alpha_asc", row_limit: 2000 });
    expect(byDay!.time_grain_sqla).toBeUndefined();
    expect(series).toMatchObject({ x_axis: "visit_date", time_grain_sqla: "P1D", sort_x_axis: "alpha_asc", row_limit: 10000 });
  });

  it("reads a heatmap made in Superset when lenspack can draw it exactly", () => {
    // As Superset's editor saves one: a string groupby, both axes A to Z, values shown, its own colours.
    const r = read({ x_axis: "day_label", groupby: "site", metric: "visits", row_limit: 10000, sort_x_axis: "alpha_asc", sort_y_axis: "alpha_asc", normalize_across: "heatmap", linear_color_scheme: "blue_white_yellow", show_values: true, adhoc_filters: [{ clause: "WHERE", comparator: "No filter", expressionType: "SIMPLE", operator: "TEMPORAL_RANGE", subject: "visit_date" }], time_range: "No filter" });
    expect(r.widget).toEqual({ title: "Heat", kind: "chart", chart: "heatmap", options: { legend: true, colorScheme: "sequential" }, query: { kind: "breakdown", dimension: "day_label", by: "site", measure: "visits", limit: 200, sort: "asc", sortBy: "group" } });
    // A one-item groupby list is the same chart.
    expect(read({ x_axis: "day_label", groupby: ["site"], metric: "visits", sort_x_axis: "alpha_desc" }).widget).toMatchObject({ query: { sort: "desc", sortBy: "group" } });
  });

  it("keeps a heatmap it cannot draw exactly as Superset's, saying why", () => {
    const base = { x_axis: "day_label", groupby: "site", metric: "visits", sort_x_axis: "alpha_asc", sort_y_axis: "alpha_asc" };
    const why = (over: Record<string, unknown>) => {
      const r = read({ ...base, ...over });
      return r.widget ? "(read)" : r.reason;
    };
    expect(why({ normalize_across: "y" })).toMatch(/each row on its own scale/);
    expect(why({ normalize_across: "x" })).toMatch(/each column on its own scale/);
    expect(why({ normalized: true })).toMatch(/rank/);
    expect(why({ sort_x_axis: "value_desc" })).toMatch(/sorted by the metric/);
    expect(why({ sort_x_axis: undefined })).toMatch(/no order/);
    expect(why({ sort_y_axis: "value_asc" })).toMatch(/A to Z/);
    expect(why({ groupby: ["site", "region"] })).toMatch(/not one column/);
    expect(why({ x_axis: "not_a_column" })).toMatch(/not a pack dimension/);
    expect(why({ metric: { expressionType: "SQL", sqlExpression: "COUNT(*)" } })).toMatch(/saved metric/);
    expect(why({ x_axis: "visit_date", time_grain_sqla: "P1D", row_limit: 100 })).toMatch(/row limit/);
    expect(why({ x_axis: "visit_date", time_grain_sqla: "P1D" })).toBe("(read)");
  });

  it("gives reports the query Superset's heatmap builds: both axes as columns, sorted per axis, ranked", () => {
    const spec = widgetToChart(cases[0] as never, pack, binding)!;
    const ctx = queryContextOf(spec) as { queries: Record<string, any>[] };
    const q = ctx.queries[0]!;
    expect(q.columns).toEqual(["day_label", "site"]);
    expect(q.metrics).toEqual(["people_seen"]);
    expect(q.orderby).toEqual([["day_label", true], ["site", true]]);
    expect(q.post_processing).toEqual([{ operation: "rank", options: { metric: "people_seen", group_by: undefined } }]);
    const series = queryContextOf(widgetToChart(cases[1] as never, pack, binding)!) as { queries: Record<string, any>[] };
    expect(series.queries[0]!.columns[0]).toMatchObject({ columnType: "BASE_AXIS", sqlExpression: "visit_date", timeGrain: "P1D" });
  });
});
