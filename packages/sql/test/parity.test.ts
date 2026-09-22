import type { Query } from "@lenspack/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Executor, type WidgetData, run } from "../src/executor";
import { openDuckdb } from "../src/executors/duckdb";
import { openPostgres } from "../src/executors/pg";
import { pack, seedFixture } from "./fixture-pack";

// The genericity proof, part one: the same query against the same data must
// return the same answer from both engines. Runs only when a Postgres is
// reachable; CI provides one, and locally LENSPACK_PG_URL enables it.

const PG_URL = process.env.LENSPACK_PG_URL ?? "postgres://localhost:5432/lenspack_test";
const ctx = { tenant: "t1", now: new Date("2026-02-15T00:00:00Z") };

const QUERIES: Query[] = [
  { kind: "breakdown", dimension: "colour", measure: "things", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "colour", measure: "broken_rate", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "colour", measure: "avg_weight", limit: 10, sort: "asc" },
  { kind: "breakdown", dimension: "origin", measure: "weight", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "nested", measure: "things", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "tier", measure: "broken", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "colour", measure: "parts", limit: 10, sort: "desc" },
  { kind: "series", measure: "things", grain: "month" },
  { kind: "series", measure: "things", grain: "week", time: { last: "60d" } },
  { kind: "series", measure: "weight", grain: "day", by: "colour" },
  { kind: "value", measure: "median_size" },
  { kind: "value", measure: "p90_size" },
  { kind: "value", measure: "distinct_owners" },
  { kind: "value", measure: "broken_rate", compare: "previous_period", time: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" } },
  { kind: "value", measure: "things", filters: [{ dimension: "colour", op: "contains", value: "ED" }, { dimension: "size", op: "between", value: [10, 30] }] },
  { kind: "rows", entity: "things", columns: ["colour", "size", "origin"], limit: 4, orderBy: { key: "size", dir: "desc" } },
];

function normalise(data: WidgetData) {
  const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  return {
    rows: data.rows.map((r) => ({ ...r, value: round(r.value) })).sort((a, b) => `${a.group}|${a.series ?? ""}`.localeCompare(`${b.group}|${b.series ?? ""}`)),
    records: data.records,
    total: data.total,
    format: data.format,
    compare: data.compare ? { previous: round(data.compare.previous), delta: round(data.compare.delta) } : undefined,
    error: data.error,
  };
}

let pg: Awaited<ReturnType<typeof openPostgres>> | null = null;
let duck: Awaited<ReturnType<typeof openDuckdb>>;

beforeAll(async () => {
  duck = await openDuckdb();
  await seedFixture(duck.writer, "duckdb");
  try {
    pg = await openPostgres(PG_URL);
    await pg.pool.query("SELECT 1");
    await seedFixture(pg.writer, "postgres");
  } catch (e) {
    pg = null;
    console.warn(`[parity] Postgres not reachable at ${PG_URL}; skipping (${String(e).slice(0, 80)})`);
  }
});
afterAll(async () => {
  await duck.close();
  await pg?.close();
});

describe("postgres and duckdb agree", () => {
  for (const query of QUERIES) {
    it(JSON.stringify(query), async ({ skip }) => {
      if (!pg) return skip();
      const a = normalise(await run(query, { pack, executor: duck.executor as Executor, ctx }));
      const b = normalise(await run(query, { pack, executor: pg.executor, ctx }));
      expect(a.error).toBeUndefined();
      expect(b).toEqual(a);
    });
  }
});
