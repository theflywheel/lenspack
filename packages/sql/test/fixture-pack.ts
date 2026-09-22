import { parsePack } from "@lenspack/spec";

import type { Writer } from "../src/executor";

// A neutral schema: things, owned by owners, with parts. It has every shape
// the compiler must handle — a many-to-one join, a one-to-many join (the
// fan-out trap), a JSON column, a tenant column, a time column, a derived
// measure, a filtered measure and a percentile.
export const pack = parsePack({
  pack: "fixture",
  version: 1,
  entities: {
    things: {
      source: "things",
      grain: "one row per thing",
      time: "made_at",
      tenant: "tenant_id",
      joins: [
        { to: "owners", on: "things.owner_id = owners.id", type: "many_to_one" },
        { to: "parts", on: "parts.thing_id = things.id", type: "one_to_many" },
      ],
    },
    owners: { source: "owners", grain: "one row per owner" },
    parts: { source: "parts", grain: "one row per part", time: "added_at", tenant: "tenant_id" },
  },
  dimensions: [
    { key: "colour", entity: "things", sql: "colour" },
    { key: "size", entity: "things", sql: "size", type: "number" },
    { key: "origin", entity: "things", json: ["attrs", "origin"] },
    { key: "nested", entity: "things", json: ["attrs", "meta", "grade"] },
    { key: "tier", entity: "owners", sql: "tier" },
    { key: "part_kind", entity: "parts", sql: "kind" },
    { key: "made", entity: "things", sql: "made_at", type: "time", grains: ["day", "month"] },
  ],
  measures: [
    { key: "things", entity: "things", agg: "count" },
    { key: "weight", entity: "things", agg: "sum", sql: "weight_g / 1000.0" },
    { key: "broken_rate", entity: "things", agg: "avg", sql: "(status = 'broken')::int", format: "percent" },
    { key: "broken", entity: "things", agg: "count", filter: "status = 'broken'" },
    { key: "avg_weight", entity: "things", derived: "weight / things" },
    { key: "median_size", entity: "things", agg: "median", sql: "size" },
    { key: "p90_size", entity: "things", agg: "p90", sql: "size" },
    { key: "owners", entity: "owners", agg: "count" },
    { key: "distinct_owners", entity: "things", agg: "count_distinct", sql: "owner_id" },
    { key: "parts", entity: "parts", agg: "count" },
  ],
});

export async function seedFixture(writer: Writer, dialect: "postgres" | "duckdb") {
  const json = dialect === "postgres" ? "JSONB" : "JSON";
  for (const stmt of [
    `DROP TABLE IF EXISTS parts`,
    `DROP TABLE IF EXISTS things`,
    `DROP TABLE IF EXISTS owners`,
    `CREATE TABLE owners (id INTEGER PRIMARY KEY, tier VARCHAR)`,
    `CREATE TABLE things (id INTEGER PRIMARY KEY, tenant_id VARCHAR, owner_id INTEGER, colour VARCHAR, size INTEGER, weight_g INTEGER, status VARCHAR, attrs ${json}, made_at TIMESTAMP)`,
    `CREATE TABLE parts (id INTEGER PRIMARY KEY, tenant_id VARCHAR, thing_id INTEGER, kind VARCHAR, added_at TIMESTAMP)`,
    `INSERT INTO owners VALUES (1, 'gold'), (2, 'silver'), (3, 'gold')`,
    `INSERT INTO things VALUES
      (1, 't1', 1, 'red',   10, 1000, 'ok',     '{"origin":"north","meta":{"grade":"a"}}', '2026-01-05 10:00:00'),
      (2, 't1', 1, 'red',   20, 2000, 'broken', '{"origin":"south","meta":{"grade":"b"}}', '2026-01-06 10:00:00'),
      (3, 't1', 2, 'blue',  30, 3000, 'ok',     '{"origin":"north","meta":{"grade":"a"}}', '2026-01-20 10:00:00'),
      (4, 't1', 3, 'blue',  40, 4000, 'ok',     '{"origin":"east"}',                        '2026-02-01 10:00:00'),
      (5, 't1', 2, 'green', 50, 5000, 'broken', '{"origin":"north","meta":{"grade":"c"}}', '2026-02-10 10:00:00'),
      (6, 't2', 3, 'red',   60, 6000, 'ok',     '{"origin":"west"}',                        '2026-02-11 10:00:00')`,
    `INSERT INTO parts VALUES
      (1, 't1', 1, 'bolt', '2026-01-05 11:00:00'), (2, 't1', 1, 'nut', '2026-01-05 12:00:00'), (3, 't1', 1, 'bolt', '2026-01-05 13:00:00'),
      (4, 't1', 2, 'nut',  '2026-01-06 11:00:00'), (5, 't1', 3, 'bolt', '2026-01-20 11:00:00')`,
  ])
    await writer.exec(stmt);
}
