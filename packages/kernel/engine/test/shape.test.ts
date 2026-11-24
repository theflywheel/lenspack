import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { type DataRow, SERIES_ROWS, SPLIT_ROWS, limitGroups, resolve, rowCap, shapeBound, shapeRows, sortGroups } from "../src";

// The order and the cut every connector's breakdown goes through.

const row = (group: string, value: number | null, series?: string): DataRow => ({ group, ...(series ? { series } : {}), value, count: 1 });
const names = (rows: DataRow[]) => rows.map((r) => (r.series ? `${r.group}/${r.series}` : r.group));

describe("sortGroups", () => {
  const rows = () => [row("b", 2), row("a", 2), row("c", null), row("d", 5), row("e", null)];

  it("sorts by value with ties by name, and no value last", () => {
    expect(names(sortGroups(rows(), { sort: "desc" }))).toEqual(["d", "a", "b", "c", "e"]);
    expect(names(sortGroups(rows(), { sort: "asc", sortBy: "value" }))).toEqual(["a", "b", "d", "c", "e"]);
  });

  it("leaves ties as given under measure, and every row as given under none", () => {
    expect(names(sortGroups(rows(), { sort: "desc", sortBy: "measure" }))).toEqual(["d", "b", "a", "c", "e"]);
    expect(names(sortGroups(rows(), { sort: "desc", sortBy: "none" }))).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("sorts by group in the direction asked, series A to Z within it", () => {
    expect(names(sortGroups([row("a", 1, "y"), row("b", 1, "x"), row("a", 1, "x")], { sort: "desc", sortBy: "group" }))).toEqual(["b/x", "a/x", "a/y"]);
  });

  it("reads raw rows too: numbers as text, groups as numbers", () => {
    expect(sortGroups([{ group: 10, value: "3" }, { group: 9, value: 7 }], { sort: "desc" }).map((r) => r.group)).toEqual([9, 10]);
  });
});

describe("a series' rows", () => {
  const query = { kind: "series", measure: "n", grain: "day", by: "kind" } as const;
  const raw = [
    { bucket: "2026-01-02", series: "b", value: 1, n: 1 },
    { bucket: "2026-01-01", series: "b", value: 1, n: 1 },
    { bucket: "2026-01-02", series: "a", value: 1, n: 1 },
    { bucket: "2026-01-01", series: "a", value: 1, n: 1 },
  ];

  it("come in one order, by bucket then series, whatever order the source answered in", () => {
    const order = ["2026-01-01/a", "2026-01-01/b", "2026-01-02/a", "2026-01-02/b"];
    expect(names(shapeRows(raw, query, "number").rows)).toEqual(order);
    expect(names(shapeRows([...raw].reverse(), query, "number").rows)).toEqual(order);
  });
});

describe("limitGroups", () => {
  // north has the largest cell, south and east the largest totals.
  const split = [row("north", 9, "a"), row("south", 6, "a"), row("south", 5, "b"), row("east", 4, "a"), row("east", 4, "b"), row("east", 4, "c")];
  const breakdown = { by: "kind", limit: 2, sort: "desc" } as const;

  it("cuts an unsplit breakdown at its limit", () => {
    expect(names(limitGroups([row("a", 3), row("b", 2), row("c", 1)], { limit: 2, sort: "desc" }))).toEqual(["a", "b"]);
  });

  it("split, keeps every row of the top groups by total, in the order given", () => {
    expect(names(limitGroups(split, breakdown))).toEqual(["south/a", "south/b", "east/a", "east/b", "east/c"]);
    expect(names(limitGroups(split, { ...breakdown, sort: "asc" }))).toEqual(["north/a", "south/a", "south/b"]);
  });

  it("split and sorted by group or not at all, keeps the first groups as they come", () => {
    expect(names(limitGroups(split, { ...breakdown, sortBy: "group" }))).toEqual(["north/a", "south/a", "south/b"]);
    expect(names(limitGroups(split, { ...breakdown, sortBy: "none" }))).toEqual(["north/a", "south/a", "south/b"]);
  });

  it("breaks tied totals by name, or keeps them as given under measure", () => {
    const tied = [row("c", 1, "x"), row("a", 1, "x"), row("b", 1, "x")];
    expect(names(limitGroups(tied, breakdown))).toEqual(["a/x", "b/x"]);
    expect(names(limitGroups(tied, { ...breakdown, sortBy: "measure" }))).toEqual(["c/x", "a/x"]);
  });
});

// A source reads one row past its limit (rowCap) so a cut answer can say so. A
// series keeps its latest buckets whole; a split breakdown is ranked on the rows
// the source returned. Either way the answer is marked truncated and says why.
describe("an answer the source cut at its row limit", () => {
  const pack = parsePack({
    pack: "cut",
    version: 1,
    entities: { visits: { source: "visits", time: "at" } },
    dimensions: [
      { key: "region", entity: "visits", field: "region" },
      { key: "kind", entity: "visits", field: "kind" },
    ],
    measures: [{ key: "visits", entity: "visits", agg: "count" }],
  });
  const hour = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 3600e3).toISOString();

  it("keeps a plain series' latest buckets, and says how many", () => {
    const bound = resolve({ kind: "series", measure: "visits", grain: "hour" }, pack);
    const cap = rowCap(bound)!;
    expect(cap).toBe(SERIES_ROWS);
    // Latest first, as the source orders a series; one row past the cap.
    const raw = Array.from({ length: cap + 1 }, (_, i) => ({ bucket: hour(cap - i), value: 1, n: 1 }));
    const data = shapeBound(raw, bound);
    expect(data.rows.length).toBe(cap);
    expect(data.rows[0]!.group).toBe(hour(1).slice(0, 13) + ":00");
    expect(data.rows.at(-1)!.group).toBe(hour(cap).slice(0, 13) + ":00");
    expect(data.truncated).toBe(true);
    expect(data.notes).toEqual([`only the latest ${cap.toLocaleString("en")} hours are shown; the source has more than ${cap.toLocaleString("en")} rows for this series`]);
    // One row fewer is the whole answer.
    expect(shapeBound(raw.slice(0, cap), bound).truncated).toBeUndefined();
  });

  it("leaves out the bucket the cut went through, so every bucket shown is whole", () => {
    const bound = resolve({ kind: "series", measure: "visits", grain: "day", by: "region" }, pack);
    const cap = rowCap(bound)!;
    // 2 regions a day, latest day first; the cut falls between the two regions of the earliest day.
    const days = Math.ceil((cap + 1) / 2);
    const raw = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2000, 0, 1) + (days - i) * 86400e3).toISOString())
      .flatMap((bucket) => ["a", "b"].map((series) => ({ bucket, series, value: 1, n: 1 })))
      .slice(0, cap + 1);
    const data = shapeBound(raw, bound);
    expect(data.truncated).toBe(true);
    expect(data.notes?.[0]).toMatch(/^only the latest [\d,]+ days are shown, and series are ranked on those days; the source has more than/);
    // Every day shown has both regions.
    const perDay = new Map<string, number>();
    for (const r of shapeRows(raw, bound.query, "number", undefined, true).rows) perDay.set(r.group, (perDay.get(r.group) ?? 0) + 1);
    const partial = [...perDay].filter(([, n]) => n === 1).map(([d]) => d);
    expect(partial.length).toBe(1);
    expect(data.rows.some((r) => r.group === partial[0])).toBe(false);
  });

  it("ranks a split breakdown on the rows returned, and says so", () => {
    const bound = resolve({ kind: "breakdown", dimension: "region", by: "kind", measure: "visits", limit: 5, sort: "desc" }, pack);
    expect(rowCap(bound)).toBe(SPLIT_ROWS);
    const raw = Array.from({ length: SPLIT_ROWS + 1 }, (_, i) => ({ group: `g${Math.floor(i / 2)}`, series: i % 2 ? "x" : "y", value: SPLIT_ROWS - i, n: 1 }));
    const data = shapeBound(raw, bound);
    expect(data.truncated).toBe(true);
    expect(data.notes).toEqual([`groups are ranked on part of the data; the source has more than ${SPLIT_ROWS.toLocaleString("en")} rows for this breakdown`]);
    // An unsplit breakdown's limit is its top N, not a cut.
    expect(rowCap(resolve({ kind: "breakdown", dimension: "region", measure: "visits", limit: 5, sort: "desc" }, pack))).toBeUndefined();
  });

  it("takes the source's word for a cut it knows of without counting rows", () => {
    const bound = resolve({ kind: "breakdown", dimension: "region", measure: "visits", limit: 5, sort: "desc" }, pack);
    const data = shapeBound([{ group: "north", value: 3, n: 3 }], bound, true);
    expect(data.truncated).toBe(true);
    expect(data.notes).toEqual(["groups are ranked on part of the data; the source stops at its row limit for this breakdown"]);
  });
});
