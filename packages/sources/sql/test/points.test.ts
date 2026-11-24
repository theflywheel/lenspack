import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run as runWith } from "@lenspack/engine";
import { parsePack } from "@lenspack/pack";

import { type Executor, sqlConnector } from "../src/executor";
import { openDuckdb } from "../src/executors/duckdb";

// Made-up sites on a made-up grid: points for a map, with a kind (colour) and people seen (size).
const pack = parsePack({
  pack: "sites",
  version: 1,
  entities: {
    sites: { source: "sites", grain: "one row per site", geo: { lat: "lat", lon: "lon" }, joins: [{ to: "areas", on: "sites.area_id = areas.id", type: "many_to_one" }] },
    areas: { source: "areas", grain: "one row per area" },
    visits: { source: "visits", grain: "one row per visit" },
  },
  dimensions: [
    { key: "site", entity: "sites", sql: "name" },
    { key: "kind", entity: "sites", sql: "kind" },
    { key: "area", entity: "areas", sql: "name" },
  ],
  measures: [
    { key: "sites", entity: "sites", agg: "count" },
    { key: "people", entity: "sites", agg: "sum", sql: "people" },
    { key: "visits", entity: "visits", agg: "count" },
  ],
});

let db: Awaited<ReturnType<typeof openDuckdb>>;
let executor: Executor;
const q = (query: Parameters<typeof runWith>[0]) => runWith(query, { pack, connector: sqlConnector(executor) });

beforeAll(async () => {
  db = await openDuckdb();
  for (const stmt of [
    `CREATE TABLE areas (id INTEGER, name VARCHAR)`,
    `CREATE TABLE sites (id INTEGER, area_id INTEGER, name VARCHAR, kind VARCHAR, lat DOUBLE, lon DOUBLE, people INTEGER)`,
    `CREATE TABLE visits (id INTEGER)`,
    `INSERT INTO areas VALUES (1, 'Upper'), (2, 'Lower')`,
    `INSERT INTO sites VALUES
      (1, 1, 'Site A', 'clinic', 1.5, 2.5, 40),
      (2, 1, 'Site B', 'post',   1.0, 3.0, 10),
      (3, 2, 'Site C', 'clinic', 0.5, 2.0, 25),
      (4, 2, 'Site D', 'post',   NULL, 2.0, 99),
      (5, 2, 'Site E', 'clinic', 0.5, 2.0, 5)`,
  ])
    await db.writer.exec(stmt);
  executor = db.executor;
});
afterAll(async () => db.close());

describe("points", () => {
  it("lists every located row with its coordinates, colour and name, leaving out rows with no location", async () => {
    const data = await q({ kind: "points", entity: "sites", color: "kind", label: "site", limit: 1000 });
    expect(data.error).toBeUndefined();
    expect(data.columns).toEqual(["lat", "lon", "site", "kind"]);
    expect(data.records).toHaveLength(4);
    expect(data.records).toContainEqual({ lat: 1.5, lon: 2.5, site: "Site A", kind: "clinic" });
    expect(data.records!.some((r) => r.site === "Site D")).toBe(false);
  });

  it("sizes each point by a measure, adding up rows at one spot, largest first", async () => {
    const data = await q({ kind: "points", entity: "sites", size: "people", limit: 1000 });
    expect(data.records).toEqual([
      { lat: 1.5, lon: 2.5, people: 40 },
      { lat: 0.5, lon: 2, people: 30 },
      { lat: 1, lon: 3, people: 10 },
    ]);
  });

  it("keeps the largest points when there are more than the limit, and says the list was cut", async () => {
    const data = await q({ kind: "points", entity: "sites", size: "people", limit: 2 });
    expect(data.records!.map((r) => r.people)).toEqual([40, 30]);
    expect(data.notes?.[0]).toMatch(/first 2 points only, largest people first/);
    expect((await q({ kind: "points", entity: "sites", limit: 4 })).notes).toBeUndefined();
  });

  it("colours by a dimension on a joined entity and narrows by filters", async () => {
    const data = await q({ kind: "points", entity: "sites", color: "area", label: "site", limit: 1000, filters: [{ dimension: "kind", op: "eq", value: "clinic" }] });
    expect(data.records!.map((r) => [r.site, r.area]).sort()).toEqual([["Site A", "Upper"], ["Site C", "Lower"], ["Site E", "Lower"]]);
  });

  it("refuses an entity with no location, and a size measured elsewhere", async () => {
    expect((await q({ kind: "points", entity: "visits", limit: 10 })).error).toMatch(/no location/);
    expect((await q({ kind: "points", entity: "sites", size: "visits", limit: 10 })).error).toMatch(/must be a measure of the points' own entity/);
  });
});
