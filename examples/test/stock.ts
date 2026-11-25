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

export const stockPack = parsePack({
  pack: "stock",
  version: 1,
  timeZone: "America/New_York",
  entities: { stock: { source: TABLE, time: { field: "on_day", type: "date" } } },
  dimensions: [{ key: "ward", entity: "stock", field: "ward" }],
  measures: [{ key: "dispatched", entity: "stock", agg: "sum", field: "units" }],
});

/** 22:00 on 9 November in New York; already 10 November in UTC. */
export const stockCtx = { now: new Date("2025-11-10T03:00:00Z") };

export async function seedStock(writer: Writer, dialect: Dialect) {
  await writer.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  await execAll(writer, [`CREATE TABLE ${TABLE} (on_day DATE, ward VARCHAR, units INTEGER)`], dialect);
  await insertRows(writer, TABLE, ["on_day", "ward", "units"], rows().map((r) => [r.on_day, r.ward, r.units]));
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
    label: "the last 7 days against the 7 days before",
    query: { kind: "value", measure: "dispatched", compare: "previous_period", time: { last: "7d" } },
    check: (data) => {
      expect(data.rows[0]!.value).toBe(total("2025-11-03", "2025-11-09"));
      expect(data.compare?.previous).toBe(total("2025-10-27", "2025-11-02"));
    },
  },
];
