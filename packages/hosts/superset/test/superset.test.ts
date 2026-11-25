import { parsePackText } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { aggOf, chartToWidget, packFromDatasets, timeRangeBack, timeRangeOf, widgetToChart, type SupersetDataset } from "../src/index";

const DATASETS: SupersetDataset[] = [
  {
    id: 1,
    table_name: "hcm_task",
    main_dttm_col: "created_at",
    columns: [
      { column_name: "created_at", is_dttm: true, type: "TIMESTAMP" },
      { column_name: "state", groupby: true, type: "TEXT", verbose_name: "State" },
      { column_name: "lga", groupby: true, type: "TEXT" },
      { column_name: "quantity", groupby: false, type: "NUMERIC" },
    ],
    metrics: [
      { metric_name: "count", expression: "COUNT(*)", verbose_name: "Task records" },
      { metric_name: "doses_delivered", expression: "COUNT(*) FILTER (WHERE is_delivered)" },
      { metric_name: "delivery_rate", expression: "COUNT(*) FILTER (WHERE is_delivered)::float / NULLIF(COUNT(*), 0)", d3format: ".1%" },
    ],
  },
  { id: 2, table_name: "hcm_household", main_dttm_col: "created_at", columns: [{ column_name: "state", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "people", expression: "SUM(member_count)" }] },
];

describe("superset catalogue", () => {
  it("reads how a metric adds up from its expression", () => {
    expect(aggOf("COUNT(*)")).toBe("count");
    expect(aggOf("SUM(x)")).toBe("sum");
    expect(aggOf("COUNT(*) FILTER (WHERE y)")).toBe("sum");
    expect(aggOf("COUNT(DISTINCT u)")).toBe("count_distinct");
    // ClickHouse spellings.
    expect(aggOf("count()")).toBe("count");
    expect(aggOf("countIf(is_delivered)")).toBe("sum");
    expect(aggOf("sumIf(quantity, is_delivered = 1)")).toBe("sum");
    expect(aggOf("uniqExact(field_worker)")).toBe("count_distinct");
    expect(aggOf("uniq(field_worker)")).toBe("count_distinct");
    expect(aggOf("maxIf(x, y)")).toBe("max");
    expect(aggOf("uniqExactMerge(administered_uniq)")).toBe("count_distinct");
    expect(aggOf("sumMerge(s)")).toBe("sum");
    expect(aggOf("countIf(is_delivered) / nullIf(count(), 0)")).toBe("avg");
    expect(aggOf("SUM(a) / SUM(b)")).toBe("avg");
    expect(aggOf("COUNT(*) FILTER (WHERE d)::float / NULLIF(COUNT(*), 0)")).toBe("avg");
  });

  it("builds a pack: datasets as entities, conformed columns, a row count where Superset has none", () => {
    const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "1": "task", "2": "household" } });
    expect(Object.keys(pack.entities)).toEqual(["task", "household"]);
    expect(pack.dimensions.find((d) => d.key === "state")?.also?.household).toEqual({ field: "state" });
    expect(pack.dimensions.some((d) => d.key === "quantity" || d.key === "created_at")).toBe(false);
    expect(pack.measures.map((m) => m.key)).toEqual(["task_count", "doses_delivered", "delivery_rate", "household_rows", "people"]);
    expect(pack.measures.find((m) => m.key === "delivery_rate")).toMatchObject({ agg: "avg", format: "percent" });
    expect(binding.metrics.get("task_count")).toEqual({ entity: "task", metric: "count" });
  });
});

describe("a catalogue Lenspack can't use all of", () => {
  // As a mart came to Superset: numeric columns Superset lets you group by (its default), each with a saved metric of the same name.
  const MART: SupersetDataset = {
    id: 5,
    table_name: "campaign_mart",
    main_dttm_col: "day",
    columns: [
      { column_name: "day", is_dttm: true, type: "DATE" },
      { column_name: "district", groupby: true, type: "TEXT", verbose_name: "District" },
      { column_name: "children_reached", groupby: true, type: "BIGINT", verbose_name: "Children reached" },
      { column_name: "c1", groupby: true, type: "BIGINT" },
      { column_name: "task_records", groupby: true, type: "UInt64", description: "Tasks on the day" },
      // Types Lenspack doesn't know read as text.
      { column_name: "tags", groupby: true, type: "Array(String)" },
      { column_name: "odd", groupby: true, type: null },
      { column_name: "", groupby: true, type: "TEXT" },
    ],
    metrics: [
      { metric_name: "children_reached", expression: "SUM(children_reached)", verbose_name: "Children reached" },
      { metric_name: "c1", expression: "SUM(c1)", verbose_name: "Children reached" },
      { metric_name: "task_records", expression: "SUM(task_records)" },
      { metric_name: "unfinished", expression: "  " },
      { metric_name: "", expression: "COUNT(*)" },
      { metric_name: "Total", expression: "SUM(a)" },
      { metric_name: "total", expression: "SUM(b)" },
      { metric_name: "TOTAL", expression: "SUM(c)" },
    ],
  };
  const { pack, binding, warnings } = packFromDatasets([MART], { pack: "mart" });

  it("keeps each metric's key and gives the column that wanted it <key>_value", () => {
    expect(pack.measures.map((m) => m.key)).toEqual(["campaign_mart_rows", "children_reached", "c1", "task_records", "total", "campaign_mart_total", "campaign_mart_total_2"]);
    expect(pack.measures.find((m) => m.key === "children_reached")).toMatchObject({ agg: "sum", sql: { superset: "children_reached" } });
    expect(pack.dimensions.map((d) => d.key)).toEqual(["district", "children_reached_value", "c1_value", "task_records_value", "tags", "odd"]);
    expect(pack.dimensions.find((d) => d.key === "children_reached_value")).toMatchObject({ field: "children_reached", type: "number", label: "Children reached", hint: "Each row's own children_reached value. For the total, use the measure children_reached." });
    // A column's own description stays its hint.
    expect(pack.dimensions.find((d) => d.key === "task_records_value")?.hint).toBe("Tasks on the day");
    expect(pack.dimensions.find((d) => d.key === "tags")?.type).toBe("string");
    expect(binding.columns.get("children_reached_value")).toEqual(new Map([["campaign_mart", "children_reached"]]));
    expect(binding.columns.has("children_reached")).toBe(false);
    expect(binding.dimensionOf.get("campaign_mart")!.get("children_reached")).toBe("children_reached_value");
    expect(binding.metrics.get("children_reached")).toEqual({ entity: "campaign_mart", metric: "children_reached" });
  });

  it("says, one line each, what it left out or renamed", () => {
    expect(warnings).toEqual([
      'Superset dataset "campaign_mart" (5): metric "unfinished" has no SQL expression and is left out',
      'Superset dataset "campaign_mart" (5): a metric with no name is left out',
      'Superset dataset "campaign_mart" (5): a column with no name is left out',
      'Superset dataset "campaign_mart" (5): column "children_reached" and a metric both come to the key "children_reached"; the metric keeps it, and the column is the dimension "children_reached_value"',
      'Superset dataset "campaign_mart" (5): column "c1" and a metric both come to the key "c1"; the metric keeps it, and the column is the dimension "c1_value"',
      'Superset dataset "campaign_mart" (5): column "task_records" and a metric both come to the key "task_records"; the metric keeps it, and the column is the dimension "task_records_value"',
    ]);
  });

  it("renames a conformed column on every dataset that has it", () => {
    const other: SupersetDataset = { id: 6, table_name: "visits", columns: [{ column_name: "c1", groupby: true, type: "BIGINT" }], metrics: [{ metric_name: "visits", expression: "COUNT(*)" }] };
    const built = packFromDatasets([other, MART], { pack: "two" });
    expect(built.pack.dimensions.find((d) => d.key === "c1_value")).toMatchObject({ entity: "visits", field: "c1", also: { campaign_mart: { field: "c1" } } });
    expect(built.binding.dimensionOf.get("visits")!.get("c1")).toBe("c1_value");
    expect(built.warnings.filter((w) => w.includes('column "c1"'))).toHaveLength(2);
  });

  it("still refuses a hand-written pack that names a dimension and a measure alike", () => {
    const yaml = ["pack: hand", "version: 1", "entities: { visit: { source: visits } }", "dimensions: [{ key: children_reached, entity: visit, field: children_reached }]", "measures: [{ key: children_reached, entity: visit, agg: sum, sql: children_reached }]", ""].join("\n");
    expect(() => parsePackText(yaml)).toThrow(/Invalid pack: measures\[0\]: key "children_reached" already used by dimensions\[0\]/);
  });
});

describe("superset time ranges", () => {
  it("keeps relative windows relative, and reads back only its own forms", () => {
    for (const t of [{ last: "30d" }, { period: "month" as const, offset: -1, count: 1 }, { period: "week" as const, offset: 0, count: 4 }, { from: "2025-05-01T00:00:00Z", to: "2025-06-01T00:00:00Z" }]) {
      expect(timeRangeBack(timeRangeOf(t as never))).toEqual(t);
    }
    expect(timeRangeOf(undefined)).toBe("No filter");
    expect(timeRangeBack("Last week")).toEqual({ last: "7d" });
    expect(timeRangeBack("previous calendar year")).toBeNull();
  });
});

describe("widgets and charts", () => {
  const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "1": "task", "2": "household" } });
  const cases = [
    { title: "Doses", kind: "kpi", query: { kind: "value", measure: "doses_delivered" } },
    { title: "By LGA", kind: "chart", chart: "bar", options: { legend: true, colorScheme: "default" }, query: { kind: "breakdown", dimension: "lga", measure: "task_count", limit: 10, sort: "desc", filters: [{ dimension: "state", op: "in", value: ["Sokoto"] }] } },
    { title: "Weekly", kind: "chart", chart: "line", options: { legend: true, colorScheme: "default" }, query: { kind: "series", measure: "task_count", grain: "week", by: "state", time: { last: "12w" } } },
    { title: "Share", kind: "chart", chart: "pie", options: { legend: true, colorScheme: "default" }, query: { kind: "breakdown", dimension: "state", measure: "people", limit: 6, sort: "desc" } },
  ] as const;
  for (const w of cases)
    it(`round-trips a ${w.kind} ${"chart" in w ? w.chart : ""} through Superset form_data`, () => {
      const spec = widgetToChart(w as never, pack, binding)!;
      const back = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: spec.params, datasource_id: spec.datasetId }, pack, binding);
      expect(back.widget).toEqual(w);
      // And read as a person's chart (no lenspack marker), it means the same.
      const { lenspack: _l, ...plain } = spec.params as Record<string, unknown>;
      const read = chartToWidget({ slice_name: w.title, viz_type: spec.viz_type, params: plain, datasource_id: spec.datasetId }, pack, binding);
      expect(read.widget?.kind).toBe(w.kind);
      expect((read.widget as { query: unknown }).query).toMatchObject({ kind: w.query.kind, ...("measure" in w.query ? { measure: w.query.measure } : {}) });
    });

  it("keeps a chart lenspack cannot say as Superset's, with the reason", () => {
    const r = chartToWidget({ slice_name: "Sun", viz_type: "sunburst_v2", params: { datasource: "1__table" } }, pack, binding);
    expect(r.widget).toBeNull();
    expect(!r.widget && r.reason).toMatch(/sunburst_v2/);
  });
});
