import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/spec";
import { describe, expect, it } from "vitest";

import { COMPUTE_ROWS, type Connector, type Row, SQL_CAPABILITIES, bucketsOf, check, checkOps, describeComputed, explain, run, shapeRows } from "../src";

// Steps run on the source's aggregated answer, so a stub that answers the base
// query from canned rows pins every rule: gaps, zeros, windows, grains.

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
    { key: "out_share", entity: "movement", derived: "dispatched / received", format: "percent" },
    { key: "capacity", entity: "site", agg: "sum", field: "capacity" },
  ],
});

// Five days: 1 to 5 September 2026.
const time = { from: "2026-09-01T00:00:00Z", to: "2026-09-06T00:00:00Z" };
const ctx = { now: new Date("2026-09-10T00:00:00Z") };
const day = (n: number) => `2026-09-0${n}`;

function stub(answers: (q: Query) => Row[]): Connector & { seen: { query: Query; base: boolean }[] } {
  const seen: { query: Query; base: boolean }[] = [];
  return {
    kind: "stub",
    capabilities: SQL_CAPABILITIES,
    seen,
    compile: (bound) => ({ text: JSON.stringify(bound.query), native: bound.query, bound }),
    async execute(plan) {
      const q = plan.native as Query;
      seen.push({ query: q, base: !!plan.bound.base });
      return shapeRows(answers(q), q, plan.bound.measure?.def.format ?? "number", plan.bound.measure?.def.key, !!plan.bound.base);
    },
  };
}

// Dispatched per ward and day. North has nothing on the 3rd (no rows at all), south dispatched 0 on the 1st.
const daily: Row[] = [
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

  it("change: against the bucket before; a day with no records is 0 for a sum, the first day has none", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    expect(data.rows.map((r) => r.group)).toEqual([day(1), day(2), day(3), day(4), day(5)]);
    expect(values(data.rows)).toEqual([null, 10, -20, 10, 5]);
    expect(data.format).toBe("number");
    expect(data.label).toBe("day-on-day change in dispatched");
    expect(c.seen[0]).toMatchObject({ query: { kind: "series", grain: "day", measure: "dispatched" }, base: true });
  });

  it("% change: a change from 0 is skipped, never infinite", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "dispatched", grain: "day", time, compute: { steps: [{ op: "change", percent: true }] } }, { pack, connector: c, ctx });
    // 10 → 20 (+100%), 20 → 0 (−100%), 0 → 10 (from 0: skipped), 10 → 15 (+50%).
    expect(values(data.rows)).toEqual([null, 1, -1, null, 0.5]);
    expect(data.format).toBe("percent");
    expect(data.computed).toContain("a change from 0 has no percentage and is skipped");
  });

  it("an average has no value on a day with no records, so the change across that gap is skipped", async () => {
    const c = stub(() => north(daily));
    const data = await run({ kind: "series", measure: "avg_out", grain: "day", time, compute: { steps: [{ op: "change" }] } }, { pack, connector: c, ctx });
    expect(values(data.rows)).toEqual([null, 10, null, null, 5]);
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
    expect(values(data.rows.filter((r) => r.series === "south"))).toEqual([null, 5, 5, 0, -5]);
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

  it("average day-on-day % change per ward: changes from 0 and the first day are skipped", async () => {
    const data = await run(perWard([{ op: "change", percent: true }, { op: "over_time", fn: "mean" }], { sort: "asc" }), { pack, connector: stub(() => daily), ctx });
    // north: +100%, −100%, (from 0), +50% → 50/3 %; south: (from 0), +100%, 0%, −50% → 50/3 %.
    expect(data.rows.map((r) => r.group)).toEqual(["north", "south"]);
    expect(values(data.rows)).toEqual([0.166667, 0.166667]);
    expect(data.format).toBe("percent");
    expect(data.label).toBe("average day-on-day % change in dispatched");
    expect(data.computed).toBe(
      "average day-on-day % change in dispatched: a day with no records counts as 0; the first day has no day before it, so it has no change; a change from 0 has no percentage and is skipped; days without a value are skipped in the average",
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
    expect(data.rows).toEqual([{ group: "dispatched", value: 6, count: 5 }]);
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
