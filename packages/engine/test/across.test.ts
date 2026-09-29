import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/spec";
import { describe, expect, it } from "vitest";

import { type Connector, type Row, SQL_CAPABILITIES, explain, run, shapeRows } from "../src";

// Cross-entity ratios are computed by the engine from two ordinary queries,
// so a stub connector that answers from canned rows is enough to pin the join.

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

describe("ratios across entities", () => {
  it("joins on the group, counting a group missing from the numerator as zero", async () => {
    const c = stub((q) =>
      q.kind === "breakdown" && q.measure === "done_n"
        ? [{ group: "north", value: 5, n: 5 }]
        : [{ group: "north", value: 10, n: 1 }, { group: "south", value: 4, n: 1 }],
    );
    const data = await run({ kind: "breakdown", dimension: "region", measure: "progress", limit: 5, sort: "desc" }, { pack, connector: c });
    expect(data.rows).toEqual([
      { group: "north", value: 0.5, count: 5 },
      { group: "south", value: 0, count: 0 },
    ]);
    expect(data.format).toBe("percent");
  });

  it("narrows only the side that has the filtered dimension", async () => {
    const c = stub((q) => [{ value: q.measure === "done_n" ? 3 : 12, n: 1 }] as Row[]);
    const q: Query = { kind: "value", measure: "progress", filters: [{ dimension: "kind", op: "eq", value: "a" }] };
    const data = await run(q, { pack, connector: c });
    expect(data.rows[0]!.value).toBe(0.25);
    expect(c.seen.find((s) => s.kind === "value" && s.measure === "goal_n")!.filters).toBeUndefined();
    expect((await explain(q, { pack, connector: c })).text).toMatch(/not narrowed by kind/);
  });

  it("divides every period by a denominator that has no time", async () => {
    const c = stub((q) =>
      q.kind === "series" ? [{ bucket: "2026-08-01", value: 4, n: 4 }, { bucket: "2026-08-02", value: 6, n: 6 }] : [{ value: 8, n: 1 }],
    );
    const data = await run({ kind: "series", measure: "progress", grain: "day", time: { last: "7d" } }, { pack, connector: c, ctx: { now: new Date("2026-08-03T00:00:00Z") } });
    expect(data.rows.map((r) => r.value)).toEqual([0.5, 0.75]);
    const goal = c.seen.find((s) => s.kind !== "series")!;
    expect(goal).toMatchObject({ kind: "value", measure: "goal_n" });
    expect("time" in goal && goal.time).toBeFalsy();
  });

  it("compares periods against the same timeless denominator", async () => {
    const c = stub((q) => (q.kind === "value" && q.measure === "done_n" ? [{ value: 6, n: 6, previous: 3 }] : [{ value: 12, n: 1 }]) as Row[]);
    const data = await run({ kind: "value", measure: "progress", compare: "previous_period", time: { last: "7d" } }, { pack, connector: c });
    expect(data.rows[0]!.value).toBe(0.5);
    expect(data.compare).toEqual({ previous: 0.25, delta: 1 });
  });
});
