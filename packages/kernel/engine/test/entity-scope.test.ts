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

  it("says it is the caller's access when the host keeps it (ACCESS_HIDDEN), not the pack's rules or a missing key", () => {
    const why = "your Superset access doesn't include it. A Superset admin can give you access.";
    const ctx = { hiddenEntities: new Set(["goal"]), hidden: new Set(["goal_n", "kind"]), accessHidden: { keys: new Set(["goal", "goal_n"]), reason: why } };
    const refusal = (q: Query, c: Parameters<typeof resolve>[2] = ctx) => {
      try {
        resolve(q, pack, c, SQL_CAPABILITIES);
      } catch (e) {
        return e instanceof ResolveError ? { code: e.code, message: e.message, nearest: e.nearest } : String(e);
      }
      return null;
    };
    expect(refusal(byRegion("goal_n"))).toEqual({ code: "ACCESS_HIDDEN", message: `"goal_n" is not available to you: ${why}`, nearest: undefined });
    expect(refusal({ kind: "rows", entity: "goal", columns: ["region"], limit: 5 })).toMatchObject({ code: "ACCESS_HIDDEN", message: `"goal" is not available to you: ${why}` });
    // Hidden by the pack's own rules ("kind" is not the host's): the refusal as before.
    expect(refusal({ kind: "breakdown", measure: "done_n", dimension: "kind", limit: 10, sort: "desc" })).toEqual({ code: "NOT_PERMITTED", message: `"kind" is not available to you`, nearest: undefined });
    // Not in the pack at all: the pack's own message, and no suggestion of a key or entity kept from the caller.
    expect(refusal(byRegion("doses"))).toMatchObject({ code: "UNKNOWN_MEASURE", message: `"doses" is not a measure in pack "stub"` });
    expect(refusal(byRegion("goal_m"))).toMatchObject({ code: "UNKNOWN_MEASURE", nearest: undefined });
    expect(refusal(byRegion("goal_m"), {})).toMatchObject({ code: "UNKNOWN_MEASURE", nearest: "goal_n" });
    expect(refusal({ kind: "rows", entity: "goals", columns: ["region"], limit: 5 })).toMatchObject({ code: "UNKNOWN_ENTITY", nearest: undefined });
    expect(refusal({ kind: "rows", entity: "goals", columns: ["region"], limit: 5 }, {})).toMatchObject({ code: "UNKNOWN_ENTITY", nearest: "goal" });
  });
});
