import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type DssChart, compileDss, toWhere, walk } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const charts = JSON.parse(readFileSync(join(here, "fixtures/ChartApiConfig.sample.json"), "utf8")) as Record<string, DssChart>;
const master = JSON.parse(readFileSync(join(here, "fixtures/MasterDashboardConfig.sample.json"), "utf8"));

describe("reading an aggregation tree", () => {
  const out = () => ({ leaves: [], placeholders: [], problems: [] });
  it("turns must_not terms into one neq per value", () => {
    expect(toWhere({ bool: { must_not: [{ terms: { "Data.status.keyword": ["A", "B"] } }] } }, new Set(), out())).toEqual([
      { field: "Data.status", op: "neq", value: "A" },
      { field: "Data.status", op: "neq", value: "B" },
    ]);
  });
  it("turns a request placeholder into a filter, not a predicate", () => {
    const o = out();
    expect(toWhere({ match_phrase: { "Data.productVariant": "PVAR" } }, new Set(["PVAR"]), o)).toEqual([]);
    expect(o.placeholders).toEqual([{ field: "Data.productVariant", token: "PVAR" }]);
  });
  it("refuses a should clause rather than guessing its meaning", () => {
    expect(toWhere({ bool: { should: [{ term: { a: 1 } }] } }, new Set(), out())).toBeNull();
  });
  it("reads a constant bucket_script as a scale and a quotient as a ratio", () => {
    const w = walk(
      JSON.stringify({
        aggs: {
          SUM: { sum: { field: "Data.quantity" } },
          N: { value_count: { field: "Data.id.keyword" } },
          People: { bucket_script: { buckets_path: { s: "SUM" }, script: "(params.s) * 1.8" } },
          Per: { bucket_script: { buckets_path: { a: "SUM", b: "N" }, script: "params.a / params.b * 100" } },
        },
      }),
      new Set(),
    );
    const people = w.leaves.find((l) => l.path.at(-1) === "People")!;
    expect(people).toMatchObject({ agg: "sum", field: "Data.quantity", scale: 1.8 });
    const per = w.leaves.find((l) => l.path.at(-1) === "Per")!;
    expect(per.arith?.percent).toBe(true);
    expect(per.arith?.vars.v_b).toMatchObject({ agg: "count", field: "Data.id" });
  });
  it("names what it cannot read", () => {
    const w = walk(JSON.stringify({ aggs: { X: { sum: { script: "doc['a'].value * 2" } } } }), new Set());
    expect(w.problems[0]).toMatch(/sum over a script/);
  });
});

describe("compiling the sampled DSS health charts", () => {
  const r = compileDss(charts, master, { pack: "dss_sample" });
  const m = (key: string) => r.pack.measures.find((x) => x.key === key);
  const status = Object.fromEntries(r.outcomes.map((o) => [o.chart, o.status]));

  it("translates the charts it can and says why it skips the rest", () => {
    expect(status).toMatchObject({
      todaysVisits: "converted",
      totalPopulationCovered: "converted",
      totalHouseholdCoverageProvince: "partial",
      totalHouseholdsNotDeliveredProvince: "converted",
      userSyncSummaryProvince: "converted",
      summaryByDistrictDay: "partial",
      rdBednetsDistributedChartProvincePercent: "skipped",
    });
    expect(r.outcomes.find((o) => o.chart === "rdBednetsDistributedChartProvincePercent")!.notes.join(" ")).toMatch(/percentage whose operands/);
  });

  it("defines each number once, with the window left to the widget", () => {
    expect(m("visits")).toMatchObject({ entity: "project_task", agg: "count", field: "Data.id", where: [{ field: "Data.deliveredTo", op: "eq", value: "HOUSEHOLD" }] });
    expect(m("total_population_covered")).toMatchObject({ agg: "sum", field: "Data.quantity", scale: 1.8 });
    const visits = r.boards[0]!.ops.find((o) => (o as { id?: string }).id === "todays_visits") as unknown as { widget: { query: unknown } };
    expect(visits.widget.query).toEqual({ kind: "value", measure: "visits", compare: "previous_period", time: { last: "1d" } });
  });

  it("keeps the hierarchy level a target reads as part of its name", () => {
    expect(m("overall_target_at_province")?.where).toContainEqual({ field: "Data.district", op: "missing" });
    expect(r.report).toMatch(/## Per-level copies/);
  });

  it("builds cross-index ratios in DSS's operand order, through additive aliases", () => {
    expect(m("user_sync_rate")).toMatchObject({ derived: "unique_users_synced / total_users_created", format: "percent", entity: "user_sync" });
    expect(m("overview_total_coverage_household_visits")?.derived).toBe("visits / overall_target_at_province");
  });

  it("shares dimensions across indexes and turns placeholders into a board filter", () => {
    const province = r.pack.dimensions.find((d) => d.key === "province")!;
    expect(Object.keys(province.also ?? {}).sort()).toEqual(["project", "project_staff", "user_sync"]);
    expect(r.boards[0]!.ops.at(-1)).toMatchObject({ op: "add_filter", filter: { field: "product_variant" } });
  });

  it("writes a pack that parses back", async () => {
    const { parsePackText } = await import("@lenspack/spec");
    expect(parsePackText(r.packYaml).measures.length).toBe(r.pack.measures.length);
  });
});

describe("what real configs carry besides charts", () => {
  const q = (index: string, aggs: object, rqm = "") => ({ indexName: index, requestQueryMap: rqm, aggrQuery: JSON.stringify({ aggs }) });
  const r = compileDss(
    {
      _comment: "not a chart" as never,
      byService: { chartType: "pie", queries: [q("idx-a", { business_service: { terms: { field: "Data.businessService.keyword" }, aggs: { Count: { value_count: { field: "Data.id.keyword" } } } } })] },
      joined: { chartType: "metric", queries: [q("idx-a,idx-b", { Total: { sum: { field: "Data.amount" } } })] },
      named: { chartType: "metric", queries: [q("idx-a", { business_service: { value_count: { field: "Data.id.keyword" } } }, '{"business_service":"Data.businessService.keyword"}')] },
    },
    undefined,
  );
  it("skips comments, searches index lists as one, and keeps measures and dimensions apart", () => {
    expect(r.outcomes.map((o) => o.chart).sort()).toEqual(["byService", "joined", "named"]);
    expect(Object.values(r.pack.entities).map((e) => e.source)).toContain("idx-a,idx-b");
    const dims = new Set(r.pack.dimensions.map((d) => d.key));
    expect(r.pack.measures.some((m) => dims.has(m.key))).toBe(false);
    expect(r.outcomes.every((o) => o.status !== "skipped")).toBe(true);
  });
});

