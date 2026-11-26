import { type Query } from "@lenspack/core";
import { datedTime, parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { bucketZoneOf, localDate, resolve, timeWindowOf, windowDates, writtenDayStart, zonedSeriesGaps, zonedSeriesWarnings } from "../src";

// A time column of calendar dates: a window is whole days in the pack's zone,
// and the dates are bucketed as they are. New York's clocks went back on
// 2 November 2025, so a day there was 25 hours long.

const pack = parsePack({
  pack: "p",
  version: 1,
  timeZone: "America/New_York",
  entities: {
    stock: { source: "stock", time: { field: "on_day", type: "date" } },
    visits: { source: "visits", time: "at" },
  },
  measures: [
    { key: "dispatched", entity: "stock", agg: "sum", field: "units" },
    { key: "visits", entity: "visits", agg: "count" },
  ],
});
// 22:00 on 9 November in New York, already the 10th in UTC.
const ctx = { now: new Date("2025-11-10T03:00:00Z") };
const dates = (time: Query["time"], measure = "dispatched") => {
  const w = timeWindowOf({ kind: "value", measure, time } as Query, pack, ctx)!;
  return windowDates(w, pack.timeZone);
};

describe("series a source cannot draw in the pack's zone", () => {
  it("are the entities with a time of day, on a source that cuts days in UTC only", () => {
    expect(zonedSeriesGaps(pack, { zonedBuckets: false })).toEqual([{ entity: "visits", column: "at", zone: "America/New_York" }]);
    expect(zonedSeriesGaps(pack, { zonedBuckets: true })).toEqual([]);
    expect(zonedSeriesGaps(pack, {})).toEqual([]);
    expect(zonedSeriesGaps({ ...pack, timeZone: "UTC" }, { zonedBuckets: false })).toEqual([]);
  });

  it("are warned about with the column and what to do", () => {
    expect(zonedSeriesWarnings(pack, { zonedBuckets: false }, (e) => `the ${e} table`)).toEqual([
      'the visits table: its time column "at" has a time of day, and the pack\'s timeZone is America/New_York, which this source cannot cut days in, so every series over it (by hour, day, week or month) is refused. Use a date column for its time, or keep the pack in UTC.',
    ]);
  });
});

describe("a pack's calendar-date time", () => {
  it("is declared with type: date, and only then", () => {
    expect(datedTime(pack.entities.stock)).toBe(true);
    expect(datedTime(pack.entities.visits)).toBe(false);
    expect(bucketZoneOf(pack, pack.entities.stock)).toBeUndefined();
    expect(bucketZoneOf(pack, pack.entities.visits)).toBe("America/New_York");
  });

  it("reads relative windows as whole days ending today in the pack's zone", () => {
    expect(dates({ period: "day" })).toEqual({ from: "2025-11-09", to: "2025-11-10" });
    expect(dates({ last: "7d" })).toEqual({ from: "2025-11-03", to: "2025-11-10" });
    expect(dates({ last: "1d" })).toEqual({ from: "2025-11-09", to: "2025-11-10" });
    expect(dates({ period: "month" })).toEqual({ from: "2025-11-01", to: "2025-11-10" });
    expect(dates({ period: "month", offset: -1 })).toEqual({ from: "2025-10-01", to: "2025-11-01" });
    expect(dates({ period: "week", offset: -1 })).toEqual({ from: "2025-10-27", to: "2025-11-03" });
  });

  it("reads an exact range by the dates written in it", () => {
    // Written in UTC, at local midnight, or partway through a day.
    expect(dates({ from: "2025-11-01T00:00:00Z", to: "2025-11-03T00:00:00Z" })).toEqual({ from: "2025-11-01", to: "2025-11-03" });
    expect(dates({ from: "2025-11-01T00:00:00-04:00", to: "2025-11-03T00:00:00-05:00" })).toEqual({ from: "2025-11-01", to: "2025-11-03" });
    expect(dates({ from: "2025-11-01T09:30:00Z", to: "2025-11-02T23:59:59Z" })).toEqual({ from: "2025-11-02", to: "2025-11-03" });
    expect(localDate(writtenDayStart("2025-11-02T00:00:00.000Z", "America/New_York"), "America/New_York")).toBe("2025-11-02");
  });

  it("reads a range it wrote itself back as the same days", () => {
    const w = timeWindowOf({ kind: "value", measure: "dispatched", time: { last: "7d" } }, pack, ctx)!;
    expect(dates({ from: w.from.toISOString(), to: w.to.toISOString() })).toEqual({ from: "2025-11-03", to: "2025-11-10" });
  });

  it("compares with as many days just before, across the change of clocks", () => {
    const bound = resolve({ kind: "value", measure: "dispatched", compare: "previous_period", time: { last: "7d" } }, pack, ctx);
    expect(windowDates(bound.previous!, pack.timeZone)).toEqual({ from: "2025-10-27", to: "2025-11-03" });
  });

  it("leaves a time with a time of day as it was", () => {
    const w = timeWindowOf({ kind: "value", measure: "visits", time: { last: "7d" } }, pack, ctx)!;
    expect(w).toEqual({ from: new Date("2025-11-03T03:00:00Z"), to: ctx.now });
  });
});
