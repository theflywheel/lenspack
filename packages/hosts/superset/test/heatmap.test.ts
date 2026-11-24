import { describe, expect, it } from "vitest";

import { SPLIT_ROWS, checkOps, run } from "@lenspack/engine";

import { SUPERSET_CAPABILITIES, supersetConnector } from "../src/connector";
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
    { title: "Visits, site by region", kind: "chart", chart: "heatmap", options: { legend: false, colorScheme: "sequential" }, query: { kind: "breakdown", dimension: "region", by: "site", measure: "visits", limit: 12, sort: "desc", sortBy: "value", time: { last: "30d" } } },
  ] as const;

  for (const w of cases)
    it(`writes “${w.title}” as heatmap_v2 and reads back the identical widget`, () => {
      const spec = widgetToChart(w as never, pack, binding)!;
      expect(spec.viz_type).toBe("heatmap_v2");
      expect(spec.params).toMatchObject({ groupby: "site", metric: w.query.measure, sort_y_axis: "alpha_asc", normalize_across: "heatmap", show_legend: w.options.legend });
      const ours = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: spec.params, datasource_id: spec.datasetId }, pack, binding);
      expect(ours.widget).toEqual(w);
      const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
      const theirs = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: plain, datasource_id: spec.datasetId }, pack, binding);
      // Without the marker, a column order by the metric is Superset's cell-by-cell sort, which lenspack does not draw.
      if (w.query.sortBy === "group") expect(theirs.widget).toEqual(w);
      else expect(theirs.widget).toBeNull();
    });

  it("puts the breakdown's column on the x axis, its split on y, and the limit on cells", () => {
    const [byDay, byValue] = cases.map((w) => widgetToChart(w as never, pack, binding)!.params as Record<string, unknown>);
    expect(byDay).toMatchObject({ x_axis: "day_label", groupby: "site", sort_x_axis: "alpha_asc", row_limit: 2000 });
    expect(byDay!.time_grain_sqla).toBeUndefined();
    expect(byValue).toMatchObject({ x_axis: "region", sort_x_axis: "value_desc", row_limit: 600 });
  });

  it("refuses a heatmap over time, which Superset's heatmap cannot keep in order, and says what to do instead", () => {
    const series = { title: "Visits per day by site", kind: "chart", chart: "heatmap", options: { legend: true, colorScheme: "sequential" }, query: { kind: "series", measure: "visits", grain: "day", by: "site" } };
    expect(() => widgetToChart(series as never, pack, binding)).toThrow(/time axis in order.*breakdown/);
    // And before any change is made, so the model hears it at once (and an eval without Superset agrees).
    const op = { op: "add_widget", id: "h", widget: series } as never;
    const refused = checkOps([op], pack, { capabilities: SUPERSET_CAPABILITIES });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/time axis in order/) });
    expect(checkOps([op], pack, {})).toEqual({ ok: true });
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
    expect(why({ x_axis: "visit_date", time_grain_sqla: "P1D" })).toMatch(/columns are time/);
  });

  it("gives reports the query Superset's heatmap builds: both axes as columns, sorted per axis, ranked", () => {
    const spec = widgetToChart(cases[0] as never, pack, binding)!;
    const ctx = queryContextOf(spec) as { queries: Record<string, any>[] };
    const q = ctx.queries[0]!;
    expect(q.columns).toEqual(["day_label", "site"]);
    expect(q.metrics).toEqual(["people_seen"]);
    expect(q.orderby).toEqual([["day_label", true], ["site", true]]);
    expect(q.post_processing).toEqual([{ operation: "rank", options: { metric: "people_seen", group_by: undefined } }]);
    const byValue = (queryContextOf(widgetToChart(cases[1] as never, pack, binding)!) as { queries: Record<string, any>[] }).queries[0]!;
    expect(byValue.orderby).toEqual([["visits", false], ["site", true]]);
  });
});

describe("a split breakdown run through Superset", () => {
  // Superset answers every (column, row) cell; the engine keeps the breakdown's top columns, as on every source.
  const cells = [
    { region: "north", site: "a", visits: 9 },
    { region: "south", site: "a", visits: 6 },
    { region: "south", site: "b", visits: 5 },
    { region: "east", site: "a", visits: 4 },
    { region: "east", site: "b", visits: 4 },
    { region: "east", site: "c", visits: 4 },
  ].map((r) => ({ ...r, __lenspack_n: r.visits }));
  const sent: { queries: { row_limit: number; orderby: [unknown, boolean][] }[] }[] = [];
  // Rows come back in the order asked, as Superset sorts them: by the metric, or by the column A to Z.
  const ordered = (by: unknown) => (by === "region" ? [...cells].sort((a, b) => a.region.localeCompare(b.region)) : cells);
  const client = { post: async (_path: string, body: (typeof sent)[number]) => (sent.push(body), { result: [{ data: ordered(body.queries[0]!.orderby[0]?.[0]) }] }) } as never;
  const connector = supersetConnector(client, binding);
  const shown = async (q: Record<string, unknown>) =>
    (await run({ kind: "breakdown", dimension: "region", by: "site", measure: "visits", limit: 2, sort: "desc", ...q } as never, { pack, connector })).rows.map((r) => `${r.group}/${r.series}`);

  it("keeps the top groups by their total, every split inside them, from every row Superset has", async () => {
    expect(await shown({})).toEqual(["south/a", "south/b", "east/a", "east/b", "east/c"]);
    expect(sent.at(-1)!.queries[0]!.row_limit).toBe(SPLIT_ROWS + 1);
  });

  it("keeps the first groups in the order asked when sorted by group", async () => {
    expect(await shown({ sortBy: "group", sort: "asc" })).toEqual(["east/a", "east/b", "east/c", "north/a"]);
  });
});

it("orders a split series by bucket, then series, as every source does", async () => {
  const day = (d: string) => Date.parse(`2026-01-0${d}T00:00:00Z`);
  const data = [
    { __lenspack_bucket: day("2"), site: "b", visits: 1, __lenspack_n: 1 },
    { __lenspack_bucket: day("1"), site: "b", visits: 1, __lenspack_n: 1 },
    { __lenspack_bucket: day("2"), site: "a", visits: 1, __lenspack_n: 1 },
    { __lenspack_bucket: day("1"), site: "a", visits: 1, __lenspack_n: 1 },
  ];
  const connector = supersetConnector({ post: async () => ({ result: [{ data }] }) } as never, binding);
  const { rows } = await run({ kind: "series", measure: "visits", grain: "day", by: "site" }, { pack, connector });
  expect(rows.map((r) => `${r.group}/${r.series}`)).toEqual(["2026-01-01/a", "2026-01-01/b", "2026-01-02/a", "2026-01-02/b"]);
});
