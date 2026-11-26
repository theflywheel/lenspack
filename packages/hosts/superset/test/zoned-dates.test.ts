import { describe, expect, it } from "vitest";

import { type Tool, boardTools } from "@lenspack/agent";
import { type Query, memoryStore } from "@lenspack/core";
import { checkOps, run } from "@lenspack/engine";

import { SUPERSET_CAPABILITIES, supersetConnector, timeZoneWarnings } from "../src/connector";
import { packFromDatasets, widgetToChart, type SupersetDataset } from "../src/index";

// A pack whose days start in Lagos, over Superset. Superset cuts time into
// days with no time zone, so a series over a column with a time of day is
// refused here. A column of calendar dates (a DATE column) needs no zone: a day
// of dates is the same day anywhere. Its series are drawn, and a window is
// sent to Superset as the dates it holds in Lagos.

const dataset = (id: number, table: string, time: string, type: string): SupersetDataset => ({
  id,
  table_name: table,
  main_dttm_col: time,
  columns: [
    { column_name: time, is_dttm: true, type },
    { column_name: "ward", groupby: true, type: "TEXT" },
  ],
  metrics: [
    { metric_name: "dispatched", expression: "SUM(qty_out)" },
    { metric_name: "movements", expression: "COUNT(*)" },
  ],
});
const zoned = { pack: "s", timeZone: "Africa/Lagos", entities: { "3": "movement", "4": "event" } };
const { pack, binding } = packFromDatasets([dataset(3, "stock_movements", "moved_on", "DATE"), dataset(4, "stock_events", "logged_at", "TIMESTAMP WITHOUT TIME ZONE")], zoned);

// 00:30 on 10 September in Lagos, still 9 September in UTC.
const ctx = { now: new Date("2026-09-09T23:30:00Z") };
type Sent = { queries: { filters: { col: string; op: string; val?: unknown }[]; columns: unknown[]; extras: Record<string, unknown> }[] };

function stub(data: Record<string, unknown>[] = []) {
  const sent: Sent[] = [];
  const connector = supersetConnector({ post: async (_p: string, body: Sent) => (sent.push(body), { result: body.queries.map(() => ({ data })) }) } as never, binding);
  return { sent, connector };
}
const window = (s: Sent) => s.queries[0]!.filters.find((f) => f.op === "TEMPORAL_RANGE")?.val;

describe("the catalogue says which time columns hold calendar dates", () => {
  it("DATE, Date, Date32 and Nullable(Date) are dates; a timestamp is not", () => {
    const time = (type: string) => packFromDatasets([dataset(9, "t", "d", type)], { pack: "x" }).pack.entities.t!.time;
    for (const type of ["DATE", "date", "Date", "Date32", "Nullable(Date)"]) expect(time(type), type).toEqual({ field: "d", type: "date" });
    for (const type of ["TIMESTAMP", "TIMESTAMP WITHOUT TIME ZONE", "DateTime", "DateTime64(3, 'UTC')", "DATETIME"]) expect(time(type), type).toBe("d");
    expect(binding.datasets.get("movement")!.time).toBe("moved_on");
  });
});

describe("a zoned pack over Superset, on a column of calendar dates", () => {
  const queries: [string, Query, string | undefined][] = [
    ["a daily series over the last 7 days", { kind: "series", measure: "dispatched", grain: "day", time: { last: "7d" } }, "2026-09-04T00:00:00 : 2026-09-11T00:00:00"],
    ["a weekly series by ward this month", { kind: "series", measure: "dispatched", grain: "week", by: "ward", time: { period: "month" } }, "2026-09-01T00:00:00 : 2026-09-11T00:00:00"],
    ["a monthly series with no window", { kind: "series", measure: "movements", grain: "month" }, undefined],
    ["today", { kind: "series", measure: "dispatched", grain: "day", time: { period: "day" } }, "2026-09-10T00:00:00 : 2026-09-11T00:00:00"],
    ["an exact range written in UTC", { kind: "series", measure: "dispatched", grain: "day", time: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" } }, "2026-08-01T00:00:00 : 2026-09-01T00:00:00"],
    ["a breakdown last month", { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 10, sort: "desc", time: { period: "month", offset: -1 } }, "2026-08-01T00:00:00 : 2026-09-01T00:00:00"],
    ["a running total", { kind: "series", measure: "dispatched", grain: "day", time: { last: "30d" }, compute: { steps: [{ op: "running_total" }] } }, "2026-08-12T00:00:00 : 2026-09-11T00:00:00"],
    // A change needs the day before the window as well.
    ["a day-on-day change", { kind: "series", measure: "dispatched", grain: "day", time: { last: "7d" }, compute: { steps: [{ op: "change" }] } }, "2026-09-03T00:00:00 : 2026-09-11T00:00:00"],
  ];
  for (const [label, query, range] of queries)
    it(`draws ${label}, sending the window as Lagos dates`, async () => {
      const { sent, connector } = stub();
      const data = await run(query, { pack, connector, ctx });
      expect(data.error).toBeUndefined();
      expect(window(sent[0]!)).toBe(range);
      // The dates are bucketed by Superset's own time grain, with no zone expression.
      if (query.kind === "series") expect(JSON.stringify(sent[0]!.queries[0]!.columns)).not.toMatch(/zone|AT TIME/i);
    });

  it("compares the last 7 days with the 7 days before, as dates", async () => {
    const { sent, connector } = stub([{ dispatched: 5, __lenspack_n: 1 }]);
    const data = await run({ kind: "value", measure: "dispatched", compare: "previous_period", time: { last: "7d" } }, { pack, connector, ctx });
    expect(data.error).toBeUndefined();
    expect(sent[0]!.queries.map((q) => q.filters.find((f) => f.op === "TEMPORAL_RANGE")?.val)).toEqual(["2026-09-04T00:00:00 : 2026-09-11T00:00:00", "2026-08-28T00:00:00 : 2026-09-04T00:00:00"]);
  });

  it("keeps series and per-day summaries as Superset charts", () => {
    const add = (widget: unknown) => [{ op: "add_widget", id: "w", widget, placement: { place: "bottom", width: "half" } }] as never;
    const line = { title: "Daily", kind: "chart", chart: "line", options: { legend: true, colorScheme: "default" }, query: { kind: "series", measure: "dispatched", grain: "day", by: "ward", time: { last: "30d" } } };
    const pivot = { title: "Per ward", kind: "table", pageSize: 10, query: { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time: { last: "30d" }, compute: { grain: "day", steps: [{ op: "over_time", fn: "sum" }] } } };
    for (const w of [line, pivot]) {
      expect(checkOps(add(w), pack, { capabilities: SUPERSET_CAPABILITIES, ctx })).toEqual({ ok: true });
      expect(widgetToChart(w as never, pack, binding)).toBeTruthy();
    }
  });
});

describe("a zoned pack over Superset, on a column with a time of day", () => {
  it("refuses a series, and says what would work", async () => {
    const { sent, connector } = stub();
    // The second dataset's metric of the same name is keyed by its entity.
    expect(pack.measures.find((m) => m.key === "event_dispatched")?.entity).toBe("event");
    const refused = await run({ kind: "series", measure: "event_dispatched", grain: "day", time: { last: "7d" } }, { pack, connector, ctx });
    // Plain enough that the model stops trying other series on it, and says why.
    expect(refused.error).toContain('No series of "event" can be drawn on this deployment, at any grain');
    expect(refused.error).toContain("cannot cut it into days in Africa/Lagos, the pack's time zone");
    expect(refused.error).toContain('Do not try another series, grain or window on "event"');
    expect(refused.error).toContain("tell the user plainly that over-time charts of this data are not available here");
    expect(refused.error).toContain("a date column for its time, or a pack kept in UTC");
    expect(sent).toHaveLength(0);
  });

  it("is said at start-up, naming the dataset and column and what to do; dated datasets and UTC packs have none", () => {
    expect(timeZoneWarnings(pack, binding)).toEqual([
      'Superset dataset "stock_events" (4): its time column "logged_at" has a time of day, and the pack\'s timeZone is Africa/Lagos, which this source cannot cut days in, so every series over it (by hour, day, week or month) is refused. Use a date column for its time, or keep the pack in UTC.',
    ]);
    const utc = packFromDatasets([dataset(4, "stock_events", "logged_at", "TIMESTAMP WITHOUT TIME ZONE")], { ...zoned, timeZone: "UTC" });
    expect(timeZoneWarnings(utc.pack, utc.binding)).toEqual([]);
    const plain = packFromDatasets([dataset(4, "stock_events", "logged_at", "TIMESTAMP WITHOUT TIME ZONE")], { pack: "s" });
    expect(timeZoneWarnings(plain.pack, plain.binding)).toEqual([]);
  });
});

describe("the agent's tools on a zoned pack with dates", () => {
  it("answers “the average daily units dispatched per ward” with numbers", async () => {
    const store = memoryStore();
    await store.create({ id: "b", pack, title: "Stock" });
    // Superset answers the base: dispatched per ward and day. A day with none has no row.
    const { sent, connector } = stub([
      { __lenspack_bucket: "2026-09-04", ward: "north", dispatched: 10, __lenspack_n: 2 },
      { __lenspack_bucket: "2026-09-10", ward: "north", dispatched: 30, __lenspack_n: 3 },
      { __lenspack_bucket: "2026-09-05", ward: "south", dispatched: 7, __lenspack_n: 1 },
    ]);
    const tools = Object.fromEntries(boardTools({ pack, connector, store, boardId: "b", ctx }).map((t) => [t.name, t])) as Record<string, Tool>;
    const args = { query_kind: "breakdown", dimension: "ward", measure: "dispatched", grain: "day", compute: "mean", time_last: "7d" };
    const out = (await tools.query!.execute(tools.query!.inputSchema.parse(args) as never)) as { ok: boolean; error?: string; rows: { group: string; value: number }[]; computed?: string };
    expect(out.ok, out.error).toBe(true);
    // Seven days, today being 10 September in Lagos; a day with no dispatch counts as 0.
    expect(out.rows.map((r) => [r.group, r.value])).toEqual([
      ["north", 40 / 7],
      ["south", 1],
    ]);
    expect(window(sent[0]!)).toBe("2026-09-04T00:00:00 : 2026-09-11T00:00:00");
  });
});
