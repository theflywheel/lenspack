import { memoryStore } from "@lenspack/core";
import { parsePack } from "@lenspack/pack";
import { sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatCompute, parseCompute } from "../src/args";
import { type Tool, boardTools } from "../src/tools";

// A made-up stock ledger: one row per movement of stock in or out of a ward's store. The pack
// defines plain measures only; a burn rate or a day-on-day change is asked of the agent's tools.

const pack = parsePack({
  pack: "stock",
  version: 1,
  entities: { movement: { source: "stock_movements", time: "moved_at", grain: "one movement of stock in or out" } },
  dimensions: [
    { key: "ward", entity: "movement", field: "ward" },
    { key: "item", entity: "movement", field: "item" },
  ],
  measures: [
    { key: "dispatched", entity: "movement", agg: "sum", field: "qty", where: [{ field: "kind", value: "dispatch" }], label: "Units dispatched" },
    { key: "received", entity: "movement", agg: "sum", field: "qty", where: [{ field: "kind", value: "receipt" }], label: "Units received" },
    { key: "movements", entity: "movement", agg: "count" },
    { key: "out_share", entity: "movement", derived: "dispatched / received", format: "percent" },
  ],
});

// 1 to 5 March. North dispatches nothing on the 3rd (it only receives), south nothing on the
// 1st, east only on the 5th.
const ROWS = [
  ["north", "dispatch", 10, 1], ["north", "dispatch", 20, 2], ["north", "receipt", 100, 3], ["north", "dispatch", 10, 4], ["north", "dispatch", 15, 5],
  ["south", "receipt", 50, 1], ["south", "dispatch", 5, 2], ["south", "dispatch", 10, 3], ["south", "dispatch", 10, 4], ["south", "dispatch", 5, 5],
  ["east", "dispatch", 30, 5],
] as const;
const week = { time_from: "2026-03-01T00:00:00Z", time_to: "2026-03-06T00:00:00Z" };

let db: Awaited<ReturnType<typeof openDuckdb>>;
let tools: Record<string, Tool>;
beforeAll(async () => {
  db = await openDuckdb();
  await db.writer.exec("CREATE TABLE stock_movements (id INTEGER, ward VARCHAR, item VARCHAR, kind VARCHAR, qty INTEGER, moved_at TIMESTAMP)");
  await db.writer.exec(`INSERT INTO stock_movements VALUES ${ROWS.map(([ward, kind, qty, d], i) => `(${i + 1}, '${ward}', 'kit', '${kind}', ${qty}, '2026-03-0${d} 09:00:00')`).join(", ")}`);
  const store = memoryStore();
  await store.create({ id: "b", pack, title: "Stock" });
  tools = Object.fromEntries(boardTools({ pack, connector: sqlConnector(db.executor), store, boardId: "b", ctx: { now: new Date("2026-03-10T00:00:00Z") } }).map((t) => [t.name, t]));
});
afterAll(async () => db.close());

type Answer = { ok: boolean; error?: string; computed?: string; rows: { group: string; series?: string; value: number | null; count: number }[]; format: string; sql: string; counts?: string; applied?: boolean; board?: string };
const call = async (name: string, args: Record<string, unknown>) => (await tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never)) as Answer;
const round = (v: number | null) => (v === null ? null : Math.round(v * 1e4) / 1e4);

describe("rates and changes the pack does not define, asked of the tools", () => {
  it("“what's the burn rate per ward?”: units dispatched per ward and day, then the average per ward", async () => {
    const r = await call("query", { query_kind: "breakdown", measure: "dispatched", dimension: "ward", grain: "day", compute: "mean", ...week });
    expect(r.ok, r.error).toBe(true);
    // A day with no dispatch counts as 0: north (10 + 20 + 0 + 10 + 15) / 5, east 30 / 5, south (0 + 5 + 10 + 10 + 5) / 5.
    expect(r.rows.map((x) => [x.group, x.value])).toEqual([["north", 11], ["east", 6], ["south", 6]]);
    // What the reply can say the burn rate is, in plain words.
    expect(r.computed).toBe("average daily units dispatched: a day with no records counts as 0");
    // The source was asked for the base grain, every ward by day; the average was taken after.
    expect(r.sql).toMatch(/^-- computed after the source answers: average daily units dispatched/);
    expect(r.sql).toMatch(/GROUP BY/);
  });

  it("“can we not have a day-on-day average percentage per ward?”: the % change per day, then its average", async () => {
    const r = await call("query", { query_kind: "breakdown", measure: "dispatched", dimension: "ward", grain: "day", compute: "pct_change, mean", ...week });
    expect(r.ok, r.error).toBe(true);
    expect(r.format).toBe("percent");
    // north: +100%, −100%, (from 0: skipped), +50%; south: (from 0), +100%, 0%, −50%; east: every change is from 0.
    expect(r.rows.map((x) => [x.group, round(x.value)])).toEqual([["north", 0.1667], ["south", 0.1667], ["east", null]]);
    expect(r.computed).toContain("average day-on-day % change in units dispatched");
    expect(r.computed).toContain("a change from 0 has no percentage and is skipped");
  });

  it("the day-on-day change itself, as a series per ward", async () => {
    const r = await call("query", { query_kind: "series", measure: "dispatched", dimension: "ward", grain: "day", compute: "% change", ...week });
    expect(r.ok, r.error).toBe(true);
    expect(r.rows.filter((x) => x.series === "north").map((x) => round(x.value))).toEqual([null, 1, -1, null, 0.5]);
  });

  it("a 3-day rolling average, a running total and a ratio, from the same plain measures", async () => {
    const rolling = await call("query", { query_kind: "series", measure: "dispatched", grain: "day", compute: "rolling_mean 3", ...week });
    expect(rolling.rows.map((x) => [x.group, round(x.value)])).toEqual([["2026-03-03", 15], ["2026-03-04", 18.3333], ["2026-03-05", 26.6667]]);
    const total = await call("query", { query_kind: "series", measure: "dispatched", grain: "day", compute: "running total", ...week });
    expect(total.rows.map((x) => x.value)).toEqual([10, 35, 45, 65, 115]);
    const ratio = await call("query", { query_kind: "value", measure: "dispatched", compute: "ratio received pct", ...week });
    expect(ratio).toMatchObject({ ok: true, format: "percent", rows: [{ value: 115 / 150 }] });
  });

  it("refuses what would mislead, with what would work", async () => {
    const summed = await call("query", { query_kind: "breakdown", measure: "out_share", dimension: "ward", grain: "day", compute: "sum", ...week });
    expect(summed).toMatchObject({ ok: false, error: expect.stringMatching(/percentage.*never added up.*mean/) });
    const noGrain = await call("query", { query_kind: "breakdown", measure: "dispatched", dimension: "ward", compute: "mean", ...week });
    expect(noGrain).toMatchObject({ ok: false, error: expect.stringMatching(/need a grain/) });
    const unread = await call("query", { query_kind: "series", measure: "dispatched", compute: "trend", ...week });
    expect(unread).toMatchObject({ ok: false, error: expect.stringMatching(/Cannot read the step "trend": write change, pct_change/) });
  });

  it("puts a computed breakdown on the board, says what it shows, and a patch can drop the steps", async () => {
    const added = await call("add_widget", { id: "burn", kind: "chart", chart: "bar", title: "Burn rate by ward", query_kind: "breakdown", measure: "dispatched", dimension: "ward", grain: "day", compute: "mean", time_last: "30d" });
    expect(added.applied, added.error).toBe(true);
    expect(added.board).toContain("dispatched → mean over days by ward");
    const dropped = await call("update_widget", { id: "burn", compute: "none" });
    expect(dropped.applied, dropped.error).toBe(true);
    expect(dropped.board).toMatch(/burn \(bar, .*\) dispatched by ward last 30d/);
  });

  it("says plainly what a breakdown's counts cover", async () => {
    const r = await call("query", { query_kind: "breakdown", measure: "movements", dimension: "ward", limit: 2 });
    expect(r.counts).toBe("2 groups shown, the top 2: other groups may exist. records (10) counts only the records behind the groups shown, not the data's total; for a total, run a value query.");
  });
});

describe("the compute string", () => {
  it("reads the ways a model writes a step, and writes it back the one way", () => {
    expect(parseCompute("pct change then avg", "breakdown", "day")).toEqual({ grain: "day", steps: [{ op: "change", percent: true }, { op: "over_time", fn: "mean" }] });
    expect(parseCompute("7-day rolling average", "series", "day")).toEqual({ steps: [{ op: "rolling", fn: "mean", window: 7 }] });
    expect(parseCompute("rolling_sum 14 -> max", "value", "week")).toEqual({ grain: "week", steps: [{ op: "rolling", fn: "sum", window: 14 }, { op: "over_time", fn: "max" }] });
    // A ratio alone runs per group, so it keeps no grain.
    expect(parseCompute("ratio received %", "breakdown", "day")).toEqual({ steps: [{ op: "ratio", to: "received", percent: true }] });
    expect(parseCompute("", "series", "day")).toBeUndefined();
    const c = parseCompute("ratio received pct, change, cumulative, latest", "value", "month")!;
    expect(parseCompute(formatCompute(c), "value", "month")).toEqual(c);
  });
});
