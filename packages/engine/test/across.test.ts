import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/spec";
import { describe, expect, it } from "vitest";

import { type Connector, type Row, SQL_CAPABILITIES, check, explain, run, shapeRows } from "../src";

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

  it("adds distinct counts from entities whose groups do not overlap", async () => {
    const two = parsePack({
      pack: "two",
      version: 1,
      entities: { web: { source: "web" }, phone: { source: "phone" } },
      dimensions: [{ key: "channel", entity: "web", field: "channel", also: { phone: { sql: "'phone'" } } }],
      measures: [
        { key: "web_users", entity: "web", agg: "count_distinct", field: "user" },
        { key: "phone_users", entity: "phone", agg: "count_distinct", field: "user" },
        { key: "users", entity: "web", derived: "web_users + phone_users" },
      ],
    });
    const c = stub((q) => (q.kind === "breakdown" && q.measure === "web_users" ? [{ group: "site", value: 7, n: 9 }] : [{ group: "phone", value: 2, n: 3 }]));
    const data = await run({ kind: "breakdown", dimension: "channel", measure: "users", limit: 5, sort: "desc" }, { pack: two, connector: c });
    expect(data.rows.map((r) => [r.group, r.value])).toEqual([["site", 7], ["phone", 2]]);
  });

  it("narrows only the side that has the filtered dimension", async () => {
    const c = stub((q) => [{ value: q.kind !== "rows" && q.measure === "done_n" ? 3 : 12, n: 1 }] as Row[]);
    const q: Query = { kind: "value", measure: "progress", filters: [{ dimension: "kind", op: "eq", value: "a" }] };
    const data = await run(q, { pack, connector: c });
    expect(data.rows[0]!.value).toBe(0.25);
    expect(c.seen.find((s) => s.kind === "value" && s.measure === "goal_n")!.filters).toBeUndefined();
    expect((await explain(q, { pack, connector: c })).text).toMatch(/not narrowed by kind/);
    expect(data.notes).toEqual(['goal_n is not narrowed by kind: "goal" has no such dimension']);
  });

  it("refuses a filter that cannot narrow an operand counted into the answer, at run and at edit time", async () => {
    const sum = parsePack({
      pack: "sum",
      version: 1,
      entities: { chat: { source: "chat", time: "at" }, voice: { source: "voice", time: "at" } },
      dimensions: [
        { key: "language", entity: "chat", field: "language" },
        { key: "channel", entity: "voice", field: "channel" },
      ],
      measures: [
        { key: "chat_turns", entity: "chat", agg: "count" },
        { key: "voice_questions", entity: "voice", agg: "count" },
        { key: "questions", entity: "chat", derived: "chat_turns + voice_questions" },
        { key: "per_call", entity: "chat", derived: "chat_turns / (chat_turns + voice_questions)" },
        { key: "per_voice", entity: "chat", derived: "chat_turns / voice_questions" },
      ],
    });
    const c = stub(() => [{ value: 1, n: 1 }]);
    const filters = [{ dimension: "language", op: "eq" as const, value: "x" }];
    const data = await run({ kind: "value", measure: "questions", filters }, { pack: sum, connector: c });
    expect(data.error).toMatch(/"questions" cannot be narrowed by "language".*voice_questions.*chat_turns/);
    expect(data.hint).toBe("chat_turns");
    expect(c.seen).toEqual([]);
    // A divisor that counts some narrowed rows is no reference either, nor is one counting events over time.
    expect((await run({ kind: "value", measure: "per_call", filters }, { pack: sum, connector: c })).error).toMatch(/cannot be narrowed/);
    expect((await run({ kind: "value", measure: "per_voice", filters }, { pack: sum, connector: c })).error).toMatch(/cannot be narrowed/);
    const both = await run({ kind: "value", measure: "questions", filters: [...filters, { dimension: "channel", op: "eq", value: "y" }] }, { pack: sum, connector: c });
    expect(both.error).toMatch(/None of its operands takes every filter/);
    expect(both.hint).toBeUndefined();
    expect(() => check({ kind: "value", measure: "questions", filters }, sum)).toThrow(/cannot be narrowed by "language"/);
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

describe("calendar windows", () => {
  it("turns local dates into instants in the pack's zone, and a month default into from..to", async () => {
    const { dateRangeWindow, defaultRange, startOfLocalDay } = await import("../src");
    expect(startOfLocalDay("2026-09-01", "Africa/Nairobi").toISOString()).toBe("2026-08-31T21:00:00.000Z");
    expect(dateRangeWindow("2026-08-29..2026-09-29", "Africa/Nairobi")).toEqual({ from: "2026-08-28T21:00:00.000Z", to: "2026-09-29T21:00:00.000Z" });
    expect(defaultRange({ months: 1 }, new Date("2026-09-29T20:59:00Z"), "Africa/Nairobi")).toBe("2026-08-29..2026-09-29");
    expect(defaultRange({ months: 1 }, new Date("2026-09-29T21:01:00Z"), "Africa/Nairobi")).toBe("2026-08-30..2026-09-30");
    expect(defaultRange({ months: 1 }, new Date("2026-03-31T12:00:00Z"), "UTC")).toBe("2026-02-28..2026-03-31");
    expect(startOfLocalDay("2026-03-29", "Europe/Berlin").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfLocalDay("2026-03-30", "Europe/Berlin").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });
});

describe("split series", () => {
  it("says how many series it left out", () => {
    const raw = Array.from({ length: 14 }, (_, i) => ({ bucket: "2026-08-01", series: `s${i}`, value: i, n: 1 }));
    const data = shapeRows(raw, { kind: "series", measure: "done_n", grain: "day", by: "kind" }, "number");
    expect(new Set(data.rows.map((r) => r.series)).size).toBe(12);
    expect(data.notes).toEqual(["top 12 of 14 series by total; 2 left out"]);
    expect(shapeRows(raw.slice(0, 12), { kind: "series", measure: "done_n", grain: "day", by: "kind" }, "number").notes).toBeUndefined();
  });
});
