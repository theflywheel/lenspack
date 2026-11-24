import { describe, expect, it } from "vitest";

import { parsePack } from "@lenspack/spec";

import { assembleQuery } from "../src/args";

const pack = parsePack({
  pack: "sites",
  version: 1,
  entities: { sites: { source: "sites", geo: { lat: "lat", lon: "lon" } } },
  dimensions: [
    { key: "site", entity: "sites", sql: "name" },
    { key: "kind", entity: "sites", sql: "kind" },
  ],
  measures: [{ key: "people", entity: "sites", agg: "sum", sql: "people" }],
});
const blank = { query_kind: "points", measure: "", measures: "", dimension: "", entity: "sites", label: "", grain: "day", time_last: "", time_period: "", time_count: 1, time_from: "", time_to: "", compare: false, share: false, other: false, limit: 0, sort: "desc", split: "", filters: "", filter_dimension: "", filter_value: "" } as const;

describe("a points query from the flat tool arguments", () => {
  it("reads dimension as the colour, measure as the size and label as the name", () => {
    expect(assembleQuery({ ...blank, dimension: "kind", measure: "people", label: "site", filters: "kind = clinic" } as never, pack)).toEqual({
      kind: "points",
      entity: "sites",
      color: "kind",
      size: "people",
      label: "site",
      limit: 5000,
      filters: [{ dimension: "kind", op: "eq", value: "clinic" }],
    });
  });

  it("takes up to 5000 points, and no further measures", () => {
    expect(assembleQuery({ ...blank, limit: 5000, measures: "people" } as never, pack)).toEqual({ kind: "points", entity: "sites", limit: 5000 });
  });
});
