import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { COMPUTE_ROWS, type Connector, type Row, SQL_CAPABILITIES, bucketsOf, check, checkOps, describeComputed, explain, readWindow, run, shapeBound } from "../src";

// Steps run on the source's aggregated answer, so a stub that answers the base
// query from canned rows (those in its window) pins every rule: gaps, zeros,
// windows, grains.

const pack = parsePack({
  pack: "stock",
  version: 1,
  entities: { movement: { source: "movement", time: "at" }, site: { source: "site" } },
  dimensions: [
    { key: "ward", entity: "movement", field: "ward", also: { site: { field: "ward" } } },
    { key: "item", entity: "movement", field: "item" },
  ],
  measures: [
    { key: "dispatched", entity: "movement", agg: "sum", field: "qty_out" },
    { key: "received", entity: "movement", agg: "sum", field: "qty_in" },
    { key: "movements", entity: "movement", agg: "count" },
    { key: "avg_out", entity: "movement", agg: "avg", field: "qty_out" },
    { key: "handlers", entity: "movement", agg: "count_distinct", field: "user" },
    // Handlers with 3 or more movements: one value per key, so a handler busy on two days would count twice.
    { key: "busy_handlers", entity: "movement", agg: "count", per: { key: "user", agg: "count", having: { op: "gte", value: 3 } } },
    { key: "out_share", entity: "movement", derived: "dispatched / received", format: "percent" },
    { key: "capacity", entity: "site", agg: "sum", field: "capacity" },
  ],
});

// Five days: 1 to 5 September 2026.
const time = { from: "2026-09-01T00:00:00Z", to: "2026-09-06T00:00:00Z" };
const ctx = { now: new Date("2026-09-10T00:00:00Z") };
const day = (n: number) => `2026-09-0${n}`;

function stub(answers: (q: Query) => Row[], cut = false): Connector & { seen: { query: Query; base: boolean }[] } {
  const seen: { query: Query; base: boolean }[] = [];
  return {
    kind: "stub",
    capabilities: SQL_CAPABILITIES,
    seen,
    compile: (bound) => ({ text: JSON.stringify(bound.query), native: bound.query, bound }),
    async execute(plan) {
      const q = plan.native as Query;
      seen.push({ query: q, base: !!plan.bound.base });
      const t = "time" in q && q.time && "from" in q.time ? q.time : null;
      const rows = answers(q).filter((r) => !t || !r.bucket || (r.bucket >= t.from.slice(0, 10) && r.bucket < t.to.slice(0, 10)));
      return shapeBound(rows, plan.bound, cut);
    },
  };
}

// Dispatched per ward and day. North has nothing on the 3rd (no rows at all), south dispatched 0 on the 1st.
// The day before the window, 31 August, is read only for a change from it.
const daily: Row[] = [
  { bucket: "2026-08-31", series: "north", value: 4, n: 1 },
  { bucket: day(1), series: "north", value: 10, n: 2 },
  { bucket: day(2), series: "north", value: 20, n: 2 },
  { bucket: day(4), series: "north", value: 10, n: 1 },
  { bucket: day(5), series: "north", value: 15, n: 3 },
  { bucket: day(1), series: "south", value: 0, n: 1 },
  { bucket: day(2), series: "south", value: 5, n: 1 },
  { bucket: day(3), series: "south", value: 10, n: 1 },
  { bucket: day(4), series: "south", value: 10, n: 1 },
  { bucket: day(5), series: "south", value: 5, n: 1 },
];
const values = (rows: { value: number | null }[]) => rows.map((r) => (r.value === null ? null : Math.round(r.value * 1e6) / 1e6));

describe("steps over time on a series", () => {
  const north = (rows: Row[]) => rows.filter((r) => r.series === "north").map(({ series: _s, ...r }) => r);

  it("change: against the bucket before; a day with no records is 0 for a sum", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    expect(data.rows.map((r) => r.group)).toEqual([day(1), day(2), day(3), day(4), day(5)]);
    expect(values(data.rows)).toEqual([6, 10, -20, 10, 5]);
    expect(data.format).toBe("number");
    expect(data.label).toBe("day-on-day change in dispatched");
    expect(c.seen[0]).toMatchObject({ query: { kind: "series", grain: "day", measure: "dispatched" }, base: true });
  });

  it("change: the first bucket changes from the one before the window, as Superset's time comparison reads it", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    // The source is asked for one more day, 31 August; it is read, not shown or counted.
    expect((c.seen[0]!.query as { time: unknown }).time).toEqual({ from: "2026-08-31T00:00:00.000Z", to: "2026-09-06T00:00:00.000Z" });
    expect(data.rows[0]).toEqual({ group: day(1), value: 6, count: 2 });
    expect(data.computed).toContain("the first day changes from the day before it, even when that is before the time range");
    // With no time range there is no bucket before the first, so it has no change.
    const open = await run({ kind: "series", measure: "dispatched", grain: "day", compute: { steps: [{ op: "change" }] } }, { pack, connector: stub(() => north(daily).slice(1)), ctx });
    expect(values(open.rows)).toEqual([null, 10, -20, 10, 5]);
    expect(open.computed).toContain("the first day has no day before it, so it has no change");
  });

  it("one bucket back is one step of the local calendar: a month back from 31 March is 28 February", () => {
    const q = (grain: "day" | "week" | "month" | "quarter") => ({ kind: "series", measure: "dispatched", grain, compute: { steps: [{ op: "change" }] } }) as Extract<Query, { kind: "series" }>;
    const from = (grain: "day" | "week" | "month" | "quarter", at: string, zone?: string) => readWindow(q(grain), { from: new Date(at), to: new Date("2026-04-01T00:00:00Z") }, zone)!.from.toISOString();
    expect(from("month", "2026-03-31T00:00:00Z")).toBe("2026-02-28T00:00:00.000Z");
    expect(from("quarter", "2026-03-15T06:30:00Z")).toBe("2025-12-15T06:30:00.000Z");
    expect(from("week", "2026-03-02T00:00:00Z")).toBe("2026-02-23T00:00:00.000Z");
    // Midnight in Nairobi (UTC+3) is 21:00 UTC the day before.
    expect(from("day", "2026-02-28T21:00:00Z", "Africa/Nairobi")).toBe("2026-02-27T21:00:00.000Z");
    // A step that does not change from the bucket before reads the window as it is.
    expect(readWindow({ ...q("day"), compute: { steps: [{ op: "running_total" }] } }, { from: new Date(), to: new Date() })).toBeNull();
  });

  it("% change: a change from 0 is skipped, never infinite", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "change", percent: true }] } }, { pack, connector: c, ctx });
    // 4 → 10 (+150%), 10 → 20 (+100%), 20 → 0 (−100%), 0 → 10 (from 0: skipped), 10 → 15 (+50%).
    expect(values(data.rows)).toEqual([1.5, 1, -1, null, 0.5]);
    expect(data.format).toBe("percent");
    expect(data.computed).toContain("a change from 0 has no percentage and is skipped");
  });

  it("an average has no value on a day with no records, so the change across that gap is skipped", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "avg_out", grain: "day", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    expect(values(data.rows)).toEqual([6, 10, null, null, 5]);
    expect(data.computed).toContain("a day with no records has no value and is skipped");
  });

  it("rolling: the first window-1 buckets are left out; a sum's empty day counts as 0", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "rolling", fn: "mean", window: 3 }] } }, { pack, connector: c, ctx });
    expect(data.rows.map((r) => r.group)).toEqual([day(3), day(4), day(5)]);
    expect(values(data.rows)).toEqual([10, 10, 8.333333]);
    const sum = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "rolling", fn: "sum", window: 2 }] } }, { pack, connector: c, ctx });
    expect(values(sum.rows)).toEqual([30, 20, 10, 25]);
  });

  it("rolling over an average: a window with a day missing has no value", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "avg_out", grain: "day", time, compute: { steps: [{ op: "rolling", fn: "mean", window: 2 }] } }, { pack, connector: c, ctx });
    expect(values(data.rows)).toEqual([15, null, null, 12.5]);
  });

  it("rolling refuses a window longer than the buckets there are", async () => {
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "rolling", fn: "mean", window: 7 }] } }, { pack, connector: stub(() => north(daily)), ctx });
    expect(data.error).toMatch(/needs at least 7 days, and this window has 5/);
  });

  it("running total: from the first day shown", async () => {
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "running_total" }] } }, { pack, connector: stub(() => north(daily)), ctx });
    expect(values(data.rows)).toEqual([10, 30, 30, 40, 55]);
  });

  it("split by a dimension: every series is computed on its own, the top ones kept", async () => {
    const c = stub(() => daily);
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", by: "ward", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    // South has no row on 31 August: 0 for a sum, so its first change is 0 - 0.
    expect(values(data.rows.filter((r) => r.series === "south"))).toEqual([0, 5, 5, 0, -5]);
    expect(c.seen[0]!.base).toBe(true);
  });

  it("buckets span the window, in the pack's time zone, weeks from Monday", () => {
    expect(bucketsOf([], "week", { from: new Date("2026-09-02T10:00:00Z"), to: new Date("2026-09-20T00:00:00Z") })).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    // 21:30 UTC on the 1st is already the 2nd in Nairobi (UTC+3).
    expect(bucketsOf([], "day", { from: new Date("2026-09-01T21:30:00Z"), to: new Date("2026-09-03T21:00:00Z") }, "Africa/Nairobi")).toEqual(["2026-09-02", "2026-09-03"]);
    expect(bucketsOf(["2026-01-01", "2026-03-01"], "month", null)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
});

describe("a summary of the buckets per group", () => {
  const perWard = (steps: NonNullable<Extract<Query, { kind: "breakdown" }>["compute"]>["steps"], extra: Partial<Extract<Query, { kind: "breakdown" }>> = {}): Query =>
    ({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time, compute: { grain: "day", steps }, ...extra }) as Query;

  it("average daily dispatched per ward: a ward's day with no records counts as 0", async () => {
    const c = stub(() => daily);
    const data = await run(perWard([{ op: "over_time", fn: "mean" }]), { pack, connector: c, ctx });
    // north: (10 + 20 + 0 + 10 + 15) / 5; south: (0 + 5 + 10 + 10 + 5) / 5.
    expect(data.rows).toEqual([
      { group: "north", value: 11, count: 8 },
      { group: "south", value: 6, count: 5 },
    ]);
    expect(data.label).toBe("average daily dispatched");
    // The source was asked for the measure per ward and day, every ward.
    expect(c.seen[0]).toMatchObject({ query: { kind: "series", by: "ward", grain: "day" }, base: true });
  });

  it("average day-on-day % change per ward: changes from 0 are skipped, the first day changes from the day before", async () => {
    const data = await run(perWard([{ op: "change", percent: true }, { op: "over_time", fn: "mean" }], { sort: "asc" }), { pack, connector: stub(() => daily), ctx });
    // north: +150%, +100%, −100%, (from 0), +50% → 50 %; south: (from 0), (from 0), +100%, 0%, −50% → 50/3 %.
    expect(data.rows.map((r) => r.group)).toEqual(["south", "north"]);
    expect(values(data.rows)).toEqual([0.166667, 0.5]);
    // The day read before the window is not counted.
    expect(data.rows.map((r) => r.count)).toEqual([5, 8]);
    expect(data.format).toBe("percent");
    expect(data.label).toBe("average day-on-day % change in dispatched");
    expect(data.computed).toBe(
      "average day-on-day % change in dispatched: a day with no records counts as 0; the first day changes from the day before it, even when that is before the time range; a change from 0 has no percentage and is skipped; days without a value are skipped in the average; averaged over 5 days, 2026-09-01 to 2026-09-05 (the first to the last day with dispatched in the time range)",
    );
  });

  it("min, max, median, last and sum, sorted and cut like any breakdown", async () => {
    const c = stub(() => daily);
    const of = async (fn: "min" | "max" | "median" | "last" | "sum") => (await run(perWard([{ op: "over_time", fn }], { limit: 1 }), { pack, connector: c, ctx })).rows;
    expect(await of("max")).toEqual([{ group: "north", value: 20, count: 8 }]);
    expect(await of("min")).toEqual([{ group: "north", value: 0, count: 8 }]);
    expect(await of("median")).toEqual([{ group: "north", value: 10, count: 8 }]);
    expect(await of("last")).toEqual([{ group: "north", value: 15, count: 8 }]);
    expect(await of("sum")).toEqual([{ group: "north", value: 55, count: 8 }]);
  });

  it("one number for everything: a value", async () => {
    const c = stub(() => daily.filter((r) => r.series === "south").map(({ series: _s, ...r }) => r));
    const data = await run({ kind: "value", measure: "dispatched", time, compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } }, { pack, connector: c, ctx });
    // South dispatched 0 on the 1st, so its days run from the 2nd: (5 + 10 + 10 + 5) / 4.
    expect(data.rows).toEqual([{ group: "dispatched", value: 7.5, count: 4 }]);
    expect(data.window).toEqual({ from: day(2), to: day(5), buckets: 4, grain: "day" });
  });
});

describe("the days a summary is taken over", () => {
  // North's dispatches, 1 to 5 September: (10 + 20 + 0 + 10 + 15) / 5 = 11 a day.
  const north = daily.filter((r) => r.series === "north" && r.bucket !== "2026-08-31").map(({ series: _s, ...r }) => r);
  const mean = (extra: Partial<Extract<Query, { kind: "value" }>> = {}): Query => ({ kind: "value", measure: "dispatched", compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] }, ...extra });
  const later = { now: new Date("2027-01-01T00:00:00Z") };

  it("rows of another measure on other days do not stretch the days: they run from the first to the last day with the measure", async () => {
    // The dataset has rows months later (receipts, say): the source answers those days with no dispatch at all.
    const stray: Row[] = [
      { bucket: "2026-10-15", value: null, n: 3 },
      { bucket: "2026-12-20", value: 0, n: 2 },
    ];
    const data = await run(mean(), { pack, connector: stub(() => [...north, ...stray]), ctx: later });
    expect(data.rows).toEqual([{ group: "dispatched", value: 11, count: 8 }]);
    expect(data.window).toEqual({ from: day(1), to: day(5), buckets: 5, grain: "day" });
    expect(data.computed).toBe("average daily dispatched: a day with no records counts as 0; averaged over 5 days, 2026-09-01 to 2026-09-05 (the first to the last day with dispatched)");
  });

  it("days of 0 at the end are not counted; a day of 0 between two with the measure is", async () => {
    const zeros: Row[] = [6, 7, 8].map((n) => ({ bucket: day(n), value: 0, n: 1 }));
    const data = await run(mean(), { pack, connector: stub(() => [...north, ...zeros]), ctx: later });
    expect(data.rows[0]!.value).toBe(11);
    expect(data.window?.buckets).toBe(5);
  });

  it("with a time range: the measure's own days inside it; the range alone when none of its days has the measure", async () => {
    // The 2nd to the 4th: (20 + 0 + 10) / 3.
    const inside = await run(mean({ time: { from: "2026-09-02T00:00:00Z", to: "2026-09-05T00:00:00Z" } }), { pack, connector: stub(() => north), ctx });
    expect(inside.rows[0]!.value).toBe(10);
    expect(inside.window).toEqual({ from: day(2), to: day(4), buckets: 3, grain: "day" });
    // A range that starts weeks before the first dispatch: the days still start at the first dispatch.
    const wide = await run(mean({ time: { from: "2026-08-01T00:00:00Z", to: "2026-09-06T00:00:00Z" } }), { pack, connector: stub(() => north), ctx });
    expect(wide.rows[0]!.value).toBe(11);
    expect(wide.computed).toContain("averaged over 5 days, 2026-09-01 to 2026-09-05 (the first to the last day with dispatched in the time range)");
    // Nothing dispatched in the range: every day of it counts, as 0.
    const none = await run(mean({ time: { from: "2026-08-20T00:00:00Z", to: "2026-08-25T00:00:00Z" } }), { pack, connector: stub(() => north), ctx });
    expect(none.rows[0]!.value).toBe(0);
    expect(none.computed).toContain("averaged over 5 days, 2026-08-20 to 2026-08-24 (the time range; no day in it has dispatched)");
  });

  it("never goes past today: a row dated later is left out, and the words say so", async () => {
    // Midday on the 4th: the 5th has not happened yet. (10 + 20 + 0 + 10) / 4.
    const midweek = { now: new Date("2026-09-04T12:00:00Z") };
    const open = await run(mean(), { pack, connector: stub(() => north), ctx: midweek });
    expect(open.rows).toEqual([{ group: "dispatched", value: 10, count: 5 }]);
    expect(open.window).toEqual({ from: day(1), to: day(4), buckets: 4, grain: "day" });
    expect(open.computed).toContain("averaged over 4 days, 2026-09-01 to 2026-09-04 (the first to the last day with dispatched); days after today are left out");
    // The same with a time range that runs on past today.
    const ranged = await run(mean({ time: { from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" } }), { pack, connector: stub(() => north), ctx: midweek });
    expect(ranged.rows[0]!.value).toBe(10);
    // A series over that range stops at today too, rather than drawing the rest of the month as 0.
    const series = await run({ kind: "series", measure: "dispatched", grain: "day", time: { from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" }, compute: { steps: [{ op: "running_total" }] } }, { pack, connector: stub(() => north), ctx: midweek });
    expect(series.rows.map((r) => [r.group, r.value])).toEqual([[day(1), 10], [day(2), 30], [day(3), 30], [day(4), 40]]);
    expect(series.computed).toContain("over 4 days, 2026-09-01 to 2026-09-04 (the time range up to today)");
  });

  it("every group is averaged over the same days, the whole answer's first to last", async () => {
    // South dispatches from the 3rd only: (10 + 10 + 5) / 5 over north's days too, not / 3.
    const south: Row[] = [3, 4, 5].map((n, i) => ({ bucket: day(n), series: "south", value: [10, 10, 5][i]!, n: 1 }));
    const data = await run(
      { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } },
      { pack, connector: stub(() => [...north.map((r) => ({ ...r, series: "north" })), ...south]), ctx: later },
    );
    expect(data.rows.map((r) => [r.group, r.value])).toEqual([["north", 11], ["south", 5]]);
    expect(data.window?.buckets).toBe(5);
  });

  it("a series with no time range runs over the measure's own days too", async () => {
    const stray: Row[] = [{ bucket: "2026-11-01", value: null, n: 4 }];
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", compute: { steps: [{ op: "running_total" }] } }, { pack, connector: stub(() => [...north, ...stray]), ctx: later });
    expect(data.rows.map((r) => r.group)).toEqual([day(1), day(2), day(3), day(4), day(5)]);
  });
});

describe("ratios after aggregation", () => {
  it("per group: a zero or missing divisor is skipped, and groups rank by the ratio", async () => {
    const c = stub((q) =>
      q.kind === "breakdown" && q.measure === "dispatched"
        ? [{ group: "north", value: 30, n: 3 }, { group: "south", value: 10, n: 1 }, { group: "east", value: 4, n: 1 }]
        : [{ group: "north", value: 60, n: 3 }, { group: "south", value: 0, n: 1 }, { group: "east", value: 2, n: 1 }],
    );
    const data = await run({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", compute: { steps: [{ op: "ratio", to: "received", percent: true }] } }, { pack, connector: c, ctx });
    expect(data.rows).toEqual([
      { group: "east", value: 2, count: 1 },
      { group: "north", value: 0.5, count: 3 },
      { group: "south", value: null, count: 1 },
    ]);
    expect(data.format).toBe("percent");
    expect(data.label).toBe("dispatched as a share of received");
  });

  it("per day, then the average per ward: the mean of the daily ratios", async () => {
    const c = stub(() => daily.map((r) => ({ ...r })));
    const data = await run(
      { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time, compute: { grain: "day", steps: [{ op: "ratio", to: "movements" }, { op: "over_time", fn: "mean" }] } },
      { pack, connector: c, ctx },
    );
    // Both measures answer from the same rows here, so every daily ratio with a non-zero divisor is 1.
    expect(values(data.rows)).toEqual([1, 1]);
    expect(c.seen.map((s) => (s.query as { measure?: string }).measure).sort()).toEqual(["dispatched", "movements"]);
  });

  // Received on three days, dispatched on two of them: the third day dispatched nothing, a ratio of 0.
  const receivedOnly: Row[] = [1, 2, 3].map((n) => ({ bucket: day(n), series: "north", value: 10, n: 1 }));
  const dispatchedOnTwo: Row[] = [1, 2].map((n) => ({ bucket: day(n), series: "north", value: 10, n: 1 }));
  const flat = (rows: Row[]) => rows.map(({ series: _s, ...r }) => r);

  it("per group: a group with a divisor and no rows for the numerator is 0, not missing", async () => {
    const c = stub((q) => ((q as { measure?: string }).measure === "dispatched" ? [{ group: "north", value: 30, n: 3 }] : [{ group: "north", value: 60, n: 3 }, { group: "south", value: 50, n: 2 }]));
    const data = await run({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", compute: { steps: [{ op: "ratio", to: "received", percent: true }] } }, { pack, connector: c, ctx });
    expect(data.rows).toEqual([
      { group: "north", value: 0.5, count: 3 },
      { group: "south", value: 0, count: 0 },
    ]);
  });

  it("per day, then the average per ward: a day with receipts and no dispatches counts as 0", async () => {
    const c = stub((q) => ((q as { measure?: string }).measure === "dispatched" ? dispatchedOnTwo : receivedOnly));
    const data = await run(
      { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 12, sort: "desc", time, compute: { grain: "day", steps: [{ op: "ratio", to: "received" }, { op: "over_time", fn: "mean" }] } },
      { pack, connector: c, ctx },
    );
    // (1 + 1 + 0) / 3: the days with nothing received (the 4th and 5th) have no ratio and are skipped.
    expect(values(data.rows)).toEqual([0.666667]);
  });

  it("per day on a series: a day where only the divisor has rows is 0", async () => {
    const c = stub((q) => flat((q as { measure?: string }).measure === "received" ? receivedOnly : dispatchedOnTwo));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "ratio", to: "received" }] } }, { pack, connector: c, ctx });
    expect(data.rows.map((r) => [r.group, r.value])).toEqual([[day(1), 1], [day(2), 1], [day(3), 0]]);
    // An average with no rows has no value, so its ratio is skipped rather than 0.
    const avg = await run({ kind: "series", measure: "avg_out", grain: "day", time, compute: { steps: [{ op: "ratio", to: "received" }] } }, { pack, connector: c, ctx });
    expect(values(avg.rows)).toEqual([1, 1, null]);
  });

  it("a divisor on an entity without time is one number per series", async () => {
    const c = stub((q) => ((q as { measure?: string }).measure === "capacity" ? [{ group: "north", value: 100, n: 1 }, { group: "south", value: 50, n: 1 }] : daily));
    const data = await run(
      { kind: "series", measure: "dispatched", grain: "day", by: "ward", time, compute: { steps: [{ op: "ratio", to: "capacity" }] } },
      { pack, connector: c, ctx },
    );
    expect(values(data.rows.filter((r) => r.series === "south"))).toEqual([0, 0.1, 0.2, 0.2, 0.1]);
  });
});

describe("refusals, with what would work", () => {
  const refused = (q: Query) => {
    try {
      check(q, pack);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const series = (steps: unknown[], measure = "dispatched"): Query => ({ kind: "series", measure, grain: "day", compute: { steps } }) as Query;

  it("never adds up a distinct count, a percentage, an average or a ratio", () => {
    expect(refused(series([{ op: "running_total" }], "handlers"))).toMatch(/distinct count: one key seen on two days would count twice.*Use last/);
    expect(refused(series([{ op: "rolling", fn: "sum", window: 7 }], "out_share"))).toMatch(/is a percentage, and a percentage is never added up. Use mean/);
    expect(refused(series([{ op: "running_total" }], "avg_out"))).toMatch(/average.*does not add up over time/);
    expect(refused(series([{ op: "change", percent: true }, { op: "running_total" }]))).toMatch(/A percentage change is never added up/);
    expect(refused({ kind: "value", measure: "dispatched", compute: { grain: "day", steps: [{ op: "ratio", to: "received" }, { op: "over_time", fn: "sum" }] } })).toMatch(/A ratio is never added up/);
    expect(refused(series([{ op: "running_total" }]))).toBeNull();
    // A per-key count ("handlers with 3+ movements") counts each key once, like a distinct count.
    expect(refused(series([{ op: "running_total" }], "busy_handlers"))).toMatch(/distinct count: one key seen on two days would count twice/);
    expect(refused({ kind: "value", measure: "busy_handlers", compute: { grain: "day", steps: [{ op: "over_time", fn: "sum" }] } })).toMatch(/would count twice/);
    expect(refused(series([{ op: "rolling", fn: "mean", window: 7 }], "handlers"))).toBeNull();
  });

  it("says where each step goes and what the grain is", () => {
    expect(refused(series([{ op: "over_time", fn: "mean" }]))).toMatch(/A series keeps its time buckets.*ask a breakdown/);
    expect(refused({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", compute: { steps: [{ op: "over_time", fn: "mean" }] } })).toMatch(/need a grain/);
    expect(refused({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", compute: { grain: "day", steps: [{ op: "change" }] } })).toMatch(/end with a summary of the buckets/);
    expect(refused(series([{ op: "change" }, { op: "ratio", to: "received" }]))).toMatch(/A ratio comes first/);
    expect(refused({ kind: "value", measure: "dispatched", compare: "previous_period", time: { last: "30d" }, compute: { steps: [{ op: "ratio", to: "received" }] } })).toMatch(/no previous-period comparison/);
    expect(refused({ kind: "series", measure: "dispatched", grain: "week", compute: { grain: "day", steps: [{ op: "change" }] } })).toMatch(/grain "week", not "day"/);
  });

  it("refuses an answer the source would have to cut, rather than computing from part of it", async () => {
    const many: Row[] = Array.from({ length: COMPUTE_ROWS + 1 }, (_, i) => ({ bucket: day(1 + (i % 5)), series: `w${Math.floor(i / 5)}`, value: 1, n: 1 }));
    const data = await run({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", time, compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } }, { pack, connector: stub(() => many), ctx });
    expect(data.error).toMatch(/needs the measure for every ward and day: more than 20,000 numbers.*week instead of day/);
  });

  it("refuses a base the source says it cut, however few rows came back", async () => {
    const q: Query = { kind: "series", measure: "dispatched", grain: "day", by: "ward", time, compute: { steps: [{ op: "running_total" }] } };
    const data = await run(q, { pack, connector: stub(() => daily, true), ctx });
    expect(data.error).toMatch(/more than 20,000 numbers from the source/);
    // A ratio alone, per group, is refused the same way.
    const ratio = await run({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", compute: { steps: [{ op: "ratio", to: "received" }] } }, { pack, connector: stub(() => [{ group: "north", value: 1, n: 1 }], true), ctx });
    expect(ratio.error).toMatch(/more than 20,000 numbers from the source/);
  });

  it("a cut answer stays marked as cut through further measures", async () => {
    const data = await run({ kind: "breakdown", dimension: "ward", measure: "dispatched", measures: ["received"], limit: 5, sort: "desc" }, { pack, connector: stub(() => [{ group: "north", value: 1, n: 1 }], true), ctx });
    expect(data.truncated).toBe(true);
    expect(data.notes).toEqual(["groups are ranked on part of the data; the source stops at its row limit for this breakdown"]);
  });

  it("refuses at edit time what the host cannot keep as its own chart", () => {
    const widget = { kind: "chart", chart: "bar", title: "t", query: series([{ op: "change" }]), options: { legend: true, colorScheme: "default" } } as const;
    const caps = { ...SQL_CAPABILITIES, savedCompute: () => "not here" };
    expect(checkOps([{ op: "add_widget", id: "w", widget, placement: { place: "bottom", width: "half" } }], pack, { capabilities: caps })).toMatchObject({ ok: false, error: "not here" });
    expect(checkOps([{ op: "add_widget", id: "w", widget, placement: { place: "bottom", width: "half" } }], pack, {})).toEqual({ ok: true });
  });
});

describe("in words", () => {
  it("explains what is computed and what the source answers", async () => {
    const e = await explain({ kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", compute: { grain: "week", steps: [{ op: "rolling", fn: "mean", window: 4 }, { op: "over_time", fn: "max" }] } }, { pack, connector: stub(() => []) });
    expect(e.text).toMatch(/^-- computed after the source answers: highest 4-week rolling average of dispatched: a week with no records counts as 0; the first 3 weeks are left out/);
    expect(e.text).toContain('"kind":"series"');
  });

  it("names a chain the way a person would say it", () => {
    const q = (steps: unknown[], grain = "day"): Extract<Query, { kind: "value" }> => ({ kind: "value", measure: "dispatched", compute: { grain, steps } }) as never;
    expect(describeComputed(q([{ op: "over_time", fn: "sum" }]), pack).label).toBe("dispatched, added up over the days");
    expect(describeComputed(q([{ op: "change" }, { op: "over_time", fn: "last" }], "week"), pack).label).toBe("latest week-on-week change in dispatched");
    expect(describeComputed(q([{ op: "ratio", to: "movements" }, { op: "over_time", fn: "mean" }]), pack).label).toBe("average daily dispatched per movements");
  });
});
