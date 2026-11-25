import type { Query } from "@lenspack/core";
import type { WidgetData } from "@lenspack/engine";
import { parsePack } from "@lenspack/pack";
import type { Writer } from "@lenspack/sql";
import { expect } from "vitest";

import { type Dialect, execAll, insertRows } from "../_shared/seed-util";

// Made-up stock dispatches kept by calendar date (a DATE column, no time of
// day), in a pack whose days start in New York. A day of dates is the same day
// in any zone, so every source must bucket the dates as they are and compare a
// window with them as dates, "today" being the date in New York. The clock is
// set where New York's date (9 November) is a day behind UTC's (10 November),
// and one range crosses the end of daylight saving time (2 November 2025).

const TABLE = "lenspack_stock";
const FIRST = Date.UTC(2025, 9, 20); // 20 October 2025
const DAYS = 26; // to 14 November, past "today"
const day = (i: number) => new Date(FIRST + i * 86400e3).toISOString().slice(0, 10);

/** One row per ward and day: north every day (i + 1 units), south every other day (10 units). */
const rows = (): { on_day: string; ward: string; units: number }[] =>
  Array.from({ length: DAYS }, (_, i) => [
    { on_day: day(i), ward: "north", units: i + 1 },
    ...(i % 2 === 0 ? [{ on_day: day(i), ward: "south", units: 10 }] : []),
  ]).flat();

// A second table of movements in and out, for the days a computed summary is
// taken over. Dispatches run from 20 to 29 October (north every day but the
// 25th, 10 units; south from the 22nd, 5 units), then two days of 0. The other
// rows are receipts on days with no dispatch (1 October and 5 November), and
// one dispatch dated after "today" (20 November).
const MOVES = "lenspack_moves";
const moves = (): { on_day: string; ward: string; kind: string; units: number }[] => [
  ...Array.from({ length: 10 }, (_, i) => day(i)).flatMap((d, i) => [
    ...(d === "2025-10-25" ? [] : [{ on_day: d, ward: "north", kind: "dispatch", units: 10 }]),
    ...(i >= 2 ? [{ on_day: d, ward: "south", kind: "dispatch", units: 5 }] : []),
  ]),
  { on_day: "2025-10-30", ward: "north", kind: "dispatch", units: 0 },
  { on_day: "2025-10-31", ward: "north", kind: "dispatch", units: 0 },
  { on_day: "2025-10-01", ward: "north", kind: "receipt", units: 50 },
  { on_day: "2025-11-05", ward: "south", kind: "receipt", units: 50 },
  { on_day: "2025-11-20", ward: "north", kind: "dispatch", units: 100 },
];

export const stockPack = parsePack({
  pack: "stock",
  version: 1,
  timeZone: "America/New_York",
  entities: { stock: { source: TABLE, time: { field: "on_day", type: "date" } }, moves: { source: MOVES, time: { field: "on_day", type: "date" } } },
  dimensions: [
    { key: "ward", entity: "stock", field: "ward", also: { moves: { field: "ward" } } },
  ],
  measures: [
    { key: "dispatched", entity: "stock", agg: "sum", field: "units" },
    { key: "moved_out", entity: "moves", agg: "sum", field: "units", where: [{ field: "kind", value: "dispatch" }], label: "Units moved out" },
    { key: "moved_in", entity: "moves", agg: "sum", field: "units", where: [{ field: "kind", value: "receipt" }], label: "Units moved in" },
  ],
});

/** 22:00 on 9 November in New York; already 10 November in UTC. */
export const stockCtx = { now: new Date("2025-11-10T03:00:00Z") };

export async function seedStock(writer: Writer, dialect: Dialect) {
  await writer.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  await execAll(writer, [`CREATE TABLE ${TABLE} (on_day DATE, ward VARCHAR, units INTEGER)`], dialect);
  await insertRows(writer, TABLE, ["on_day", "ward", "units"], rows().map((r) => [r.on_day, r.ward, r.units]));
  await writer.exec(`DROP TABLE IF EXISTS ${MOVES}`);
  await execAll(writer, [`CREATE TABLE ${MOVES} (on_day DATE, ward VARCHAR, kind VARCHAR, units INTEGER)`], dialect);
  await insertRows(writer, MOVES, ["on_day", "ward", "kind", "units"], moves().map((r) => [r.on_day, r.ward, r.kind, r.units]));
}

type Request = (method: string, path: string, body?: unknown) => Promise<any>;

export async function seedStockSearch(request: Request) {
  await request("DELETE", `/${TABLE}`).catch(() => undefined);
  await request("PUT", `/${TABLE}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: { properties: { on_day: { type: "date", format: "yyyy-MM-dd" }, ward: { type: "keyword" }, units: { type: "integer" } } },
  });
  const lines = rows().flatMap((r) => [JSON.stringify({ index: {} }), JSON.stringify(r)]);
  const res = await request("POST", `/${TABLE}/_bulk`, lines.join("\n") + "\n");
  if (res?.errors) throw new Error(`bulk into ${TABLE} reported errors`);
  await request("POST", `/${TABLE}/_refresh`);
  await request("DELETE", `/${MOVES}`).catch(() => undefined);
  await request("PUT", `/${MOVES}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: { properties: { on_day: { type: "date", format: "yyyy-MM-dd" }, ward: { type: "keyword" }, kind: { type: "keyword" }, units: { type: "integer" } } },
  });
  const moved = moves().flatMap((r) => [JSON.stringify({ index: {} }), JSON.stringify(r)]);
  const out = await request("POST", `/${MOVES}/_bulk`, moved.join("\n") + "\n");
  if (out?.errors) throw new Error(`bulk into ${MOVES} reported errors`);
  await request("POST", `/${MOVES}/_refresh`);
}

// The expected numbers, from the rows themselves.
const total = (from: string, to: string, ward?: string) => rows().filter((r) => r.on_day >= from && r.on_day <= to && (!ward || r.ward === ward)).reduce((n, r) => n + r.units, 0);
const daily = (from: string, to: string) => {
  const out: { group: string; value: number }[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400e3) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ group: d, value: total(d, d) });
  }
  return out;
};
const groupsAndValues = (data: WidgetData) => data.rows.map((r) => ({ group: r.group, value: r.value }));
const dailyMean = { grain: "day" as const, steps: [{ op: "over_time" as const, fn: "mean" as const }] };

/** Each query with the answer every source must give. */
export const stockCases: { label: string; query: Query; check(data: WidgetData): void }[] = [
  {
    label: "today is the date in the pack's zone",
    query: { kind: "series", measure: "dispatched", grain: "day", time: { period: "day" } },
    check: (data) => expect(groupsAndValues(data)).toEqual([{ group: "2025-11-09", value: total("2025-11-09", "2025-11-09") }]),
  },
  {
    label: "the last 7 days are today and the 6 days before",
    query: { kind: "series", measure: "dispatched", grain: "day", time: { last: "7d" } },
    check: (data) => expect(groupsAndValues(data)).toEqual(daily("2025-11-03", "2025-11-09")),
  },
  {
    label: "this month so far, by week from Monday",
    query: { kind: "series", measure: "dispatched", grain: "week", time: { period: "month" } },
    check: (data) =>
      expect(groupsAndValues(data)).toEqual([
        { group: "2025-10-27", value: total("2025-11-01", "2025-11-02") },
        { group: "2025-11-03", value: total("2025-11-03", "2025-11-09") },
      ]),
  },
  {
    label: "an exact range written in UTC names the dates it says, across the change of clocks",
    query: { kind: "series", measure: "dispatched", grain: "day", time: { from: "2025-11-01T00:00:00Z", to: "2025-11-03T00:00:00Z" } },
    check: (data) => expect(groupsAndValues(data)).toEqual(daily("2025-11-01", "2025-11-02")),
  },
  {
    label: "every month, with no window",
    query: { kind: "series", measure: "dispatched", grain: "month" },
    check: (data) =>
      expect(groupsAndValues(data)).toEqual([
        { group: "2025-10-01", value: total("2025-10-01", "2025-10-31") },
        { group: "2025-11-01", value: total("2025-11-01", "2025-11-30") },
      ]),
  },
  {
    label: "the average daily units dispatched per ward over the last 7 days, a day with none counting as 0",
    query: { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 10, sort: "desc", time: { last: "7d" }, compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } },
    check: (data) => {
      expect(data.rows.map((r) => r.group)).toEqual(["north", "south"]);
      for (const r of data.rows) expect(r.value).toBeCloseTo(total("2025-11-03", "2025-11-09", r.group) / 7, 9);
    },
  },
  {
    label: "the average daily units moved out: from the first to the last day with a dispatch, not the receipts' days or a day after today",
    query: { kind: "value", measure: "moved_out", compute: dailyMean },
    // 90 + 40 units over the 10 days from 20 to 29 October.
    check: (data) => {
      expect(data.rows[0]!.value).toBeCloseTo(13, 9);
      expect(data.window).toEqual({ from: "2025-10-20", to: "2025-10-29", buckets: 10, grain: "day" });
      expect(data.computed).toContain("averaged over 10 days, 2025-10-20 to 2025-10-29 (the first to the last day with units moved out); days after today are left out");
    },
  },
  {
    label: "per ward, every ward averaged over the same days",
    query: { kind: "breakdown", dimension: "ward", measure: "moved_out", limit: 10, sort: "desc", compute: dailyMean },
    // South starts on the 22nd, and is still averaged over the 10 days: 40 / 10, not 40 / 8.
    check: (data) => expect(groupsAndValues(data)).toEqual([{ group: "north", value: 9 }, { group: "south", value: 4 }]),
  },
  {
    label: "within a time range: the days with a dispatch inside it",
    query: { kind: "value", measure: "moved_out", time: { from: "2025-10-24T00:00:00Z", to: "2025-11-01T00:00:00Z" }, compute: dailyMean },
    // 24 to 29 October: north 50, south 30, over 6 days (the 30th and 31st dispatched 0).
    check: (data) => {
      expect(data.rows[0]!.value).toBeCloseTo(80 / 6, 9);
      expect(data.window).toEqual({ from: "2025-10-24", to: "2025-10-29", buckets: 6, grain: "day" });
    },
  },
  {
    label: "a time range that runs on past today stops at today",
    query: { kind: "value", measure: "moved_out", time: { from: "2025-10-26T00:00:00Z", to: "2025-12-01T00:00:00Z" }, compute: dailyMean },
    // 26 to 29 October: 40 + 20 over 4 days; the dispatch dated 20 November is not counted.
    check: (data) => {
      expect(data.rows[0]!.value).toBeCloseTo(15, 9);
      expect(data.window?.buckets).toBe(4);
    },
  },
  {
    label: "the last 7 days against the 7 days before",
    query: { kind: "value", measure: "dispatched", compare: "previous_period", time: { last: "7d" } },
    check: (data) => {
      expect(data.rows[0]!.value).toBe(total("2025-11-03", "2025-11-09"));
      expect(data.compare?.previous).toBe(total("2025-10-27", "2025-11-02"));
    },
  },
];
