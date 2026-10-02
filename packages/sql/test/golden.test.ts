import type { Query } from "@lenspack/core";
import { parsePack } from "@lenspack/spec";
import { describe, expect, it } from "vitest";

import { compile } from "../src/compile";

// The printer's output, byte for byte, for every node the planner can emit.
// The Postgres and DuckDB files were written before dialects became drivers;
// a change here is a change in the SQL lenspack sends, so it must be meant.

const pack = parsePack({
  pack: "golden",
  version: 1,
  entities: {
    things: {
      source: "app.things",
      time: "made_at",
      tenant: { field: "tenant_id", match: "subtree" },
      filter: "deleted = false",
      where: [{ field: "kind", op: "neq", value: "test" }],
      joins: [
        { to: "owners", on: "things.owner_id = owners.id", type: "many_to_one" },
        { to: "parts", on: "parts.thing_id = things.id", type: "one_to_many" },
      ],
    },
    owners: { source: "Owners", grain: "one row per owner" },
    parts: { source: "parts", time: { field: "added_ms", unit: "epoch_ms" }, tenant: "tenant_id" },
    logs: { source: "logs", time: { field: "at_s", unit: "epoch_s" } },
    events: { source: "events", time: { sql: { postgres: "to_timestamp(t)", duckdb: "to_timestamp(t)" } } },
  },
  dimensions: [
    { key: "colour", entity: "things", sql: "colour" },
    { key: "size", entity: "things", field: "size", type: "number" },
    { key: "origin", entity: "things", json: ["attrs", "origin"] },
    { key: "nested", entity: "things", json: ["attrs", "meta", "grade"] },
    { key: "path", entity: "things", field: "path" },
    { key: "tier", entity: "owners", sql: { postgres: "upper(tier)", duckdb: "upper(tier)" } },
    { key: "part_kind", entity: "parts", field: "kind" },
    { key: "level", entity: "logs", field: "level" },
    { key: "made", entity: "things", sql: "made_at", type: "time" },
  ],
  measures: [
    { key: "things", entity: "things", agg: "count" },
    { key: "weight", entity: "things", agg: "sum", sql: "weight_g / 1000.0" },
    { key: "broken", entity: "things", agg: "count", filter: "status = 'broken'" },
    { key: "big", entity: "things", agg: "count", where: [{ field: "size", op: "gte", value: 30 }, { field: "colour", op: "in", value: ["red", "blue"] }] },
    { key: "sized", entity: "things", agg: "count", field: "size" },
    { key: "labelled", entity: "things", agg: "count", where: [{ field: "label", op: "exists" }, { field: "note", op: "missing" }, { field: "size", op: "lt", value: 99 }] },
    { key: "light", entity: "things", agg: "count", where: [{ field: "size", op: "lte", value: 10 }, { field: "size", op: "gt", value: 1 }, { field: "colour", op: "eq", value: "red" }] },
    { key: "avg_size", entity: "things", agg: "avg", field: "size" },
    { key: "min_size", entity: "things", agg: "min", field: "size" },
    { key: "max_size", entity: "things", agg: "max", field: "size" },
    { key: "median_size", entity: "things", agg: "median", sql: "size" },
    { key: "p90_size", entity: "things", agg: "p90", sql: "size" },
    { key: "distinct_owners", entity: "things", agg: "count_distinct", sql: "owner_id" },
    { key: "scaled", entity: "things", agg: "sum", field: "size", scale: 1.8 },
    { key: "per_thing", entity: "things", derived: "(weight - broken) / things * 100" },
    { key: "negated", entity: "things", derived: "-weight + 1" },
    { key: "parts", entity: "parts", agg: "count" },
    { key: "logs", entity: "logs", agg: "count" },
    { key: "events", entity: "events", agg: "count" },
    { key: "owners", entity: "owners", agg: "count" },
  ],
});

const ctx = { tenant: "ke_1", now: new Date("2026-02-15T12:34:56Z") };
const between = { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" };

export const GOLDEN_QUERIES: Query[] = [
  { kind: "breakdown", dimension: "colour", measure: "things", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "colour", measure: "weight", limit: 10, sort: "asc", sortBy: "group" },
  { kind: "breakdown", dimension: "colour", measure: "broken", limit: 10, sort: "desc", sortBy: "measure" },
  { kind: "breakdown", dimension: "colour", measure: "big", limit: 10, sort: "desc", sortBy: "none" },
  { kind: "breakdown", dimension: "tier", measure: "sized", by: "colour", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "origin", measure: "labelled", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "nested", measure: "light", limit: 10, sort: "desc" },
  { kind: "breakdown", dimension: "colour", measure: "parts", limit: 10, sort: "desc", time: { last: "30d" } },
  { kind: "breakdown", dimension: "level", measure: "logs", limit: 10, sort: "desc", time: between },
  { kind: "value", measure: "avg_size" },
  { kind: "value", measure: "min_size" },
  { kind: "value", measure: "max_size" },
  { kind: "value", measure: "median_size" },
  { kind: "value", measure: "p90_size" },
  { kind: "value", measure: "distinct_owners" },
  { kind: "value", measure: "scaled" },
  { kind: "value", measure: "per_thing" },
  { kind: "value", measure: "negated" },
  { kind: "value", measure: "owners" },
  { kind: "value", measure: "events", time: { last: "7d" } },
  { kind: "value", measure: "weight", compare: "previous_period", time: { last: "30d" } },
  { kind: "value", measure: "parts", compare: "previous_period", time: between },
  { kind: "value", measure: "logs", compare: "previous_period", time: between },
  { kind: "value", measure: "broken", compare: "previous_period", time: between },
  ...(["hour", "day", "week", "month", "quarter", "year"] as const).map((grain): Query => ({ kind: "series", measure: "things", grain })),
  { kind: "series", measure: "weight", grain: "week", by: "tier", time: { last: "12w" } },
  { kind: "series", measure: "parts", grain: "day", time: { last: "60d" } },
  { kind: "series", measure: "logs", grain: "month" },
  { kind: "series", measure: "events", grain: "hour", time: { last: "2d" } },
  {
    kind: "value",
    measure: "things",
    filters: [
      { dimension: "colour", op: "eq", value: "red" },
      { dimension: "colour", op: "neq", value: "blue" },
      { dimension: "size", op: "gte", value: 10 },
      { dimension: "size", op: "lte", value: 90 },
      { dimension: "colour", op: "in", value: ["red", "green"] },
      { dimension: "size", op: "between", value: [20, 40] },
      { dimension: "path", op: "segment", value: ["B%1", "C"] },
      { dimension: "path", op: "subtree", value: "a_b" },
      { dimension: "colour", op: "contains", value: "E%D" },
      { dimension: "tier", op: "eq", value: "GOLD" },
    ],
  },
  { kind: "rows", entity: "things", columns: ["colour", "size", "origin"], limit: 4, orderBy: { key: "size", dir: "desc" } },
  { kind: "rows", entity: "things", columns: ["colour", "nested"], limit: 20 },
];

const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

export function goldenText(dialect: "postgres" | "duckdb") {
  return GOLDEN_QUERIES.map((query) => {
    const c = compile(query, pack, { dialect, ctx });
    return `-- ${JSON.stringify(query)}\n-- params: ${stringify(c.params)}\n${c.sql};\n`;
  }).join("\n");
}

describe("golden SQL", () => {
  for (const dialect of ["postgres", "duckdb"] as const) {
    it(`${dialect} prints exactly what it printed before drivers`, async () => {
      await expect(goldenText(dialect)).toMatchFileSnapshot(`./golden/${dialect}.sql`);
    });
  }
});
