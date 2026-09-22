import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/compile";
import { type Executor, run } from "../src/executor";
import { ResolveError } from "../src/resolve";
import { openDuckdb } from "../src/executors/duckdb";
import { pack, seedFixture } from "./fixture-pack";

// Every assertion here runs the real SQL on an in-memory DuckDB. The Postgres
// suite reuses the same fixture and boards to prove the two dialects agree.

let db: Awaited<ReturnType<typeof openDuckdb>>;
let executor: Executor;
const ctx = { tenant: "t1", now: new Date("2026-02-15T00:00:00Z") };
const q = (query: Parameters<typeof run>[0]) => run(query, { pack, executor, ctx });

beforeAll(async () => {
  db = await openDuckdb();
  await seedFixture(db.writer, "duckdb");
  executor = db.executor;
});
afterAll(async () => db.close());

describe("breakdown", () => {
  it("counts things by colour, tenant-scoped, sorted", async () => {
    const data = await q({ kind: "breakdown", dimension: "colour", measure: "things", limit: 10, sort: "desc" });
    expect(data.rows.map((r) => [r.group, r.value])).toEqual([["blue", 2], ["red", 2], ["green", 1]]);
    expect(data.total).toBe(5); // thing 6 is t2
  });

  it("computes a rate as an average over base rows", async () => {
    const data = await q({ kind: "breakdown", dimension: "colour", measure: "broken_rate", limit: 10, sort: "desc" });
    expect(data.format).toBe("percent");
    expect(data.rows.find((r) => r.group === "red")?.value).toBeCloseTo(0.5);
    expect(data.rows.find((r) => r.group === "blue")?.value).toBe(0);
  });

  it("applies a measure filter", async () => {
    const data = await q({ kind: "breakdown", dimension: "colour", measure: "broken", limit: 10, sort: "desc" });
    expect(Object.fromEntries(data.rows.map((r) => [r.group, r.value]))).toEqual({ red: 1, green: 1, blue: 0 });
  });

  it("expands a derived measure as a ratio of aggregates", async () => {
    const data = await q({ kind: "breakdown", dimension: "colour", measure: "avg_weight", limit: 10, sort: "desc" });
    expect(data.rows.find((r) => r.group === "red")?.value).toBeCloseTo(1.5);
  });

  it("reads JSON paths, nested and single", async () => {
    const origin = await q({ kind: "breakdown", dimension: "origin", measure: "things", limit: 10, sort: "desc" });
    expect(origin.rows.find((r) => r.group === "north")?.value).toBe(3);
    const nested = await q({ kind: "breakdown", dimension: "nested", measure: "things", limit: 10, sort: "desc" });
    expect(nested.rows.find((r) => r.group === "a")?.value).toBe(2);
    expect(nested.rows.find((r) => r.group === "(none)")?.value).toBe(1);
  });

  it("joins many-to-one for a dimension on another entity", async () => {
    const data = await q({ kind: "breakdown", dimension: "tier", measure: "things", limit: 10, sort: "desc" });
    expect(Object.fromEntries(data.rows.map((r) => [r.group, r.value]))).toEqual({ gold: 3, silver: 2 });
  });

  it("computes percentiles and distinct counts", async () => {
    const med = await q({ kind: "value", measure: "median_size" });
    expect(med.rows[0]?.value).toBe(30);
    const p90 = await q({ kind: "value", measure: "p90_size" });
    expect(p90.rows[0]?.value).toBeCloseTo(46);
    const owners = await q({ kind: "value", measure: "distinct_owners" });
    expect(owners.rows[0]?.value).toBe(3);
  });

  it("honours filter clauses of every operator", async () => {
    const eq = await q({ kind: "value", measure: "things", filters: [{ dimension: "colour", op: "eq", value: "red" }] });
    expect(eq.rows[0]?.value).toBe(2);
    const inn = await q({ kind: "value", measure: "things", filters: [{ dimension: "colour", op: "in", value: ["red", "green"] }] });
    expect(inn.rows[0]?.value).toBe(3);
    const between = await q({ kind: "value", measure: "things", filters: [{ dimension: "size", op: "between", value: [20, 40] }] });
    expect(between.rows[0]?.value).toBe(3);
    const contains = await q({ kind: "value", measure: "things", filters: [{ dimension: "colour", op: "contains", value: "ED" }] });
    expect(contains.rows[0]?.value).toBe(2);
    const joined = await q({ kind: "value", measure: "things", filters: [{ dimension: "tier", op: "neq", value: "gold" }] });
    expect(joined.rows[0]?.value).toBe(2);
  });
});

describe("series and value", () => {
  it("buckets by month with a relative window", async () => {
    const data = await q({ kind: "series", measure: "things", grain: "month", time: { last: "60d" } });
    expect(data.rows.map((r) => [r.group, r.value])).toEqual([["2026-01-01", 3], ["2026-02-01", 2]]);
  });

  it("splits a series by a dimension", async () => {
    const data = await q({ kind: "series", measure: "things", grain: "month", by: "colour" });
    expect(data.rows.filter((r) => r.series === "red").map((r) => r.value)).toEqual([2]);
    expect(data.rows.filter((r) => r.series === "blue").map((r) => [r.group, r.value])).toEqual([["2026-01-01", 1], ["2026-02-01", 1]]);
  });

  it("compares to the previous period in one statement", async () => {
    const data = await q({ kind: "value", measure: "things", compare: "previous_period", time: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" } });
    expect(data.rows[0]?.value).toBe(2);
    expect(data.compare?.previous).toBe(3);
    expect(data.compare?.delta).toBeCloseTo(-1 / 3);
  });

  it("a rate over the whole population is not the mean of group rates", async () => {
    const whole = await q({ kind: "value", measure: "broken_rate" });
    expect(whole.rows[0]?.value).toBeCloseTo(0.4);
  });
});

describe("rows", () => {
  it("lists dimension columns of one entity", async () => {
    const data = await q({ kind: "rows", entity: "things", columns: ["colour", "size"], limit: 3, orderBy: { key: "size", dir: "asc" } });
    expect(data.records).toEqual([{ colour: "red", size: 10 }, { colour: "red", size: 20 }, { colour: "blue", size: 30 }]);
  });
});

describe("refusals", () => {
  const fails = (query: Parameters<typeof compile>[0], code: string) => {
    try {
      compile(query, pack, { dialect: "duckdb", ctx });
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).code).toBe(code);
      return e as ResolveError;
    }
    throw new Error(`expected ${code}`);
  };

  it("refuses a fan-out rather than multiplying", () => {
    const e = fails({ kind: "breakdown", dimension: "part_kind", measure: "things", limit: 10, sort: "desc" }, "FANOUT_REFUSED");
    expect(e.message).toContain("multiply");
  });

  it("allows the same join in the safe direction", async () => {
    // parts → things is many-to-one, so a parts measure by a things dimension is fine.
    const data = await q({ kind: "breakdown", dimension: "colour", measure: "parts", limit: 10, sort: "desc" });
    expect(Object.fromEntries(data.rows.map((r) => [r.group, r.value]))).toEqual({ red: 4, blue: 1 });
  });

  it("requires a tenant when any entity in play declares one", () => {
    try {
      compile({ kind: "value", measure: "things" }, pack, { dialect: "duckdb", ctx: {} });
    } catch (e) {
      expect((e as ResolveError).code).toBe("TENANT_REQUIRED");
      return;
    }
    throw new Error("expected TENANT_REQUIRED");
  });

  it("names the nearest key for a typo", () => {
    const e = fails({ kind: "breakdown", dimension: "colr", measure: "things", limit: 10, sort: "desc" }, "UNKNOWN_DIMENSION");
    expect(e.nearest).toBe("colour");
  });

  it("refuses a series on an entity without time", () => {
    fails({ kind: "series", measure: "owners", grain: "day" }, "NO_TIME");
  });

  it("returns resolution errors as data from run()", async () => {
    const data = await q({ kind: "breakdown", dimension: "ghost", measure: "things", limit: 10, sort: "desc" });
    expect(data.error).toContain("ghost");
  });
});

describe("printed SQL invariants", () => {
  const c = compile(
    { kind: "breakdown", dimension: "tier", measure: "broken_rate", limit: 5, sort: "desc", time: { last: "30d" }, filters: [{ dimension: "colour", op: "eq", value: "red" }] },
    pack,
    { dialect: "postgres", ctx },
  );
  it("binds every value and inlines none", () => {
    expect(c.sql).not.toContain("'red'");
    expect(c.sql).not.toContain("t1");
    expect(c.params).toContain("red");
    expect(c.params).toContain("t1");
  });
  it("always emits a limit and the tenant predicate", () => {
    expect(c.sql).toMatch(/LIMIT 5$/);
    expect(c.sql).toContain(`"tenant_id" = $`);
  });
  it("prints the same shape for duckdb", () => {
    const d = compile({ kind: "value", measure: "things" }, pack, { dialect: "duckdb", ctx });
    expect(d.sql).toContain('count(*) AS "value"');
    expect(d.params).toEqual(["t1"]);
  });
});
