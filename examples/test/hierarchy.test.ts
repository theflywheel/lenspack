import type { BoardConfig, Query } from "@lenspack/core";
import { drilledQuery, resolveBoard, run, sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBoard, campaign, contextFor } from "../index";

// Hierarchies on the campaign pack: area = province > district > locality >
// village, with household targets kept per province and per district, the
// way DSS keeps them.

const pack = campaign.pack;
const ctx = contextFor.campaign;
let duck: Awaited<ReturnType<typeof openDuckdb>>;
const q = (query: Query) => run(query, { pack, connector: sqlConnector(duck.executor), ctx });

beforeAll(async () => {
  duck = await openDuckdb(":memory:");
  await campaign.seed(duck.writer, "duckdb", { households: 2000 });
});
afterAll(async () => duck?.close());

describe("a measure kept per level", () => {
  it("reads the level a query views, so the rows are never counted twice", async () => {
    const national = (await q({ kind: "value", measure: "household_target" })).rows[0]!.value!;
    const byDistrict = (await q({ kind: "breakdown", dimension: "district", measure: "household_target", limit: 50, sort: "desc" })).rows;
    const byProvince = (await q({ kind: "breakdown", dimension: "province", measure: "household_target", limit: 50, sort: "desc" })).rows;
    const sum = (rows: { value: number | null }[]) => rows.reduce((n, r) => n + (r.value ?? 0), 0);
    expect(byDistrict.some((r) => r.group === "(none)")).toBe(false);
    expect(sum(byDistrict)).toBe(national);
    expect(sum(byProvince)).toBe(national);
    // A filter on a level reads that level's own row.
    const eastern = (await q({ kind: "value", measure: "household_target", filters: [{ dimension: "province", op: "eq", value: "Eastern" }] })).rows[0]!.value;
    expect(eastern).toBe(byProvince.find((r) => r.group === "Eastern")!.value);
  });

  it("carries through arithmetic: coverage by province uses the province rows", async () => {
    const rows = (await q({ kind: "breakdown", dimension: "province", measure: "household_coverage", measures: ["household_target", "households_delivered"], limit: 5, sort: "desc" })).rows;
    for (const r of rows) expect(r.value).toBeCloseTo(r.values!.households_delivered! / r.values!.household_target!, 12);
  });
});

describe("drilling down a board", () => {
  const board: BoardConfig = buildBoard("campaign", "overview");

  it("steps a grouping at or above the selection one level down, narrowed to it", () => {
    const widget = board.widgets.by_province!;
    const drilled = drilledQuery(board, "by_province", widget, { province: "Eastern" }, pack, { ctx });
    expect(drilled).toMatchObject({ kind: "breakdown", dimension: "district", filters: [{ dimension: "province", op: "eq", value: "Eastern" }] });
    const deeper = drilledQuery(board, "by_province", widget, { province: "Eastern", district: "Chipata" }, pack, { ctx });
    expect(deeper).toMatchObject({ dimension: "locality" });
  });

  it("leaves groupings below the selection alone and still narrows them", () => {
    const widget = board.widgets.coverage_by_district!;
    const drilled = drilledQuery(board, "coverage_by_district", widget, { province: "Eastern" }, pack, { ctx });
    expect(drilled).toMatchObject({ dimension: "district", filters: [{ dimension: "province", value: "Eastern" }] });
  });

  it("draws the drilled board: only the selected province's districts, every widget answering", async () => {
    const data = await resolveBoard(board, { pack, connector: sqlConnector(duck.executor), ctx }, { province: "Eastern" });
    for (const [id, d] of Object.entries(data)) expect(d.error, id).toBeUndefined();
    const eastern = ["Chipata", "Lundazi", "Petauke", "Katete"];
    expect(data.coverage_by_district!.rows.map((r) => r.group).sort()).toEqual([...eastern].sort());
    expect(data.by_province!.rows.every((r) => eastern.includes(r.group))).toBe(true);
    const whole = await resolveBoard(board, { pack, connector: sqlConnector(duck.executor), ctx });
    expect(data.visits!.rows[0]!.value!).toBeLessThan(whole.visits!.rows[0]!.value!);
  });
});
