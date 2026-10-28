import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/spec";
import { describe, expect, it } from "vitest";

import { type Connector, type Row, ResolveError, SQL_CAPABILITIES, check, run, shapeRows } from "../src";

// Share and Other come from a value query beside the breakdown, so canned
// rows for each are enough to pin the arithmetic and what is refused.

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
    { key: "done_qty", entity: "done", agg: "sum", field: "qty" },
    { key: "done_people", entity: "done", agg: "count_distinct", field: "who" },
    { key: "done_avg", entity: "done", agg: "avg", field: "qty" },
    { key: "goal_n", entity: "goal", agg: "sum", field: "n" },
    { key: "progress", entity: "done", derived: "done_n / goal_n", format: "percent" },
  ],
});

function stub(answers: (q: Query) => Row[]): Connector & { seen: Query[] } {
  const seen: Query[] = [];
  return {
    kind: "stub",
    capabilities: SQL_CAPABILITIES,
    seen,
    compile: (bound) => ({ text: JSON.stringify(bound.query), native: bound.query, bound }),
    async execute(plan) {
      const q = plan.native as Query;
      seen.push(q);
      return shapeRows(answers(q), q, "number", plan.bound.measure?.def.key);
    },
  };
}

const time = { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" };

describe("share and other", () => {
  it("measures the groups shown against the whole population, previous period included", async () => {
    const c = stub((q) =>
      q.kind === "value"
        ? [{ value: 120, n: 12, previous: 100 }]
        : [
            { group: "north", value: 60, n: 6, previous: 40 },
            { group: "south", value: 30, n: 3, previous: null },
          ],
    );
    const data = await run({ kind: "breakdown", dimension: "region", measure: "done_qty", limit: 2, sort: "desc", compare: "previous_period", share: true, other: true, time }, { pack, connector: c });
    expect(data.rows).toEqual([
      { group: "north", value: 60, count: 6, compare: { previous: 40, delta: 0.5 }, share: 0.5 },
      { group: "south", value: 30, count: 3, compare: { previous: null, delta: null }, share: 0.25 },
      { group: "(other)", value: 30, count: 3, compare: { previous: 60, delta: -0.5 }, share: 0.25, other: true },
    ]);
    expect(data.total).toBe(12);
    expect(c.seen.find((q) => q.kind === "value")).toEqual({ kind: "value", measure: "done_qty", compare: "previous_period", time });
  });

  it("refuses what does not add up over groups, and a compared ratio across entities", () => {
    const refused = (q: Query) => {
      try {
        check(q, pack);
        return null;
      } catch (e) {
        if (e instanceof ResolveError) return { code: e.code, hint: e.nearest };
        throw e;
      }
    };
    const b = { kind: "breakdown", dimension: "region", limit: 5, sort: "desc" } as const;
    expect(refused({ ...b, measure: "done_avg", share: true })).toEqual({ code: "NOT_SUPPORTED", hint: "done_n" });
    expect(refused({ ...b, measure: "progress", share: true })?.code).toBe("NOT_SUPPORTED");
    expect(refused({ ...b, measure: "done_people", share: true })).toBeNull();
    expect(refused({ ...b, measure: "done_people", other: true })?.code).toBe("NOT_SUPPORTED");
    expect(refused({ ...b, measure: "done_n", other: true, by: "kind" })?.code).toBe("NOT_SUPPORTED");
    expect(refused({ ...b, measure: "progress", compare: "previous_period", time })).toEqual({ code: "NOT_SUPPORTED", hint: "value" });
    expect(refused({ ...b, measure: "done_n", compare: "previous_period" })?.code).toBe("NEEDS_TIME_RANGE");
  });

  it("compares only the primary of a breakdown with further measures", async () => {
    const c = stub((q) => (q.kind === "breakdown" && q.measure === "done_n" ? [{ group: "north", value: 5, n: 5, previous: 4 }] : [{ group: "north", value: 9, n: 1 }]));
    const data = await run({ kind: "breakdown", dimension: "region", measure: "done_n", measures: ["goal_n"], limit: 5, sort: "desc", compare: "previous_period", time }, { pack, connector: c });
    expect(data.rows).toEqual([{ group: "north", value: 5, count: 5, compare: { previous: 4, delta: 0.25 }, values: { goal_n: 9 } }]);
    expect(c.seen.find((q) => q.kind === "breakdown" && q.measure === "goal_n")).not.toHaveProperty("compare", "previous_period");
  });
});
