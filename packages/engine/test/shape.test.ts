import { describe, expect, it } from "vitest";

import { type DataRow, limitGroups, sortGroups } from "../src";

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
