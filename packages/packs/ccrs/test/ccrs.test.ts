import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileCcrs } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(join(here, "fixtures", f), "utf8"));
const r = compileCcrs(read("KpiDefinition.json"), read("DashboardPack.json"), { timeZone: "Africa/Nairobi" });
const m = (k: string) => r.pack.measures.find((x) => x.key === k);
const board = (id: string) => r.boards.find((b) => b.id === id)!;
const widget = (b: string, id: string) => (board(b).ops.find((o) => (o as { id?: string }).id === id) as unknown as { widget: { query: Record<string, unknown> } }).widget;

describe("compiling a CCRS KPI catalog", () => {
  it("defines each number once: filters become where, ratios arithmetic", () => {
    expect(m("complaints")).toMatchObject({ entity: "facts", agg: "count" });
    expect(m("complaints_not_open_resolved")?.where).toEqual([{ field: "is_open", op: "eq", value: false }, { field: "is_resolved", op: "eq", value: true }]);
    expect(m("reopen_rate")).toMatchObject({ derived: "complaints_resolved_reopened / complaints_resolved", format: "percent" });
    expect(r.pack.timeZone).toBe("Africa/Nairobi");
    expect(r.pack.entities.facts?.tenant).toEqual({ field: "tenant_id", match: "subtree" });
  });
  it("keeps the pack's exact grid and places every tile", () => {
    expect(board("supervisor-default").layout[0]).toEqual({ i: "cl_resolution_rate_count", x: 0, y: 0, w: 2, h: 2 });
    expect(board("public-default").layout).toHaveLength(8);
  });
  it("reads live tiles at the current state, and others in their own window", () => {
    expect(widget("public-default", "cl_open_complaints_live").query).toEqual({ kind: "value", measure: "complaints_open" });
    expect(widget("public-default", "cl_new_created_count").query).toMatchObject({ kind: "value", compare: "previous_period", time: { last: "7d" } });
    expect(widget("public-default", "cl_chart_complaints_by_type").query).toMatchObject({ kind: "breakdown", dimension: "service_type_l1", time: { last: "30d" } });
    expect(widget("supervisor-default", "cl_chart_open_by_type_stage").query).toMatchObject({ dimension: "service_type_l1", by: "application_status" });
    expect(widget("public-default", "cl_chart_over_time_created_daily").query).toMatchObject({ dimension: "created_date", sortBy: "group", sort: "asc", measures: expect.any(Array) });
  });
  it("gives the employee pack a month-long date range over its non-live tiles, and the public pack none", () => {
    const dates = board("supervisor-default").ops.find((o) => (o as { filter?: { id: string } }).filter?.id === "dates") as unknown as { filter: { applies: string[]; default: unknown } };
    expect(dates.filter.default).toEqual({ months: 1 });
    expect(dates.filter.applies).not.toContain("rs_breach_total");
    expect(board("public-default").ops.some((o) => (o as { filter?: { id: string } }).filter?.id === "dates")).toBe(false);
  });
  it("maps lenspack's result back onto the columns CCRS's components read", () => {
    expect(r.skin.tiles.cl_chart_over_time_created_daily?.columns).toMatchObject({ group: "created_date", value: "created" });
    expect(r.skin.tiles.cl_new_created_count?.sparkline).toEqual({ measure: "complaints", dateColumn: "created_date" });
  });
});
