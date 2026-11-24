import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { ResolveError, SQL_CAPABILITIES, resolve } from "../src";

// A table's row-level security as scope: a clause with an entity narrows only
// the queries that read that entity, and an entity the caller may not read
// refuses every query that reads it, by any path.

const pack = parsePack({
  pack: "stub",
  version: 1,
  entities: { done: { source: "done", time: "at" }, goal: { source: "goal" } },
  dimensions: [
    { key: "region", entity: "done", field: "region", also: { goal: { field: "region" } } },
    { key: "kind", entity: "done", field: "kind" },
  ],
  measures: [
    { key: "done_n", entity: "done", agg: "count" },
    { key: "goal_n", entity: "goal", agg: "sum", field: "n" },
  ],
});
const byRegion = (measure: string): Query => ({ kind: "breakdown", measure, dimension: "region", limit: 10, sort: "desc" });
const scoped = (q: Query, ctx: Parameters<typeof resolve>[2]) => resolve(q, pack, ctx, SQL_CAPABILITIES).filters.map((f) => [f.dimension.def.entity, f.dimension.def.key, f.value]);

describe("entity scope", () => {
  const kindA = { entity: "done", dimension: "kind", op: "eq" as const, value: "a" };

  it("narrows the queries that read its entity, and leaves the others alone", () => {
    expect(scoped(byRegion("done_n"), { scope: [kindA] })).toEqual([["done", "kind", "a"]]);
    expect(scoped(byRegion("goal_n"), { scope: [kindA] })).toEqual([]);
    // Without an entity, a clause the query cannot reach is still refused.
    expect(() => scoped(byRegion("goal_n"), { scope: [{ ...kindA, entity: undefined }] })).toThrow(/limited by "kind"/);
  });

  it("refuses any query that reads an entity kept from the caller", () => {
    const hiddenEntities = new Set(["goal"]);
    expect(() => scoped(byRegion("goal_n"), { hiddenEntities })).toThrow(ResolveError);
    expect(() => scoped({ kind: "rows", entity: "goal", columns: ["region"], limit: 5 }, { hiddenEntities })).toThrow(/"goal" is not available to you/);
    expect(scoped(byRegion("done_n"), { hiddenEntities })).toEqual([]);
  });
});
