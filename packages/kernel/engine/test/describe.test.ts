import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { type Connector, type Plan, SQL_CAPABILITIES, type SourceCall, computeWords, dateSpan, describeQuery, measureDefinition, tracedConnector } from "../src";

// "How this was worked out": a query in plain words, built from the query and the pack alone. Each
// kind of query and each compute step is pinned here, with the dates a relative window covered, the
// time zone when it is not UTC, and every cut-off.

const base = {
  pack: "stock",
  version: 1,
  entities: { movement: { source: "movement", time: "at", grain: "one row per movement" }, site: { source: "site", geo: { lat: "lat", lon: "lon" } } },
  dimensions: [
    { key: "ward", entity: "movement", field: "ward", label: "Ward" },
    { key: "item", entity: "movement", field: "item", label: "Item" },
    { key: "qty", entity: "movement", field: "qty", type: "number" as const, label: "Quantity" },
    { key: "moved", entity: "movement", field: "at", type: "time" as const, label: "Moved at" },
    { key: "band", entity: "site", field: "band", label: "Band" },
  ],
  measures: [
    { key: "dispatched", entity: "movement", agg: "sum" as const, field: "qty_out", label: "Units dispatched" },
    { key: "received", entity: "movement", agg: "sum" as const, field: "qty_in", label: "Units received" },
    { key: "movements", entity: "movement", agg: "count" as const, label: "Movements" },
    { key: "avg_out", entity: "movement", agg: "avg" as const, field: "qty_out", label: "Average units out" },
    { key: "out_share", entity: "movement", derived: "dispatched / received", format: "percent" as const, label: "Share dispatched" },
    { key: "broken", entity: "movement", agg: "count" as const, filter: "state = 'broken'", where: [{ field: "kind", op: "in" as const, value: ["a", "b"] }], label: "Broken" },
    { key: "busy", entity: "movement", agg: "count" as const, per: { key: "user", agg: "count" as const, having: { op: "gte" as const, value: 3 } }, label: "Busy handlers" },
    { key: "scaled", entity: "movement", agg: "sum" as const, field: "packs", scale: 10, label: "Units in packs" },
    { key: "guess", entity: "movement", agg: "sum" as const, field: "guess", label: "A guess", verified: false },
    { key: "sites", entity: "site", agg: "count" as const, label: "Sites" },
  ],
};
const pack = parsePack(base);
const zoned = parsePack({ ...base, timeZone: "Africa/Nairobi" });
const now = new Date("2026-09-10T09:00:00Z");
const words = (q: unknown, o: Parameters<typeof describeQuery>[2] = {}) => describeQuery(q as Query, pack, { now, definitions: true, ...o });

describe("a query in plain words", () => {
  it("a value: the approved measure, its definition and the dates a relative window covered", () => {
    expect(words({ kind: "value", measure: "dispatched", time: { last: "30d" } })).toBe(
      "Units dispatched (sum of qty_out, the pack's approved measure “dispatched”), in the last 30 days (11 August to 10 September 2026).",
    );
    expect(words({ kind: "value", measure: "out_share", compare: "previous_period", time: { period: "month", offset: -1 } })).toBe(
      "Share dispatched (dispatched / received, the pack's approved measure “out_share”), last month (1 to 31 August 2026), beside its value in the period just before.",
    );
  });

  it("a breakdown: filters, an exact range, the grouping and the cut-off", () => {
    const q = { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", filters: [{ dimension: "item", op: "eq", value: "nets" }], time: { from: "2025-09-01T00:00:00Z", to: "2025-09-08T00:00:00Z" } };
    expect(words(q)).toBe("Units dispatched (sum of qty_out, the pack's approved measure “dispatched”), for Item = nets, from 1 to 7 September 2025, grouped by ward, top 5 by value.");
    expect(words({ ...q, sort: "asc", filters: [{ dimension: "item", op: "in", value: ["a", "b", "c"] }], time: undefined })).toContain("for Item is one of a, b or c, over all dates, grouped by ward, bottom 5 by value");
    expect(words({ ...q, sortBy: "group", sort: "asc", time: undefined, filters: undefined })).toContain("first 5 by ward, A to Z");
    expect(words({ ...q, by: "item", share: true, other: true, compare: "previous_period", time: undefined, filters: undefined })).toContain(
      `grouped by ward, split by Item, top 5 by value, with each group's share of the whole, the rest added up as one "(other)" row, each group beside its value in the period just before`,
    );
  });

  it("every filter operator in words", () => {
    const f = (op: string, value: unknown) => words({ kind: "value", measure: "movements", filters: [{ dimension: op === "gte" || op === "lte" || op === "between" ? "qty" : "ward", op, value }] });
    expect(f("neq", "North")).toContain("for Ward is not North");
    expect(f("neq", ["North", "South"])).toContain("for Ward is none of North or South");
    expect(f("gte", 5)).toContain("for Quantity ≥ 5");
    expect(f("lte", 5)).toContain("for Quantity ≤ 5");
    expect(f("between", [2, 9])).toContain("for Quantity between 2 and 9");
    expect(f("contains", "nor")).toContain("for Ward contains nor");
    expect(f("subtree", "a.b")).toContain("for Ward is a.b or anything under it");
    expect(f("segment", "B")).toContain("for Ward includes B");
  });

  it("a series: its grain, its split and calendar periods", () => {
    expect(words({ kind: "series", measure: "movements", grain: "week", by: "ward", time: { period: "month", offset: -1, count: 3 } })).toBe(
      "Movements (count of rows in movement (one row per movement), the pack's approved measure “movements”), the 3 whole months before this one (1 June to 31 August 2026), per week, one line per ward (the top 12 by total).",
    );
    expect(words({ kind: "series", measure: "movements", grain: "day", time: { period: "month" } })).toContain("this month so far (1 to 10 September 2026), per day");
    expect(words({ kind: "series", measure: "movements", grain: "day", time: { period: "week", count: 2 } })).toContain("the last 2 weeks, this one so far included (31 August to 10 September 2026)");
    expect(words({ kind: "series", measure: "movements", grain: "hour", time: { last: "48h" } })).toContain("in the last 48 hours (8 to 10 September 2026)");
  });

  it("rows: the columns, the order and the row limit", () => {
    expect(words({ kind: "rows", entity: "movement", columns: ["ward", "item"], limit: 500, orderBy: { key: "qty", dir: "desc" } })).toBe(
      "Records of movement (one row per movement), showing Ward and Item, first 500 rows, ordered by Quantity, highest first.",
    );
    expect(words({ kind: "rows", entity: "movement", columns: ["ward"], limit: 25, offset: 50, orderBy: { key: "moved", dir: "asc" }, time: { last: "7d" } })).toContain(
      "in the last 7 days (3 to 10 September 2026), first 25 rows after skipping 50, ordered by Moved at, oldest first",
    );
  });

  it("points: what colours and sizes them, and how many are kept", () => {
    expect(words({ kind: "points", entity: "site", color: "band", size: "sites", limit: 1000 })).toBe(
      "Locations of site, one point per location, coloured by Band and sized by Sites (count of rows in site, the pack's approved measure “sites”), at most 1000 points, the largest kept; records without coordinates are left out.",
    );
  });

  it("further measures are named with their definitions", () => {
    expect(words({ kind: "breakdown", dimension: "ward", measure: "dispatched", measures: ["received"], limit: 12, sort: "desc" })).toContain(
      "Units dispatched (sum of qty_out, the pack's approved measure “dispatched”), beside Units received (sum of qty_in, the pack's approved measure “received”)",
    );
  });

  it("names the time zone only when it is not UTC", () => {
    const q = { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", time: { period: "day" } } as Query;
    expect(describeQuery(q, zoned, { now })).toContain("this day so far (10 September 2026), grouped by ward, top 5 by value, with days in Africa/Nairobi time.");
    expect(describeQuery(q, pack, { now })).not.toMatch(/ time\.$|UTC/);
    // A query with no dates and no buckets has no days to place.
    expect(describeQuery({ kind: "value", measure: "dispatched" }, zoned, { now })).not.toContain("Nairobi");
  });

  it("without definitions (a caller not shown the statement) it still names the approved measure", () => {
    expect(words({ kind: "value", measure: "dispatched" }, { definitions: false })).toBe("Units dispatched (the pack's approved measure “dispatched”), over all dates.");
    expect(words({ kind: "value", measure: "guess" })).toContain("A guess (sum of guess, “guess”, a proposed measure not yet approved)");
  });

  it("a measure's definition says what it counts, and only where", () => {
    const def = (key: string) => measureDefinition(pack, pack.measures.find((m) => m.key === key)!);
    expect(def("broken")).toBe("count of rows in movement (one row per movement), only where state = 'broken' and kind in (a, b)");
    expect(def("busy")).toBe("count, over each user, of its records, counting a user only when that is ≥ 3");
    expect(def("scaled")).toBe("sum of packs, times 10");
    expect(def("avg_out")).toBe("average of qty_out");
  });

  it("is the same every time", () => {
    const q = { kind: "series", measure: "dispatched", grain: "day", time: { last: "30d" }, compute: { steps: [{ op: "rolling", fn: "mean", window: 7 }] } };
    expect(words(q)).toBe(words(q));
  });

  it("says what the source left out, cut or estimated", () => {
    expect(words({ kind: "value", measure: "dispatched" }, { data: { notes: ["top 12 of 30 series by total"], truncated: true, approximate: true } })).toContain(
      "Note: top 12 of 30 series by total; the source stopped at its row limit, so some rows are missing; some numbers are the source's estimates.",
    );
  });
});

describe("each compute step in words", () => {
  const window = { from: "2026-05-28", to: "2026-09-26", buckets: 122, grain: "day" as const };
  const steps = (q: unknown, data?: unknown) => computeWords(q as never, pack, { definitions: true, data: data as never });

  it("an average per day over the window, with days of nothing counted as 0", () => {
    const q = { kind: "breakdown", dimension: "ward", measure: "dispatched", limit: 5, sort: "desc", compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } };
    expect(steps(q, { window })).toEqual(["Then averaged per day over 122 days (28 May to 26 September 2026), with days that had no units dispatched counted as 0."]);
    expect(words(q, { data: { window } })).toMatch(/top 5 by value\. Then averaged per day over 122 days/);
  });

  it("an average of a level skips empty buckets instead", () => {
    const q = { kind: "value", measure: "avg_out", compute: { grain: "week", steps: [{ op: "over_time", fn: "median" }] } };
    expect(steps(q)).toEqual(["Then taking the median per week, with weeks with no records skipped, as they have no value."]);
  });

  it("a ratio, a change, a rolling window and a running total", () => {
    expect(steps({ kind: "breakdown", dimension: "ward", measure: "dispatched", compute: { steps: [{ op: "ratio", to: "received", percent: true }] } })).toEqual([
      "Then divided by Units received (sum of qty_in, the pack's approved measure “received”) for each group, as a percentage; where units received is 0 or missing there is no ratio.",
    ]);
    expect(steps({ kind: "series", measure: "dispatched", grain: "day", compute: { steps: [{ op: "change", percent: true }, { op: "rolling", fn: "mean", window: 7 }] } })).toEqual([
      "Then the percentage change from each day to the next; a change from 0 has no percentage.",
      "After that, a rolling 7-day average; the first 6 days have no full window and are left out.",
    ]);
    expect(steps({ kind: "series", measure: "dispatched", grain: "week", compute: { steps: [{ op: "change" }, { op: "running_total" }] } })).toEqual([
      "Then the change from each week to the next.",
      "After that, a running total from the first week shown.",
    ]);
    expect(steps({ kind: "breakdown", dimension: "ward", measure: "dispatched", compute: { grain: "day", steps: [{ op: "change", percent: true }, { op: "over_time", fn: "mean" }] } }, { window })).toEqual([
      "Then the percentage change from each day to the next; a change from 0 has no percentage.",
      "After that, averaged per day over 122 days (28 May to 26 September 2026), with days without a value skipped.",
    ]);
  });
});

describe("dates in words", () => {
  it("says only what differs between the two ends", () => {
    expect(dateSpan("2025-09-01", "2025-09-07")).toBe("1 to 7 September 2025");
    expect(dateSpan("2026-05-28", "2026-09-26")).toBe("28 May to 26 September 2026");
    expect(dateSpan("2025-12-28", "2026-01-03")).toBe("28 December 2025 to 3 January 2026");
    expect(dateSpan("2026-09-10", "2026-09-10")).toBe("10 September 2026");
  });
});

describe("what a source ran", () => {
  const plan = { text: "SELECT 1", native: null, bound: {} } as unknown as Plan;
  const stub = (kind: string, report?: (ran: (s: SourceCall) => void) => void, fail = false): Connector => ({
    kind,
    capabilities: SQL_CAPABILITIES,
    compile: () => plan,
    async execute(_p, o) {
      if (report && o?.ran) report(o.ran);
      if (fail) throw new Error("down");
      return { rows: [], total: 0, format: "number" };
    },
  });

  it("is the plan's text when the connector says nothing, in the language its kind speaks", async () => {
    const out: SourceCall[] = [];
    await tracedConnector(stub("duckdb"), out).execute(plan);
    await tracedConnector(stub("elasticsearch"), out).execute({ ...plan, text: "POST /i/_search\n{}" });
    expect(out).toEqual([{ language: "sql", text: "SELECT 1" }, { language: "json", text: "POST /i/_search\n{}" }]);
  });

  it("is what the connector reports, each statement in turn, even when the call fails", async () => {
    const out: SourceCall[] = [];
    const two = stub("superset", (ran) => (ran({ language: "sql", text: "SELECT a" }), ran({ language: "sql", text: "SELECT b", cachedAt: "2026-09-10T08:00:00Z" })));
    await tracedConnector(two, out).execute(plan);
    await expect(tracedConnector(stub("postgres", (ran) => ran({ language: "sql", text: "SELECT $1", params: [5] }), true), out).execute(plan)).rejects.toThrow("down");
    expect(out.map((s) => s.text)).toEqual(["SELECT a", "SELECT b", "SELECT $1"]);
    expect(out[1]!.cachedAt).toBe("2026-09-10T08:00:00Z");
    expect(out[2]!.params).toEqual([5]);
  });
});
