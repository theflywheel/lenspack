import { readFileSync } from "node:fs";

import { type BoardOp, type Query, applyOps, emptyBoard } from "@lenspack/core";
import { compileDss } from "@lenspack/dss";
import { catalogueFrom } from "@lenspack/spec";
import { elasticsearchConnector } from "@lenspack/elasticsearch";
import { type WidgetData, explain, resolveBoard, run, sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { campaign, contextFor } from "../index";

// One pack, one set of generated documents, two backends. Every query below
// runs on DuckDB (tables named like the indexes, columns named like the field
// paths) and on a real Elasticsearch, and the answers must agree: exactly for
// counts, sums and ratios; within 1% where the search engine estimates.
//
//   LENSPACK_ES_URL=http://127.0.0.1:9217 pnpm vitest run examples/test/elasticsearch.test.ts

const url = process.env.LENSPACK_ES_URL;
const ctx = contextFor.campaign;
const pack = campaign.pack;

const dims = ["province", "district", "locality", "product_variant", "delivered_to", "not_delivered_reason"];
const measures = ["visits", "households_delivered", "households_not_delivered", "nets_distributed", "population_covered", "avg_nets_per_visit", "distributors_active", "delivery_rate"];

const queries: Query[] = [
  ...dims.flatMap((dimension) => measures.map((measure) => ({ kind: "breakdown", dimension, measure, limit: 8, sort: "desc" }) as Query)),
  { kind: "breakdown", dimension: "district", measure: "nets_distributed", limit: 5, sort: "asc" },
  { kind: "breakdown", dimension: "district", measure: "undelivered_share", limit: 12, sort: "desc" },
  { kind: "breakdown", dimension: "district", measure: "households_remaining", limit: 12, sort: "desc" },
  { kind: "breakdown", dimension: "province", measure: "coverage_points", limit: 12, sort: "desc" },
  { kind: "value", measure: "households_remaining" },
  { kind: "value", measure: "undelivered_share", compare: "previous_period", time: { last: "30d" } },
  { kind: "series", measure: "undelivered_share", grain: "week", by: "province" },
  { kind: "breakdown", dimension: "district", measure: "visits", measures: ["nets_distributed", "household_target", "household_coverage", "distributors_active"], limit: 12, sort: "desc" },
  { kind: "breakdown", dimension: "province", measure: "household_coverage", measures: ["households_remaining", "delivery_rate"], limit: 5, sort: "asc" },
  { kind: "series", measure: "visits", measures: ["households_delivered", "delivery_rate"], grain: "week" },
  { kind: "value", measure: "visits", measures: ["nets_distributed", "household_coverage"] },
  { kind: "breakdown", dimension: "district", measure: "coverage_gap_points", limit: 12, sort: "desc" },
  { kind: "breakdown", dimension: "province", by: "product_variant", measure: "visits", limit: 20, sort: "desc" },
  { kind: "breakdown", dimension: "district", by: "not_delivered_reason", measure: "households_not_delivered", limit: 15, sort: "desc", filters: [{ dimension: "not_delivered_reason", op: "neq", value: "" }] },
  { kind: "breakdown", dimension: "locality", measure: "visits", measures: ["nets_distributed"], limit: 40, sort: "asc", sortBy: "group" },
  { kind: "breakdown", dimension: "district", by: "product_variant", measure: "nets_distributed", limit: 30, sort: "desc", sortBy: "group" },
  { kind: "breakdown", dimension: "district", measure: "household_coverage", limit: 12, sort: "desc" },
  { kind: "breakdown", dimension: "province", measure: "household_coverage", limit: 12, sort: "asc" },
  ...measures.map((measure) => ({ kind: "value", measure }) as Query),
  { kind: "value", measure: "household_coverage" },
  { kind: "value", measure: "visits", compare: "previous_period", time: { last: "30d" } },
  { kind: "value", measure: "delivery_rate", compare: "previous_period", time: { from: "2026-08-01T00:00:00Z", to: "2026-08-15T00:00:00Z" } },
  { kind: "series", measure: "visits", grain: "day" },
  { kind: "series", measure: "nets_distributed", grain: "week" },
  { kind: "series", measure: "nets_distributed", grain: "week", by: "product_variant" },
  { kind: "series", measure: "delivery_rate", grain: "month", by: "province" },
  { kind: "series", measure: "visits", grain: "week", time: { last: "4w" } },
  { kind: "breakdown", dimension: "district", measure: "visits", limit: 10, sort: "desc", filters: [{ dimension: "province", op: "eq", value: "Eastern" }] },
  { kind: "breakdown", dimension: "district", measure: "visits", limit: 10, sort: "desc", filters: [{ dimension: "province", op: "neq", value: "Eastern" }] },
  { kind: "breakdown", dimension: "district", measure: "visits", limit: 10, sort: "desc", filters: [{ dimension: "province", op: "in", value: ["Western", "Northern"] }] },
  { kind: "breakdown", dimension: "locality", measure: "visits", limit: 10, sort: "desc", filters: [{ dimension: "district", op: "contains", value: "pat" }] },
  { kind: "breakdown", dimension: "not_delivered_reason", measure: "households_not_delivered", limit: 6, sort: "desc", filters: [{ dimension: "not_delivered_reason", op: "neq", value: "" }] },
  { kind: "breakdown", dimension: "district", measure: "household_coverage", limit: 12, sort: "desc", filters: [{ dimension: "product_variant", op: "eq", value: "PVAR-NET-SINGLE" }] },
];

const APPROXIMATE = new Set(["distributors_active"]);

function close(a: number | null, b: number | null, approximate: boolean) {
  if (a === null || b === null) return a === b;
  const tolerance = approximate ? 0.01 : 1e-9;
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

// Ties may come back in either order within equal values, so compare the
// rows as a set keyed on group and series, then check each side is ordered.
function agree(sql: WidgetData, es: WidgetData, q: Query) {
  const approximate = q.kind !== "rows" && APPROXIMATE.has(q.measure);
  expect(es.error, es.error).toBeUndefined();
  expect(sql.error, sql.error).toBeUndefined();
  const key = (r: { group: string; series?: string }) => `${r.group}|${r.series ?? ""}`;
  const esByKey = new Map(es.rows.map((r) => [key(r), r]));
  expect([...esByKey.keys()].sort()).toEqual(sql.rows.map(key).sort());
  for (const r of sql.rows) {
    const other = esByKey.get(key(r))!;
    expect(close(r.value, other.value, approximate), `${key(r)}: sql ${r.value} vs es ${other.value}`).toBe(true);
    for (const [k, v] of Object.entries(r.values ?? {}))
      expect(close(v, other.values?.[k] ?? null, APPROXIMATE.has(k)), `${key(r)} ${k}: sql ${v} vs es ${other.values?.[k]}`).toBe(true);
    expect(other.count).toBe(r.count);
  }
  if (sql.compare) {
    expect(close(sql.compare.previous, es.compare!.previous, approximate)).toBe(true);
  }
  const anyApprox = approximate || (q.kind !== "rows" && (q.measures ?? []).some((m) => APPROXIMATE.has(m)));
  expect(!!es.approximate).toBe(anyApprox);
  expect(es.measures).toEqual(sql.measures);
}

describe.skipIf(!url)("elasticsearch agrees with duckdb on the campaign pack", () => {
  const es = elasticsearchConnector({ url: url ?? "" });
  let duck: Awaited<ReturnType<typeof openDuckdb>>;

  beforeAll(async () => {
    duck = await openDuckdb(":memory:");
    await campaign.seed(duck.writer, "duckdb", { households: 3000 });
    await campaign.seedSearch(es.request, { households: 3000 });
  });
  afterAll(async () => {
    await duck?.close();
  });

  for (const q of queries) {
    it(JSON.stringify(q), async () => {
      const [a, b] = await Promise.all([run(q, { pack, connector: sqlConnector(duck.executor), ctx }), run(q, { pack, connector: es, ctx })]);
      agree(a, b, q);
    });
  }

  it("lists rows with the same ordering column", async () => {
    const q: Query = { kind: "rows", entity: "task", columns: ["district", "locality", "not_delivered_reason"], limit: 20, orderBy: { key: "locality", dir: "desc" } };
    const [a, b] = await Promise.all([run(q, { pack, connector: sqlConnector(duck.executor), ctx }), run(q, { pack, connector: es, ctx })]);
    expect(b.records!.length).toBe(20);
    expect(b.records!.map((r) => r.locality)).toEqual(a.records!.map((r) => r.locality));
  });

  it("refuses a join the index cannot do, and names what it can group by", async () => {
    const data = await run({ kind: "breakdown", dimension: "target_type", measure: "visits", limit: 5, sort: "desc" }, { pack, connector: es, ctx });
    expect(data.error).toMatch(/cannot join/);
    expect(data.error).toMatch(/district/);
  });

  it("explains as a search request on the right index, resolving text to keyword", async () => {
    const e = await explain({ kind: "breakdown", dimension: "district", measure: "visits", limit: 5, sort: "desc" }, { pack, connector: es, ctx });
    expect(e.text).toMatch(/^POST \/project-task-index-v1\/_search/);
    expect(e.text).toContain('"Data.district.keyword"');
    expect(e.text).toContain('"Data.deliveredTo.keyword"');
  });

  it("introspects the indexes and their fields", async () => {
    const schema = await es.introspect!();
    const task = schema.collections.find((c) => c.name === "project-task-index-v1")!;
    expect(task.rows).toBe(3000);
    expect(task.fields.find((f) => f.path === "Data.district")?.type).toBe("text");
    expect(task.fields.find((f) => f.path === "Data.district.keyword")?.type).toBe("keyword");
  });

  it("draws DSS charts compiled to a pack against the index they were written for", async () => {
    const fx = new URL("../../packages/dss/test/fixtures/", import.meta.url);
    const r = compileDss(JSON.parse(readFileSync(new URL("ChartApiConfig.sample.json", fx), "utf8")), JSON.parse(readFileSync(new URL("MasterDashboardConfig.sample.json", fx), "utf8")));
    const built = applyOps(emptyBoard(r.pack, "dss"), r.boards[0]!.ops as BoardOp[], catalogueFrom(r.pack));
    if (!built.ok) throw new Error(built.error);
    const data = await resolveBoard(built.config, { pack: r.pack, connector: es, ctx }, { product_variant: "PVAR-NET-SINGLE" });
    // The synthetic data has the task and project indexes, not the staff and sync ones.
    const onSeeded = Object.entries(built.config.widgets).filter(([, w]) => w.kind !== "text" && !/user_sync|staff/.test(JSON.stringify(w)));
    expect(onSeeded.length).toBeGreaterThanOrEqual(5);
    for (const [id] of onSeeded) {
      expect(data[id]!.error, `${id}: ${data[id]!.error}`).toBeUndefined();
      expect(data[id]!.rows.length, id).toBeGreaterThan(0);
    }
    const byDistrict = data["rd_total_households_not_delivered_chart"]!;
    // The compiled pack is connector-neutral too: DuckDB, over tables named
    // like the indexes, must draw the same board.
    const onSql = await resolveBoard(built.config, { pack: r.pack, connector: sqlConnector(duck.executor), ctx }, { product_variant: "PVAR-NET-SINGLE" });
    for (const [id] of onSeeded) {
      expect(onSql[id]!.error, `${id} on sql: ${onSql[id]!.error}`).toBeUndefined();
      expect(data[id]!.rows, id).toEqual(onSql[id]!.rows);
    }
    expect(byDistrict.rows.length).toBeGreaterThan(3);
  });

  it("drills the same way on both: a province selected, districts and per-level targets follow", async () => {
    const { buildBoard } = await import("../index");
    const board = buildBoard("campaign", "overview");
    for (const selection of [{ province: "Eastern" }, { province: "Northern", district: "Mansa" }] as Record<string, string>[]) {
      const [a, b] = await Promise.all([
        resolveBoard(board, { pack, connector: sqlConnector(duck.executor), ctx }, selection),
        resolveBoard(board, { pack, connector: es, ctx }, selection),
      ]);
      for (const id of Object.keys(a)) {
        expect(b[id]!.error, `${id}: ${b[id]!.error}`).toBeUndefined();
        if (id !== "distributors") expect(b[id]!.rows, `${JSON.stringify(selection)} ${id}`).toEqual(a[id]!.rows);
      }
    }
  });
});

